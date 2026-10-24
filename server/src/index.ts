import { serve } from "@hono/node-server";
import { App } from "@octokit/app";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { Store } from "./runtime/store.ts";
import { Chain } from "./chain/client.ts";
import { GitHub } from "./github/client.ts";
import { Service } from "./runtime/service.ts";
import { createHttp } from "./runtime/http.ts";
import { startIndexer } from "./chain/indexer.ts";
import { serveStatic } from "@hono/node-server/serve-static";
import { setupHttp } from "./setup.ts";
import { execFileSync } from "node:child_process";

if (!process.env.GFH_OPERATOR_ADDRESS) {
  const app = setupHttp();
  app.use("/*", serveStatic({ root: "./web/dist" }));
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, () =>
    console.log("Gas for Humans: deployment setup pending"),
  );
} else {
  if (!process.env.GITHUB_TOKEN && !process.env.GITHUB_APP_ID) {
    try {
      process.env.GITHUB_TOKEN = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
  }
  const cfg = loadConfig();
  const githubApp =
    cfg.github.appId && cfg.github.privateKey
      ? new App({ appId: cfg.github.appId, privateKey: cfg.github.privateKey })
      : undefined;
  const db = openDb(cfg.databasePath);
  const service = new Service(
    new Store(db),
    new Chain(
      cfg.chain.rpcUrl,
      cfg.chain.relayerKey,
      cfg.chain.adjudicatorKey,
      cfg.chain.operator,
      cfg.chain.communityKeys,
    ),
    new GitHub({ app: githubApp, token: cfg.github.token }),
    cfg.publicBaseUrl,
  );
  const stopIndexer = startIndexer(service, cfg.chain.deploymentBlock);
  const app = createHttp(service, {
    adminToken: cfg.adminToken,
    webhookSecret: cfg.github.webhookSecret,
    mode: cfg.mode,
  });
  app.use("/*", serveStatic({ root: "./web/dist" }));
  const server = serve({ fetch: app.fetch, port: cfg.port }, (info) =>
    console.log(`Gas for Humans (${cfg.mode}) on :${info.port}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      stopIndexer();
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
}
