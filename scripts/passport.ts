import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isAddress } from "viem";
import { verifyPassport } from "@gfh/shared";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { login: { type: "string" }, out: { type: "string" }, rpc: { type: "string" }, operator: { type: "string" } },
});
if (positionals[0] === "export") {
  const login = values.login || process.env.GFH_GITHUB_LOGIN;
  if (!login) throw new Error("Specify the contributor with --login or GFH_GITHUB_LOGIN");
  const response = await fetch(`${process.env.GFH_API ?? "http://127.0.0.1:8787"}/api/passports/${encodeURIComponent(login)}`);
  if (!response.ok) throw new Error(await response.text());
  const passport = await response.json() as any;
  const path = resolve(values.out ?? `artifacts/passport-${passport.network.mode}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(passport, null, 2) + "\n");
  console.log(JSON.stringify({ path, mode: passport.network.mode, records: passport.records.length }));
} else if (positionals[0] === "verify" && positionals[1]) {
  const operator = values.operator ?? process.env.GFH_OPERATOR_ADDRESS;
  if (!operator || !isAddress(operator)) throw new Error("Specify the expected Operator with --operator or GFH_OPERATOR_ADDRESS");
  const result = await verifyPassport(JSON.parse(readFileSync(positionals[1], "utf8")), values.rpc ?? process.env.RPC_URL ?? "https://sepolia.base.org", operator);
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(values.out, JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify(result, null, 2));
} else throw new Error("Usage: passport.ts export [--login NAME] [--out FILE] | verify FILE [--rpc URL] [--operator ADDRESS] [--out FILE]");
