import {
  createPublicClient,
  http,
  parseAbi,
  toHex,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { BASE_SEPOLIA } from "./addresses.ts";

const encodePayment = (value: string) =>
  typeof Buffer !== "undefined"
    ? Buffer.from(value).toString("base64")
    : btoa(
        Array.from(new TextEncoder().encode(value), (b) =>
          String.fromCharCode(b),
        ).join(""),
      );
const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const decodePayment = (value: string) =>
  JSON.parse(
    typeof Buffer !== "undefined"
      ? Buffer.from(value, "base64").toString("utf8")
      : new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))),
  );
/** GFH-aware x402 client. The caller supplies a signing account and an explicit spending limit. */
export async function postBond(options: {
  api: string;
  repo: string;
  number: number;
  account: Account;
  maxAmountUsdc: number;
  rpcUrl?: string;
  agentId?: string;
}) {
  const { api, repo, number, account } = options;
  const url = `${api}/api/bonds/${repo}/${number}`;
  const challenge = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: json({ payer: account.address, agentId: options.agentId }),
  });
  if (challenge.status !== 402) {
    if (!challenge.ok) throw new Error(await challenge.text());
    return challenge.json();
  }
  // x402 HTTP places the authoritative requirements in this header; the body is optional.
  const header = challenge.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("Missing PAYMENT-REQUIRED header");
  const required = decodePayment(header);
  const accepted = required.accepts?.[0];
  const info = required.extensions?.["gfh-contribution"]?.info?.paymentInfo;
  if (
    !info ||
    accepted?.network !== BASE_SEPOLIA.network ||
    accepted?.scheme !== "auth-capture" ||
    accepted?.asset.toLowerCase() !== BASE_SEPOLIA.usdc.toLowerCase()
  )
    throw new Error("Unsupported payment challenge");
  if (BigInt(accepted.amount) > BigInt(Math.floor(options.maxAmountUsdc * 1e6)))
    throw new Error("Required bond exceeds agent spending limit");
  if (
    info.payer.toLowerCase() !== account.address.toLowerCase() ||
    info.receiver.toLowerCase() !== accepted.payTo.toLowerCase() ||
    info.operator.toLowerCase() !==
      accepted.extra.captureAuthorizer.toLowerCase() ||
    String(info.maxAmount) !== accepted.amount ||
    info.token.toLowerCase() !== accepted.asset.toLowerCase() ||
    info.minFeeBps !== 0 ||
    info.maxFeeBps !== 0
  )
    throw new Error("Payment terms do not match authorization");
  const client = createPublicClient({
    transport: http(options.rpcUrl ?? BASE_SEPOLIA.rpcUrl),
  });
  const abi = parseAbi([
    "function getHash((address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)) view returns(bytes32)",
  ]);
  const nonce = await client.readContract({
    address: BASE_SEPOLIA.authCaptureEscrow,
    abi,
    functionName: "getHash",
    args: [
      {
        ...info,
        payer: "0x0000000000000000000000000000000000000000",
        maxAmount: BigInt(info.maxAmount),
        salt: BigInt(info.salt),
      },
    ],
  });
  const typed = {
    domain: {
      name: "USDC",
      version: "2",
      chainId: 84532,
      verifyingContract: BASE_SEPOLIA.usdc,
    },
    primaryType: "ReceiveWithAuthorization",
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    message: {
      from: account.address,
      to: BASE_SEPOLIA.erc3009TokenCollector,
      value: BigInt(info.maxAmount),
      validAfter: 0n,
      validBefore: BigInt(info.preApprovalExpiry),
      nonce,
    },
  } as const;
  if (!account.signTypedData) throw new Error("Account cannot sign typed data");
  const signature = await account.signTypedData(typed);
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      authorization: JSON.parse(json(typed.message)),
      signature,
      salt: toHex(BigInt(info.salt), { size: 32 }),
    },
    extensions: required.extensions,
  };
  const paid = await fetch(url, {
    method: "POST",
    headers: {
      "PAYMENT-SIGNATURE": encodePayment(json(payload)),
    },
  });
  if (!paid.ok)
    throw new Error(`Payment failed (${paid.status}): ${await paid.text()}`);
  return paid.json();
}
export async function agentIdentity(
  agentId: bigint,
  rpcUrl: string = BASE_SEPOLIA.rpcUrl,
) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const abi = parseAbi([
    "function ownerOf(uint256) view returns(address)",
    "function tokenURI(uint256) view returns(string)",
    "function getAgentWallet(uint256) view returns(address)",
  ]);
  const [owner, uri, wallet] = await Promise.all([
    client.readContract({
      address: BASE_SEPOLIA.erc8004Identity,
      abi,
      functionName: "ownerOf",
      args: [agentId],
    }),
    client.readContract({
      address: BASE_SEPOLIA.erc8004Identity,
      abi,
      functionName: "tokenURI",
      args: [agentId],
    }),
    client.readContract({
      address: BASE_SEPOLIA.erc8004Identity,
      abi,
      functionName: "getAgentWallet",
      args: [agentId],
    }),
  ]);
  return {
    agentId: String(agentId),
    registry: BASE_SEPOLIA.erc8004Identity,
    owner,
    uri,
    wallet,
  };
}
