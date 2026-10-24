import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY, quote, type Signals } from "@gfh/shared";

const stranger: Signals = {
  isInfraBot: false,
  hasWriteAccess: false,
  vouched: false,
  denounced: false,
  records: 0,
  recentSlashes: 0,
  accountAgeDays: 1000,
  openInQueue: 0,
};

test("maintainers, bots and vouched people never pay", () => {
  for (const s of [{ isInfraBot: true }, { hasWriteAccess: true }, { vouched: true }]) {
    assert.equal(quote({ ...stranger, ...s }).amount, 0);
  }
});

test("two records exempt, one record is a tenth, none is base", () => {
  assert.equal(quote({ ...stranger, records: 2 }).amount, 0);
  assert.equal(quote({ ...stranger, records: 1 }).amount, 0.5);
  assert.equal(quote(stranger).amount, DEFAULT_POLICY.baseBond);
});

test("a fresh account costs 4x, a half-year-old one 2x", () => {
  assert.equal(quote({ ...stranger, accountAgeDays: 3 }).amount, 20);
  assert.equal(quote({ ...stranger, accountAgeDays: 90 }).amount, 10);
});

test("bulk pipelines pay more per PR once they keep several open", () => {
  assert.equal(quote({ ...stranger, openInQueue: 2 }).amount, 5);
  assert.equal(quote({ ...stranger, openInQueue: 3 }).amount, 10);
});

test("slashes compound up to the cap and cancel the record exemption", () => {
  assert.equal(quote({ ...stranger, records: 5, recentSlashes: 1 }).amount, 1); // 5 × 0.1 × 2
  assert.equal(quote({ ...stranger, recentSlashes: 5 }).amount, 40); // capped at ×8
});

test("denounced is pricier by default, or blocked if the repo says so", () => {
  assert.equal(quote({ ...stranger, denounced: true }).amount, 20);
  assert.equal(quote({ ...stranger, denounced: true }, { ...DEFAULT_POLICY, denounced: "block" }).blocked, true);
});

test("zero base, multiplier and rounded amounts exempt without overriding a policy block", () => {
  for (const policy of [
    { ...DEFAULT_POLICY, baseBond: 0 },
    { ...DEFAULT_POLICY, oneRecordMultiplier: 0 },
    { ...DEFAULT_POLICY, baseBond: 0.001 },
  ]) {
    const result = quote({ ...stranger, records: 1 }, policy);
    assert.equal(result.amount, 0);
    assert.equal(result.exempt, true);
    assert.equal(result.reasons.at(-1)?.rule, "zero_bond");
  }
  const blocked = quote({ ...stranger, denounced: true }, { ...DEFAULT_POLICY, baseBond: 0, denounced: "block" });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.exempt, false);
});
