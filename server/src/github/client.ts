import type { App } from "@octokit/app";
import type { PullRequest } from "@gfh/shared";

export interface GitHubGateway {
  pull(repo: string, number: number): Promise<PullRequest>;
  user(login: string): Promise<{ id: number; createdAt: string }>;
  signals(
    repo: string,
    login: string,
    minStars: number,
  ): Promise<{ write: boolean; merged: { repo: string; number: number }[] }>;
  check(pr: PullRequest, admitted: boolean, summary: string): Promise<void>;
}
export class GitHub implements GitHubGateway {
  app?: App;
  token?: string;
  constructor(options: { app?: App; token?: string } = {}) {
    this.app = options.app;
    this.token = options.token;
  }
  async request(
    path: string,
    repo?: string,
    method = "GET",
    body?: unknown,
  ): Promise<any> {
    if (this.app && repo) {
      const installation = await this.app.octokit.request(
        "GET /repos/{owner}/{repo}/installation",
        { owner: repo.split("/")[0]!, repo: repo.split("/")[1]! },
      );
      const client = await this.app.getInstallationOctokit(
        installation.data.id,
      );
      return (
        await client.request(
          `${method} ${path}`,
          body as Record<string, unknown>,
        )
      ).data;
    }
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path}: ${response.status}`);
    return response.json();
  }
  async pull(repo: string, number: number): Promise<PullRequest> {
    const p = await this.request(`/repos/${repo}/pulls/${number}`, repo);
    return pullFromPayload(repo, p.base.repo.id, p);
  }
  async user(login: string) {
    const u = await this.request(`/users/${encodeURIComponent(login)}`);
    return { id: u.id, createdAt: u.created_at };
  }
  async signals(repo: string, login: string, minStars: number) {
    let write = false;
    if (this.app) {
      const permission = await this.request(
        `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        repo,
      );
      write = ["admin", "maintain", "write"].includes(permission.permission);
    }
    const q = encodeURIComponent(
      `author:${login} is:pr is:merged -user:${login}`,
    );
    const search = await this.request(
      `/search/issues?q=${q}&per_page=100`,
      repo,
    );
    const repos = new Map<string, number>();
    const merged: { repo: string; number: number }[] = [];
    for (const pr of search.items) {
      const name = pr.repository_url.replace(
        "https://api.github.com/repos/",
        "",
      );
      if (!repos.has(name))
        repos.set(
          name,
          (await this.request(`/repos/${name}`)).stargazers_count,
        );
      if (repos.get(name)! >= minStars)
        merged.push({ repo: name, number: pr.number });
    }
    return { write, merged };
  }
  async check(pr: PullRequest, admitted: boolean, summary: string) {
    if (!this.app) return;
    await this.request(`/repos/${pr.repo}/check-runs`, pr.repo, "POST", {
      name: "gas-for-humans/bond",
      head_sha: pr.headSha,
      status: "completed",
      conclusion: admitted ? "success" : "action_required",
      output: {
        title: admitted ? "Ready for review" : "Review commitment required",
        summary,
      },
    });
  }
}
export function pullFromPayload(
  repo: string,
  repoId: number,
  p: any,
): PullRequest {
  return {
    repo,
    repoId,
    number: p.number,
    authorId: p.user.id,
    authorLogin: p.user.login,
    title: p.title,
    draft: Boolean(p.draft),
    updatedAt: p.updated_at,
    headSha: p.head.sha,
    url: p.html_url,
    state: p.state,
    merged: Boolean(p.merged),
    labels: (p.labels ?? []).map((l: any) => l.name),
  };
}
