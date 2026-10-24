import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  http,
  formatEther,
  formatUnits,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA } from "@gfh/shared";
const client = createPublicClient({
  transport: http(process.env.RPC_URL ?? "https://sepolia.base.org"),
});
const result: any = {
  chainId: await client.getChainId(),
  mode: process.env.GFH_MODE ?? "base-sepolia",
  accounts: {},
  github: {},
};
for (const [name, key] of [
  ["relayer", process.env.RELAYER_PRIVATE_KEY],
  ["agent", process.env.GFH_AGENT_KEY],
]) {
  if (!key) {
    result.accounts[name!] = { ready: false };
    continue;
  }
  const address = privateKeyToAccount(key as `0x${string}`).address;
  const [eth, usdc] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: BASE_SEPOLIA.usdc,
      abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  result.accounts[name!] = {
    address,
    eth: formatEther(eth),
    usdc: formatUnits(usdc, 6),
  };
}
result.operator = process.env.GFH_OPERATOR_ADDRESS
  ? {
      address: process.env.GFH_OPERATOR_ADDRESS,
      deployed: Boolean(
        await client.getCode({
          address: process.env.GFH_OPERATOR_ADDRESS as `0x${string}`,
        }),
      ),
    }
  : { deployed: false };
result.github.appConfigured = Boolean(
  process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY_PATH &&
    existsSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH),
);
const communityKeysPath = process.env.COMMUNITY_KEYS_PATH ?? "secrets/communities.json";
const repositories = existsSync(communityKeysPath)
  ? Object.keys(JSON.parse(readFileSync(communityKeysPath, "utf8")))
  : [];
for (const name of repositories)
  try {
    const r = JSON.parse(
      execFileSync("gh", ["api", `repos/${name}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    result.github[name] = { id: r.id, url: r.html_url };
  } catch {
    result.github[name] = { accessible: false };
  }
console.log(JSON.stringify(result, null, 2));
