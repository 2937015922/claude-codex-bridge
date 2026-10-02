import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/cli.ts",
    "src/codex-server.ts",
    "src/claude-server.ts",
    "src/personal-server.ts",
    "src/personal-daemon.ts",
    "src/personal-control.ts",
    "src/personal/context-hook.ts",
    "src/native-gateway.ts",
  ],
  format: "esm",
  dts: true,
  clean: true,
  publint: true,
  noExternal: ["ajv"],
  inlineOnly: false,
});
