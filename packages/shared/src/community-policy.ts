import { keccak256, stringToHex, type Address, type Hex } from "viem";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function communityPolicyTypedData(
  operator: Address,
  queueId: Hex,
  document: unknown,
  revision: number,
  expiresAt: number,
) {
  return {
    domain: {
      name: "Gas for Humans Community",
      version: "1",
      chainId: 84532,
      verifyingContract: operator,
    },
    primaryType: "CommunityPolicy",
    types: {
      CommunityPolicy: [
        { name: "queueId", type: "bytes32" },
        { name: "policyHash", type: "bytes32" },
        { name: "revision", type: "uint256" },
        { name: "expiresAt", type: "uint48" },
      ],
    },
    message: {
      queueId,
      policyHash: keccak256(stringToHex(canonicalJson(document))),
      revision: BigInt(revision),
      expiresAt,
    },
  } as const;
}
