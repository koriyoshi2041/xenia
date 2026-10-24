import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, http, parseAbi, formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA, canonicalJson, communityPolicyTypedData } from "@gfh/shared";
import { verifyPassport, type Passport } from "@gfh/shared";
import type { Queue } from "@gfh/shared";

const { values } = parseArgs({ options: {
  source: { type: "string" }, target: { type: "string" }, login: { type: "string" },
} });
const login = values.login || process.env.GFH_GITHUB_LOGIN;
if (!login) throw new Error("Specify the contributor with --login or GFH_GITHUB_LOGIN");
const api = process.env.GFH_API ?? "http://127.0.0.1:8787";
const rpc = process.env.RPC_URL ?? BASE_SEPOLIA.rpcUrl;
const client = createPublicClient({ transport: http(rpc) });
const keys: Record<string, Hex> = JSON.parse(readFileSync(process.env.COMMUNITY_KEYS_PATH ?? "secrets/communities.json", "utf8"));
const names = Object.keys(keys);
const source = values.source ?? names[0]!, target = values.target ?? names[1]!;
const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
  const response = await fetch(api + path, { method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
const passport = () => request(`/api/passports/${encodeURIComponent(login)}`) as Promise<Passport>;
const original = await passport();
const a = original.communities.find((q) => q.repo === source);
const b = original.communities.find((q) => q.repo === target);
assert.ok(a && b && a.id !== b.id, "Select two registered communities");
assert.ok(b.trusts.some((t) => t.queueId === a.id && t.weight > 0), "The target must currently recognize the source");
assert.ok(keys[b.repo], "Target community signing key is not configured");
const signer = privateKeyToAccount(keys[b.repo]!);
assert.equal(signer.address.toLowerCase(), b.adjudicator.toLowerCase());
await verifyPassport(original, rpc, original.network.operator);
const agent = privateKeyToAccount(process.env.GFH_AGENT_KEY as Hex).address;
const document = (q: Queue) => ({ trusts: q.trusts, acceptedKinds: q.acceptedKinds, policy: q.policy });
async function signPolicy(patch: Partial<Queue>) {
  const challenge = await request(`/api/queues/${b!.id}/policy-challenge`, "POST", patch);
  const signature = await signer.signTypedData(communityPolicyTypedData(
    original.network.operator, b!.id, challenge.document, challenge.revision, challenge.expiresAt,
  ));
  return request(`/api/queues/${b!.id}/policy`, "PATCH", { ...challenge, signature });
}
const balance = async (address: `0x${string}`) => formatUnits(await client.readContract({
  address: BASE_SEPOLIA.usdc, abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
  functionName: "balanceOf", args: [address],
}), 6);
async function capture(stage: string) {
  const [bundle, quoteA, quoteB, agentUsdc, poolUsdc, queue] = await Promise.all([
    passport(),
    request(`/api/quote?repo=${encodeURIComponent(source)}&login=${encodeURIComponent(login!)}`),
    request(`/api/quote?repo=${encodeURIComponent(target)}&login=${encodeURIComponent(login!)}`),
    balance(agent), balance(b!.pool), request("/api/review-queue"),
  ]);
  const verification = await verifyPassport(bundle, rpc, original.network.operator);
  const result = { stage, at: new Date().toISOString(), passport: bundle, verification,
    quotes: { source: quoteA, target: quoteB }, balances: { agentUsdc, poolUsdc },
    admitted: queue.items.map((i: any) => ({ url: i.pr.url, state: i.state })),
  };
  console.log(`${stage}: ${source} = ${quoteA.amount} USDC; ${target} = ${quoteB.amount} USDC; ${bundle.records.length} verified proofs`);
  return result;
}
const report: any = { mode: original.network.mode, login, source, target, passed: false, restored: false, stages: [] };
const withoutSource = { ...document(b), trusts: b.trusts.filter((t) => t.queueId !== a.id) };
let mutationAttempted = false;
try {
  const baseline = await capture("recognized");
  report.stages.push(baseline);
  assert.ok(baseline.quotes.target.recognized.some((r: any) => r.queueId === a.id), "No source proofs influence the target yet");
  mutationAttempted = true;
  await signPolicy(withoutSource);
  const removed = await capture("recognition removed");
  report.stages.push(removed);
  assert.equal(removed.quotes.source.amount, baseline.quotes.source.amount);
  assert.ok(removed.quotes.target.amount > baseline.quotes.target.amount, "This record set does not produce a price contrast");
  assert.deepEqual(removed.passport.records, baseline.passport.records);
  assert.deepEqual(removed.balances, baseline.balances);
  assert.deepEqual(removed.admitted, baseline.admitted);
} finally {
  try {
    if (mutationAttempted) {
      const current = (await passport()).communities.find((q) => q.id === b.id)!;
      if (canonicalJson(document(current)) !== canonicalJson(document(b))) {
        assert.equal(canonicalJson(document(current)), canonicalJson(withoutSource), "Another policy change occurred; original policy was not restored over it");
        await signPolicy(document(b));
      }
      const restored = await capture("recognition restored");
      report.stages.push(restored);
      assert.deepEqual(document(restored.passport.communities.find((q) => q.id === b.id)!), document(b));
      assert.equal(restored.quotes.target.amount, report.stages[0].quotes.target.amount);
      assert.deepEqual(restored.passport.records, original.records);
      report.restored = true;
    }
  } finally {
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(`artifacts/rehearsal-${original.network.mode}.json`, JSON.stringify(report, null, 2) + "\n");
  }
}
report.passed = true;
writeFileSync(`artifacts/rehearsal-${original.network.mode}.json`, JSON.stringify(report, null, 2) + "\n");
console.log("PASS: source price, proof records, funds and admitted work preserved; target policy restored.");
