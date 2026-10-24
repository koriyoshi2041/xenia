import { encodeAbiParameters, keccak256, stringToHex, zeroAddress, type Address } from "viem";
import { BASE_SEPOLIA } from "@gfh/shared";
import type { PaymentInfo } from "./escrow.ts";

export const PAYMENT_INFO_COMPONENTS = [
  { name: "operator", type: "address" }, { name: "payer", type: "address" },
  { name: "receiver", type: "address" }, { name: "token", type: "address" },
  { name: "maxAmount", type: "uint120" }, { name: "preApprovalExpiry", type: "uint48" },
  { name: "authorizationExpiry", type: "uint48" }, { name: "refundExpiry", type: "uint48" },
  { name: "minFeeBps", type: "uint16" }, { name: "maxFeeBps", type: "uint16" },
  { name: "feeReceiver", type: "address" }, { name: "salt", type: "uint256" },
] as const;

export const PAYMENT_INFO_TYPEHASH = keccak256(stringToHex(
  "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)"
));

/** Matches AuthCaptureEscrow.getHash, including chain and escrow domains. */
export function paymentInfoHash(info: PaymentInfo, chainId: number = BASE_SEPOLIA.chainId, escrow: Address = BASE_SEPOLIA.authCaptureEscrow) {
  const structHash = keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "tuple", components: PAYMENT_INFO_COMPONENTS },
  ], [PAYMENT_INFO_TYPEHASH, info]));
  return keccak256(encodeAbiParameters([
    { type: "uint256" }, { type: "address" }, { type: "bytes32" },
  ], [BigInt(chainId), escrow, structHash]));
}

export function erc3009TypedData(info: PaymentInfo, chainId: number = BASE_SEPOLIA.chainId, escrow: Address = BASE_SEPOLIA.authCaptureEscrow, collector: Address = BASE_SEPOLIA.erc3009TokenCollector) {
  return {
    domain: { name: "USDC", version: "2", chainId, verifyingContract: info.token },
    types: { ReceiveWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: info.payer, to: collector, value: info.maxAmount,
      validAfter: 0n, validBefore: BigInt(info.preApprovalExpiry),
      nonce: paymentInfoHash({ ...info, payer: zeroAddress }, chainId, escrow),
    },
  } as const;
}
