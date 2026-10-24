// Payment identity and contribution binding. Transaction execution lives in client.ts.
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { BondRef } from "@gfh/shared";

export interface PaymentInfo {
  operator: Address;
  payer: Address;
  receiver: Address; // always the queue's pool
  token: Address;
  maxAmount: bigint;
  preApprovalExpiry: number;
  authorizationExpiry: number; // > posted + review window; payer can reclaim after this
  refundExpiry: number; // must be >= authorizationExpiry
  minFeeBps: 0;
  maxFeeBps: 0;
  feeReceiver: Address;
  salt: bigint; // uint256(keccak256(abi.encode(ref)))
}

const BOND_REF_ABI = [
  {
    type: "tuple",
    components: [
      { name: "queueId", type: "bytes32" },
      { name: "itemNumber", type: "uint64" },
      { name: "githubUserId", type: "uint64" },
      { name: "claimedSeverity", type: "uint8" },
      { name: "nonce", type: "uint96" },
    ],
  },
] as const;

/** Salt that commits the payer's signature to one PR / report. Must equal the contract's check. */
export function saltFor(ref: BondRef): bigint {
  const encoded: Hex = encodeAbiParameters(BOND_REF_ABI, [ref]);
  return BigInt(keccak256(encoded));
}

export function buildPaymentInfo(args: {
  operator: Address;
  payer: Address;
  pool: Address;
  token: Address;
  amount: bigint;
  ref: BondRef;
  now: number;
  reviewWindowSec: number;
}): PaymentInfo {
  const authorizationExpiry = args.now + args.reviewWindowSec * 2; // e.g. 14d window → 28d hard expiry
  return {
    operator: args.operator,
    payer: args.payer,
    receiver: args.pool,
    token: args.token,
    maxAmount: args.amount,
    preApprovalExpiry: args.now + 300,
    authorizationExpiry,
    refundExpiry: authorizationExpiry,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: args.pool,
    salt: saltFor(args.ref),
  };
}
