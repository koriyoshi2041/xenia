import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
const api = process.env.GFH_API ?? "http://localhost:8787";
const request = async (path: string, method = "GET", value?: unknown) => {
  const r = await fetch(api + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GFH_ADMIN_TOKEN}`,
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const result = (await r.json()) as any;
  if (!r.ok) throw new Error(result.error ?? `HTTP ${r.status}`);
  return result;
};
const keys = JSON.parse(
  readFileSync(
    process.env.COMMUNITY_KEYS_PATH ?? "secrets/communities.json",
    "utf8",
  ),
);
const names = Object.keys(keys);
const existing = (await request("/api/queues")).queues;
for (const repo of names) {
  if (existing.some((q: any) => q.repo === repo)) continue;
  const metadata = JSON.parse(
    execFileSync("gh", ["api", `repos/${repo}`], { encoding: "utf8" }),
  );
  const q = await request("/api/queues", "POST", {
    repo,
    repoId: metadata.id,
    pool: process.env.POOL_ADDRESS,
    adjudicator: privateKeyToAccount(keys[repo]).address,
    githubHistory: false,
  });
  console.log(`Registered ${repo}: ${q.id}`);
}
const queues = (await request("/api/queues")).queues;
if (process.argv[2] === "policy") {
  const q = queues.find((q: any) => q.repo === process.argv[3]);
  if (!q)
    throw new Error("Supply a registered repository and a JSON policy file");
  const patch = JSON.parse(readFileSync(process.argv[4]!, "utf8"));
  const challenge = await request(
    `/api/queues/${q.id}/policy-challenge`,
    "POST",
    patch,
  );
  const signature = await privateKeyToAccount(keys[q.repo]).signTypedData(
    challenge.typedData,
  );
  const result = await request(`/api/queues/${q.id}/policy`, "PATCH", {
    ...challenge,
    signature,
  });
  console.log(
    `Policy revision ${result.policyRevision} signed by ${result.adjudicator}`,
  );
} else {
  const [a, b] = names.map((name) => queues.find((q: any) => q.repo === name));
  if (a && b && !b.policyRevision) {
    const challenge = await request(
      `/api/queues/${b.id}/policy-challenge`,
      "POST",
      { trusts: [{ queueId: a.id, weight: 1 }] },
    );
    const signature = await privateKeyToAccount(keys[b.repo]).signTypedData(
      challenge.typedData,
    );
    await request(`/api/queues/${b.id}/policy`, "PATCH", {
      ...challenge,
      signature,
    });
    console.log(`${b.repo} signed recognition of ${a.repo}`);
  }
}
