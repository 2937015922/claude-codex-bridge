import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import { discoverClaudeExecutable, terminateClaudeTree } from "./claude-process.js";
import type { AgentProvider, ProviderRequest, ProviderResult } from "./types.js";

export interface ClaudeCliProviderOptions {
  /** Trusted launcher override, primarily for a synthetic CLI in tests. */
  command?: string;
  prefixArgs?: string[];
  timeoutMs?: number;
  terminationGraceMs?: number;
  maxOutputBytes?: number;
  maxLineChars?: number;
  maxResultChars?: number;
  maxProgressChars?: number;
  maxProgressEvents?: number;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_TOOLS = ["Read", "Grep", "Glob"];

async function cliArguments(
  request: ProviderRequest,
): Promise<{ args: string[]; mcpServers: string[] }> {
  if (!UUID.test(request.sessionId)) throw new Error("A valid explicit session UUID is required");
  if (!isAbsolute(request.workingDirectory)) throw new Error("workingDirectory must be absolute");
  if (!Number.isSafeInteger(request.maxTurns) || request.maxTurns < 1) {
    throw new Error("maxTurns must be a positive integer");
  }
  let mcpServers: string[] = [];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    request.model || "opus",
    "--max-turns",
    String(request.maxTurns),
    request.resume ? "--resume" : "--session-id",
    request.sessionId,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
  ];
  if (request.profile === "discussion" || request.profile === "review") {
    const reviewTools = request.reviewTools ?? REVIEW_TOOLS;
    if (reviewTools.some((tool) => !REVIEW_TOOLS.includes(tool))) {
      throw new Error("Review tools must be a subset of Read, Grep, and Glob");
    }
    args.push("--safe-mode", "--tools", request.profile === "review" ? reviewTools.join(",") : "");
    if (request.profile === "review" && reviewTools.length)
      args.push("--allowedTools", ...reviewTools);
  } else if (request.profile === "mcp") {
    if (!request.mcpConfigPath || !isAbsolute(request.mcpConfigPath)) {
      throw new Error("MCP profile requires a trusted absolute mcpConfigPath");
    }
    const allowed = request.mcpAllowedTools;
    if (!allowed?.length || allowed.some((name) => !/^mcp__[\w-]+__[\w-]+$/.test(name))) {
      throw new Error("MCP profile requires exact mcpAllowedTools names without wildcards");
    }
    const info = await stat(request.mcpConfigPath);
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("Invalid MCP configuration file");
    let config: unknown;
    try {
      config = JSON.parse(await readFile(request.mcpConfigPath, "utf8"));
    } catch {
      throw new Error("Could not read valid MCP configuration JSON");
    }
    if (!object(config) || !object(config.mcpServers) || !Object.keys(config.mcpServers).length) {
      throw new Error("MCP configuration must declare mcpServers");
    }
    const names = Object.keys(config.mcpServers);
    mcpServers = names;
    if (
      names.some(
        (name) =>
          !/^[\w-]+$/.test(name) || !allowed.some((tool) => tool.startsWith(`mcp__${name}__`)),
      ) ||
      allowed.some((tool) => !names.some((name) => tool.startsWith(`mcp__${name}__`)))
    ) {
      throw new Error("MCP configuration servers must match the trusted tool allowlist");
    }
    args.push(
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      request.mcpConfigPath,
      "--allowedTools",
      ...allowed,
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
      "--disable-slash-commands",
    );
  } else {
    throw new Error("Unsupported agent profile");
  }
  return { args, mcpServers };
}

/** One CLI process per turn; Claude's persisted session is resumed by its exact ID. */
export class ClaudeCliProvider implements AgentProvider {
  constructor(private readonly options: ClaudeCliProviderOptions = {}) {}

  async run(
    request: ProviderRequest,
    emit: (type: string, data: unknown) => void,
  ): Promise<ProviderResult> {
    const failure = (error: string, interrupted = false): ProviderResult => ({
      sessionId: request.sessionId,
      status: interrupted ? "interrupted" : "failed",
      text: "",
      error,
    });
    if (request.signal.aborted) return failure("Request was interrupted before startup", true);
    let command: string;
    let args: string[];
    let expectedMcpServers: string[];
    try {
      const configuration = await cliArguments(request);
      args = [...(this.options.prefixArgs || []), ...configuration.args];
      expectedMcpServers = configuration.mcpServers;
      command = this.options.command || (await discoverClaudeExecutable());
      if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
        throw new Error("Use a native executable, not a Windows shell wrapper");
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : "Provider configuration failed");
    }
    if (request.signal.aborted) return failure("Request was interrupted before startup", true);

