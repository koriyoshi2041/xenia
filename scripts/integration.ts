import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import {
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA,
  postBond,
  agentIdentity,
  communityPolicyTypedData,
} from "@gfh/shared";
import { deploy, fundFork } from "./chain-setup.ts";
import { Chain } from "../server/src/chain/client.ts";
import { openDb } from "../server/src/db/index.ts";
import { Store } from "../server/src/runtime/store.ts";
import { Service } from "../server/src/runtime/service.ts";
import { createHttp } from "../server/src/runtime/http.ts";
import { indexContributions } from "../server/src/chain/indexer.ts";
import type { GitHubGateway } from "../server/src/github/client.ts";
import type { PullRequest } from "@gfh/shared";
import { verifyPassport } from "@gfh/shared";

// Public Anvil development keys. Never use these for a public deployment.
const RELAYER =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const PAYER =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const ADJUDICATOR = `0x${"33".repeat(32)}` as Hex;
const account = privateKeyToAccount(PAYER);
const pool = privateKeyToAccount(`0x${"44".repeat(32)}`).address;
const rpc = process.env.TEST_RPC_URL ?? "http://127.0.0.1:8545";
const forkSource = process.env.TEST_FORK_URL ?? BASE_SEPOLIA.rpcUrl;
const api = "http://127.0.0.1:8790";
const secret = "integration-fixture-webhook-secret";
const admin = "integration-admin";
const report: any = {
  mode: "base-sepolia-fork",
  forkSource: new URL(forkSource).origin,
  githubTransport:
    "signed webhook fixtures; no external PRs or check runs written",
  startedAt: new Date().toISOString(),
  cases: [],
};
const metadata = new Map<string, PullRequest>();
const github: GitHubGateway = {
  async pull(repo, number) {
    const p = metadata.get(`${repo}#${number}`);
    if (!p) throw new Error("Missing fixture");
    return p;
  },
  async user(login) {
    return {
      id: login === "contributor" ? 77 : 88,
      createdAt: "2020-01-01T00:00:00Z",
    };
  },
  async signals() {
    return { write: false, merged: [] };
  },
  async check() {},
};
const reset = await fetch(rpc, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "anvil_reset",
    params: [{ forking: { jsonRpcUrl: forkSource } }],
  }),
});
if (((await reset.json()) as any).error)
  throw new Error("Integration requires a disposable Anvil fork");
const deployment = await deploy(rpc, RELAYER, pool);
report.deployment = deployment;
console.log("Deployed operator and EAS schema", deployment);
await fundFork(rpc, account.address, 100_000_000n);
const dbPath = new URL("../server/integration.sqlite", import.meta.url)
  .pathname;
