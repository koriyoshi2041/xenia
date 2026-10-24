import { readFileSync } from "node:fs";
import { App } from "@octokit/app";
import SmeeClient from "smee-client";
import { updateEnv } from "./lib/local-config.ts";
const source =
  process.env.GFH_WEBHOOK_RELAY ??
  (await fetch("https://smee.io/new", { redirect: "manual" })).headers.get(
    "location",
  );
if (!source?.startsWith("https://smee.io/"))
  throw new Error("Cannot create webhook relay");
updateEnv({ GFH_WEBHOOK_RELAY: source });
const app = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH!, "utf8"),
});
const auth = (await app.octokit.auth({ type: "app" })) as { token: string };
const configured = await fetch("https://api.github.com/app/hook/config", {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: source,
    content_type: "json",
    insecure_ssl: "0",
    secret: process.env.GITHUB_WEBHOOK_SECRET,
  }),
});
if (!configured.ok)
  throw new Error(`Cannot configure App webhook: ${configured.status}`);
const relay = new SmeeClient({
  source,
  target: process.env.GFH_WEBHOOK_TARGET ?? "http://127.0.0.1:8787/webhooks/github",
  logger: {
    info: (message: string) => {
      if (message.startsWith("POST")) console.log(message);
    },
    error: (...args: unknown[]) => console.error("Webhook relay:", ...args),
  },
});
await relay.start();
console.log(
  "GitHub webhook relay connected to local server. Signatures are verified by the server.",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await relay.stop();
    process.exit(0);
  });
