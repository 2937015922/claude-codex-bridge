#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const catalog = process.argv[2];
if (!catalog || !path.isAbsolute(catalog))
  throw new Error("Specify an absolute prepared catalog path");
const expected = JSON.parse(fs.readFileSync(catalog, "utf8")).models;
const cli = "C:/Users/user/AppData/Local/OpenAI/Codex/bin/c6fe824d725f02d7/codex.exe";
const child = spawn(
  cli,
  ["app-server", "-c", "model_catalog_json=" + JSON.stringify(catalog.replaceAll("\\", "/"))],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    try {
      const message = JSON.parse(line);
      const handler = pending.get(message.id);
      if (handler) {
        pending.delete(message.id);
        handler(message);
      }
    } catch {}
  }
});
child.stderr.resume();
function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Catalog RPC timed out"));
    }, 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error("Catalog RPC failed"));
      else resolve(message.result);
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
try {
  await rpc(0, "initialize", {
    clientInfo: { name: "native_gateway_catalog_probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  const result = await rpc(1, "model/list", { includeHidden: true });
  const list = result.data || result.models || [];
  const claude = list.find((x) => x.model === "claude-opus" || x.id === "claude-opus");
  const missing = expected
    .filter((x) => !list.some((m) => m.model === x.slug || m.id === x.slug))
    .map((x) => x.slug);
  const report = {
    catalogLoaded: !!claude,
    expectedModels: expected.length,
    actualModels: list.length,
    missing,
    claude: claude
      ? {
          id: claude.id,
          model: claude.model,
          displayName: claude.displayName,
          defaultReasoningEffort: claude.defaultReasoningEffort,
        }
      : null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.catalogLoaded || missing.length) process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
