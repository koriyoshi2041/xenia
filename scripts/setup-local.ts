import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { updateEnv } from "./lib/local-config.ts";
mkdirSync("secrets", { recursive: true, mode: 0o700 });
if (existsSync(".env")) process.loadEnvFile(".env");
const repos = process.argv.length > 2
  ? process.argv.slice(2)
  : (process.env.GFH_REPOSITORIES ?? "").split(",").map((repo) => repo.trim()).filter(Boolean);
for (const repo of repos)
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error(`Expected owner/repository, received: ${repo}`);
const values: Record<string, string> = {};
const ensure = (name: string, value: () => string) =>
  process.env[name] || (values[name] = value());
for (const name of [
  "RELAYER_PRIVATE_KEY",
  "ADJUDICATOR_PRIVATE_KEY",
  "GFH_AGENT_KEY",
])
  ensure(name, generatePrivateKey);
for (const name of ["GFH_ADMIN_TOKEN", "GITHUB_WEBHOOK_SECRET"])
  ensure(name, () => randomBytes(32).toString("hex"));
if (!existsSync("secrets/pool.key"))
  writeFileSync("secrets/pool.key", generatePrivateKey() + "\n", {
    mode: 0o600,
  });
ensure(
  "POOL_ADDRESS",
  () =>
    privateKeyToAccount(
      readFileSync("secrets/pool.key", "utf8").trim() as `0x${string}`,
    ).address,
);
const path = process.env.COMMUNITY_KEYS_PATH || "secrets/communities.json";
const keys = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
for (const repo of repos) keys[repo] ??= generatePrivateKey();
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
ensure("COMMUNITY_KEYS_PATH", () => path);
for (const [name, value] of Object.entries({
  RPC_URL: "https://sepolia.base.org",
  GFH_MODE: "base-sepolia",
  PUBLIC_BASE_URL: "http://localhost:8787",
  DATABASE_PATH: "./server/gfh.sqlite",
  GFH_API: "http://localhost:8787",
  PORT: "8787",
}))
  ensure(name, () => value);
updateEnv(values);
const merged = { ...process.env, ...values };
const addresses = {
  relayer: privateKeyToAccount(merged.RELAYER_PRIVATE_KEY as `0x${string}`)
    .address,
  agent: privateKeyToAccount(merged.GFH_AGENT_KEY as `0x${string}`).address,
  pool: merged.POOL_ADDRESS,
  communities: Object.fromEntries(
    Object.keys(keys).map((repo) => [repo, privateKeyToAccount(keys[repo]).address]),
  ),
};
writeFileSync(
  "secrets/addresses.json",
  JSON.stringify(addresses, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      addresses,
      config: ".env",
      repositories: Object.keys(keys),
      setup: "npm run setup:local -- owner/repository owner/another-repository",
      note: "Private keys remain in ignored local files. Public testnet funding is still needed.",
    },
    null,
    2,
  ),
);
