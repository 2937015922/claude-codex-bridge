import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, open, unlink, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateDirectory } from "./context.js";
import { z } from "zod";
import type { AgentProvider } from "./types.js";

export const PERSONAL_VERSION = "0.4.0-personal.1";
export interface DaemonManifest {
  version: 1;
  pid: number;
  port: number;
  token: string;
}
export interface DaemonStartOptions {
  directory?: string;
  /** Trusted launch override for isolated process tests; never an RPC parameter. */
  daemonPath?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}
const pendingStarts = new Map<string, Promise<DaemonManifest>>();
const manifestSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65535),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const taskId = z.string().min(1).max(128);
const requestId = z.string().min(1).max(128);
const contextRef = z
  .string()
  .regex(/^ctx_[a-f0-9]{64}$/)
  .optional();
const workingDirectory = z.string().min(1).max(32768);
export const rpcSchemas = {
  ping: z.object({}).strict(),
  shutdown: z.object({}).strict(),
  agent_start: z
    .object({
      requestId,
      task: z.string().min(1).max(100000),
      workingDirectory,
      contextRef,
      requireContext: z.boolean().optional().default(true),
      model: z.enum(["opus", "sonnet", "haiku"]).optional().default("opus"),
      maxTurns: z.number().int().min(1).max(30).optional().default(8),
      profile: z.enum(["discussion", "review", "mcp"]).optional().default("discussion"),
    })
    .strict(),
  agent_send: z
    .object({
      requestId,
      taskId,
      message: z.string().min(1).max(100000),
      contextRef,
      workingDirectory: workingDirectory.optional(),
    })
    .strict(),
  agent_status: z.object({ taskId }).strict(),
  agent_list: z.object({ parentThreadId: z.string().min(1).max(300).optional() }).strict(),
  agent_wait: z
    .object({
      taskId,
      afterCursor: z.number().int().min(0).optional().default(0),
      timeoutMs: z.number().int().min(0).max(60000).optional().default(30000),
    })
    .strict(),
  agent_interrupt: z.object({ taskId }).strict(),
  agent_close: z.object({ taskId }).strict(),
};
export function parseDaemonRpc(input: unknown): {
  method: keyof typeof rpcSchemas;
  args: Record<string, unknown>;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid request envelope");
  const envelope = input as Record<string, unknown>;
  if (
    Object.keys(envelope).some((key) => key !== "method" && key !== "args") ||
    typeof envelope.method !== "string" ||
    !Object.hasOwn(rpcSchemas, envelope.method)
  )
    throw new Error("Unknown or invalid local bridge method");
  const method = envelope.method as keyof typeof rpcSchemas;
  const parsed = rpcSchemas[method].safeParse(envelope.args === undefined ? {} : envelope.args);
  if (!parsed.success)
    throw new Error(
      "Invalid arguments for " +
        method +
        ": " +
        parsed.error.issues
          .map((issue) => issue.path.join(".") || "arguments")
          .slice(0, 8)
          .join(", "),
    );
  return { method, args: parsed.data };
}
const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
export function runtimeDirectory(): string {
  return path.resolve(process.env.BRIDGE_STATE_DIR || defaultStateDirectory());
}
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function readManifest(directory = runtimeDirectory()): Promise<DaemonManifest | null> {
  try {
    const file = path.join(directory, "daemon.json");
    if ((await stat(file)).size > 4096) return null;
    return manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}
export async function contextSharingAllowed(directory = runtimeDirectory()): Promise<boolean> {
  try {
    const policy = JSON.parse(await readFile(path.join(directory, "policy.json"), "utf8"));
    return policy?.version === 1 && policy.contextSharing === true;
  } catch (error) {
    return (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      process.env.BRIDGE_CONTEXT_SHARING === "enabled"
    );
  }
}
export function guardContextSharing(
  provider: AgentProvider,
  directory = runtimeDirectory(),
): AgentProvider {
  return {
    async run(request, emit) {
      if (request.containsParentContext && !(await contextSharingAllowed(directory))) {
        return {
          sessionId: request.sessionId,
          status: "failed",
          text: "",
          error: "Automatic context sharing was disabled before this queued request executed",
        };
      }
      return provider.run(request, emit);
    },
  };
}
export async function daemonRequest(
  manifest: DaemonManifest,
  method: string,
  args: unknown = {},
  timeoutMs?: number,
): Promise<unknown> {
  manifestSchema.parse(manifest);
  const rpc = parseDaemonRpc({ method, args });
  const response = await fetch(`http://127.0.0.1:${manifest.port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${manifest.token}` },
    body: JSON.stringify(rpc),
    signal: AbortSignal.timeout(timeoutMs ?? (method === "agent_wait" ? 65000 : 15000)),
    redirect: "error",
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Local bridge returned an empty response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.length;
    if (bytes > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Local bridge response is too large");
    }
    chunks.push(chunk.value);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Local bridge returned invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Local bridge returned an invalid response");
  const value = body as { result?: unknown; error?: unknown };
  if (!response.ok || value.error !== undefined)
    throw new Error(
      typeof value.error === "string"
        ? value.error.slice(0, 2000)
        : `Local bridge returned HTTP ${response.status}`,
    );
  if (!Object.hasOwn(body, "result")) throw new Error("Local bridge response omitted its result");
  return value.result;
}
async function healthy(manifest: DaemonManifest | null): Promise<boolean> {
  if (!manifest || !pidAlive(manifest.pid)) return false;
  let reply: unknown;
  try {
    reply = await daemonRequest(manifest, "ping", {}, 1000);
  } catch {
    return false;
  }
  if (!reply || typeof reply !== "object") return false;
  const ping = reply as { pid?: unknown; version?: unknown; stopping?: unknown };
  if (ping.pid !== manifest.pid)
    throw new Error("Recorded daemon identity does not match the responding process");
  if (ping.version !== PERSONAL_VERSION)
    throw new Error(
      "A different personal bridge version is running; stop it before upgrading. No duplicate was started.",
    );
  if (ping.stopping === true)
    throw new Error("The personal bridge is stopping; retry after it exits.");
  return true;
}
async function unlinkIfOwned(file: string, expected: string): Promise<void> {
  try {
    if ((await readFile(file, "utf8")) === expected) await unlink(file);
  } catch {
    /* Already replaced or removed. */
  }
}
export async function removeOwnManifest(
  manifest: DaemonManifest,
  directory = runtimeDirectory(),
): Promise<void> {
  const current = await readManifest(directory);
  if (
    current?.pid === manifest.pid &&
    current.token === manifest.token &&
    current.port === manifest.port
  ) {
    await unlinkIfOwned(path.join(directory, "daemon.json"), JSON.stringify(current));
  }
}
export async function ensureDaemon(options: DaemonStartOptions = {}): Promise<DaemonManifest> {
  const directory = path.resolve(options.directory || runtimeDirectory());
  const key = process.platform === "win32" ? directory.toLowerCase() : directory;
  const existing = pendingStarts.get(key);
  if (existing) return existing;
  const starting = startDaemon(directory, options).finally(() => pendingStarts.delete(key));
  pendingStarts.set(key, starting);
  return starting;
}
async function startDaemon(
  directory: string,
  options: DaemonStartOptions,
): Promise<DaemonManifest> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let current = await readManifest(directory);
  if (await healthy(current)) return current!;
  const lockPath = path.join(directory, "bootstrap.lock");
  const ownerText = JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString("hex") });
  const deadline = Date.now() + (options.startupTimeoutMs ?? 20000);
  const interval = options.pollIntervalMs ?? 100;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  while (!lock && Date.now() < deadline) {
    try {
      const acquired = await open(lockPath, "wx", 0o600);
      try {
        await acquired.writeFile(ownerText);
        lock = acquired;
      } catch (error) {
        await acquired.close();
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      current = await readManifest(directory);
      if (await healthy(current)) return current!;
      try {
        const oldText = await readFile(lockPath, "utf8");
        const owner = JSON.parse(oldText);
        if (Number.isInteger(owner.pid) && owner.pid > 0 && !pidAlive(owner.pid))
          await unlinkIfOwned(lockPath, oldText);
      } catch {
        /* A bootstrap writer may still be writing its lock. */
      }
      await delay(interval);
    }
  }
  if (!lock) throw new Error("Local bridge startup is already in progress; retry shortly.");
  try {
    current = await readManifest(directory);
    if (await healthy(current)) return current!;
    if (current && pidAlive(current.pid))
      throw new Error(
        "A recorded bridge process is alive but unreachable; refusing to start a duplicate.",
      );
    const token = randomBytes(32).toString("hex");
    const daemonPath =
      options.daemonPath || fileURLToPath(new URL("./personal-daemon.mjs", import.meta.url));
    const startupFile = path.join(directory, "startup-error.txt");
    await unlink(startupFile).catch(() => {});
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, BRIDGE_STATE_DIR: directory, BRIDGE_DAEMON_TOKEN: token },
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
    try {
      while (Date.now() < deadline) {
        if (spawnError) throw new Error("Could not launch the personal bridge daemon");
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Personal bridge daemon exited during startup");
        current = await readManifest(directory);
        if (current?.token === token && current.pid === child.pid && (await healthy(current)))
          return current;
        await delay(interval);
      }
      throw new Error("Local bridge did not become ready before the startup deadline");
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      let diagnostic = "";
      try {
        if ((await stat(startupFile)).size < 8192)
          diagnostic =
            "; " +
            (await readFile(startupFile, "utf8")).replaceAll(token, "[redacted]").slice(0, 2000);
      } catch {
        /* No diagnostic was produced. */
      }
      throw new Error(
        (error instanceof Error ? error.message : "Daemon startup failed") + diagnostic,
      );
    }
  } finally {
    await lock.close();
    await unlinkIfOwned(lockPath, ownerText);
  }
}
export async function writeManifest(manifest: DaemonManifest, directory: string): Promise<void> {
  manifestSchema.parse(manifest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `daemon-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(directory, "daemon.json"));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function stopDaemon(
  manifest: DaemonManifest,
  directory = runtimeDirectory(),
  timeoutMs = 10000,
): Promise<void> {
  if (!pidAlive(manifest.pid)) {
    await removeOwnManifest(manifest, directory);
    return;
  }
  await daemonRequest(manifest, "shutdown");
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(manifest.pid) && Date.now() < deadline) await delay(100);
  if (pidAlive(manifest.pid))
    throw new Error("Shutdown was requested but daemon exit was not confirmed");
  await removeOwnManifest(manifest, directory);
}