rmSync(dbPath, { force: true });
const db = openDb(dbPath);
const keyB = `0x${"55".repeat(32)}` as Hex;
const keyC = `0x${"66".repeat(32)}` as Hex;
const chain = new Chain(rpc, RELAYER, ADJUDICATOR, deployment.operator, {
  "fixture/community-b": keyB,
  "fixture/security": keyC,
});
const service = new Service(new Store(db), chain, github, api);
const app = createHttp(service, {
  adminToken: admin,
  webhookSecret: secret,
  mode: "base-sepolia-fork",
});
const server = serve({ fetch: app.fetch, port: 8790 });
async function call(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${admin}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = (await r.json()) as any;
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
async function webhook(
  repo: string,
  repoId: number,
  number: number,
  action: string,
  login = "contributor",
  labels: string[] = [],
  delivery = randomUUID(),
) {
  const closed = action === "closed";
  const p: PullRequest = {
    repo,
    repoId,
    number,
    authorId: login === "contributor" ? 77 : 88,
    authorLogin: login,
    title: `Integration contribution ${number}`,
    draft: false,
    headSha: "a".repeat(40),
    url: `https://github.com/${repo}/pull/${number}`,
    state: closed ? "closed" : "open",
    merged: closed && labels.includes("merged"),
    labels: labels.filter((l) => l !== "merged"),
  };
  metadata.set(`${repo}#${number}`, p);
  const payload = {
    action,
    repository: { full_name: repo, id: repoId },
    pull_request: {
      number,
      user: { login, id: p.authorId },
      head: { sha: p.headSha },
      title: p.title,
      draft: p.draft,
      html_url: p.url,
      state: p.state,
      merged: p.merged,
      labels: p.labels.map((name) => ({ name })),
    },
  };
  const raw = JSON.stringify(payload);
  const response = await fetch(`${api}/webhooks/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    },
    body: raw,
  });
  assert.equal(response.status, 200, await response.text());
  return delivery;
}
let registeredAgent: string | undefined;
const paid = (repo: string, number: number, maxAmountUsdc = 5) =>
  postBond({
    api,
    repo,
    number,
    account,
    maxAmountUsdc,
    rpcUrl: rpc,
    agentId: registeredAgent,
  });
const item = (repo: string, number: number) =>
  call(`/api/items/${repo}/${number}`);
try {
  const identityAbi = parseAbi([
    "function register(string agentURI) returns(uint256)",
    "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
  ]);
  const agentWallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpc),
  });
  const metadataUri =
    "data:application/json;base64," +
    Buffer.from(
      JSON.stringify({
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: "GFH integration agent",
        description: "Local fork integration fixture",
        services: [],
        active: true,
        x402Support: true,
      }),
    ).toString("base64");
  const identityTx = await agentWallet.writeContract({
    address: BASE_SEPOLIA.erc8004Identity,
    abi: identityAbi,
    functionName: "register",
    args: [metadataUri],
  });
  const identityReceipt = await chain.confirmed(identityTx);
  registeredAgent = String(
    parseEventLogs({
      abi: identityAbi,
      eventName: "Registered",
      logs: identityReceipt.logs,
    })[0]!.args.agentId,
  );
  assert.equal(
    (await agentIdentity(BigInt(registeredAgent), rpc)).owner.toLowerCase(),
    account.address.toLowerCase(),
  );
  report.cases.push({
    name: "ERC-8004 registration and wallet ownership",
    agentId: registeredAgent,
    transaction: identityTx,
  });
  const a = await call("/api/queues", {
    repo: "fixture/community-a",
    repoId: 42,
    pool,
    githubHistory: false,
  });
  const b = await call("/api/queues", {
    repo: "fixture/community-b",
    repoId: 43,
    pool,
    githubHistory: false,
    trusts: [{ queueId: a.id, weight: 1 }],
  });
  const c = await call("/api/queues", {
    repo: "fixture/security",
    repoId: 44,
    pool,
    githubHistory: false,
    kind: "security_reports",
    acceptedKinds: ["pull_requests", "security_reports"],
    trusts: [{ queueId: b.id, weight: 1 }],
    policy: { ...a.policy, baseBond: 10, exemptMinRecords: 3 },
  });
  assert.notEqual(a.adjudicator, b.adjudicator);
  assert.notEqual(b.adjudicator, c.adjudicator);
  report.cases.push({
    name: "Independent community adjudicators",
    adjudicators: [a.adjudicator, b.adjudicator, c.adjudicator],
  });
  assert.equal(
    (await call("/api/quote?repo=fixture/community-a&login=contributor"))
      .amount,
    5,
  );
  await webhook(a.repo, 42, 1, "opened");
  assert.equal((await call("/api/review-queue")).items.length, 0);
  await assert.rejects(() => paid(a.repo, 1, 1), /spending limit/);
  const first = await paid(a.repo, 1);
  assert.equal(first.state, "BONDED");
  assert.equal((await call("/api/review-queue")).items[0].pr.number, 1);
  assert.equal(await chain.balance(account.address), 95_000_000n);
  await webhook(a.repo, 42, 1, "closed", "contributor", ["merged"]);
  const resolved = await item(a.repo, 1);
  assert.equal(resolved.state, "RESOLVED");
  assert.equal((await call("/api/review-queue")).items.length, 0);
  report.cases.push({
    name: "Maintainer review queue tracks confirmed admission and closure",
    passed: true,
  });
  assert.equal(resolved.verdict, 1);
  assert.ok(resolved.attestation);
  assert.equal(resolved.feedbackConfirmed, true, resolved.feedbackError);
  const feedbackIndex = await chain.public.readContract({
    address: BASE_SEPOLIA.erc8004Reputation,
    abi: parseAbi([
      "function getLastIndex(uint256,address) view returns(uint64)",
    ]),
    functionName: "getLastIndex",
    args: [BigInt(registeredAgent!), chain.wallet.account.address],
  });
  assert.equal(feedbackIndex, 1n);
  report.cases.push({
    name: "ERC-8004 contribution feedback",
    transaction: resolved.feedbackTx,
    feedbackIndex: String(feedbackIndex),
  });
  assert.equal(await chain.balance(account.address), 100_000_000n);
  report.cases.push({
    name: "x402 → ERC-3009 → escrow → Accepted refund → EAS",
    payment: first.txPost,
    settlement: resolved.txResolve,
    attestation: resolved.attestation,
  });
  const afterOne = await call(
    "/api/quote?repo=fixture/community-a&login=contributor",
  );
  assert.equal(afterOne.amount, 0.5);
  await webhook(a.repo, 42, 2, "opened");
  await paid(a.repo, 2);
  await webhook(a.repo, 42, 2, "closed", "contributor", ["merged"]);
  assert.equal(
    (await call("/api/quote?repo=fixture/community-b&login=contributor"))
      .amount,
    0,
  );
  const proofUids = service.store.records().map((r) => r.uid);
  const challenge = await call(`/api/queues/${b.id}/policy-challenge`, {
    trusts: [],
  });
  const typed = communityPolicyTypedData(
    deployment.operator,
    b.id,
    challenge.document,
    challenge.revision,
    challenge.expiresAt,
  );
  const wrongSignature = await chain.adjudicator.signTypedData(typed);
  await assert.rejects(
    () =>
      call(
        `/api/queues/${b.id}/policy`,
        { ...challenge, signature: wrongSignature },
        "PATCH",
      ),
    /community adjudicator/,
  );
  const signature = await privateKeyToAccount(keyB).signTypedData(typed);
  await call(
    `/api/queues/${b.id}/policy`,
    { ...challenge, signature },
    "PATCH",
  );
  assert.equal(
    (await call("/api/quote?repo=fixture/community-b&login=contributor"))
      .amount,
    5,
  );
  assert.equal(
    (await call("/api/quote?repo=fixture/community-a&login=contributor"))
      .amount,
    0,
  );
  assert.deepEqual(
    service.store.records().map((r) => r.uid),
    proofUids,
  );
  await assert.rejects(
    () =>
      call(`/api/queues/${b.id}/policy`, { ...challenge, signature }, "PATCH"),
    /fresh signature/,
  );
  const restore = await call(`/api/queues/${b.id}/policy-challenge`, {
    trusts: [{ queueId: a.id, weight: 1 }],
  });
  await call(
    `/api/queues/${b.id}/policy`,
    {
      ...restore,
      signature: await privateKeyToAccount(keyB).signTypedData(
        communityPolicyTypedData(
          deployment.operator,
          b.id,
          restore.document,
          restore.revision,
          restore.expiresAt,
        ),
      ),
    },
    "PATCH",
  );
  report.cases.push({
    name: "Community-signed policy changes its own price while EAS facts remain unchanged",
    removedTrustPrice: 5,
    restoredTrustPrice: 0,
  });
  const passport = await call("/api/passports/contributor");
  const verified = await verifyPassport(passport, rpc, deployment.operator);
  assert.equal(verified.recordsVerified, 2);
  assert.ok(verified.policies.find((p) => p.queueId === b.id)?.signatureVerified);
  const changedFact = structuredClone(passport);
  changedFact.records[0].bondAmount = "1";
  await assert.rejects(() => verifyPassport(changedFact, rpc, deployment.operator), /differ from EAS/);
  const changedPolicy = structuredClone(passport);
  changedPolicy.communities.find((q: any) => q.id === b.id).policy.baseBond = 1;
  await assert.rejects(() => verifyPassport(changedPolicy, rpc, deployment.operator), /document hash/);
  const changedPath = structuredClone(passport);
  changedPath.recognition[0].acceptedCredits += 1;
  await assert.rejects(() => verifyPassport(changedPath, rpc, deployment.operator), /Recognition paths/);
  const wrongFork = structuredClone(passport);
  wrongFork.network.anchor.hash = `0x${"00".repeat(32)}`;
  await assert.rejects(() => verifyPassport(wrongFork, rpc, deployment.operator), /chain snapshot/);
  report.cases.push({
    name: "Portable passport verified without server: EAS receipts, community signatures, recognition paths and chain anchor",
    records: verified.recordsVerified,
    rejected: ["changed contribution", "changed policy", "changed recognition", "different chain snapshot"],
  });
  const securityQuote = await call(
    "/api/quote?repo=fixture/security&login=contributor",
  );
  assert.equal(securityQuote.credits, 1);
  assert.equal(securityQuote.amount, 1);
  report.cases.push({
    name: "Real EAS records change local/direct/two-hop pricing",
    localAfterOne: afterOne.amount,
    directAfterTwo: 0,
    twoHopSecurity: securityQuote.amount,
    uids: securityQuote.recognized.map((r: any) => r.uid),
  });
  await webhook(b.repo, 43, 3, "opened");
  const exempt = await paid(b.repo, 3);
  assert.equal(exempt.state, "EXEMPT");
  assert.equal(exempt.txPost, undefined);
  const delivery = await webhook(b.repo, 43, 3, "closed", "contributor", [
    "merged",
  ]);
  const freeResult = await item(b.repo, 3);
  assert.ok(freeResult.attestation);
  assert.equal(freeResult.payment, undefined);
  await webhook(b.repo, 43, 3, "closed", "contributor", ["merged"], delivery);
  assert.equal((await item(b.repo, 3)).attestation, freeResult.attestation);
  report.cases.push({
    name: "Exempt contribution + duplicate delivery",
    attestation: freeResult.attestation,
    transaction: freeResult.txResolve,
  });
  await webhook(a.repo, 42, 4, "opened", "newcomer");
  await paid(a.repo, 4);
  await webhook(a.repo, 42, 4, "closed", "newcomer");
  assert.equal(await chain.balance(account.address), 100_000_000n);
  assert.equal((await item(a.repo, 4)).verdict, 2);
  report.cases.push({
    name: "GoodFaith close refunds",
    transaction: (await item(a.repo, 4)).txResolve,
  });
  await webhook(a.repo, 42, 5, "opened", "newcomer");
  await paid(a.repo, 5);
  await webhook(a.repo, 42, 5, "closed", "newcomer", ["gfh:spam"]);
  assert.equal(await chain.balance(pool), 5_000_000n);
  assert.equal(await chain.balance(account.address), 95_000_000n);
  assert.equal(await chain.balance(chain.adjudicator.address), 0n);
  report.cases.push({
    name: "Spam captures USDC to public pool",
    transaction: (await item(a.repo, 5)).txResolve,
    poolBalance: "5000000",
  });
  await webhook(c.repo, 44, 6, "opened", "contributor");
  await paid(c.repo, 6, 10);
  const rpcCall = async (method: string, params: unknown[]) =>
    fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  await rpcCall("evm_increaseTime", [14 * 86400 + 1]);
  await rpcCall("evm_mine", []);
  await call(`/api/items/${c.repo}/6/expire`, {});
  assert.equal((await item(c.repo, 6)).verdict, 5);
  assert.equal(await chain.balance(account.address), 95_000_000n);
  report.cases.push({
    name: "Permissionless timeout refund",
    transaction: (await item(c.repo, 6)).txResolve,
  });
  await webhook(a.repo, 42, 7, "opened", "newcomer");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/src/index.ts"],
    env: {
      ...process.env,
      GFH_API: api,
      GFH_AGENT_KEY: PAYER,
      RPC_URL: rpc,
    } as Record<string, string>,
    stderr: "pipe",
  });
  const mcp = new Client({ name: "gfh-integration", version: "1.0.0" });
  try {
    await mcp.connect(transport);
    const listed = await mcp.listTools();
    assert.ok(listed.tools.some((t) => t.name === "post_bond"));
    const exported = await mcp.callTool({ name: "export_passport", arguments: { github_login: "contributor" } });
    assert.equal(exported.isError, undefined);
    assert.equal(JSON.parse((exported.content as any[])[0].text).version, "gfh-passport/1");
    const result = await mcp.callTool({
      name: "post_bond",
      arguments: { repo: a.repo, pr_number: 7, max_amount_usdc: 20 },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal((await item(a.repo, 7)).state, "BONDED");
    await webhook(a.repo, 42, 7, "closed", "newcomer");
    report.cases.push({
      name: "MCP stdio tool → shared x402 signer → confirmed USDC bond",
      transaction: (await item(a.repo, 7)).txPost,
    });
  } finally {
    await mcp.close();
  }
  const before = service.store.records().length;
  db.exec("DELETE FROM contributions");
  service.store.setMeta(`index:${chain.operator.toLowerCase()}`, String((await chain.public.getBlockNumber()) + 1000n));
  await indexContributions(service, BigInt(deployment.deploymentBlock));
  assert.equal(service.store.records().length, before);
  report.cases.push({
    name: "Rebuild reputation from verified EAS records after restoring a chain behind its index cursor",
    records: before,
  });
  const reloaded = new Store(openDb(dbPath));
  assert.equal(reloaded.items().length, 7);
  assert.equal(reloaded.records().length, before);
  reloaded.db.close();
  const bad = await fetch(`${api}/webhooks/github`, {
    method: "POST",
    body: "{}",
    headers: { "x-hub-signature-256": "sha256=invalid" },
  });
  assert.equal(bad.status, 401);
  report.cases.push({
    name: "SQLite restart recovery and webhook signature verification",
    passed: true,
  });
  report.finalBalances = {
    payer: String(await chain.balance(account.address)),
    pool: String(await chain.balance(pool)),
    adjudicator: String(await chain.balance(chain.adjudicator.address)),
  };
  report.passed = true;
  console.log("PASS", report.cases.map((c: any) => c.name).join("\n"));
} finally {
  report.completedAt = new Date().toISOString();
  mkdirSync(new URL("../artifacts", import.meta.url), {
    recursive: true,
  });
  writeFileSync(
    new URL("../artifacts/system-integration.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
}
