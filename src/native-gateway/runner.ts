import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

export class GatewayError extends Error {
  constructor(
    message: string,
    public status = 502,
    public code = "gateway_error",
  ) {
    super(message);
  }
}

export interface ClaudeRunOptions {
  command: string;
  cwd: string;
  model: string;
  prompt: string;
  content: unknown[];
  schema: unknown;
  signal: AbortSignal;
  timeoutMs?: number;
  effort?: "low" | "medium" | "high" | "max";
}

export interface ClaudeRunResult {
  decision: unknown;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

async function verifySubscription(command: string, cwd: string): Promise<void> {
  const status = await new Promise<string>((resolve, reject) => {
    execFile(
      command,
      ["auth", "status"],
      { cwd, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error)
          reject(
            new GatewayError(
              "Could not verify Claude subscription login",
              503,
              "authentication_unavailable",
            ),
          );
        else resolve(stdout);
      },
    );
  });
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(status);
  } catch {
    throw new GatewayError(
      "Claude authentication status was invalid",
      503,
      "authentication_unavailable",
    );
  }
  if (
    auth.loggedIn !== true ||
    auth.authMethod !== "claude.ai" ||
    auth.apiProvider !== "firstParty"
  ) {
    throw new GatewayError(
      "Claude must be logged in with its existing first-party subscription",
      503,
      "authentication_mode_mismatch",
    );
  }
}

/** Claude is an inference worker only. Codex executes every requested tool. */
export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  if (
    !isAbsolute(options.command) ||
    !isAbsolute(options.cwd) ||
    /\.(bat|cmd)$/i.test(options.command)
  ) {
    throw new GatewayError(
      "The Claude launcher and working directory must be absolute native paths",
      500,
    );
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(options.model))
    throw new GatewayError("Invalid Claude model alias", 400);
  if (options.signal.aborted) throw new GatewayError("Request cancelled", 499, "cancelled");
  if (
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_BASE_URL ||
    process.env.ANTHROPIC_PROFILE ||
    ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
      (key) => process.env[key] === "1" || process.env[key] === "true",
    )
  ) {
    throw new GatewayError(
      "The subscription gateway requires Claude's existing first-party login without API-key or cloud-provider overrides",
      503,
      "authentication_mode_mismatch",
    );
  }
  await verifySubscription(options.command, options.cwd);
  if (options.signal.aborted) throw new GatewayError("Request cancelled", 499, "cancelled");
  const args = [
    "-p",
    "--model",
    options.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--json-schema",
    JSON.stringify(options.schema),
    "--safe-mode",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--max-turns",
    "5",
    "--effort",
    options.effort ?? "high",
    "--system-prompt",
    "You provide model inference for a Codex agent. Follow the supplied conversation and instructions. You have no local tools. Return only the required structured decision. Tool requests are executed by Codex after your decision is validated. Never execute tools yourself.",
  ];
  const child = spawn(options.command, args, {
    cwd: options.cwd,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sessionId = randomUUID();
  child.stdin.on("error", () => {});
  child.stdin.end(
    JSON.stringify({
      type: "user",
      session_id: sessionId,
      message: {
        role: "user",
        content: options.content.length
          ? options.content
          : [{ type: "text", text: options.prompt }],
      },
    }) + "\n",
  );
  let stdout = "";
  let outputBytes = 0;
  const decoder = new StringDecoder("utf8");
  let stderr = "";
  let stopped = false;
  let timedOut = false;
  let spawnError: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<number | null>((resolve, reject) => {
    rejectCompletion = reject;
    child.once("close", resolve);
  });
  const maxOutputBytes = 32 * 1024 * 1024;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += decoder.write(chunk);
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) void stop();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  async function stop() {
    if (stopped || child.exitCode !== null || !child.pid) return;
    stopped = true;
    killTimer = setTimeout(() => {
      if (child.exitCode !== null) return;
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      rejectCompletion(
        new GatewayError(
          "Could not confirm the Claude worker stopped; restart the gateway before retrying",
          503,
          "termination_unknown",
        ),
      );
    }, 10_000);
    if (process.platform === "win32") {
      await new Promise<void>((resolve) =>
        execFile(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5000 },
          (error) => {
            if (error && child.exitCode === null) child.kill("SIGKILL");
            resolve();
          },
        ),
      );
    } else child.kill("SIGTERM");
  }
  const abort = () => {
    void stop();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) void stop();
  const timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, options.timeoutMs ?? 240_000);
  let exitCode: number | null;
  try {
    exitCode = await completion;
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal.removeEventListener("abort", abort);
  }
  stdout += decoder.end();
  if (options.signal.aborted) throw new GatewayError("Request cancelled", 499, "cancelled");
  if (timedOut) throw new GatewayError("Claude inference timed out", 504, "timeout");
  if (stopped) throw new GatewayError("Claude output exceeded the limit", 502, "output_limit");
  if (spawnError)
    throw new GatewayError(
      "Could not start the configured Claude CLI",
      503,
      "launcher_unavailable",
    );
  let events: Record<string, unknown>[];
  try {
    events = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw new GatewayError("Claude emitted invalid stream JSON", 502, "invalid_provider_output");
  }
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const terminal = events.filter((event) => event.type === "result");
  if (
    !init ||
    !Array.isArray(init.tools) ||
    init.tools.some((tool) => tool !== "StructuredOutput" && tool !== "EndConversation")
  ) {
    throw new GatewayError(
      "Claude CLI exposed unexpected execution tools",
      502,
      "unsafe_tool_inventory",
    );
  }
  if (
    terminal.length !== 1 ||
    exitCode !== 0 ||
    terminal[0].is_error ||
    terminal[0].subtype !== "success"
  ) {
    // Never include stdout, stderr, tokens, or private context in an error or a log.
    const rateLimited = /rate.limit|usage.limit|limit.reached/i.test(
      JSON.stringify(terminal[0]) + stderr,
    );
    throw new GatewayError(
      rateLimited
        ? "Claude plan usage limit reached"
        : "Claude did not finish inference successfully",
      rateLimited ? 429 : 502,
      rateLimited ? "rate_limit_exceeded" : "provider_failed",
    );
  }
  const result = terminal[0];
  if (result.structured_output === undefined)
    throw new GatewayError(
      "Claude returned no structured decision",
      502,
      "invalid_provider_output",
    );
  const usage = (result.usage ?? {}) as Record<string, number>;
  const input =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const output = usage.output_tokens || 0;
  return {
    decision: result.structured_output,
    model: String(init.model || options.model),
    usage: {
      input_tokens: usage.input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      output_tokens: output,
      total_tokens: input + output,
    },
  };
}
