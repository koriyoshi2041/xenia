import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { updateEnv } from "./lib/local-config.ts";
const base = process.env.PUBLIC_BASE_URL;
let hook = base?.startsWith("https://")
  ? `${base}/webhooks/github`
  : process.env.GFH_WEBHOOK_RELAY;
if (!hook) {
  const response = await fetch("https://smee.io/new", { redirect: "manual" });
  hook = response.headers.get("location") ?? undefined;
  if (!hook?.startsWith("https://smee.io/"))
    throw new Error("Could not prepare GitHub webhook relay");
  updateEnv({ GFH_WEBHOOK_RELAY: hook });
}
const state = randomBytes(24).toString("hex");
const port = 8789;
const manifest = {
  name: process.env.GITHUB_APP_NAME || "Xenia",
  url: "https://github.com/koriyoshi2041/xenia",
  description:
    "Community review commitments and verifiable contribution records. Hackathon integration.",
  public: false,
  hook_attributes: { url: hook, active: true },
  redirect_url: `http://127.0.0.1:${port}/callback`,
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    checks: "write",
    metadata: "read",
  },
  default_events: ["pull_request"],
};
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
let completed = false;
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/")
    return res.end(
      `<meta charset="utf-8"><title>Connect GitHub</title><main style="font:17px system-ui;max-width:640px;margin:80px auto"><h1>连接 GitHub</h1><p>创建应用后，选择准备接入 Xenia 的社区仓库。应用会接收 PR 事件、写入审阅检查，并作为 Agent 提交代码。</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>创建 Xenia GitHub App →</button></form></main>`,
    );
  if (
    url.pathname !== "/callback" ||
    url.searchParams.get("state") !== state ||
    completed
  ) {
    res.statusCode = 400;
    return res.end("Invalid or completed registration.");
  }
  try {
    const code = url.searchParams.get("code");
    if (!code) throw new Error("Missing registration code");
    const response = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      { method: "POST", headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok)
      throw new Error(`GitHub conversion returned ${response.status}`);
    const app = (await response.json()) as any;
    mkdirSync("secrets", { recursive: true, mode: 0o700 });
    writeFileSync("secrets/github-app.pem", app.pem, { mode: 0o600 });
    updateEnv({
      GITHUB_APP_ID: String(app.id),
      GITHUB_APP_PRIVATE_KEY_PATH: "secrets/github-app.pem",
      GITHUB_WEBHOOK_SECRET: app.webhook_secret,
    });
    const installation = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
    writeFileSync(
      "secrets/github-app.json",
      JSON.stringify({ id: app.id, slug: app.slug, installation }, null, 2) +
        "\n",
    );
    completed = true;
    console.log(
      `GitHub App ${app.slug} registered. Credentials saved locally. Install: ${installation}`,
    );
    res.end(
      `<meta charset="utf-8"><h1>应用已创建</h1><p>凭证已保存在本机。</p><a href="${installation}">选择社区仓库并安装 →</a>`,
    );
  } catch (error) {
    res.statusCode = 400;
    res.end(escape((error as Error).message));
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`GitHub App setup: http://127.0.0.1:${port}`),
);
