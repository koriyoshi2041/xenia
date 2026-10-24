import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex, zeroAddress, zeroHash } from "viem";
import {
  DEFAULT_POLICY, Verdict, quote, trustedRecords,
  type Queue, type Contribution, type Signals,
} from "@gfh/shared";

function community(n: number, patch: Partial<Queue> = {}): Queue {
  return {
    id: toHex(n, { size: 32 }), repo: `community/repo-${n}`, repoId: n,
    kind: "pull_requests", adjudicator: zeroAddress, pool: zeroAddress,
    reviewWindow: 86400, policy: DEFAULT_POLICY, trusts: [],
    acceptedKinds: ["pull_requests"], githubHistory: false, minStars: 10,
    ...patch,
  };
}
function record(q: Queue, n = 1, patch: Partial<Contribution> = {}): Contribution {
  return {
    uid: toHex(n, { size: 32 }), queueId: q.id, repoId: q.repoId,
    itemNumber: n, githubUserId: 77, kind: q.kind, verdict: Verdict.Accepted,
    reasonCode: 0, bondAmount: "0", slashedAmount: "0",
    evidenceHash: zeroHash, paymentInfoHash: zeroHash, recipient: zeroAddress,
    recordedAt: 1_700_000_000, blockNumber: "1", txHash: zeroHash,
    ...patch,
  };
}

test("recognition is directional, attenuates two hops and stops before a third", () => {
  const a = community(1);
  const b = community(2, { trusts: [{ queueId: a.id, weight: 0.8 }] });
  const c = community(3, { trusts: [{ queueId: b.id, weight: 0.5 }] });
  const d = community(4, { trusts: [{ queueId: c.id, weight: 1 }] });
  const network = [a, b, c, d];
  const proof = record(a);
  assert.equal(trustedRecords(a, network, [proof])[0]?.weight, 1);
  assert.equal(trustedRecords(b, network, [proof])[0]?.weight, 0.8);
  assert.deepEqual(trustedRecords(c, network, [proof]).map(({ weight, path }) => ({ weight, path })), [
    { weight: 0.2, path: [c.id, b.id, a.id] },
  ]);
  assert.deepEqual(trustedRecords(d, network, [proof]), []);
  assert.deepEqual(trustedRecords(a, network, [record(b)]), []);
});

test("alternate paths recognize each attestation once at the strongest weight", () => {
  const a = community(1);
  const b = community(2, { trusts: [{ queueId: a.id, weight: 1 }] });
  const c = community(3, { trusts: [
    { queueId: a.id, weight: 0.2 }, { queueId: b.id, weight: 1 },
  ] });
  const recognized = trustedRecords(c, [a, b, c], [record(a)]);
  assert.equal(recognized.length, 1);
  assert.equal(recognized[0]?.weight, 0.5);
  assert.deepEqual(recognized[0]?.path, [c.id, b.id, a.id]);
});

test("target and intermediary communities must accept the contribution kind", () => {
  const a = community(1, { kind: "security_reports", acceptedKinds: ["security_reports"] });
  const b = community(2, { trusts: [{ queueId: a.id, weight: 1 }] });
  const c = community(3, {
    acceptedKinds: ["security_reports"], trusts: [{ queueId: b.id, weight: 1 }],
  });
  const proof = record(a);
  assert.deepEqual(trustedRecords(b, [a, b, c], [proof]), []);
  assert.deepEqual(trustedRecords(c, [a, b, c], [proof]), []);
  const acceptsReports = { ...b, acceptedKinds: a.acceptedKinds };
  assert.equal(trustedRecords(c, [a, acceptsReports, c], [proof])[0]?.weight, 0.5);
});

test("changing B's policy changes its quote while preserving A's facts and quote", () => {
  const a = community(1);
  const b = community(2, { trusts: [{ queueId: a.id, weight: 1 }] });
  const facts = [record(a), record(a, 2), record(a, 3, { verdict: Verdict.GoodFaith })];
  const snapshot = structuredClone(facts);
  const signals: Signals = {
    isInfraBot: false, hasWriteAccess: false, vouched: false, denounced: false,
    records: 0, recentSlashes: 0, accountAgeDays: 1000, openInQueue: 0,
  };
  const price = (target: Queue, queues: Queue[]) => quote({
    ...signals,
    records: trustedRecords(target, queues, facts)
      .filter((r) => r.verdict === Verdict.Accepted)
      .reduce((sum, r) => sum + r.weight, 0),
  }, target.policy).amount;
  const independentB = { ...b, trusts: [] };
  assert.deepEqual([
    price(b, [a, b]), price(independentB, [a, independentB]), price(b, [a, b]),
  ], [0, 5, 0]);
  assert.equal(price(a, [a, independentB]), 0);
  assert.deepEqual(facts, snapshot);
  assert.equal(trustedRecords(b, [a, b], facts).length, 3);
});
