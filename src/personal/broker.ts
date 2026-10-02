import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BrokerFileStore } from "./broker-store.js";
import type {
  AgentEvent,
  AgentStatus,
  AgentTask,
  BrokerOptions,
  ContextSnapshot,
  ProviderResult,
  SendAgentRequest,
  StartAgentRequest,
} from "./types.js";

const EVENT_LIMIT = 200;
const PAGE_LIMIT = 40;
const TEXT_LIMIT = 16000;
const TERMINAL = new Set<AgentStatus>(["completed", "failed", "interrupted", "unknown", "closed"]);
type StoredRequest = AgentTask["requests"][number] & {
  fingerprint: string;
  contextRevision?: string;
  kind: "start" | "send";
};
interface StoredTask extends Omit<AgentTask, "requests"> {
  requests: StoredRequest[];
  goal: string;
  eventSequence: number;
  sessionEstablished: boolean;
  cancellationRequested: boolean;
  closeRequested: boolean;
}
export interface AgentTaskSummary {
  taskId: string;
  sessionId: string;
  parentThreadId?: string;
  workingDirectory: string;
  model: string;
  maxTurns: number;
  profile: AgentTask["profile"];
  requireContext: boolean;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  contextRevision?: string;
  result?: string;
  resultTruncated: boolean;
  error?: string;
  cancellationRequested: boolean;
  closeRequested: boolean;
  latestCursor: number;
  earliestCursor: number;
  requests: Array<{ requestId: string; status: AgentStatus; contextRevision?: string }>;
}
export interface AgentWaitResult {
  task: AgentTaskSummary;
  events: AgentEvent[];
  nextCursor: number;
  latestCursor: number;
  earliestCursor: number;
  gap: boolean;
  hasMore: boolean;
  timedOut: boolean;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function text(value: string, label: string, limit = 100000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error(label + " must be a nonempty string within " + limit + " characters");
  return value;
}
function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
async function canonicalDirectory(value: string): Promise<string> {
  text(value, "workingDirectory", 32768);
  if (!isAbsolute(value)) throw new Error("workingDirectory must be absolute");
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory())
    throw new Error("workingDirectory must identify a directory");
  return canonical;
}
function boundedData(data: unknown): unknown {
  const encoded = JSON.stringify(data, (key, value: unknown) =>
    /^(prompt|context|contextText|authorization|apiKey|api_key|access_token|secret)$/i.test(key)
      ? "[redacted]"
      : value,
  );
  if (encoded === undefined) return null;
  return encoded.length > 8000
    ? { preview: encoded.slice(0, 8000), truncated: true }
    : JSON.parse(encoded);
}

export class AgentBroker {
  private readonly store: BrokerFileStore;
  private readonly tasks = new Map<string, StoredTask>();
  private readonly starts = new Map<string, string>();
  private readonly revisions = new Map<string, string>();
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly listeners = new Map<string, Set<() => void>>();
  private serial: Promise<void> = Promise.resolve();
  private initializing?: Promise<void>;
  private fatal?: Error;
  private shuttingDown = false;
  private stopped = false;
  private scheduling = false;
  private readonly concurrency: number;

