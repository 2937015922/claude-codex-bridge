#!/usr/bin/env node
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentBroker } from "./personal/broker.js";
import { ClaudeCliProvider } from "./personal/claude-provider.js";
import { FileContextStore } from "./personal/context.js";
import {
  contextSharingAllowed,
  guardContextSharing,
  parseDaemonRpc,
  PERSONAL_VERSION,
  removeOwnManifest,
  runtimeDirectory,
  writeManifest,
  type DaemonManifest,
} from "./personal/runtime.js";
import type { SendAgentRequest, StartAgentRequest } from "./personal/types.js";

const directory = runtimeDirectory();
const token = process.env.BRIDGE_DAEMON_TOKEN;
if (!token || !/^[a-f0-9]{64}$/.test(token))
  throw new Error("Daemon must be started by the local bridge client.");
delete process.env.BRIDGE_DAEMON_TOKEN;
const broker = new AgentBroker({
  stateDirectory: directory,
  provider: guardContextSharing(new ClaudeCliProvider(), directory),
  contextStore: new FileContextStore(directory),
  maxConcurrency: 2,
  mcpConfigPath: process.env.BRIDGE_MCP_CONFIG,
  mcpAllowedTools: process.env.BRIDGE_MCP_ALLOWED_TOOLS?.split(",")
    .map((tool) => tool.trim())
    .filter(Boolean),
});
async function dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
  if (method === "ping")
    return {
      version: PERSONAL_VERSION,
      pid: process.pid,
      stopping,
      contextSharing: await contextSharingAllowed(directory),
    };
  if (stopping && method !== "shutdown") throw new Error("Personal bridge is shutting down");
  if (
    (method === "agent_start" || method === "agent_send") &&
    args.contextRef &&
    !(await contextSharingAllowed(directory))
  )
    throw new Error(
      "Automatic context sharing is disabled. Enable it once through personal-control --enable-context-sharing after reviewing the local policy.",
    );
  switch (method) {
    case "agent_start":
      return broker.start(args as unknown as StartAgentRequest);
    case "agent_send":
      return broker.send(args as unknown as SendAgentRequest);
    case "agent_status":
      return broker.status(String(args.taskId));
    case "agent_list":
      return broker.list(args.parentThreadId ? String(args.parentThreadId) : undefined);
    case "agent_wait":
      return broker.wait(
        String(args.taskId),
        Number(args.afterCursor ?? 0),
        Number(args.timeoutMs ?? 30000),
      );
    case "agent_interrupt":
      return broker.interrupt(String(args.taskId));
    case "agent_close":
      return broker.close(String(args.taskId));
    case "shutdown":
      stopping = true;
      setTimeout(() => {
        void stop();
      }, 50);
      return { stopping: true };
    default:
      throw new Error("Unknown local bridge method");
  }
}
let stopping = false;
let stopPromise: Promise<void> | undefined;
let ownManifest: DaemonManifest | undefined;
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  const supplied = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (
    request.headers.origin ||
    request.method !== "POST" ||
    request.url !== "/rpc" ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    response.writeHead(403);
    response.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("Request too large");
      chunks.push(chunk);
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Invalid request JSON");
    }
    const { method, args } = parseDaemonRpc(input);
    const result = await dispatch(method, args);
    response.end(JSON.stringify({ result }));
  } catch (error) {
    response.writeHead(400);
    response.end(
      JSON.stringify({ error: error instanceof Error ? error.message : "Bridge request failed" }),
    );
  }
});
function stop(): Promise<void> {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    let exitCode = 0;
    try {
      await broker.shutdown();
    } catch {
      exitCode = 1;
    }
    if (ownManifest) await removeOwnManifest(ownManifest, directory);
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 5000);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      process.exit(exitCode);
    });
    server.closeIdleConnections();
  })();
  return stopPromise;
}
async function main(): Promise<void> {
  await broker.init();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener");
  ownManifest = { version: 1, pid: process.pid, port: address.port, token: token! };
  await writeManifest(ownManifest, directory);
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.keepAliveTimeout = 1000;
main().catch(async (error) => {
  const message = (error instanceof Error ? error.message : "Daemon failed")
    .replaceAll(token!, "[redacted]")
    .slice(0, 2000);
  await writeFile(path.join(directory, "startup-error.txt"), message, { mode: 0o600 }).catch(
    () => {},
  );
  await broker.shutdown().catch(() => {});
  if (ownManifest) await removeOwnManifest(ownManifest, directory);
  process.exit(1);
});
