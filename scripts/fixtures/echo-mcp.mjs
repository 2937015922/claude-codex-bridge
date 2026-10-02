import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "synthetic-echo", version: "1.0" });
server.registerTool(
  "echo",
  {
    description: "Echo synthetic validation text without file or network access.",
    inputSchema: { text: z.string().max(256) },
  },
  ({ text }) => ({ content: [{ type: "text", text: `SYNTHETIC_ECHO:${text}` }] }),
);
await server.connect(new StdioServerTransport());
