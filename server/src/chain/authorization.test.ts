import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverTypedDataAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA } from "@gfh/shared";
import { buildPaymentInfo } from "./escrow.ts";
import { erc3009TypedData, paymentInfoHash } from "./authorization.ts";

// Public test fixture key; never funded or used to submit transactions.
const account = privateKeyToAccount("0x" + "11".repeat(32) as `0x${string}`);
const info = buildPaymentInfo({
  operator: "0x2222222222222222222222222222222222222222", payer: account.address,
  pool: "0x3333333333333333333333333333333333333333", token: BASE_SEPOLIA.usdc,
  amount: 5_000_000n, now: 1_800_000_000, reviewWindowSec: 14 * 86400,
  ref: { queueId: "0x" + "44".repeat(32) as `0x${string}`, itemNumber: 42n, githubUserId: 7n, claimedSeverity: 0, nonce: 1n },
});

test("ERC-3009 signs the canonical collector and a payer-agnostic escrow commitment", async () => {
  const typed = erc3009TypedData(info);
  assert.equal(typed.message.to, BASE_SEPOLIA.erc3009TokenCollector);
  assert.equal(typed.message.value, info.maxAmount);
  assert.equal(typed.message.nonce, paymentInfoHash({ ...info, payer: zeroAddress }));
  const signature = await account.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature }), account.address);
  assert.notEqual(await recoverTypedDataAddress({ ...typed, message: { ...typed.message, value: 6_000_000n }, signature }), account.address);
});

test("payment identity commits to the receiver, contribution reference, chain and escrow", () => {
  const hash = paymentInfoHash(info);
  assert.notEqual(hash, paymentInfoHash({ ...info, receiver: zeroAddress }));
  assert.notEqual(hash, paymentInfoHash({ ...info, salt: info.salt + 1n }));
  assert.notEqual(hash, paymentInfoHash(info, 8453));
  assert.notEqual(hash, paymentInfoHash(info, 84532, zeroAddress));
  assert.notEqual(hash, paymentInfoHash({ ...info, payer: zeroAddress }));
});
