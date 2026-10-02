import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.personal-validation",
);
const fixture = path.resolve(process.argv[2] || "");
if (
  !fixture.startsWith(root + path.sep) ||
  path.basename(fixture) !== "synthetic-fixture.txt" ||
  path.basename(path.dirname(fixture)) !== "synthetic-workspace"
) {
  throw new Error("Only the generated synthetic fixture can be read");
}
const server = new McpServer({ name: "synthetic-read-only", version: "1.0" });
server.registerTool(
  "read_fixture",
  {
    description:
      "Read the generated synthetic fixture. No arguments, writes, network or other files.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  () => {
    const value = fs.readFileSync(fixture, "utf8");
    if (!/^NATIVE_TOOL_[a-z0-9-]{8}$/.test(value)) throw new Error("Invalid synthetic fixture");
    return { content: [{ type: "text", text: value }] };
  },
);
await server.connect(new StdioServerTransport());
