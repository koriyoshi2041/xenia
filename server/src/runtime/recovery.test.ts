import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex, zeroAddress, zeroHash, TransactionReceiptNotFoundError, type Hex } from "viem";
import { BASE_SEPOLIA, DEFAULT_POLICY, Verdict, type Contribution, type Queue } from "@gfh/shared";
import { Chain } from "../chain/client.ts";
import { syncChainState } from "../chain/indexer.ts";
import { buildPaymentInfo } from "../chain/escrow.ts";
import { paymentInfoHash } from "../chain/authorization.ts";
import type { GitHubGateway } from "../github/client.ts";
import { openDb } from "../db/index.ts";
import { Store } from "./store.ts";
import { Service } from "./service.ts";
import { createHttp } from "./http.ts";
import type { Item } from "./model.ts";

function fixture() {
  const db = openDb(":memory:");
  const store = new Store(db);
  const queue: Queue = {
    id: toHex(1, { size: 32 }), repo: "fixture/recovery", repoId: 1,
    kind: "pull_requests", adjudicator: zeroAddress, pool: zeroAddress,
    reviewWindow: 86400, policy: { ...DEFAULT_POLICY, youngAccount: [] },
    trusts: [], acceptedKinds: ["pull_requests"], githubHistory: false, minStars: 10,
  };
  store.saveQueue(queue);
  const checks: boolean[] = [];
  const receipts = new Map<Hex, "success" | "reverted">();
  let settled: Contribution | undefined;
  let settlements = 0;
  let deadline = 10000n;
  const chain = {
    operator: zeroAddress,
    public: {
      async getBlock() { return { timestamp: 1000n }; },
      async getBlockNumber() { return 1n; },
      async getLogs() { return []; },
      async getTransactionReceipt({ hash }: { hash: Hex }) {
        const status = receipts.get(hash);
        if (!status) throw new TransactionReceiptNotFoundError({ hash });
        return { transactionHash: hash, status };
      },
      async readContract() { return [0, 0, 0, deadline, 0, 0, false]; },
    },
    receipt: Chain.prototype.receipt,
    async confirmed() { throw new Error("Recovery must not wait for mining"); },
    async post() { throw new Error("Recovery must not submit another deposit"); },
    async resolve(payment: Item["payment"], ref: Item["ref"], verdict: number,
      _slash: number, _reason: number, _evidence: Hex, onSent: (tx: Hex) => void) {
      settlements++;
      const tx = toHex(100 + settlements, { size: 32 });
      settled = {
        uid: toHex(200 + settlements, { size: 32 }), queueId: ref.queueId,
        repoId: queue.repoId, itemNumber: Number(ref.itemNumber), githubUserId: Number(ref.githubUserId),
        kind: "pull_requests", verdict, reasonCode: 0, bondAmount: String(payment?.maxAmount ?? 0n),
        slashedAmount: "0", evidenceHash: zeroHash, paymentInfoHash: payment ? paymentInfoHash(payment) : zeroHash,
        recipient: zeroAddress, blockNumber: "1", txHash: tx,
      };
      onSent(tx);
      return { transactionHash: tx, status: "success" };
    },
    async records() { return [settled!]; },
    async expire(payment: NonNullable<Item["payment"]>, ref: Item["ref"], onSent: (tx: Hex) => void) {
      return chain.resolve(payment, ref, Verdict.Timeout, 0, 0, zeroHash, onSent);
    },
  } as unknown as Chain;
  const github: GitHubGateway = {
    async user() { return { id: 77, createdAt: "2020-01-01T00:00:00Z" }; },
    async signals() { return { write: false, merged: [] }; },
    async pull() { throw new Error("Unexpected pull fetch"); },
    async check(_pr, admitted) { checks.push(admitted); },
  };
  const restart = () => new Service(new Store(db), chain, github, "http://localhost");
  const seed = (number = 1) => {
    const item: Item = {
      queueId: queue.id, state: "AWAITING_BOND",
      pr: { repo: queue.repo, repoId: queue.repoId, number, authorId: 77,
        authorLogin: "contributor", headSha: "abc", state: "open", merged: false, labels: [],
        url: `https://github.com/${queue.repo}/pull/${number}` },
      ref: { queueId: queue.id, itemNumber: BigInt(number), githubUserId: 77n, claimedSeverity: 0, nonce: BigInt(number) },
      quote: { amount: 5, exempt: false, blocked: false, reasons: [] },
      txPost: toHex(number, { size: 32 }),
    };
    item.payment = buildPaymentInfo({ operator: zeroAddress, payer: zeroAddress, pool: zeroAddress,
      token: BASE_SEPOLIA.usdc, amount: 5_000_000n, ref: item.ref, now: 1, reviewWindowSec: queue.reviewWindow });
    store.saveItem(item);
    return item;
  };
  return { db, store, queue, checks, receipts, restart, seed, settlements: () => settlements,
    setDeadline(value: bigint) { deadline = value; } };
}

test("startup reconciliation recovers a mined deposit without another payment or signature", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const original = f.seed();
  f.receipts.set(original.txPost!, "success");
  const service = f.restart();
  await syncChainState(service, 0n);
  const recovered = service.item(f.queue.repo, 1);
  assert.equal(recovered.state, "BONDED");
  assert.equal(recovered.paymentHash, paymentInfoHash(original.payment!));
  assert.equal(recovered.txPost, original.txPost);
  assert.ok(recovered.admittedAt);
  assert.deepEqual(service.reviewQueue().map((i) => i.pr.number), [1]);
  assert.deepEqual(f.checks, [true]);
  await syncChainState(service, 0n);
  assert.deepEqual(f.checks, [true]);
});

