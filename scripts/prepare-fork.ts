import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploy, fundFork } from "./chain-setup.ts";
import { updateEnv } from "./lib/local-config.ts";
const rpc = "http://127.0.0.1:8545";
const client = createPublicClient({ transport: http(rpc) });
const relayer = privateKeyToAccount(
  process.env.RELAYER_PRIVATE_KEY as `0x${string}`,
);
const agent = privateKeyToAccount(process.env.GFH_AGENT_KEY as `0x${string}`);
const rpcCall = async (method: string, params: unknown[]) => {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = (await r.json()) as any;
  if (data.error) throw new Error(data.error.message);
  return data.result;
};
const version = await rpcCall("web3_clientVersion", []);
if (!version.toLowerCase().includes("anvil"))
  throw new Error("Local Anvil required");
await rpcCall("anvil_setBalance", [
  relayer.address,
  `0x${parseEther("10").toString(16)}`,
]);
let deployment = existsSync("secrets/fork-deployment.json")
  ? JSON.parse(readFileSync("secrets/fork-deployment.json", "utf8"))
  : undefined;
if (!deployment || !(await client.getCode({ address: deployment.operator }))) {
  if (existsSync("server/gfh-fork.sqlite"))
    throw new Error(
      "Fork state was reset while its database remains. Use a fresh database or restore secrets/fork-state.json.",
    );
  await fundFork(rpc, agent.address, 100_000_000n);
  deployment = await deploy(
    rpc,
    process.env.RELAYER_PRIVATE_KEY as `0x${string}`,
    process.env.POOL_ADDRESS as `0x${string}`,
  );
  writeFileSync(
    "secrets/fork-deployment.json",
    JSON.stringify(deployment, null, 2) + "\n",
  );
}
updateEnv(
  {
    RPC_URL: rpc,
    GFH_MODE: "base-sepolia-fork",
    GFH_OPERATOR_ADDRESS: deployment.operator,
    GFH_DEPLOYMENT_BLOCK: deployment.deploymentBlock,
    DATABASE_PATH: "./server/gfh-fork.sqlite",
  },
  ".env.fork",
);
console.log(
  JSON.stringify({ mode: "base-sepolia-fork", ...deployment }, null, 2),
);