    const maxBytes = this.options.maxOutputBytes ?? 16 * 1024 * 1024;
    const maxLine = this.options.maxLineChars ?? 2 * 1024 * 1024;
    const maxResult = this.options.maxResultChars ?? 200_000;
    const maxProgress = this.options.maxProgressChars ?? 64_000;
    const maxEvents = this.options.maxProgressEvents ?? 512;
    const timeoutMs = this.options.timeoutMs ?? 600_000;
    const graceMs = this.options.terminationGraceMs ?? 1000;
    const env = { ...process.env };
    // The explicit profile selects customization policy; preserve all authentication settings.
    if (request.profile === "mcp") delete env.CLAUDE_CODE_SAFE_MODE;

    return new Promise<ProviderResult>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, {
          cwd: request.workingDirectory,
          env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        resolve(failure("Could not spawn Claude CLI"));
        return;
      }
      let settled = false;
      let closed = false;
      let protocolError: string | undefined;
      let stopReason: "interrupted" | "timeout" | undefined;
      let stopping: Promise<void> | undefined;
      let terminationConfirmed = true;
      let knownErrorResult = false;
      let stopFallback: ReturnType<typeof setTimeout> | undefined;
      let result: JsonObject | undefined;
      let sawInit = false;
      let outputBytes = 0;
      let progressChars = 0;
      let progressEvents = 0;
      let progressTruncated = false;
      let buffer = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const cleanup = () => {
        clearTimeout(timer);
        if (stopFallback) clearTimeout(stopFallback);
        request.signal.removeEventListener("abort", aborted);
      };
      const complete = (value: ProviderResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        const outcomeUnknown =
          Boolean(child.pid) &&
          ((value.status === "failed" && !knownErrorResult) ||
            (value.status === "interrupted" && Boolean(protocolError)));
        resolve({
          ...value,
          ...(terminationConfirmed ? {} : { terminationConfirmed: false }),
          ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
        });
      };
      const stop = () => {
        if (stopping || settled) return;
        stopping = terminateClaudeTree(child, graceMs).catch(() => {
          terminationConfirmed = false;
          protocolError ||= "Could not confirm owned process-tree termination";
          // Never scan/kill unrelated workers. A direct-child fallback is safe but may be incomplete.
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        });
        // Broken inherited pipes must not leave the broker waiting indefinitely.
        stopFallback = setTimeout(
          () => {
            if (!closed) {
              terminationConfirmed = false;
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.stdin?.destroy();
              complete(
                failure(
                  protocolError || "Worker termination could not be confirmed",
                  stopReason === "interrupted",
                ),
              );
            }
          },
          Math.max(3000, graceMs + 2000),
        );
      };
      const fail = (message: string) => {
        protocolError ||= message;
        stop();
      };
      const progress = (type: string, data: JsonObject) => {
        if (settled || progressTruncated) return;
        const size = JSON.stringify(data).length;
        if (++progressEvents > maxEvents || progressChars + size > maxProgress) {
          progressTruncated = true;
          try {
            emit("provider_progress_truncated", { reason: "progress_limit" });
          } catch {
            fail("Progress consumer failed");
          }
          return;
        }
        progressChars += size;
        try {
          emit(type, data);
        } catch {
          fail("Progress consumer failed");
        }
      };
      const parseLine = (line: string) => {
        if (!line.trim() || protocolError || stopReason) return;
        if (line.length > maxLine) return fail("Claude stream line exceeded the output limit");
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return fail("Claude returned invalid stream JSON");
        }
        if (!object(message) || typeof message.type !== "string")
          return fail("Claude returned an invalid stream event");
        if (typeof message.session_id === "string" && message.session_id !== request.sessionId) {
          return fail("Claude returned a different session ID");
        }
        if (message.type === "result") {
          if (result) return fail("Claude returned multiple terminal results");
          result = message;
          if (typeof message.result === "string" && message.result.length > maxResult)
            fail("Claude result exceeded the output limit");
        } else if (message.type === "system" && message.subtype === "init") {
          if (message.session_id !== request.sessionId)
            return fail("Claude init did not confirm the requested session ID");
          sawInit = true;
          if (request.profile === "mcp") {
            const allowed = new Set(request.mcpAllowedTools);
            const names = message.tools;
            if (
              !Array.isArray(names) ||
              names.some(
                (name) =>
                  typeof name !== "string" || (!allowed.has(name) && name !== "EndConversation"),
              ) ||
              [...allowed].some((name) => !names.includes(name))
            ) {
              return fail("Claude MCP tool inventory differs from the trusted allowlist");
            }
            if (
              (Array.isArray(message.mcp_server_errors) && message.mcp_server_errors.length) ||
              !Array.isArray(message.mcp_servers) ||
              message.mcp_servers.length !== expectedMcpServers.length ||
              message.mcp_servers.some(
                (server) =>
                  !object(server) ||
                  server.status !== "connected" ||
                  !expectedMcpServers.includes(String(server.name)),
              ) ||
              expectedMcpServers.some(
                (name) =>
                  !(message.mcp_servers as unknown[]).some(
                    (server) => object(server) && server.name === name,
                  ),
              )
            ) {
              return fail("Required MCP servers were not connected");
            }
          }
          progress("provider_init", {
            sessionId: request.sessionId,
            model: String(message.model || "").slice(0, 128),
          });
        } else if (
          message.type === "stream_event" &&
          object(message.event) &&
          object(message.event.delta) &&
          message.event.delta.type === "text_delta" &&
          typeof message.event.delta.text === "string"
        ) {
          progress("provider_text", {
            text: message.event.delta.text.slice(0, 4096),
            ...(message.event.delta.text.length > 4096 ? { truncated: true } : {}),
          });
        } else if (
          message.type === "assistant" &&
          object(message.message) &&
          Array.isArray(message.message.content)
        ) {
          for (const block of message.message.content) {
            if (object(block) && block.type === "tool_use" && typeof block.name === "string") {
              progress("provider_tool", { name: block.name.slice(0, 256) });
            }
          }
        } else if (message.type === "system") {
          progress("provider_status", {
            subtype: String(message.subtype || "unknown").slice(0, 128),
          });
        }
      };
      const consume = (text: string) => {
        buffer += text;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          parseLine(line);
        }
        if (buffer.length > maxLine) fail("Claude stream line exceeded the output limit");
      };
      const aborted = () => {
        stopReason = "interrupted";
        stop();
      };
      const timer = setTimeout(() => {
        stopReason = "timeout";
        stop();
      }, timeoutMs);
      request.signal.addEventListener("abort", aborted, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled || protocolError || stopReason) return;
        outputBytes += chunk.length;
        if (outputBytes > maxBytes) return fail("Claude output exceeded the byte limit");
        try {
          consume(decoder.decode(chunk, { stream: true }));
        } catch {
          fail("Claude returned invalid UTF-8");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        // stderr can contain credentials or echoed prompts. Count it, never forward raw bytes.
        outputBytes += chunk.length;
        if (outputBytes > maxBytes) fail("Claude output exceeded the byte limit");
      });
      child.stdin?.once("error", () => {
        if (!stopReason && !settled)
          fail("Claude CLI closed its input before accepting the prompt");
      });
      child.once("error", () => complete(failure("Could not spawn Claude CLI")));
      child.once("close", async (code, signal) => {
        closed = true;
        if (stopping) await stopping;
        if (settled) return;
        if (!protocolError && !stopReason) {
          try {
            consume(decoder.decode());
            if (buffer.trim()) parseLine(buffer);
          } catch {
            protocolError = "Claude returned invalid UTF-8";
          }
        }
        if (stopping) await stopping;
        if (settled) return;
        if (stopReason === "interrupted")
          return complete(failure(protocolError || "Request was interrupted", true));
        if (stopReason === "timeout")
          return complete(
            failure(
              `Claude CLI timed out; the request was not retried${protocolError ? `; ${protocolError}` : ""}`,
            ),
          );
        if (protocolError) return complete(failure(protocolError));
        if (code !== 0 || signal)
          return complete(failure(`Claude CLI exited unsuccessfully (${signal || code})`));
        if (!result) return complete(failure("Claude CLI exited without a terminal result"));
        if (result.session_id !== request.sessionId)
          return complete(
            failure("Claude terminal result did not confirm the requested session ID"),
          );
        if (request.profile === "mcp" && !sawInit)
          return complete(failure("Claude did not confirm the MCP tool inventory"));
        if (result.subtype !== "success" || result.is_error !== false) {
          knownErrorResult =
            typeof result.subtype === "string" &&
            /^error_[\w]+$/.test(result.subtype) &&
            result.is_error === true;
          return complete(
            failure(
              `Claude returned an unsuccessful result (${String(result.subtype || "unknown").slice(0, 128)})`,
            ),
          );
        }
        if (typeof result.result !== "string")
          return complete(failure("Claude terminal result is missing text"));
        const cost = result.total_cost_usd ?? result.cost_usd;
        complete({
          sessionId: request.sessionId,
          status: "completed",
          text: result.result,
          ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
            ? { costUsd: cost }
            : {}),
        });
      });
      if (request.signal.aborted) aborted();
      else child.stdin?.end(request.prompt, "utf8");
    });
  }
}
