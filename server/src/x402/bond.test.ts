import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_SEPOLIA } from "@gfh/shared";
import { buildPaymentInfo } from "../chain/escrow.ts";
import { encodePaymentHeader, paymentRequirements } from "./bond.ts";

test("402 negotiation describes deferred escrow and retains the resource outside accepts", () => {
  const address = "0x1111111111111111111111111111111111111111";
  const info = buildPaymentInfo({ operator: address, payer: address, pool: address, token: BASE_SEPOLIA.usdc, amount: 5_000_000n, now: 1_800_000_000, reviewWindowSec: 14 * 86400,
    ref: { queueId: "0x" + "22".repeat(32) as `0x${string}`, itemNumber: 1n, githubUserId: 2n, claimedSeverity: 0, nonce: 3n } });
  const required = paymentRequirements(info, info.maxAmount, "https://example.test/bond/1");
  const decoded = JSON.parse(Buffer.from(encodePaymentHeader(required), "base64").toString());
  assert.equal(decoded.resource.url, "https://example.test/bond/1");
  assert.equal(decoded.accepts[0].extra.paymentFlow, "escrow");
  assert.equal(decoded.accepts[0].extra.captureMode, "deferred");
  assert.equal(decoded.accepts[0].resource, undefined);
  assert.equal(decoded.accepts[0].amount, "5000000");
  assert.equal(decoded.accepts[0].payTo, info.receiver);
  assert.throws(() => paymentRequirements(info, 1n, "https://example.test"), /full quoted amount/);
});
