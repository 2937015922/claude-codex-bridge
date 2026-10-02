#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  daemonRequest,
  ensureDaemon,
  readManifest,
  runtimeDirectory,
  stopDaemon,
} from "./personal/runtime.js";
const directory = runtimeDirectory();
async function main(): Promise<void> {
  const flag = process.argv[2] || "--help";
  if (process.argv.length > 3)
    throw new Error("Personal bridge control accepts one option at a time");
  if (flag === "--enable-context-sharing" || flag === "--disable-context-sharing") {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const enabled = flag === "--enable-context-sharing";
    await writeFile(
      path.join(directory, "policy.json"),
      JSON.stringify({ version: 1, contextSharing: enabled }, null, 2),
      { mode: 0o600 },
    );
    console.log(`Automatic context sharing ${enabled ? "enabled" : "disabled"} in ${directory}.`);
    return;
  }
  if (flag === "--status") {
    console.log(JSON.stringify(await daemonRequest(await ensureDaemon(), "ping"), null, 2));
    return;
  }
  if (flag === "--stop") {
    const manifest = await readManifest();
    if (!manifest) {
      console.log("No personal bridge daemon is recorded.");
      return;
    }
    await stopDaemon(manifest, directory);
    console.log("Personal bridge daemon stopped.");
    return;
  }
  if (flag === "--print-config") {
    const serverPath = fileURLToPath(new URL("./personal-server.mjs", import.meta.url));
    const hookPath = fileURLToPath(new URL("./personal/context-hook.mjs", import.meta.url));
    console.log(
      JSON.stringify(
        {
          mcpServer: { claude_personal: { command: process.execPath, args: [serverPath] } },
          hook: {
            PreToolUse: [
              {
                matcher: "^mcp__claude_personal__(agent_start|agent_send)$",
                hooks: [
                  {
                    type: "command",
                    command: `"${process.execPath}" "${hookPath}"`,
                    timeout: 20,
                  },
                ],
              },
            ],
          },
          contextSharing: "Disabled until --enable-context-sharing is explicitly selected.",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (flag !== "--help") throw new Error("Unknown personal bridge control option");
  console.log(
    "Personal bridge: --status | --stop | --print-config | --enable-context-sharing | --disable-context-sharing\nReview PERSONAL.md before enabling sharing. Hook trust is reviewed through the normal Codex /hooks workflow.",
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Personal bridge control failed");
  process.exitCode = 1;
});
