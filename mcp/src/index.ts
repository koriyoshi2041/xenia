#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { postBond, agentIdentity } from "@gfh/shared";

const API = process.env.GFH_API ?? "http://localhost:8787";
const server = new McpServer({ name: "gas-for-humans", version: "0.1.0" });
const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});
const get = async (path: string) => {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<any>;
};
const account = () => {
  const key = process.env.GFH_AGENT_KEY;
  if (!key) throw new Error("GFH_AGENT_KEY is required to sign a bond");
  return privateKeyToAccount(key as `0x${string}`);
};
const bond = (
  repo: string,
  number: number,
  maxAmountUsdc: number,
  agentId?: number,
) =>
  postBond({
    api: API,
    repo,
    number,
    account: account(),
    maxAmountUsdc,
    rpcUrl: process.env.RPC_URL,
    agentId:
      agentId === undefined
        ? process.env.GFH_AGENT_ID || undefined
        : String(agentId),
  });
server.tool(
  "get_queue_policy",
  "Read a repository’s pricing, review window, public pool and trust relationships.",
  { repo: z.string() },
  async ({ repo }) =>
    text(
      (await get("/api/queues")).queues.find((q: any) => q.repo === repo) ?? {
        error: "Queue not registered",
      },
    ),
);
server.tool(
  "quote_bond",
  "Quote a contribution using the author’s verified record and the target community’s policy.",
  { repo: z.string(), github_login: z.string() },
  async ({ repo, github_login }) =>
    text(
      await get(
        `/api/quote?repo=${encodeURIComponent(repo)}&login=${encodeURIComponent(github_login)}`,
      ),
    ),
);
server.tool(
  "prepare_contribution",
  "Before creating a PR, read this community’s current admission quote, recognized contributions, refund outcomes and review queue rules. Read-only: creates no PR and authorizes no payment.",
  { repo: z.string(), github_login: z.string() },
  async ({ repo, github_login }) =>
    text(
      await get(
        `/api/participation?repo=${encodeURIComponent(repo)}&login=${encodeURIComponent(github_login)}`,
      ),
    ),
);
server.tool(
  "get_review_queue",
  "Read open, non-draft contributions admitted by a confirmed bond or exemption, ordered by admission time. Optionally select one repository.",
  { repo: z.string().optional() },
  async ({ repo }) =>
    text(await get(`/api/review-queue${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`)),
);
server.tool(
  "post_bond",
  "Sign the refundable USDC commitment for an existing PR, within an explicit spending limit. The relayer pays gas.",
  {
    repo: z.string(),
    pr_number: z.number().int().positive(),
    max_amount_usdc: z.number().nonnegative(),
    agent_id: z.number().int().optional(),
  },
  async (args) => {
    const sync = await fetch(
      `${API}/api/items/${args.repo}/${args.pr_number}/sync`,
      { method: "POST" },
    );
    if (!sync.ok) throw new Error(await sync.text());
    return text(
      await bond(
        args.repo,
        args.pr_number,
        args.max_amount_usdc,
        args.agent_id,
      ),
    );
  },
);
server.tool(
  "open_pull_request",
  "Create a pull request on GitHub and post its review commitment within the supplied budget.",
  {
    repo: z.string(),
    head: z.string(),
    base: z.string().default("main"),
    title: z.string(),
    body: z.string(),
    max_bond_usdc: z.number().nonnegative(),
    agent_id: z.number().int().optional(),
  },
  async (args) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token)
      throw new Error("GITHUB_TOKEN is required to create a pull request");
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    const owner = args.repo.split("/")[0];
    const head = args.head.includes(":") ? args.head : `${owner}:${args.head}`;
    const prior = await fetch(
      `https://api.github.com/repos/${args.repo}/pulls?state=open&head=${encodeURIComponent(head)}`,
      { headers },
    );
    if (!prior.ok)
      throw new Error(`Cannot inspect existing pull requests: ${prior.status}`);
    const existing = (await prior.json()) as any[];
    const result = existing.length
      ? undefined
      : await fetch(`https://api.github.com/repos/${args.repo}/pulls`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            head: args.head,
            base: args.base,
            title: args.title,
            body: args.body,
          }),
        });
    const pr = existing[0] ?? ((await result!.json()) as any);
    if (result && !result.ok)
      throw new Error(`GitHub ${result.status}: ${pr.message}`);
    const sync = await fetch(
      `${API}/api/items/${args.repo}/${pr.number}/sync`,
      { method: "POST" },
    );
    if (!sync.ok)
      return { ...text({
        pullRequest: pr.html_url,
        paymentError: await sync.text(),
      }), isError: true };
    try {
      return text({
        pullRequest: pr.html_url,
        bond: await bond(
          args.repo,
          pr.number,
          args.max_bond_usdc,
          args.agent_id,
        ),
      });
    } catch (e) {
      return { ...text({
        pullRequest: pr.html_url,
        paymentError: (e as Error).message,
      }), isError: true };
    }
  },
);
server.tool(
  "get_record",
  "Read confirmed EAS contribution proofs for a GitHub identity.",
  { github_login: z.string() },
  async ({ github_login }) =>
    text(await get(`/api/records/${encodeURIComponent(github_login)}`)),
);
server.tool(
  "export_passport",
  "Export EAS contribution proofs, signed community policies and recognition paths as a portable JSON bundle.",
  { github_login: z.string() },
  async ({ github_login }) =>
    text(await get(`/api/passports/${encodeURIComponent(github_login)}`)),
);
server.tool(
  "get_agent_identity",
  "Read an ERC-8004 agent’s registry owner, wallet and registration URI.",
  { agent_id: z.number().int().nonnegative() },
  async ({ agent_id }) =>
    text(await agentIdentity(BigInt(agent_id), process.env.RPC_URL)),
);
await server.connect(new StdioServerTransport());
