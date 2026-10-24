import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
export function updateEnv(values: Record<string, string>, path = ".env") {
  let content = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    content = re.test(content)
      ? content.replace(re, () => line)
      : `${content.trimEnd()}\n${line}\n`;
  }
  writeFileSync(path, content.trimStart(), { mode: 0o600 });
  chmodSync(path, 0o600);
}
