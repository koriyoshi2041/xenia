import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA, agentIdentity } from "@gfh/shared";
import { updateEnv } from "./lib/local-config.ts";
const rpc = process.env.RPC_URL ?? BASE_SEPOLIA.rpcUrl;
const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
if ((await client.getChainId()) !== 84532)
  throw new Error("Expected Base Sepolia");
const account = privateKeyToAccount(process.env.GFH_AGENT_KEY as `0x${string}`);
const wallet = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(rpc),
});
if (
  (await client.getBalance({ address: account.address })) < parseEther("0.0001")
) {
  const relayer = createWalletClient({
    account: privateKeyToAccount(
      process.env.RELAYER_PRIVATE_KEY as `0x${string}`,
    ),
    chain: baseSepolia,
    transport: http(rpc),
  });
  const hash = await relayer.sendTransaction({
    to: account.address,
    value: parseEther("0.001"),
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error("Agent gas transfer failed");
}
const abi = parseAbi([
  "function register(string agentURI) returns(uint256)",
  "function setAgentURI(uint256 agentId,string newURI)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
]);
const metadata = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Gas for Humans contribution agent",
  description:
    "Contributes tested code and signs bounded review commitments through local MCP stdio tools.",
  active: true,
  x402Support: true,
  services: [{ name: "web", endpoint: process.env.PUBLIC_BASE_URL }],
  supportedTrust: ["reputation"],
};
const uri = (id?: string) =>
  "data:application/json;base64," +
  Buffer.from(
    JSON.stringify({
      ...metadata,
      registrations: id
        ? [
            {
              agentId: Number(id),
              agentRegistry: `eip155:84532:${BASE_SEPOLIA.erc8004Identity}`,
            },
          ]
        : [],
    }),
  ).toString("base64");
let id = process.env.GFH_AGENT_ID,
  registrationTx;
if (!id) {
  registrationTx = await wallet.writeContract({
    address: BASE_SEPOLIA.erc8004Identity,
    abi,
    functionName: "register",
    args: [uri()],
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: registrationTx,
  });
  if (receipt.status !== "success")
    throw new Error("Identity registration failed");
  id = String(
    parseEventLogs({ abi, eventName: "Registered", logs: receipt.logs })[0]!
      .args.agentId,
  );
  updateEnv(
    { GFH_AGENT_ID: id },
    process.env.GFH_MODE === "base-sepolia-fork" ? ".env.fork" : ".env",
  );
}
const identity = await agentIdentity(BigInt(id), rpc);
if (identity.owner.toLowerCase() !== account.address.toLowerCase())
  throw new Error("Configured identity belongs to another wallet");
let metadataTx;
if (identity.uri !== uri(id)) {
  metadataTx = await wallet.writeContract({
    address: BASE_SEPOLIA.erc8004Identity,
    abi,
    functionName: "setAgentURI",
    args: [BigInt(id), uri(id)],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: metadataTx });
  if (receipt.status !== "success")
    throw new Error("Identity metadata update failed");
}
console.log(
  JSON.stringify(
    {
      agentId: id,
      owner: account.address,
      registrationTx,
      metadataTx,
      mode: process.env.GFH_MODE,
    },
    null,
    2,
  ),
);
