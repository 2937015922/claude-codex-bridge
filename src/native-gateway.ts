#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway, type GatewayConfig } from "./native-gateway/server.js";
export { createGateway } from "./native-gateway/server.js";
export { runClaude } from "./native-gateway/runner.js";
export {
  prepareResponsesRequest,
  parseClaudeDecision,
  decisionToResponse,
  responseToSse,
} from "./native-gateway/protocol.js";

async function main() {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1] || !isAbsolute(process.argv[index + 1])) {
    process.stderr.write("An absolute --config path is required.\n");
    process.exit(1);
  }
  let gateway: ReturnType<typeof createGateway>;
  try {
    const config = JSON.parse(readFileSync(process.argv[index + 1], "utf8")) as GatewayConfig;
    gateway = createGateway(config);
    await gateway.listen();
    process.stdout.write("Native model gateway ready on loopback.\n");
  } catch {
    process.stderr.write(
      "Could not start the native model gateway. Check the runtime configuration and port.\n",
    );
    process.exit(1);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void gateway.shutdown();
    });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
)
  await main();
