#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  captureContext,
  defaultStateDirectory,
  type CaptureOptions,
  type HookContextInput,
} from "./context.js";

interface HookResult {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow";
    updatedInput: Record<string, unknown>;
  };
}

export async function handleContextHook(
  raw: unknown,
  options: CaptureOptions & { serverName?: string },
): Promise<HookResult> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Hook input must be a JSON object");
  const input = raw as Record<string, unknown>;
  if (input.hook_event_name !== "PreToolUse") return {};
  const serverName = options.serverName ?? process.env["BRIDGE_MCP_SERVER"] ?? "claude_personal";
  if (!/^[a-zA-Z0-9_-]+$/.test(serverName))
    throw new Error("Invalid personal bridge MCP server name");
  const tools = [`mcp__${serverName}__agent_start`, `mcp__${serverName}__agent_send`];
  if (typeof input.tool_name !== "string" || !tools.includes(input.tool_name)) return {};
  if (
    input.tool_input === null ||
    typeof input.tool_input !== "object" ||
    Array.isArray(input.tool_input)
  )
    throw new Error("Personal agent tool input must be an object");
  if (typeof input.session_id !== "string" || typeof input.cwd !== "string")
    throw new Error("Hook session identity and cwd are required");
  const snapshot = await captureContext(input as unknown as HookContextInput, options);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...(input.tool_input as Record<string, unknown>),
        contextRef: snapshot.id,
        workingDirectory: snapshot.workingDirectory,
      },
    },
  };
}

export async function contextHookMain(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) throw new Error("Hook input is oversized");
      chunks.push(buffer);
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Malformed hook JSON input");
    }
    let instructionDirectories: string[] | undefined;
    if (process.env["BRIDGE_CONTEXT_TEST_MODE"] === "synthetic") {
      let roots: unknown;
      try {
        roots = JSON.parse(process.env["BRIDGE_CONTEXT_TEST_INSTRUCTION_ROOTS"] ?? "[]");
      } catch {
        throw new Error("Malformed synthetic instruction roots JSON");
      }
      if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string"))
        throw new Error("Synthetic instruction roots must be string paths");
      instructionDirectories = roots;
    }
    const output = await handleContextHook(input, {
      stateDirectory: defaultStateDirectory(),
      instructionDirectories,
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    // Do not echo raw input, CLI stderr, conversation text, or credentials.
    const message = error instanceof Error ? error.message : "Unknown context capture error";
    process.stderr.write(
      `Claude context hook: ${message.replace(/[\r\n]/g, " ").slice(0, 500)}; no updatedInput was emitted.\n`,
    );
    process.stdout.write("{}\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await contextHookMain();
