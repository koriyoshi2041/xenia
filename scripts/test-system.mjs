import { spawn } from "node:child_process";
const port = 18545;
const rpc = `http://127.0.0.1:${port}`;
const child = spawn(
  "anvil",
  [
    "--fork-url",
    process.env.TEST_FORK_URL ?? "https://sepolia.base.org",
    "--chain-id",
    "84532",
    "--port",
    String(port),
    "--silent",
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
child.on("error", (e) => {
  console.error("Anvil is required:", e.message);
  process.exitCode = 1;
});
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("Anvil exited before startup");
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if ((await response.json()).result === "0x14a34") {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Anvil fork did not start");
  const test = spawn(process.execPath, ["scripts/integration.ts"], {
    stdio: "inherit",
    env: { ...process.env, TEST_RPC_URL: rpc },
  });
  const code = await new Promise((resolve) => test.on("exit", resolve));
  process.exitCode = code ?? 1;
} finally {
  child.kill("SIGTERM");
}
