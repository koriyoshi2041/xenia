import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { App } from "@octokit/app";
export async function githubToken(repo: string, preferApp = true) {
  if (
    preferApp &&
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY_PATH
  ) {
    const app = new App({
      appId: process.env.GITHUB_APP_ID,
      privateKey: readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8"),
    });
    const [owner, name] = repo.split("/");
    const install = await app.octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner: owner!, repo: name! },
    );
    const auth = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: install.data.id, repositories: [name!] },
    );
    return auth.data.token;
  }
  return (
    process.env.GITHUB_TOKEN ??
    execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  );
}
