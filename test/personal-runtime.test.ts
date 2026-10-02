import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AgentBroker } from "../src/personal/broker.js";
import {
  contextSharingAllowed,
  daemonRequest,
  ensureDaemon,
  guardContextSharing,
  parseDaemonRpc,
  PERSONAL_VERSION,
  pidAlive,
  readManifest,
  removeOwnManifest,
  stopDaemon,
  writeManifest,
  type DaemonManifest,
} from "../src/personal/runtime.js";
import type { AgentProvider, ContextSnapshot, ProviderResult } from "../src/personal/types.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.unstubAllEnvs();
});
async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "personal-runtime-"));
  cleanup.push(() => rm(result, { force: true, recursive: true }));
  return result;
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function runNode(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("personal runtime boundaries", () => {
  it("validates RPC types without coercion or accepting trusted configuration overrides", () => {
    expect(() =>
      parseDaemonRpc({ method: "agent_wait", args: { taskId: "x", afterCursor: "0" } }),
    ).toThrow("Invalid arguments");
    expect(() => parseDaemonRpc({ method: "agent_status", args: { taskId: {} } })).toThrow();
    expect(() =>
      parseDaemonRpc({ method: "agent_wait", args: { taskId: "x", timeoutMs: 60001 } }),
    ).toThrow();
    expect(() => parseDaemonRpc({ method: "__proto__", args: {} })).toThrow();
    expect(() =>
      parseDaemonRpc({
        method: "agent_start",
        args: {
          requestId: "a",
          task: "task",
          workingDirectory: process.cwd(),
          requireContext: "false",
        },
      }),
    ).toThrow();
    expect(() =>
      parseDaemonRpc({
        method: "agent_start",
        args: {
          requestId: "a",
          task: "task",
          workingDirectory: process.cwd(),
          mcpConfigPath: "untrusted",
        },
      }),
    ).toThrow();
    expect(parseDaemonRpc({ method: "agent_wait", args: { taskId: "x" } }).args).toEqual({
      taskId: "x",
      afterCursor: 0,
      timeoutMs: 30000,
    });
  });

  it("validates manifests and does not delete a newer owner's token", async () => {
    const dir = await directory();
    const original: DaemonManifest = {
      version: 1,
      pid: process.pid,
      port: 12345,
      token: "a".repeat(64),
    };
    await writeManifest(original, dir);
    expect(await readManifest(dir)).toEqual(original);
    const replacement = { ...original, token: "b".repeat(64) };
    await writeManifest(replacement, dir);
    await removeOwnManifest(original, dir);
    expect(await readManifest(dir)).toEqual(replacement);
    await removeOwnManifest(replacement, dir);
    expect(await readManifest(dir)).toBeNull();
    await writeFile(join(dir, "daemon.json"), JSON.stringify({ ...original, pid: -1 }));
    expect(await readManifest(dir)).toBeNull();
    await writeFile(
      join(dir, "daemon.json"),
      JSON.stringify({ ...original, token: [original.token] }),
    );
    expect(await readManifest(dir)).toBeNull();
  });

  it("lets an explicit disabled or invalid policy override the enabling environment", async () => {
    const dir = await directory();
    vi.stubEnv("BRIDGE_CONTEXT_SHARING", "enabled");
    expect(await contextSharingAllowed(dir)).toBe(true);
    await writeFile(
      join(dir, "policy.json"),
      JSON.stringify({ version: 1, contextSharing: false }),
    );
    expect(await contextSharingAllowed(dir)).toBe(false);
    await writeFile(join(dir, "policy.json"), "not JSON");
    expect(await contextSharingAllowed(dir)).toBe(false);
    await writeFile(join(dir, "policy.json"), JSON.stringify({ version: 1, contextSharing: true }));
    expect(await contextSharingAllowed(dir)).toBe(true);
  });

  it("rechecks consent when queued context work is handed to the provider", async () => {
    const dir = await directory();
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    await writeFile(join(dir, "policy.json"), JSON.stringify({ version: 1, contextSharing: true }));
    let calls = 0;
    let finish!: () => void;
    const provider: AgentProvider = {
      run(request) {
        calls++;
        return new Promise<ProviderResult>((resolve) => {
          finish = () =>
            resolve({ sessionId: request.sessionId, status: "completed", text: "done" });
        });
      },
    };
    const context: ContextSnapshot = {
      version: 1,
      id: "ctx_" + "a".repeat(64),
      parentThreadId: "synthetic",
      workingDirectory: workspace,
      createdAt: new Date().toISOString(),
      revision: "a".repeat(64),
      source: "synthetic",
      text: "SYNTHETIC_ONLY",
      coverage: { messages: 1, toolResults: 0, instructions: 0 },
      omissions: [],
    };
    const broker = new AgentBroker({
      stateDirectory: dir,
      provider: guardContextSharing(provider, dir),
      contextStore: {
        async read() {
          return context;
        },
      },
      maxConcurrency: 1,
    });
    cleanup.push(() => broker.shutdown());
    const task = await broker.start({
      requestId: randomUUID(),
      task: "synthetic",
      workingDirectory: workspace,
      contextRef: context.id,
    });
    await until(() => calls === 1);
    await broker.send({
      taskId: task.taskId,
      requestId: randomUUID(),
      message: "queued context",
      contextRef: context.id,
    });
    await writeFile(
      join(dir, "policy.json"),
      JSON.stringify({ version: 1, contextSharing: false }),
    );
    finish();
    await until(async () => (await broker.status(task.taskId)).status === "failed");
    expect(calls).toBe(1);
    expect((await broker.status(task.taskId)).error).toContain("disabled before");
  });

  it("does not reuse an old-version daemon or spawn a duplicate", async () => {
    const dir = await directory();
    const server = createServer((_request, response) =>
      response.end(JSON.stringify({ result: { version: "older-version", pid: process.pid } })),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(resolve as () => void);
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const manifest: DaemonManifest = {
      version: 1,
      pid: process.pid,
      port: address.port,
      token: "a".repeat(64),
    };
    await writeManifest(manifest, dir);
    await expect(
      ensureDaemon({ directory: dir, daemonPath: "must-not-run", startupTimeoutMs: 500 }),
    ).rejects.toThrow("different personal bridge version");
    expect(await readManifest(dir)).toEqual(manifest);
  });

  it("releases the bootstrap lock promptly when a daemon exits during startup", async () => {
    const dir = await directory();
    const script = join(dir, "crash.mjs");
    await writeFile(script, "process.exit(17);");
    await expect(
      ensureDaemon({
        directory: dir,
        daemonPath: script,
        startupTimeoutMs: 1500,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("exited during startup");
    await expect(readFile(join(dir, "bootstrap.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares one real daemon between concurrent clients, checks auth, and confirms stop", async () => {
    const dir = await directory();
    const options = {
      directory: dir,
      daemonPath: resolve("dist/personal-daemon.mjs"),
      startupTimeoutMs: 10000,
      pollIntervalMs: 20,
    };
    const manifests = await Promise.all(Array.from({ length: 10 }, () => ensureDaemon(options)));
    const manifest = manifests[0];
    cleanup.push(async () => {
      if (pidAlive(manifest.pid))
        await stopDaemon(manifest, dir).catch(() => {
          process.kill(manifest.pid);
        });
    });
    expect(new Set(manifests.map((item) => item.pid)).size).toBe(1);
    expect(new Set(manifests.map((item) => item.token)).size).toBe(1);
    expect(await daemonRequest(manifest, "ping")).toMatchObject({
      version: PERSONAL_VERSION,
      pid: manifest.pid,
    });
    const badAuth = await fetch(`http://127.0.0.1:${manifest.port}/rpc`, {
      method: "POST",
      body: "{}",
    });
    expect(badAuth.status).toBe(403);
    const origin = await fetch(`http://127.0.0.1:${manifest.port}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${manifest.token}`, Origin: "https://example.invalid" },
      body: "{}",
    });
    expect(origin.status).toBe(403);
    const invalid = await fetch(`http://127.0.0.1:${manifest.port}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${manifest.token}` },
      body: JSON.stringify({ method: "agent_wait", args: { taskId: "x", timeoutMs: "100" } }),
    });
    expect(invalid.status).toBe(400);
    expect(await daemonRequest(manifest, "agent_list")).toEqual([]);
    await stopDaemon(manifest, dir);
    expect(pidAlive(manifest.pid)).toBe(false);
    expect(await readManifest(dir)).toBeNull();
  }, 20000);

  it("prints the actual bundled context-hook path and rejects unknown control options", async () => {
    const result = await runNode([resolve("dist/personal-control.mjs"), "--print-config"]);
    expect(result.code).toBe(0);
    const config = JSON.parse(result.stdout);
    expect(config.hook.PreToolUse[0].hooks[0].command.replaceAll("\\", "/")).toContain(
      "/personal/context-hook.mjs",
    );
    const invalid = await runNode([resolve("dist/personal-control.mjs"), "--mistyped"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Unknown");
  });
});
