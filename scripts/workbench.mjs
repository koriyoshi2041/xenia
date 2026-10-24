import { spawn } from "node:child_process";
import { connect } from "node:net";

const publicNetwork = process.argv.includes("--public");
const mode = publicNetwork ? "base-sepolia" : "base-sepolia-fork";
if (publicNetwork && (!process.env.GFH_OPERATOR_ADDRESS || process.env.GFH_MODE !== mode))
  throw new Error("Run npm run deploy first and set GFH_MODE=base-sepolia in .env.");
const backendPort = publicNetwork ? Number(process.env.PORT ?? 8787) : 8787;
const backend = `http://127.0.0.1:${backendPort}`;

const isListening = (port) => new Promise((resolve) => {
  const socket = connect({ port, host: "127.0.0.1" });
  socket.setTimeout(1000);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => { socket.destroy(); resolve(false); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
});
for (const port of publicNetwork ? [backendPort, 5173] : [8545, 8787, 5173]) {
  if (await isListening(port)) throw new Error(`Port ${port} is already in use. Stop the existing workbench before starting the combined launcher.`);
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
function start(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  children.push(child);
  child.on("error", (error) => { console.error(error.message); stop(1); });
  child.on("exit", (code) => { if (!stopping) stop(code ?? 1); });
  return child;
}
try {
  start(publicNetwork ? ["--env-file=.env", "server/src/index.ts"] : ["scripts/fork-workbench.mjs"]);
  let ready = false;
  for (let attempt = 0; attempt < 180 && !stopping; attempt++) {
    try {
      const response = await fetch(`${backend}/healthz`, { signal: AbortSignal.timeout(2000) });
      const health = await response.json();
      if (response.ok && health.mode === mode && health.chainId === 84532
          && (!publicNetwork || health.operator?.toLowerCase() === process.env.GFH_OPERATOR_ADDRESS.toLowerCase())) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`${mode} backend did not start`);
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY_PATH)
    start(["--env-file=.env", "scripts/webhook-relay.ts"], { GFH_WEBHOOK_TARGET: `${backend}/webhooks/github` });
  else console.log("GitHub App is not configured; complete setup:github to receive real PR events.");
  start(["node_modules/vite/bin/vite.js", "web", "--config", "web/vite.config.ts"], { GFH_BACKEND: backend });
  console.log(`Workbench ready at http://127.0.0.1:5173/ — ${mode}, API and GitHub relay run together. Ctrl+C stops the services; state is preserved.`);
} catch (error) {
  console.error(error.message);
  stop(1);
}
