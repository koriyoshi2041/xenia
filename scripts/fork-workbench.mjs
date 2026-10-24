import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { parseEnv } from "node:util";
const children = [];
const run = (cmd, args, env = process.env) => {
  const child = spawn(cmd, args, { stdio: "inherit", env });
  children.push(child);
  return child;
};
const completed = (child) =>
  new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Process exited ${code}`)),
    );
  });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
try {
  const statePath = "secrets/fork-state.json";
  const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
  const blocks = saved?.blocks?.map((block) => Number(BigInt(block.header.number))) ?? [];
  // Resume from the original upstream block. A new upstream tip would add a gap to this local chain.
  const forkArgs = blocks.length ? ["--fork-block-number", String(Math.min(...blocks) - 1)] : [];
  if (blocks.length && Number(saved.best_block_number) > Math.max(...blocks)
      && Number(BigInt(saved.block.number)) === Math.max(...blocks)) {
    // Repair snapshots made by older launchers that selected a fresh upstream tip on every restart.
    copyFileSync(statePath, "secrets/fork-state-before-head-repair.json");
    saved.best_block_number = Math.max(...blocks);
    writeFileSync(statePath, JSON.stringify(saved));
  }
  const anvil = run("anvil", [
    "--fork-url",
    "https://sepolia.base.org",
    ...forkArgs,
    "--chain-id",
    "84532",
    "--port",
    "8545",
    "--state",
    "secrets/fork-state.json",
    "--preserve-historical-states",
    "--state-interval",
    "30",
    "--silent",
  ]);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (anvil.exitCode !== null) throw new Error("Anvil did not start");
    try {
      const r = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if ((await r.json()).result === "0x14a34") {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Fork did not become ready");
  await completed(
    run(process.execPath, ["--env-file=.env", "scripts/prepare-fork.ts"]),
  );
  await completed(
    run(process.execPath, [
      "--env-file=.env",
      "--env-file=.env.fork",
      "server/src/index.ts",
    ], { ...process.env, ...parseEnv(readFileSync(".env", "utf8")), ...parseEnv(readFileSync(".env.fork", "utf8")) }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stop();
}