test("a payment request recovers an expired challenge's mined deposit and returns 200", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const original = f.seed();
  f.receipts.set(original.txPost!, "success");
  const app = createHttp(f.restart(), { adminToken: "test", webhookSecret: "test", mode: "test" });
  const response = await app.request(`/api/bonds/${f.queue.repo}/1`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "BONDED");
  assert.equal(response.headers.get("PAYMENT-REQUIRED"), null);
});

test("an unmined deposit does not block reconciliation of other contributions", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const pending = f.seed(1);
  const mined = f.seed(2);
  f.receipts.set(mined.txPost!, "success");
  const service = f.restart();
  await syncChainState(service, 0n);
  assert.equal(service.item(f.queue.repo, 1).state, "AWAITING_BOND");
  assert.equal(service.item(f.queue.repo, 1).txPost, pending.txPost);
  assert.equal(service.item(f.queue.repo, 2).state, "BONDED");
});

test("a reverted deposit can obtain a fresh payment challenge", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const original = f.seed();
  f.receipts.set(original.txPost!, "reverted");
  const service = f.restart();
  await syncChainState(service, 0n);
  const item = service.item(f.queue.repo, 1);
  assert.equal(item.txPost, undefined);
  await service.challenge(item, zeroAddress);
  assert.ok(item.payment!.preApprovalExpiry > 1000);
  assert.equal(item.state, "AWAITING_BOND");
});

test("a PR closed while its deposit was pending is recovered and settled once", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const original = f.seed();
  const service = f.restart();
  await service.ingest({ ...original.pr, state: "closed" });
  assert.equal(service.item(f.queue.repo, 1).state, "CLOSED_UNBONDED");
  f.receipts.set(original.txPost!, "success");
  await syncChainState(service, 0n);
  await syncChainState(service, 0n);
  const result = service.item(f.queue.repo, 1);
  assert.equal(result.state, "RESOLVED");
  assert.equal(result.verdict, Verdict.GoodFaith);
  assert.equal(f.store.records().length, 1);
  assert.equal(f.settlements(), 1);
});

test("a reopened settled PR gets a fresh quote and reference while retaining prior proofs", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const original = f.seed();
  f.receipts.set(original.txPost!, "success");
  const service = f.restart();
  const closed = await service.ingest({ ...original.pr, state: "closed" });
  assert.equal(closed.state, "RESOLVED");
  const records = f.store.records();
  f.store.saveQueue({ ...f.queue, policy: { ...f.queue.policy, baseBond: 3 } });
  const reopened = await service.ingest(original.pr);
  assert.equal(reopened.state, "AWAITING_BOND");
  assert.equal(reopened.quote.amount, 3);
  assert.notEqual(reopened.ref.nonce, original.ref.nonce);
  for (const field of ["txPost", "txResolve", "payment", "paymentHash", "attestation", "verdict", "admittedAt"] as const)
    assert.equal(reopened[field], undefined);
  assert.equal(reopened.previousRounds?.[0]?.attestation, closed.attestation);
  assert.equal(reopened.previousRounds?.[0]?.quote.amount, 5);
  assert.deepEqual(f.store.records(), records);
  assert.equal(f.checks.at(-1), false);
  assert.equal(service.reviewQueue().length, 0);
  const synced = await service.ingest(original.pr);
  assert.equal(synced.ref.nonce, reopened.ref.nonce);
  assert.equal(synced.previousRounds?.length, 1);
  await service.ingest({ ...original.pr, state: "closed" });
  f.store.saveQueue({ ...f.queue, policy: { ...f.queue.policy, baseBond: 0 } });
  const exempt = await service.ingest(original.pr);
  assert.equal(exempt.state, "EXEMPT");
  assert.equal(service.reviewQueue().length, 1);
  assert.equal(exempt.previousRounds?.length, 2);
  assert.equal(f.checks.at(-1), true);
});

test("recovery after the review deadline refunds through timeout and keeps an open round terminal", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const original = f.seed();
  f.receipts.set(original.txPost!, "success");
  f.setDeadline(999n);
  const service = f.restart();
  await syncChainState(service, 0n);
  const synced = await service.ingest(original.pr);
  assert.equal(synced.state, "RESOLVED");
  assert.equal(synced.verdict, Verdict.Timeout);
  assert.equal(synced.ref.nonce, original.ref.nonce);
  assert.equal(synced.previousRounds, undefined);
  assert.equal(f.settlements(), 1);
});

test("reopening while a deposit is still pending retains its payment reference", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const original = f.seed();
  const service = f.restart();
  await service.ingest({ ...original.pr, state: "closed" });
  const reopened = await service.ingest(original.pr);
  assert.equal(reopened.ref.nonce, original.ref.nonce);
  assert.equal(reopened.txPost, original.txPost);
  f.receipts.set(original.txPost!, "success");
  await syncChainState(service, 0n);
  assert.equal(service.item(f.queue.repo, 1).state, "BONDED");
  assert.equal(f.settlements(), 0);
});

test("a zero-bond policy admits a new contribution without returning a payment challenge", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.saveQueue({ ...f.queue, policy: { ...f.queue.policy, baseBond: 0 } });
  const original = f.seed();
  const service = f.restart();
  const exempt = await service.ingest({ ...original.pr, number: 2 });
  assert.equal(exempt.state, "EXEMPT");
  const app = createHttp(service, { adminToken: "test", webhookSecret: "test", mode: "test" });
  const response = await app.request(`/api/bonds/${f.queue.repo}/2`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).quote.exempt, true);
  assert.equal(response.headers.get("PAYMENT-REQUIRED"), null);
});
