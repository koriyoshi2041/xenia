import { writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";
import { deploy } from "./chain-setup.ts";
import { updateEnv } from "./lib/local-config.ts";
const key = process.env.RELAYER_PRIVATE_KEY as Hex;
const pool = process.env.POOL_ADDRESS as Address;
if (!key || !pool) throw new Error("Set RELAYER_PRIVATE_KEY and POOL_ADDRESS");
if (process.env.GFH_OPERATOR_ADDRESS) {
  const client = createPublicClient({
    transport: http(process.env.RPC_URL ?? "https://sepolia.base.org"),
  });
  if (
    await client.getCode({
      address: process.env.GFH_OPERATOR_ADDRESS as Address,
    })
  ) {
    console.log(`Existing deployment: ${process.env.GFH_OPERATOR_ADDRESS}`);
    process.exit(0);
  }
  throw new Error(
    "Configured operator has no bytecode on this RPC. Check the selected network before deploying.",
  );
}
const result = await deploy(
  process.env.RPC_URL ?? "https://sepolia.base.org",
  key,
  pool,
);
writeFileSync("deployment.json", JSON.stringify(result, null, 2) + "\n");
updateEnv({
  GFH_OPERATOR_ADDRESS: result.operator,
  GFH_DEPLOYMENT_BLOCK: result.deploymentBlock,
});
console.log(
  `GFH_OPERATOR_ADDRESS=${result.operator}\nGFH_DEPLOYMENT_BLOCK=${result.deploymentBlock}\nVERDICT_SCHEMA=${result.schema}`,
);
