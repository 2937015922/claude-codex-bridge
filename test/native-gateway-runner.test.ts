import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { runClaude, type ClaudeRunOptions } from "../src/native-gateway/runner.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => mocks);

const decision = { kind: "final", text: "Synthetic inference", calls: [] };
const subscription = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" };
const authOverrides = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

function options(signal = new AbortController().signal): ClaudeRunOptions {
  return {
    command: process.execPath,
    cwd: process.cwd(),
    model: "opus",
    prompt: "Synthetic prompt",
    content: [],
    schema: { type: "object" },
    signal,
  };
}
function worker() {
  const child = Object.assign(new EventEmitter(), {
    pid: 424242,
    exitCode: null as number | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
  });
  return {
    child,
    input: () => input,
    finish(events: unknown[], code: number | null = 0) {
      child.stdout.end(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      child.stderr.end();
      child.exitCode = code;
      child.emit("close", code);
    },
  };
}
function events(tools: unknown = ["StructuredOutput", "EndConversation"]) {
  return [
    { type: "system", subtype: "init", model: "synthetic-opus", tools },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: decision,
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      },
    },
  ];
}
function successfulAuth() {
  mocks.execFile.mockImplementation((_command, _args, _opts, callback) => {
    queueMicrotask(() => callback(null, JSON.stringify(subscription), ""));
    return new EventEmitter() as ChildProcess;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of authOverrides) vi.stubEnv(key, undefined);
  successfulAuth();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("native Claude inference worker", () => {
  it.each(authOverrides)("refuses %s before launching any CLI command", async (key) => {
    vi.stubEnv(key, key.startsWith("CLAUDE_CODE_USE_") ? "1" : "synthetic-override");
    await expect(runClaude(options())).rejects.toMatchObject({
      status: 503,
      code: "authentication_mode_mismatch",
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([
    { loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" },
  ])("refuses a non-subscription active authentication source before inference", async (auth) => {
    mocks.execFile.mockImplementation((_command, _args, _opts, callback) => {
      queueMicrotask(() => callback(null, JSON.stringify(auth), ""));
      return new EventEmitter();
    });
    await expect(runClaude(options())).rejects.toMatchObject({
      code: "authentication_mode_mismatch",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("does not infer when authentication status cannot be parsed", async () => {
    mocks.execFile.mockImplementation((_command, _args, _opts, callback) => {
      queueMicrotask(() => callback(null, "synthetic non-JSON auth status", ""));
      return new EventEmitter();
    });
    await expect(runClaude(options())).rejects.toMatchObject({
      code: "authentication_unavailable",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("passes user content through stdin and disables execution tools and persistence", async () => {
    const fixture = worker();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => fixture.finish(events()));
      return fixture.child;
    });
    const content = [{ type: "text", text: "--中文任务\n$(literal) `unchanged` --tools Bash" }];
    const result = await runClaude({ ...options(), content });
    const [command, args, spawnOptions] = mocks.spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(spawnOptions).toMatchObject({ shell: false, windowsHide: true });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain(content[0].text);
    expect(JSON.parse(fixture.input()).message.content).toEqual(content);
    expect(result.decision).toEqual(decision);
    expect(result.usage).toMatchObject({
      input_tokens: 2,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
      output_tokens: 3,
      total_tokens: 17,
    });
  });
  it.each([
    undefined,
    null,
    ["StructuredOutput", "Read"],
    ["EndConversation", "Bash"],
    ["mcp__synthetic__execute"],
  ])("rejects missing or unexpected tools advertised by an older CLI", async (tools) => {
    const fixture = worker();
    const output = events();
    output[0].tools = tools;
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => fixture.finish(output));
      return fixture.child;
    });
    await expect(runClaude(options())).rejects.toMatchObject({
      status: 502,
      code: "unsafe_tool_inventory",
    });
  });
  it("returns no structured decision after a caller cancels an active worker", async () => {
    const fixture = worker();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.spawn.mockImplementation(() => {
      started();
      return fixture.child;
    });
    fixture.child.kill.mockImplementation(() => {
      queueMicrotask(() => fixture.finish([], null));
      return true;
    });
    mocks.execFile.mockImplementation((command, _args, _opts, callback) => {
      queueMicrotask(() => {
        if (command === "taskkill.exe") fixture.finish([], null);
        callback(null, JSON.stringify(subscription), "");
      });
      return new EventEmitter();
    });
    const controller = new AbortController();
    const result = runClaude(options(controller.signal));
    const rejected = expect(result).rejects.toMatchObject({ status: 499, code: "cancelled" });
    await ready;
    controller.abort();
    await rejected;
    if (process.platform === "win32")
      expect(
        mocks.execFile.mock.calls.some(
          ([command, args]) =>
            command === "taskkill.exe" && args.includes("/T") && args.includes("/F"),
        ),
      ).toBe(true);
    else expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("does not launch inference after cancellation during the auth preflight", async () => {
    let completeAuth!: (error: null, stdout: string, stderr: string) => void;
    mocks.execFile.mockImplementation((_command, _args, _opts, callback) => {
      completeAuth = callback;
      return new EventEmitter();
    });
    const controller = new AbortController();
    const result = runClaude(options(controller.signal));
    const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    completeAuth(null, JSON.stringify(subscription), "");
    await rejected;
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("fails closed when worker termination cannot be confirmed within the bound", async () => {
    vi.useFakeTimers();
    const fixture = worker();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.spawn.mockImplementation(() => {
      started();
      return fixture.child;
    });
    mocks.execFile.mockImplementation((command, _args, _opts, callback) => {
      queueMicrotask(() =>
        callback(null, command === "taskkill.exe" ? "" : JSON.stringify(subscription), ""),
      );
      return new EventEmitter();
    });
    const controller = new AbortController();
    const result = runClaude(options(controller.signal));
    const rejected = expect(result).rejects.toMatchObject({
      status: 503,
      code: "termination_unknown",
    });
    await ready;
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(fixture.child.unref).toHaveBeenCalled();
    expect(fixture.child.stdin.destroyed).toBe(true);
    expect(fixture.child.stdout.destroyed).toBe(true);
  });
});
