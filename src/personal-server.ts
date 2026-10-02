#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { daemonRequest, ensureDaemon, type DaemonManifest } from "./personal/runtime.js";

const server = new McpServer({ name: "claude-personal-agents", version: "0.4.0-personal.1" });
let manifest: DaemonManifest | undefined;
async function call(method: string, args: unknown) {
  try {
    manifest = await ensureDaemon();
    const result = await daemonRequest(manifest, method, args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Personal agent request failed",
        },
      ],
      isError: true,
    };
  }
}
const requestId = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "Required stable request ID. Retain it across retries; use a new ID for a new instruction.",
  );
const contextRef = z
  .string()
  .regex(/^ctx_[a-f0-9]{64}$/)
  .optional()
  .describe("Automatically supplied by the Codex hook. Do not invent this value.");
const taskId = z.string().min(1).max(128);
server.registerTool(
  "agent_start",
  {
    description:
      "Delegate a bounded task to a persistent Claude Opus agent. The hook automatically supplies current parent context. Returns immediately with task ID; use agent_wait. Tools are discussion-only by default.",
    inputSchema: {
      requestId,
      task: z.string().min(1).max(100000),
      workingDirectory: z.string().min(1),
      contextRef,
      requireContext: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Keep true for normal delegation. False is only for isolated tasks that deliberately omit parent context.",
        ),
      model: z.enum(["opus", "sonnet", "haiku"]).optional().default("opus"),
      maxTurns: z.number().int().min(1).max(30).optional().default(8),
      profile: z.enum(["discussion", "review", "mcp"]).optional().default("discussion"),
    },
  },
  (args) => call("agent_start", args),
);
server.registerTool(
  "agent_send",
  {
    description:
      "Queue a follow-up to the same agent session. The hook supplies a fresh parent-context revision; requests execute in order.",
    inputSchema: {
      taskId,
      requestId,
      message: z.string().min(1).max(100000),
      contextRef,
      workingDirectory: z.string().optional(),
    },
  },
  (args) => call("agent_send", args),
);
server.registerTool(
  "agent_wait",
  {
    description:
      "Wait for new events using the returned cursor. A timeout does not cancel the task. Continue until terminal status; keep coordination in the current parent turn.",
    inputSchema: {
      taskId,
      afterCursor: z.number().int().min(0).optional().default(0),
      timeoutMs: z.number().int().min(0).max(60000).optional().default(30000),
    },
  },
  (args) => call("agent_wait", args),
);
server.registerTool(
  "agent_status",
  {
    description: "Read persisted task state without executing or resuming anything.",
    inputSchema: { taskId },
  },
  (args) => call("agent_status", args),
);
server.registerTool(
  "agent_list",
  {
    description:
      "List tasks, optionally for the current parent thread. Pending state survives parent-context compaction.",
    inputSchema: { parentThreadId: z.string().optional() },
  },
  (args) => call("agent_list", args),
);
server.registerTool(
  "agent_interrupt",
  {
    description: "Cancel queued work and stop the owned worker. Does not undo prior tool effects.",
    inputSchema: { taskId },
  },
  (args) => call("agent_interrupt", args),
);
server.registerTool(
  "agent_close",
  {
    description:
      "Close a task and release its worker. Its metadata and Claude session remain available for inspection.",
    inputSchema: { taskId },
  },
  (args) => call("agent_close", args),
);
server.connect(new StdioServerTransport()).catch((error) => {
  console.error(error instanceof Error ? error.message : "Personal MCP failed");
  process.exit(1);
});
