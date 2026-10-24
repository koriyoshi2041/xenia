import { Hono } from "hono";
import { BASE_SEPOLIA, type NetworkSnapshot } from "@gfh/shared";
export function setupHttp() {
  const app = new Hono();
  const requirements = [
    "部署合约到 Base Sepolia",
    "连接 GitHub App，接收 PR 事件",
  ];
  const runtime = { mode: "setup", chainId: BASE_SEPOLIA.chainId, requirements };
  app.get("/healthz", (c) => c.json({ ok: true, ...runtime }));
  app.get("/api/network", (c) => c.json({ queues: [], records: [], runtime } satisfies NetworkSnapshot));
  app.get("/api/review-queue", (c) => c.json({ items: [] }));
  app.get("/api/contributions", (c) => c.json({ items: [] }));
  app.all("/api/*", (c) =>
    c.json(
      { error: "Complete local setup and deploy the operator first" },
      503,
    ),
  );
  return app;
}
