import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toHex, zeroAddress, zeroHash } from "viem";
import { DEFAULT_POLICY, Verdict, type Queue } from "@gfh/shared";
import type { Chain } from "../chain/client.ts";
import type { GitHubGateway } from "../github/client.ts";
import { openDb } from "../db/index.ts";
import { Store } from "./store.ts";
import { Service } from "./service.ts";
import { createHttp } from "./http.ts";
import type { Item } from "./model.ts";

function fixture() {
  const db = openDb(":memory:");
  const store = new Store(db);
  const source: Queue = {
    id: toHex(1, { size: 32 }), repo: "tools/amounts", repoId: 1,
    kind: "pull_requests", adjudicator: zeroAddress,
    pool: `0x${"11".repeat(20)}`, reviewWindow: 86400,
    policy: { ...DEFAULT_POLICY, youngAccount: [] },
    trusts: [], acceptedKinds: ["pull_requests"], githubHistory: false,
    minStars: 10, policyRevision: 1,
  };
  const target: Queue = {
    ...source, id: toHex(2, { size: 32 }), repo: "tools/budgets", repoId: 2,
  };
  store.saveQueue(source);
  store.saveQueue(target);
  for (const [index, verdict] of [Verdict.Accepted, Verdict.Accepted, Verdict.GoodFaith].entries())
    store.saveRecord({
      uid: toHex(100 + index, { size: 32 }), queueId: source.id,
      repoId: source.repoId, itemNumber: index + 1, githubUserId: 77,
      kind: "pull_requests", verdict, reasonCode: 0,
      bondAmount: "5000000", slashedAmount: "0", evidenceHash: zeroHash,
      paymentInfoHash: zeroHash, recipient: zeroAddress,
      blockNumber: "1", txHash: zeroHash,
    });
  const github: GitHubGateway = {
    async user() { return { id: 77, createdAt: "2020-01-01T00:00:00Z" }; },
    async signals() { return { write: false, merged: [] }; },
    async pull() { throw new Error("Preparation must not create or sync a PR"); },
    async check() { throw new Error("Preparation must not write a GitHub check"); },
  };
  const service = new Service(store, {} as Chain, github, "http://localhost");
  const app = createHttp(service, { adminToken: "test", webhookSecret: "test", mode: "test" });
  const addItem = (number: number, state: Item["state"], amount: number, pr: Partial<Item["pr"]> = {}) => {
    const item: Item = {
      queueId: target.id, state,
      admittedAt: `2026-10-24T01:00:0${number}.000Z`,
      pr: {
        repo: target.repo, repoId: target.repoId, number, authorId: 77,
        authorLogin: "contributor", headSha: "abc", state: "open",
        url: `https://github.com/${target.repo}/pull/${number}`,
        merged: false, draft: false, labels: [], ...pr,
      },
      ref: { queueId: target.id, itemNumber: BigInt(number), githubUserId: 77n, claimedSeverity: 0, nonce: BigInt(number) },
      quote: { amount, exempt: state === "EXEMPT", blocked: false, reasons: [] },
    };
    store.saveItem(item);
  };
  return { db, store, source, target, app, addItem };
}

test("pre-submission participation follows the target's recognition policy and leaves contributions untouched", async (t) => {
  const { db, store, source, target, app } = fixture();
  t.after(() => db.close());
  const records = store.records();
  const read = async () => {
    const response = await app.request(`/api/participation?repo=${target.repo}&login=contributor`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const unfamiliar = await read();
  assert.equal(unfamiliar.admission, "bond_required");
  assert.equal(unfamiliar.quote.amount, 5);
  assert.equal(unfamiliar.quote.credits, 0);
  assert.equal(unfamiliar.commitment.publicPool, target.pool);
  assert.equal(unfamiliar.commitment.reviewWindowSeconds, target.reviewWindow);
  assert.equal(unfamiliar.commitment.outcomes.GoodFaith.funds, "full_refund");
  assert.equal(unfamiliar.commitment.outcomes.GoodFaith.recognition, "history_only");

  store.saveQueue({ ...target, policyRevision: 2, trusts: [{ queueId: source.id, weight: 0.5 }] });
  const partlyRecognized = await read();
  assert.equal(partlyRecognized.quote.amount, 0.5);
  assert.equal(partlyRecognized.quote.credits, 1);
  assert.deepEqual(partlyRecognized.quote.recognized[0].path, [target.id, source.id]);

  store.saveQueue({ ...target, policyRevision: 3, trusts: [{ queueId: source.id, weight: 1 }] });
  const recognized = await read();
  assert.equal(recognized.admission, "exempt");
  assert.equal(recognized.quote.credits, 2);
  assert.equal(recognized.community.policyRevision, 3);
  assert.equal(recognized.quote.amount, 0);
  assert.deepEqual(store.items(), []);
  assert.deepEqual(store.records(), records);
});

test("the declared review queue orders eligible contributions by admission time, independently of bond size", async (t) => {
  const { db, app, target, addItem } = fixture();
  t.after(() => db.close());
  addItem(2, "BONDED", 50);
  addItem(1, "EXEMPT", 0);
  addItem(3, "AWAITING_BOND", 5);
  addItem(4, "BONDED", 5, { draft: true });
  addItem(5, "BONDED", 5, { state: "closed" });
  const brief = await (await app.request(`/api/participation?repo=${target.repo}&login=contributor`)).json();
  const queue = await (await app.request(brief.review.endpoint)).json();
  assert.equal(brief.review.order, "admitted_at");
  assert.deepEqual(queue.items.map((item: Item) => item.pr.number), [1, 2]);
});

test("MCP exposes participation preparation and the same admitted queue without wallet credentials", async (t) => {
  const { db, store, app, target, addItem } = fixture();
  t.after(() => db.close());
  addItem(1, "EXEMPT", 0);
  const originalItems = store.items();
  const httpServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  if (!httpServer.listening) await once(httpServer, "listening");
  t.after(() => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const client = new Client({ name: "participation-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../../mcp/src/index.ts", import.meta.url))],
    env: { GFH_API: `http://127.0.0.1:${address.port}` },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  const brief = await client.callTool({ name: "prepare_contribution", arguments: { repo: target.repo, github_login: "contributor" } });
  assert.ok(Array.isArray(brief.content) && brief.content[0].type === "text");
  assert.equal(JSON.parse(brief.content[0].text).admission, "bond_required");
  const queue = await client.callTool({ name: "get_review_queue", arguments: { repo: target.repo } });
  assert.ok(Array.isArray(queue.content) && queue.content[0].type === "text");
  assert.deepEqual(JSON.parse(queue.content[0].text).items.map((item: Item) => item.pr.number), [1]);
  assert.deepEqual(store.items(), originalItems);
});
