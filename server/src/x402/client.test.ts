import assert from "node:assert/strict";
import { test } from "node:test";
import { toAccount } from "viem/accounts";
import { BASE_SEPOLIA, postBond } from "@gfh/shared";

const account = toAccount("0x1111111111111111111111111111111111111111");
const required = {
  x402Version: 2,
  resource: { url: "https://example.test/bond/1", description: "可退押金" },
  accepts: [{ scheme: "auth-capture", network: BASE_SEPOLIA.network,
    asset: BASE_SEPOLIA.usdc, amount: "5000000" }],
  extensions: { "gfh-contribution": { info: { paymentInfo: {} } } },
};

test("the x402 client reads header-only requirements and enforces its budget before signing", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () => new Response(null, {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") },
  }));
  await assert.rejects(() => postBond({ api: "https://example.test", repo: "a/b", number: 1,
    account, maxAmountUsdc: 1 }), /exceeds agent spending limit/);
  assert.equal(request.mock.callCount(), 1);
});

test("the x402 client uses the canonical header when the optional body differs", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    ...required, accepts: [{ ...required.accepts[0], amount: "0" }],
  }), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") },
  }));
  await assert.rejects(() => postBond({ api: "https://example.test", repo: "a/b", number: 1,
    account, maxAmountUsdc: 1 }), /exceeds agent spending limit/);
});
