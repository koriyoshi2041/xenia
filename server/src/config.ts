import { readFileSync } from "node:fs";
import type { Hex, Address } from "viem";
const need = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}; see .env.example`);
  return value;
};
export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 8787),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:8787",
    databasePath: process.env.DATABASE_PATH ?? "./gfh.sqlite",
    mode: process.env.GFH_MODE ?? "base-sepolia",
    adminToken: need("GFH_ADMIN_TOKEN"),
    github: {
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY_PATH
        ? readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8")
        : undefined,
      token: process.env.GITHUB_TOKEN,
      webhookSecret: need("GITHUB_WEBHOOK_SECRET"),
    },
    chain: {
      rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
      relayerKey: need("RELAYER_PRIVATE_KEY") as Hex,
      adjudicatorKey: need("ADJUDICATOR_PRIVATE_KEY") as Hex,
      communityKeys: process.env.COMMUNITY_KEYS_PATH
        ? (JSON.parse(
            readFileSync(process.env.COMMUNITY_KEYS_PATH, "utf8"),
          ) as Record<string, Hex>)
        : {},
      operator: need("GFH_OPERATOR_ADDRESS") as Address,
      deploymentBlock: BigInt(need("GFH_DEPLOYMENT_BLOCK")),
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
