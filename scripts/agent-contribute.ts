import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { githubToken } from "./lib/github-token.ts";
const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    repo: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    base: { type: "string", default: "main" },
    "max-bond": { type: "string", default: "5" },
    submit: { type: "boolean", default: false },
  },
});
if (!values.cwd || !values.repo || !values.title)
  throw new Error(
    "Supply --cwd, --repo, --title and optionally --body, --max-bond, --submit",
  );
const cwd = resolve(values.cwd),
  git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
if (git("status", "--porcelain"))
  throw new Error("Commit the contribution before submitting");
const branch = git("branch", "--show-current");
if (!branch || branch === values.base)
  throw new Error("Use a contribution branch");
const remote = git("remote", "get-url", "origin");
if (!remote.endsWith(`${values.repo}.git`) && !remote.endsWith(values.repo))
  throw new Error("The working repository must match --repo");
if (!git("diff", "--stat", `${values.base}...HEAD`))
  throw new Error("The branch has no contribution");
const budget = Number(values["max-bond"]);
if (!Number.isFinite(budget) || budget < 0)
  throw new Error("Invalid bond budget");
execFileSync("npm", ["test"], { cwd, stdio: "inherit" });
console.log(
  JSON.stringify(
    {
      repo: values.repo,
      branch,
      commit: git("rev-parse", "HEAD"),
      diff: git("diff", "--stat", `${values.base}...HEAD`),
      maxBondUsdc: budget,
      submit: values.submit,
    },
    null,
    2,
  ),
);
if (values.submit) {
  git("push", "-u", "origin", branch);
  const token = await githubToken(values.repo);
  const env = Object.fromEntries(
    Object.entries({ ...process.env, GITHUB_TOKEN: token }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("mcp/src/index.ts")],
    env,
    stderr: "inherit",
  });
  const client = new Client({
    name: "gfh-contribution-runner",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "open_pull_request",
      arguments: {
        repo: values.repo,
        head: branch,
        base: values.base,
        title: values.title,
        body:
          values.body ??
          `Contribution ${git("rev-parse", "HEAD")}. Tests passed before submission.`,
        max_bond_usdc: budget,
      },
    });
    mkdirSync("artifacts", { recursive: true });
    const evidence = {
      at: new Date().toISOString(),
      mode: process.env.GFH_MODE ?? "base-sepolia",
      repo: values.repo,
      branch,
      commit: git("rev-parse", "HEAD"),
      result,
    };
    writeFileSync(
      `artifacts/agent-${evidence.mode}-${values.repo.split("/")[1]}.json`,
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.isError) process.exitCode = 1;
  } finally {
    await client.close();
  }
}
