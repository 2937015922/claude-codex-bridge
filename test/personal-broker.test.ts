import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentBroker } from "../src/personal/broker.js";
import { createContextSnapshot } from "../src/personal/context.js";
import type {
  AgentProvider,
  ContextSnapshot,
  ProviderRequest,
  ProviderResult,
} from "../src/personal/types.js";

interface Call {
  request: ProviderRequest;
  emit: (type: string, data: unknown) => void;
  finish: (
    text?: string,
    status?: ProviderResult["status"],
    extra?: Partial<ProviderResult>,
  ) => void;
  fail: (error: Error) => void;
}
class ControlledProvider implements AgentProvider {
  calls: Call[] = [];
  active = 0;
  maximum = 0;
  run(
    request: ProviderRequest,
    emit: (type: string, data: unknown) => void,
  ): Promise<ProviderResult> {
    this.active++;
    this.maximum = Math.max(this.maximum, this.active);
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (
        text = "answer",
        status: ProviderResult["status"] = "completed",
        extra: Partial<ProviderResult> = {},
      ) => {
        if (finished) return;
        finished = true;
        this.active--;
        resolve({ sessionId: request.sessionId, text, status, ...extra });
      };
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        this.active--;
        reject(error);
      };
      this.calls.push({ request, emit, finish, fail });
      request.signal.addEventListener("abort", () => finish("", "interrupted"), { once: true });
    });
  }
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function until(check: () => boolean | Promise<boolean>, timeout = 6000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for broker state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(maxConcurrency = 2) {
  const base = await mkdtemp(join(tmpdir(), "personal-broker-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "workspace");
  const stateDirectory = join(base, "state");
  await mkdir(directory);
  const contexts = new Map<string, ContextSnapshot>();
  const context: ContextSnapshot = {
    version: 1,
    id: "ctx_" + "a".repeat(64),
    parentThreadId: "parent-a",
    workingDirectory: directory,
    createdAt: new Date().toISOString(),
    revision: "a".repeat(64),
    source: "synthetic",
    text: "PRIVATE_PARENT_CONTEXT",
    coverage: { messages: 1, toolResults: 0, instructions: 1 },
    omissions: [],
  };
  contexts.set(context.id, context);
  const provider = new ControlledProvider();
  const options = {
    stateDirectory,
    provider,
    maxConcurrency,
    contextStore: {
      async read(id: string) {
        const value = contexts.get(id);
        if (!value) throw new Error("Unknown context");
        return value;
      },
    },
  };
  const broker = new AgentBroker(options);
  await broker.init();
  cleanup.push(() => broker.shutdown().catch(() => undefined));
  const request = (requestId: string) => ({
    requestId,
    task: "PRIVATE_TASK_GOAL",
    workingDirectory: directory,
    contextRef: context.id,
  });
  return { base, directory, stateDirectory, contexts, context, provider, options, broker, request };
}

describe("personal AgentBroker", () => {
  it("freezes context, validates identity/directory/parent/revision and hides private prompts", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("start"));
    await until(() => f.provider.calls.length === 1);
    const call = f.provider.calls[0];
    f.context.text = "MUTATED_AFTER_START";
    expect(call.request.prompt).toContain("PRIVATE_PARENT_CONTEXT");
    expect(call.request.prompt).not.toContain("MUTATED_AFTER_START");
    const status = await f.broker.status(task.taskId);
    expect(JSON.stringify(status)).not.toContain("PRIVATE_PARENT_CONTEXT");
    expect(JSON.stringify(status)).not.toContain("PRIVATE_TASK_GOAL");
    expect(await f.broker.list("other-parent")).toEqual([]);
    await expect(
      f.broker.send({ taskId: task.taskId, requestId: "no-context", message: "next" }),
    ).rejects.toThrow("contextRef is required");
    const foreign = {
      ...f.context,
      id: "ctx_" + "b".repeat(64),
      parentThreadId: "parent-b",
      revision: "b".repeat(64),
    };
    f.contexts.set(foreign.id, foreign);
    await expect(
      f.broker.send({
        taskId: task.taskId,
        requestId: "foreign",
        message: "next",
        contextRef: foreign.id,
      }),
    ).rejects.toThrow("different parent");
    const anotherDirectory = join(f.base, "other");
    await mkdir(anotherDirectory);
    await expect(
      f.broker.start({ ...f.request("wrong-directory"), workingDirectory: anotherDirectory }),
    ).rejects.toThrow("workingDirectory");
    await expect(
      f.broker.send({
        taskId: task.taskId,
        requestId: "wrong-send-directory",
        message: "next",
        contextRef: f.context.id,
        workingDirectory: anotherDirectory,
      }),
    ).rejects.toThrow("workingDirectory");
    f.context.revision = "c".repeat(64);
    await expect(
      f.broker.send({
        taskId: task.taskId,
        requestId: "mutated-ref",
        message: "next",
        contextRef: f.context.id,
      }),
    ).rejects.toThrow("revision changed");
    expect(f.provider.calls).toHaveLength(1);
  });

  it("requires context by default but permits explicitly context-free tasks", async () => {
    const f = await fixture();
    await expect(
      f.broker.start({ requestId: "missing", task: "Discuss", workingDirectory: f.directory }),
    ).rejects.toThrow("contextRef is required");
    const task = await f.broker.start({
      requestId: "explicit",
      task: "Discuss",
      workingDirectory: f.directory,
      requireContext: false,
    });
    await until(() => f.provider.calls.length === 1);
    expect(task.parentThreadId).toBeUndefined();
    expect(f.provider.calls[0].request.prompt).toContain("No parent context");
  });

  it("deduplicates start/send keys and rejects a reused key with changed payload", async () => {
    const f = await fixture();
    const [first, repeated] = await Promise.all([
      f.broker.start(f.request("start")),
      f.broker.start(f.request("start")),
    ]);
    expect(first.taskId).toBe(repeated.taskId);
    await until(() => f.provider.calls.length === 1);
    await expect(f.broker.start({ ...f.request("start"), task: "Different task" })).rejects.toThrow(
      "Idempotency conflict",
    );
    const send = {
      taskId: first.taskId,
      requestId: "send",
      message: "follow up",
      contextRef: f.context.id,
    };
    await Promise.all([f.broker.send(send), f.broker.send(send)]);
    expect((await f.broker.status(first.taskId)).requests).toHaveLength(2);
    await expect(f.broker.send({ ...send, message: "different follow up" })).rejects.toThrow(
      "Idempotency conflict",
    );
    f.provider.calls[0].finish();
    await until(() => f.provider.calls.length === 2);
    expect(f.provider.calls[1].request.resume).toBe(true);
    expect(f.provider.calls[1].request.sessionId).toBe(first.sessionId);
    f.provider.calls[1].finish();
    await until(async () => (await f.broker.status(first.taskId)).status === "completed");
  });

  it("reuses accepted start/send requests after hook recaptures without replacing their context", async () => {
    const f = await fixture();
    const initial = createContextSnapshot({ ...f.context, createdAt: "2026-10-02T00:00:00.000Z" });
    const recaptured = createContextSnapshot({ ...initial, createdAt: "2026-10-02T00:00:01.000Z" });
    const updated = createContextSnapshot({
      ...initial,
      createdAt: "2026-10-02T00:00:02.000Z",
      text: "NEW_PARENT_HISTORY",
    });
    for (const context of [initial, recaptured, updated]) f.contexts.set(context.id, context);
    expect(recaptured.id).not.toBe(initial.id);
    expect(recaptured.revision).toBe(initial.revision);
    expect(updated.revision).not.toBe(initial.revision);

    const start = { ...f.request("recaptured-start"), contextRef: initial.id };
    const task = await f.broker.start(start);
    await until(() => f.provider.calls.length === 1);
    const send = {
      taskId: task.taskId,
      requestId: "recaptured-send",
      message: "Accepted message",
      contextRef: initial.id,
    };
    await f.broker.send(send);
    for (const contextRef of [recaptured.id, updated.id]) {
      expect((await f.broker.start({ ...start, contextRef })).taskId).toBe(task.taskId);
      expect((await f.broker.send({ ...send, contextRef })).requests).toHaveLength(2);
    }
    const unchanged = await f.broker.status(task.taskId);
    expect(unchanged.contextRevision).toBe(initial.revision);
    expect(
      unchanged.requests.every((request) => request.contextRevision === initial.revision),
    ).toBe(true);
    const persisted = JSON.parse(
      await readFile(join(f.stateDirectory, "task-" + task.taskId + ".json"), "utf8"),
    );
    expect(
      persisted.requests.every(
        (request: { contextRef: string; prompt: string }) =>
          request.contextRef === initial.id && !request.prompt.includes("NEW_PARENT_HISTORY"),
      ),
    ).toBe(true);
    f.provider.calls[0].finish();
    await until(() => f.provider.calls.length === 2);
    expect(f.provider.calls[1].request.prompt).not.toContain("NEW_PARENT_HISTORY");
    f.provider.calls[1].finish();
    await until(async () => (await f.broker.status(task.taskId)).status === "completed");

    await f.broker.shutdown();
    const provider = new ControlledProvider();
    const restored = new AgentBroker({ ...f.options, provider });
    cleanup.push(() => restored.shutdown());
    await restored.init();
    expect((await restored.start({ ...start, contextRef: updated.id })).taskId).toBe(task.taskId);
    expect((await restored.send({ ...send, contextRef: updated.id })).requests).toHaveLength(2);
    expect(provider.calls).toHaveLength(0);
    await restored.send({ ...send, requestId: "explicit-new-history", contextRef: updated.id });
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0].request.prompt).toContain("NEW_PARENT_HISTORY");
  });

  it("preserves legacy accepted keys across context recapture after upgrade", async () => {
    const f = await fixture();
    const start = f.request("legacy-start");
    const task = await f.broker.start(start);
    await until(() => f.provider.calls.length === 1);
    const send = {
      taskId: task.taskId,
      requestId: "legacy-send",
      message: "Legacy message",
      contextRef: f.context.id,
    };
    await f.broker.send(send);
    f.provider.calls[0].finish();
    await until(() => f.provider.calls.length === 2);
    f.provider.calls[1].finish();
    await until(async () => (await f.broker.status(task.taskId)).status === "completed");
    await f.broker.shutdown();
    const path = join(f.stateDirectory, "task-" + task.taskId + ".json");
    const record = JSON.parse(await readFile(path, "utf8"));
    const directory =
      process.platform === "win32"
        ? record.workingDirectory.toLowerCase()
        : record.workingDirectory;
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    record.requests[0].fingerprint = hash({
      kind: "start",
      requestId: start.requestId,
      task: start.task,
      directory,
      model: "opus",
      maxTurns: 12,
      profile: "discussion",
      requireContext: true,
      contextRef: f.context.id,
    });
    record.requests[1].fingerprint = hash({
      kind: "send",
      taskId: task.taskId,
      requestId: send.requestId,
      message: send.message,
      directory,
      contextRef: f.context.id,
    });
    await writeFile(path, JSON.stringify(record));
    const updated = createContextSnapshot({ ...f.context, text: "New history after upgrade" });
    f.contexts.set(updated.id, updated);
    const provider = new ControlledProvider();
    const restored = new AgentBroker({ ...f.options, provider });
    cleanup.push(() => restored.shutdown());
    expect((await restored.start({ ...start, contextRef: updated.id })).taskId).toBe(task.taskId);
    expect((await restored.send({ ...send, contextRef: updated.id })).requests).toHaveLength(2);
    expect(provider.calls).toHaveLength(0);
  });

  it("verifies context bindings on idempotent retries and rejects foreign parents or directories", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("bound-start"));
    const send = {
      taskId: task.taskId,
      requestId: "bound-send",
      message: "same message",
      contextRef: f.context.id,
    };
    await f.broker.send(send);
    const foreign = createContextSnapshot({ ...f.context, parentThreadId: "foreign-parent" });
    f.contexts.set(foreign.id, foreign);
    await expect(
      f.broker.start({ ...f.request("bound-start"), contextRef: foreign.id }),
    ).rejects.toThrow("different parent");
    await expect(f.broker.send({ ...send, contextRef: foreign.id })).rejects.toThrow(
      "different parent",
    );
    const otherDirectory = join(f.base, "foreign-workspace");
    await mkdir(otherDirectory);
    const wrongDirectory = createContextSnapshot({
      ...f.context,
      workingDirectory: otherDirectory,
    });
    f.contexts.set(wrongDirectory.id, wrongDirectory);
    await expect(
      f.broker.start({ ...f.request("bound-start"), contextRef: wrongDirectory.id }),
    ).rejects.toThrow("workingDirectory");
    await expect(f.broker.send({ ...send, contextRef: wrongDirectory.id })).rejects.toThrow(
      "workingDirectory",
    );
    await expect(
      f.broker.start({ ...f.request("bound-start"), contextRef: "ctx_missing" }),
    ).rejects.toThrow("Unknown context");
    await expect(f.broker.send({ ...send, contextRef: undefined })).rejects.toThrow(
      "contextRef is required",
    );
    f.context.revision = "f".repeat(64);
    await expect(f.broker.start(f.request("bound-start"))).rejects.toThrow("revision changed");
    await expect(f.broker.send(send)).rejects.toThrow("revision changed");
    expect((await f.broker.status(task.taskId)).requests).toHaveLength(2);
  });

  it("serializes messages within a session and caps concurrent sessions", async () => {
    const f = await fixture(2);
    const first = await f.broker.start(f.request("one"));
    await f.broker.send({
      taskId: first.taskId,
      requestId: "follow-1",
      message: "FIRST_FOLLOWUP",
      contextRef: f.context.id,
    });
    await f.broker.send({
      taskId: first.taskId,
      requestId: "follow-2",
      message: "SECOND_FOLLOWUP",
      contextRef: f.context.id,
    });
    const second = await f.broker.start(f.request("two"));
    await f.broker.start(f.request("three"));
    await until(() => f.provider.calls.length === 2);
    expect(f.provider.calls[0].request.sessionId).not.toBe(f.provider.calls[1].request.sessionId);
    const firstCall = f.provider.calls.find((call) => call.request.sessionId === first.sessionId)!;
    firstCall.finish();
    await until(() => f.provider.calls.length === 3);
    expect(f.provider.calls[2].request.prompt).toContain("FIRST_FOLLOWUP");
    f.provider.calls[2].finish();
    await until(() => f.provider.calls.length === 4);
    expect(f.provider.calls[3].request.prompt).toContain("SECOND_FOLLOWUP");
    f.provider.calls[3].finish();
    await until(() => f.provider.calls.length === 5);
    expect(f.provider.maximum).toBe(2);
    expect(
      f.provider.calls.filter((call) => call.request.sessionId === first.sessionId),
    ).toHaveLength(3);
    expect((await f.broker.status(second.taskId)).status).toBe("running");
  });

  it("persists provider_init before a failed turn so a later explicit send resumes it", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("initial"));
    await until(() => f.provider.calls.length === 1);
    f.provider.calls[0].emit("provider_init", { sessionId: task.sessionId, model: "opus" });
    f.provider.calls[0].finish("partial", "failed");
    await until(async () => (await f.broker.status(task.taskId)).status === "failed");
    await f.broker.send({
      taskId: task.taskId,
      requestId: "explicit-followup",
      message: "Inspect the partial result",
      contextRef: f.context.id,
    });
    await until(() => f.provider.calls.length === 2);
    expect(f.provider.calls[1].request.resume).toBe(true);
    expect(f.provider.calls[1].request.sessionId).toBe(task.sessionId);
  });

  it("returns bounded event pages with gap detection and never leaks prompt fields", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("events"));
    await until(() => f.provider.calls.length === 1);
    for (let index = 0; index < 215; index++)
      f.provider.calls[0].emit("progress", {
        index,
        prompt: "PRIVATE_PROMPT",
        content: index === 0 ? "x".repeat(20000) : "working",
      });
    f.provider.calls[0].finish("finished");
    await until(async () => (await f.broker.status(task.taskId)).status === "completed", 15000);
    const page = await f.broker.wait(task.taskId, 0, 0);
    expect(page.gap).toBe(true);
    expect(page.events).toHaveLength(40);
    expect(page.hasMore).toBe(true);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_PROMPT");
    const next = await f.broker.wait(task.taskId, page.nextCursor, 0);
    expect(next.events[0].sequence).toBe(page.nextCursor + 1);
    await expect(f.broker.wait(task.taskId, 999999, 0)).rejects.toThrow("ahead");
    const file = JSON.parse(
      await readFile(join(f.stateDirectory, "task-" + task.taskId + ".json"), "utf8"),
    );
    expect(file.events).toHaveLength(200);
  }, 20000);

  it("wait timeout leaves the worker alive and later events wake waiters", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("wait"));
    await until(() => f.provider.calls.length === 1);
    const running = await f.broker.status(task.taskId);
    const timeout = await f.broker.wait(task.taskId, running.latestCursor, 15);
    expect(timeout.timedOut).toBe(true);
    expect(f.provider.calls[0].request.signal.aborted).toBe(false);
    const waiting = f.broker.wait(task.taskId, timeout.nextCursor, 2000);
    f.provider.calls[0].emit("progress", { text: "arrived" });
    expect((await waiting).events.at(-1)?.type).toBe("progress");
  });

  it("interrupt cancels current and queued requests; close rejects new messages", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("interrupt"));
    await until(() => f.provider.calls.length === 1);
    await f.broker.send({
      taskId: task.taskId,
      requestId: "queued",
      message: "never run this",
      contextRef: f.context.id,
    });
    const acknowledgement = await f.broker.interrupt(task.taskId);
    expect(acknowledgement.cancellationRequested).toBe(true);
    expect(f.provider.calls[0].request.signal.aborted).toBe(true);
    await until(async () => (await f.broker.status(task.taskId)).status === "interrupted");
    expect((await f.broker.status(task.taskId)).requests.map((request) => request.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(f.provider.calls).toHaveLength(1);
    expect((await f.broker.close(task.taskId)).status).toBe("closed");
    await expect(
      f.broker.send({
        taskId: task.taskId,
        requestId: "after-close",
        message: "no",
        contextRef: f.context.id,
      }),
    ).rejects.toThrow("closed");
  });

  it("restores completed session identity and idempotency across broker instances", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("persistent"));
    await until(() => f.provider.calls.length === 1);
    f.provider.calls[0].finish("saved result");
    await until(async () => (await f.broker.status(task.taskId)).status === "completed");
    await f.broker.shutdown();
    const provider = new ControlledProvider();
    const restored = new AgentBroker({ ...f.options, provider });
    cleanup.push(() => restored.shutdown());
    await restored.init();
    expect((await restored.start(f.request("persistent"))).taskId).toBe(task.taskId);
    expect(provider.calls).toHaveLength(0);
    await restored.send({
      taskId: task.taskId,
      requestId: "after-restart",
      message: "continue",
      contextRef: f.context.id,
    });
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0].request.sessionId).toBe(task.sessionId);
    expect(provider.calls[0].request.resume).toBe(true);
  });

  it("recovers interrupted persistence as unknown and never automatically replays requests", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("crash"));
    await until(() => f.provider.calls.length === 1);
    f.provider.calls[0].finish();
    await until(async () => (await f.broker.status(task.taskId)).status === "completed");
    await f.broker.shutdown();
    const path = join(f.stateDirectory, "task-" + task.taskId + ".json");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.status = "running";
    persisted.requests[0].status = "running";
    persisted.requests.push({
      ...persisted.requests[0],
      requestId: "queued-before-crash",
      kind: "send",
      status: "queued",
    });
    await writeFile(path, JSON.stringify(persisted));
    const provider = new ControlledProvider();
    const restored = new AgentBroker({ ...f.options, provider });
    cleanup.push(() => restored.shutdown());
    await restored.init();
    const state = await restored.status(task.taskId);
    expect(state.status).toBe("unknown");
    expect(state.sessionId).toBe(task.sessionId);
    expect(state.requests.every((request) => request.status === "unknown")).toBe(true);
    expect(provider.calls).toHaveLength(0);
    await expect(
      restored.send({
        taskId: task.taskId,
        requestId: "retry",
        message: "retry",
        contextRef: f.context.id,
      }),
    ).rejects.toThrow("unknown");
    expect((await restored.start(f.request("crash"))).status).toBe("unknown");
  });

  it("refuses a second active owner instead of allowing concurrent file writers", async () => {
    const f = await fixture();
    const other = new AgentBroker(f.options);
    await expect(other.init()).rejects.toThrow("active or unverifiable owner");
    expect(await readdir(f.stateDirectory)).toContain(".broker-owner.json");
  });

  it("does not replay queued messages after an unexpected provider transport exception", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("provider-exception"));
    await until(() => f.provider.calls.length === 1);
    await f.broker.send({
      taskId: task.taskId,
      requestId: "queued",
      message: "do not replay",
      contextRef: f.context.id,
    });
    f.provider.calls[0].fail(new Error("Transport disconnected after submitting work"));
    await until(async () => (await f.broker.status(task.taskId)).status === "unknown");
    const state = await f.broker.status(task.taskId);
    expect(state.requests.map((request) => request.status)).toEqual(["unknown", "unknown"]);
    expect(f.provider.calls).toHaveLength(1);
    await expect(
      f.broker.send({
        taskId: task.taskId,
        requestId: "retry",
        message: "retry",
        contextRef: f.context.id,
      }),
    ).rejects.toThrow("unknown");
  });

  it("blocks queued work when a stopped provider cannot establish the execution outcome", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("unknown-protocol-outcome"));
    await until(() => f.provider.calls.length === 1);
    await f.broker.send({
      taskId: task.taskId,
      requestId: "queued",
      message: "do not replay",
      contextRef: f.context.id,
    });
    f.provider.calls[0].finish("", "failed", {
      outcomeUnknown: true,
      terminationConfirmed: true,
      error: "Stream ended without a terminal result",
    });
    await until(async () => (await f.broker.status(task.taskId)).status === "unknown");
    const state = await f.broker.status(task.taskId);
    expect(state.error).toContain("Stream ended without a terminal result");
    expect(state.error).not.toContain("termination is unconfirmed");
    expect(state.requests.map((request) => request.status)).toEqual(["unknown", "unknown"]);
    expect(f.provider.calls).toHaveLength(1);
    await expect(
      f.broker.send({
        taskId: task.taskId,
        requestId: "retry",
        message: "retry",
        contextRef: f.context.id,
      }),
    ).rejects.toThrow("unknown");
  });

  it("blocks the session when process-tree termination cannot be confirmed", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("uncertain-termination"));
    await until(() => f.provider.calls.length === 1);
    await f.broker.send({
      taskId: task.taskId,
      requestId: "queued",
      message: "do not run concurrently",
      contextRef: f.context.id,
    });
    f.provider.calls[0].finish("", "interrupted", {
      terminationConfirmed: false,
      error: "Provider timed out",
    });
    await until(async () => (await f.broker.status(task.taskId)).status === "unknown");
    const state = await f.broker.status(task.taskId);
    expect(state.error).toContain("Provider timed out");
    expect(state.error).toContain("termination is unconfirmed");
    expect(state.requests.map((request) => request.status)).toEqual(["unknown", "unknown"]);
    await expect(
      f.broker.send({
        taskId: task.taskId,
        requestId: "after-timeout",
        message: "continue",
        contextRef: f.context.id,
      }),
    ).rejects.toThrow("unknown");
    expect(f.provider.calls).toHaveLength(1);
  });

  it("does not acknowledge accepted work when persistence fails and aborts active workers", async () => {
    const f = await fixture();
    const task = await f.broker.start(f.request("disk-failure"));
    await until(() => f.provider.calls.length === 1);
    const ownerPath = join(f.stateDirectory, ".broker-owner.json");
    const originalOwner = await readFile(ownerPath, "utf8");
    await writeFile(
      ownerPath,
      JSON.stringify({ ...JSON.parse(originalOwner), token: "foreign-owner" }),
    );
    try {
      await expect(
        f.broker.send({
          taskId: task.taskId,
          requestId: "must-not-ack",
          message: "change",
          contextRef: f.context.id,
        }),
      ).rejects.toThrow("owner changed");
      expect(f.provider.calls[0].request.signal.aborted).toBe(true);
      await expect(f.broker.status(task.taskId)).rejects.toThrow("persistence is unavailable");
      const persisted = JSON.parse(
        await readFile(join(f.stateDirectory, "task-" + task.taskId + ".json"), "utf8"),
      );
      expect(
        persisted.requests.some(
          (request: { requestId: string }) => request.requestId === "must-not-ack",
        ),
      ).toBe(false);
    } finally {
      await writeFile(ownerPath, originalOwner);
    }
  });
});