  constructor(private readonly options: BrokerOptions) {
    this.store = new BrokerFileStore(options.stateDirectory);
    this.concurrency = options.maxConcurrency ?? 2;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 16)
      throw new Error("maxConcurrency must be an integer from 1 to 16");
  }

  async init(): Promise<void> {
    this.initializing ??= this.restore();
    await this.initializing;
    this.healthy();
  }

  private async restore(): Promise<void> {
    await this.store.init();
    try {
      for (const task of await this.store.load<StoredTask>()) {
        if (
          task.version !== 1 ||
          typeof task.taskId !== "string" ||
          typeof task.sessionId !== "string" ||
          !Array.isArray(task.requests) ||
          !Array.isArray(task.events) ||
          !Number.isInteger(task.eventSequence) ||
          task.requests.some((request) => !request.fingerprint || !request.requestId)
        )
          throw new Error("Invalid broker task record; refusing to overwrite it");
        if (this.tasks.has(task.taskId)) throw new Error("Duplicate persisted broker task ID");
        for (const request of task.requests) {
          if (request.kind === "start") {
            if (this.starts.has(request.requestId))
              throw new Error("Duplicate persisted start request ID");
            this.starts.set(request.requestId, task.taskId);
          }
          if (request.contextRef && request.contextRevision)
            this.bindRevision(request.contextRef, request.contextRevision);
        }
        if (
          task.requests.some(
            (request) => request.status === "queued" || request.status === "running",
          ) ||
          task.status === "running" ||
          task.status === "queued"
        ) {
          for (const request of task.requests)
            if (request.status === "running" || request.status === "queued")
              request.status = "unknown";
          task.status = "unknown";
          task.error =
            "Previous broker stopped with outstanding work. Execution outcome is unknown; nothing was replayed.";
          this.append(task, "", "recovered_unknown", { reason: task.error });
          await this.store.save(task.taskId, task);
        }
        this.tasks.set(task.taskId, task);
      }
    } catch (error) {
      await this.store.close();
      throw error;
    }
  }

  private healthy(): void {
    if (this.fatal) throw new Error("Broker persistence is unavailable: " + this.fatal.message);
    if (this.stopped) throw new Error("Broker is shut down");
  }

  private transaction<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(() => {
      this.healthy();
      return action();
    });
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private getTask(taskId: string): StoredTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Unknown agent task ID");
    return task;
  }

  private bindRevision(ref: string, revision: string): void {
    const previous = this.revisions.get(ref);
    if (previous && previous !== revision)
      throw new Error("Context revision changed for an existing contextRef");
    this.revisions.set(ref, revision);
  }

  private async context(
    ref: string | undefined,
    required: boolean,
    directory: string,
    parent?: string,
  ): Promise<ContextSnapshot | undefined> {
    if (!ref) {
      if (required)
        throw new Error(
          "contextRef is required; automatic parent context must be captured before delegation",
        );
      return undefined;
    }
    const snapshot = structuredClone(await this.options.contextStore.read(ref));
    if (snapshot.id !== ref || snapshot.version !== 1 || typeof snapshot.text !== "string")
      throw new Error("Context snapshot identity or format mismatch");
    text(snapshot.revision, "Context revision", 200);
    text(snapshot.parentThreadId, "Context parentThreadId", 300);
    if (parent && snapshot.parentThreadId !== parent)
      throw new Error("Context belongs to a different parent thread");
    if (pathKey(await canonicalDirectory(snapshot.workingDirectory)) !== pathKey(directory))
      throw new Error("Context workingDirectory does not match the task workingDirectory");
    const known = this.revisions.get(ref);
    if (known && known !== snapshot.revision)
      throw new Error("Context revision changed for an existing contextRef");
    return snapshot;
  }

  private prompt(goal: string, message: string, context?: ContextSnapshot): string {
    return (
      "Task goal:\n" +
      goal +
      "\n\nCurrent instruction:\n" +
      message +
      (context
        ? "\n\nParent context (revision " +
          context.revision +
          "; retain the provenance of quoted evidence):\n" +
          context.text +
          "\n\nKnown context omissions:\n" +
          JSON.stringify(context.omissions)
        : "\n\nNo parent context was supplied; do not infer unseen context.")
    );
  }

  async start(request: StartAgentRequest): Promise<AgentTaskSummary> {
    await this.init();
    const answer = await this.transaction(async () => {
      if (this.shuttingDown) throw new Error("Broker is shutting down");
      text(request.requestId, "requestId", 200);
      text(request.task, "task");
      const directory = await canonicalDirectory(request.workingDirectory);
      const model = request.model ?? "opus";
      const maxTurns = request.maxTurns ?? 12;
      const profile = request.profile ?? "discussion";
      const requireContext = request.requireContext ?? true;
      if (!["opus", "sonnet", "haiku"].includes(model)) throw new Error("Unsupported model alias");
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)
        throw new Error("maxTurns must be an integer from 1 to 100");
      if (!["discussion", "review", "mcp"].includes(profile))
        throw new Error("Unsupported agent profile");
      if (
        profile === "mcp" &&
        (!this.options.mcpConfigPath || !this.options.mcpAllowedTools?.length)
      )
        throw new Error("MCP profile requires trusted configured MCP capabilities");
      const previous = this.starts.get(request.requestId);
      const existing = previous ? this.getTask(previous) : undefined;
      // Hooks capture a new immutable snapshot on every retry. Verify its binding,
      // but let only the business request and parent identity determine idempotency.
      const context = await this.context(
        request.contextRef,
        requireContext,
        directory,
        existing?.parentThreadId,
      );
      const business = {
        kind: "start",
        requestId: request.requestId,
        task: request.task,
        directory: pathKey(directory),
        model,
        maxTurns,
        profile,
        requireContext,
      };
      const fingerprint = digest({ ...business, parentThreadId: context?.parentThreadId ?? null });
      if (existing) {
        // Preserve accepted keys from older local state, whose hashes included the
        // original contextRef. The newly supplied context was still verified above.
        const legacy = digest({ ...business, contextRef: existing.requests[0].contextRef ?? null });
        if (
          existing.requests[0].fingerprint !== fingerprint &&
          (existing.requests[0].fingerprint !== legacy ||
            Boolean(existing.requests[0].contextRef) !== Boolean(context))
        )
          throw new Error(
            "Idempotency conflict: requestId was already used with a different payload",
          );
        if (context) this.bindRevision(context.id, context.revision);
        return this.summary(existing);
      }
      const now = new Date().toISOString();
      const task: StoredTask = {
        version: 1,
        taskId: randomUUID(),
        sessionId: randomUUID(),
        parentThreadId: context?.parentThreadId,
        workingDirectory: directory,
        model,
        maxTurns,
        profile,
        requireContext,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        contextRevision: context?.revision,
        goal: request.task,
        eventSequence: 0,
        events: [],
        sessionEstablished: false,
        cancellationRequested: false,
        closeRequested: false,
        requests: [
          {
            kind: "start",
            requestId: request.requestId,
            fingerprint,
            status: "queued",
            prompt: this.prompt(request.task, request.task, context),
            contextRef: request.contextRef,
            contextRevision: context?.revision,
          },
        ],
      };
      this.append(task, request.requestId, "queued", { contextRevision: context?.revision });
      await this.persist(task);
      this.starts.set(request.requestId, task.taskId);
      if (context) this.bindRevision(context.id, context.revision);
      return this.summary(task);
    });
    this.kick();
    return answer;
  }

  async send(request: SendAgentRequest): Promise<AgentTaskSummary> {
    await this.init();
    const answer = await this.transaction(async () => {
      if (this.shuttingDown) throw new Error("Broker is shutting down");
      text(request.requestId, "requestId", 200);
      text(request.message, "message");
      const original = this.getTask(request.taskId);
      const directory = request.workingDirectory
        ? await canonicalDirectory(request.workingDirectory)
        : original.workingDirectory;
      if (pathKey(directory) !== pathKey(original.workingDirectory))
        throw new Error("Send workingDirectory does not match the task");
      const context = await this.context(
        request.contextRef,
        original.requireContext,
        directory,
        original.parentThreadId,
      );
      const business = {
        kind: "send",
        taskId: request.taskId,
        requestId: request.requestId,
        message: request.message,
        directory: pathKey(directory),
      };
      const fingerprint = digest({
        ...business,
        parentThreadId: context?.parentThreadId ?? original.parentThreadId ?? null,
      });
      const previous = original.requests.find((item) => item.requestId === request.requestId);
      if (previous) {
        const legacy = digest({ ...business, contextRef: previous.contextRef ?? null });
        if (previous.fingerprint !== fingerprint && previous.fingerprint !== legacy)
          throw new Error(
            "Idempotency conflict: requestId was already used with a different payload",
          );
        if (context) this.bindRevision(context.id, context.revision);
        return this.summary(original);
      }
      if (original.status === "closed" || original.closeRequested)
        throw new Error("Agent task is closed");
      if (original.status === "unknown")
        throw new Error(
          "Agent outcome is unknown; reconcile previous side effects before creating a new task",
        );
      if (original.cancellationRequested && this.running.has(original.taskId))
        throw new Error("Agent cancellation is still in progress");
      const task = structuredClone(original);
      task.parentThreadId ??= context?.parentThreadId;
      task.contextRevision = context?.revision ?? task.contextRevision;
      task.cancellationRequested = false;
      task.error = undefined;
      task.requests.push({
        kind: "send",
        requestId: request.requestId,
        fingerprint,
        status: "queued",
        prompt: this.prompt(task.goal, request.message, context),
        contextRef: request.contextRef,
        contextRevision: context?.revision,
      });
      task.status = task.requests.some((item) => item.status === "running") ? "running" : "queued";
      this.append(task, request.requestId, "queued", { contextRevision: context?.revision });
      await this.persist(task);
      if (context) this.bindRevision(context.id, context.revision);
      return this.summary(task);
    });
    this.kick();
    return answer;
  }

  async status(taskId: string): Promise<AgentTaskSummary> {
    await this.init();
    return this.summary(this.getTask(taskId));
  }
  async list(parentThreadId?: string): Promise<AgentTaskSummary[]> {
    await this.init();
    return [...this.tasks.values()]
      .filter((task) => parentThreadId === undefined || task.parentThreadId === parentThreadId)
      .map((task) => this.summary(task));
  }

  async wait(taskId: string, afterCursor = 0, timeoutMs = 30000): Promise<AgentWaitResult> {
    await this.init();
    if (!Number.isInteger(afterCursor) || afterCursor < 0)
      throw new Error("afterCursor must be a nonnegative integer");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new Error("timeoutMs must be nonnegative");
    const timeout = Math.min(timeoutMs, 60000);
    const current = this.page(taskId, afterCursor, false);
    if (current.events.length || TERMINAL.has(current.task.status) || timeout === 0) return current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let notify!: () => void;
    let timedOut = false;
    const completion = new Promise<void>((resolve) => {
      notify = resolve;
      const listeners = this.listeners.get(taskId) ?? new Set<() => void>();
      listeners.add(notify);
      this.listeners.set(taskId, listeners);
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeout);
    });
    // No asynchronous gap between observing state and subscribing.
    try {
      await completion;
      this.healthy();
      return this.page(taskId, afterCursor, timedOut);
    } finally {
      clearTimeout(timer);
      this.listeners.get(taskId)?.delete(notify);
    }
  }

  async interrupt(taskId: string): Promise<AgentTaskSummary> {
    return this.cancel(taskId, false);
  }
  async close(taskId: string): Promise<AgentTaskSummary> {
    return this.cancel(taskId, true);
  }

  private async cancel(taskId: string, close: boolean): Promise<AgentTaskSummary> {
    await this.init();
    return this.transaction(async () => {
      const task = structuredClone(this.getTask(taskId));
      if (task.status === "closed") return this.summary(task);
      task.cancellationRequested = true;
      task.closeRequested ||= close;
      for (const request of task.requests)
        if (request.status === "queued") request.status = "interrupted";
      const active = this.running.get(taskId);
      if (!active)
        task.status = task.closeRequested
          ? "closed"
          : task.status === "unknown"
            ? "unknown"
            : "interrupted";
      this.append(task, "", active ? "cancellation_requested" : close ? "closed" : "interrupted", {
        workerStopped: !active,
      });
      // Abort still propagates if persistence failed; never return a successful acknowledgement.
      try {
        await this.persist(task);
      } finally {
        active?.controller.abort();
      }
      return this.summary(task);
    });
  }

  private kick(): void {
    if (this.scheduling || this.shuttingDown || this.stopped || this.fatal) return;
    this.scheduling = true;
    queueMicrotask(() => {
      void this.transaction(async () => {
        for (const original of this.tasks.values()) {
          if (this.running.size >= this.concurrency) break;
          if (
            this.running.has(original.taskId) ||
            original.closeRequested ||
            original.cancellationRequested ||
            original.status === "unknown" ||
            original.status === "closed"
          )
            continue;
          const requestIndex = original.requests.findIndex(
            (request) => request.status === "queued",
          );
          if (requestIndex < 0) continue;
          const task = structuredClone(original);
          const request = task.requests[requestIndex];
          task.status = "running";
          request.status = "running";
          this.append(task, request.requestId, "running", { resume: task.sessionEstablished });
          await this.persist(task);
          const controller = new AbortController();
          const record = { controller, done: Promise.resolve() };
          this.running.set(task.taskId, record);
          record.done = this.run(task, request, controller);
        }
      })
        .catch((error) => {
          if (!this.fatal && !this.stopped) this.fail(error);
        })
        .finally(() => {
          this.scheduling = false;
        });
    });
  }

  private async run(
    started: StoredTask,
    request: StoredRequest,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await this.options.provider.run(
        {
          sessionId: started.sessionId,
          resume: started.sessionEstablished,
          prompt: request.prompt,
          workingDirectory: started.workingDirectory,
          model: started.model,
          maxTurns: started.maxTurns,
          profile: started.profile,
          containsParentContext: Boolean(request.contextRef),
          mcpConfigPath: this.options.mcpConfigPath,
          mcpAllowedTools: this.options.mcpAllowedTools
            ? [...this.options.mcpAllowedTools]
            : undefined,
          signal: controller.signal,
        },
        (type, data) => {
          if (this.stopped) return;
          void this.transaction(async () => {
            const task = structuredClone(this.getTask(started.taskId));
            if (
              (type === "session" || type === "provider_init") &&
              data &&
              typeof data === "object" &&
              typeof (data as { sessionId?: unknown }).sessionId === "string"
            ) {
              this.assignSession(task, (data as { sessionId: string }).sessionId);
              task.sessionEstablished = true;
            }
            this.append(task, request.requestId, type, boundedData(data));
            await this.persist(task);
          }).catch((error) => {
            if (!this.stopped) this.fail(error);
          });
        },
      );
      if (!this.stopped)
        await this.finish(started.taskId, request.requestId, result, controller.signal.aborted);
    } catch (error) {
      if (!this.stopped && !this.fatal) {
        const message =
          error instanceof Error
            ? error.message.replaceAll(request.prompt, "[redacted prompt]")
            : "Provider failed";
        if (controller.signal.aborted) {
          await this.finish(
            started.taskId,
            request.requestId,
            {
              sessionId: this.getTask(started.taskId).sessionId,
              status: "interrupted",
              text: "",
              error: message,
            },
            true,
          ).catch((failure) => this.fail(failure));
        } else {
          // Expected provider failures return ProviderResult. An unhandled transport
          // or worker exception cannot establish whether its side effects completed.
          await this.transaction(async () => {
            const task = structuredClone(this.getTask(started.taskId));
            task.status = "unknown";
            task.error = "Provider outcome is unknown: " + message;
            for (const item of task.requests)
              if (item.status === "running" || item.status === "queued") item.status = "unknown";
            this.append(task, request.requestId, "unknown", { reason: task.error });
            await this.persist(task);
          }).catch((failure) => this.fail(failure));
        }
      }
    } finally {
      this.running.delete(started.taskId);
      this.kick();
    }
  }

  private assignSession(task: StoredTask, sessionId: string): void {
    text(sessionId, "Provider sessionId", 300);
    if (
      [...this.tasks.values()].some(
        (other) => other.taskId !== task.taskId && other.sessionId === sessionId,
      )
    )
      throw new Error("Provider returned a session ID belonging to another task");
    if (task.sessionEstablished && task.sessionId !== sessionId)
      throw new Error("Provider changed an established session ID");
    task.sessionId = sessionId;
  }

  private async finish(
    taskId: string,
    requestId: string,
    result: ProviderResult,
    interrupted: boolean,
  ): Promise<void> {
    await this.transaction(async () => {
      const task = structuredClone(this.getTask(taskId));
      this.assignSession(task, result.sessionId);
      if (result.status === "completed") task.sessionEstablished = true;
      const request = task.requests.find((item) => item.requestId === requestId)!;
      const uncertain = result.terminationConfirmed === false || result.outcomeUnknown === true;
      request.status = uncertain ? "unknown" : interrupted ? "interrupted" : result.status;
      task.result = typeof result.text === "string" ? result.text : "";
      task.error = result.error?.replaceAll(request.prompt, "[redacted prompt]");
      if (uncertain) {
        task.error =
          (task.error ? task.error + "; " : "") +
          (result.terminationConfirmed === false
            ? "Worker termination is unconfirmed; execution outcome is unknown"
            : "Execution outcome is unknown; pending requests were not run");
        for (const pending of task.requests)
          if (pending.status === "queued") pending.status = "unknown";
      }
      task.status = uncertain
        ? "unknown"
        : task.closeRequested
          ? "closed"
          : task.requests.some((item) => item.status === "queued")
            ? "queued"
            : request.status;
      this.append(task, requestId, request.status, {
        text: task.result.slice(0, TEXT_LIMIT),
        truncated: task.result.length > TEXT_LIMIT,
        error: task.error,
        costUsd: result.costUsd,
      });
      await this.persist(task);
    });
  }

  private append(task: StoredTask, requestId: string, type: string, data: unknown): void {
    task.updatedAt = new Date().toISOString();
    task.events.push({
      sequence: ++task.eventSequence,
      taskId: task.taskId,
      requestId,
      type: type.slice(0, 100),
      timestamp: task.updatedAt,
      data: boundedData(data),
    });
    if (task.events.length > EVENT_LIMIT) task.events.splice(0, task.events.length - EVENT_LIMIT);
  }

  private async persist(task: StoredTask): Promise<void> {
    try {
      await this.store.save(task.taskId, task);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    this.tasks.set(task.taskId, task);
    for (const notify of this.listeners.get(task.taskId) ?? []) notify();
  }

  private fail(error: unknown): void {
    this.fatal ??= error instanceof Error ? error : new Error(String(error));
    for (const active of this.running.values()) active.controller.abort();
    for (const listeners of this.listeners.values()) for (const notify of listeners) notify();
  }

  private summary(task: StoredTask): AgentTaskSummary {
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      parentThreadId: task.parentThreadId,
      workingDirectory: task.workingDirectory,
      model: task.model,
      maxTurns: task.maxTurns,
      profile: task.profile,
      requireContext: task.requireContext,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      contextRevision: task.contextRevision,
      result: task.result?.slice(0, TEXT_LIMIT),
      resultTruncated: (task.result?.length ?? 0) > TEXT_LIMIT,
      error: task.error?.slice(0, 2000),
      cancellationRequested: task.cancellationRequested,
      closeRequested: task.closeRequested,
      latestCursor: task.eventSequence,
      earliestCursor: task.events[0]?.sequence ?? task.eventSequence + 1,
      requests: task.requests.map((request) => ({
        requestId: request.requestId,
        status: request.status,
        contextRevision: request.contextRevision,
      })),
    };
  }

  private page(taskId: string, cursor: number, timedOut: boolean): AgentWaitResult {
    const task = this.getTask(taskId);
    if (cursor > task.eventSequence)
      throw new Error("afterCursor is ahead of this task's event sequence");
    const events = task.events.filter((event) => event.sequence > cursor).slice(0, PAGE_LIMIT);
    const nextCursor = events.at(-1)?.sequence ?? cursor;
    const earliestCursor = task.events[0]?.sequence ?? task.eventSequence + 1;
    return {
      task: this.summary(task),
      events: structuredClone(events),
      nextCursor,
      earliestCursor,
      latestCursor: task.eventSequence,
      gap: cursor < earliestCursor - 1,
      hasMore: nextCursor < task.eventSequence,
      timedOut,
    };
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    if (!this.initializing) {
      this.stopped = true;
      return;
    }
    await this.initializing;
    this.shuttingDown = true;
    let failure: unknown;
    try {
      if (!this.fatal)
        for (const task of this.tasks.values())
          if (task.status === "running" || task.status === "queued")
            await this.cancel(task.taskId, false);
      for (const active of this.running.values()) active.controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...this.running.values()].map((active) => active.done)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!this.fatal)
        await this.transaction(async () => {
          for (const taskId of this.running.keys()) {
            const task = structuredClone(this.getTask(taskId));
            task.status = "unknown";
            task.error =
              "Cancellation requested but worker termination was not confirmed before broker shutdown";
            for (const request of task.requests)
              if (request.status === "running") request.status = "unknown";
            this.append(task, "", "unknown", { reason: task.error });
            await this.persist(task);
          }
        });
    } catch (error) {
      failure = error;
    } finally {
      this.stopped = true;
      for (const listeners of this.listeners.values()) for (const notify of listeners) notify();
      await this.serial;
      await this.store.close();
    }
    if (failure) throw failure;
  }
}
