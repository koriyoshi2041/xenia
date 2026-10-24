// Read-only comparison against the deployed Base Sepolia escrow. Sends no transaction.
import assert from "node:assert/strict";
import { createPublicClient, http, zeroAddress } from "viem";
import { BASE_SEPOLIA } from "@gfh/shared";
import { buildPaymentInfo } from "../server/src/chain/escrow.ts";
import { PAYMENT_INFO_COMPONENTS, erc3009TypedData, paymentInfoHash } from "../server/src/chain/authorization.ts";

const info = buildPaymentInfo({
  operator: "0x2222222222222222222222222222222222222222",
  payer: "0x1111111111111111111111111111111111111111",
  pool: "0x3333333333333333333333333333333333333333",
  token: BASE_SEPOLIA.usdc, amount: 5_000_000n, now: 1_800_000_000, reviewWindowSec: 14 * 86400,
  ref: { queueId: "0x" + "44".repeat(32) as `0x${string}`, itemNumber: 42n, githubUserId: 7n, claimedSeverity: 0, nonce: 1n },
});
const client = createPublicClient({ transport: http(BASE_SEPOLIA.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
const abi = [{ type: "function", name: "getHash", stateMutability: "view", inputs: [{ name: "paymentInfo", type: "tuple", components: PAYMENT_INFO_COMPONENTS }], outputs: [{ type: "bytes32" }] }] as const;
const blockNumber = await client.getBlockNumber();
const [realPayer, noPayer] = await Promise.all([info, { ...info, payer: zeroAddress }].map(paymentInfo => client.readContract({
  address: BASE_SEPOLIA.authCaptureEscrow, abi, functionName: "getHash", args: [paymentInfo], blockNumber,
})));
assert.equal(realPayer, paymentInfoHash(info));
assert.equal(noPayer, erc3009TypedData(info).message.nonce);
console.log(JSON.stringify({
  mode: "read-only", chainId: BASE_SEPOLIA.chainId, escrow: BASE_SEPOLIA.authCaptureEscrow,
  blockNumber: blockNumber.toString(), paymentInfoHash: realPayer, authorizationNonce: noPayer,
  result: "Both local hashes match deployed AuthCaptureEscrow.getHash",
}, null, 2));
