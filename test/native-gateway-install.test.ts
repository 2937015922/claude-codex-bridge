import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildModelCatalog,
  gatewayRequest,
  parseArguments,
  patchAgents,
  patchCodexConfig,
  prepareInstallation,
  readRuntimeConfig,
  removeLegacyPluginTable,
  rollbackCodexConfig,
  taskActionArgument,
  taskControlScript,
  taskRegistrationScript,
  validateRuntimeConfig,
} from "../scripts/install-native-gateway.mjs";
import {
  gatewayStatus,
  parseControlArguments,
  stopGateway,
} from "../scripts/control-native-gateway.mjs";

const token = "a".repeat(64);
const config = {
  host: "127.0.0.1",
  port: 53571,
  token,
  claudeCommand: path.resolve("claude.exe"),
  workingDirectory: path.resolve("synthetic-empty"),
  models: { "claude-opus": "opus" },
  maxClaudeConcurrency: 2,
  timeoutMs: 240000,
};
const sampleModels = {
  identity: "do-not-copy-account-metadata",
  models: [
    {
      slug: "gpt-6.1-sol",
      display_name: "GPT",
      priority: 1,
      default_reasoning_level: "high",
      model_messages: { base_instructions: "harness metadata" },
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      use_responses_lite: true,
      available_access_programs: { cyber: [] },
    },
    { slug: "gpt-6-astra", priority: 2 },
    { slug: "codex-auto-review", priority: 3 },
  ],
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "native-gateway-install-"));
  directories.push(directory);
  return directory;
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

describe("native gateway configuration migration", () => {
  it("removes only the exact legacy plugin table, preserving strings, arrays and other plugins", () => {
    const source =
      'model = "gpt-6.1-sol"\nnotes = """\n[plugins."claude-personal-agents@claude-local"]\nenabled = true\n"""\n[plugins."claude-personal-agents@claude-local"]\nenabled = true\n[[unrelated.items]]\nvalue = "keep"\n[plugins."claude-personal-agents@different-market"]\nenabled = true\n[plugins."other@claude-local"]\nenabled = true\n';
    const removed = removeLegacyPluginTable(source);
    expect(removed).toContain(
      'notes = """\n[plugins."claude-personal-agents@claude-local"]\nenabled = true\n"""',
    );
    expect(removed).toContain('[[unrelated.items]]\nvalue = "keep"');
    expect(removed).toContain('[plugins."claude-personal-agents@different-market"]');
    expect(removed).toContain('[plugins."other@claude-local"]');
    expect(removed.match(/claude-personal-agents@claude-local/g)).toHaveLength(1);
  });
  it("keeps the GPT default and unrelated settings; rollback never restores the removed bridge", () => {
    const source =
      '# preamble\nmodel = "gpt-6.1-sol"\nmodel_provider = "openai"\n[plugins."claude-personal-agents@claude-local"]\nenabled = true\n[mcp_servers.keep]\ncommand = "keep-executable"\n[model_providers.another]\nname = "Another"\n';
    const result = patchCodexConfig(source, { config, catalogFile: path.resolve("models.json") });
    expect(result.text).toContain('model = "gpt-6.1-sol"');
    expect(result.text.indexOf('model_provider = "native-gateway"')).toBeLessThan(
      result.text.indexOf("[mcp_servers.keep]"),
    );
    expect(result.text.indexOf("model_catalog_json =")).toBeLessThan(
      result.text.indexOf("[mcp_servers.keep]"),
    );
    expect(result.text).toContain("requires_openai_auth = true\nsupports_websockets = false");
    expect(result.text).toContain('name = "Native Model Gateway"');
    expect(result.text).toContain('[mcp_servers.keep]\ncommand = "keep-executable"');
    const rolledBack = rollbackCodexConfig(
      result.text + '\n[added.later]\nvalue = "preserve"\n',
      result.patch,
    );
    expect(rolledBack.conflicts).toEqual([]);
    expect(rolledBack.text).toContain('model_provider = "openai"');
    expect(rolledBack.text).toContain('[added.later]\nvalue = "preserve"');
    expect(rolledBack.text).not.toContain("claude-personal-agents@claude-local");
    expect(rolledBack.text).not.toContain("model_catalog_json");
    expect(rolledBack.text).not.toContain(token);
  });
  it("preserves later routing edits and flags conflicts instead of overwriting them", () => {
    const result = patchCodexConfig('model = "gpt-6-astra"\n', {
      config,
      catalogFile: path.resolve("models.json"),
    });
    const edited = result.text
      .replace('model_provider = "native-gateway"', 'model_provider = "new-provider"')
      .replace('name = "Native Model Gateway"', 'name = "Edited gateway"');
    const rollback = rollbackCodexConfig(edited, result.patch);
    expect(rollback.conflicts).toEqual(["model_provider", "model_providers.native-gateway"]);
    expect(rollback.text).toContain('model_provider = "new-provider"');
    expect(rollback.text).toContain('name = "Edited gateway"');
  });
  it("does not replace an identical routing line embedded inside a multiline string", () => {
    const source = 'notes = """\nmodel_provider = "openai"\n"""\nmodel_provider = "openai"\n';
    const result = patchCodexConfig(source, { config, catalogFile: path.resolve("models.json") });
    expect(result.text).toContain('notes = """\nmodel_provider = "openai"\n"""');
    expect(result.patch.beforeRoot.model_provider).toBe('model_provider = "openai"\n');
  });
});

describe("native model and instruction metadata", () => {
  it("copies all GPT and special records, preserves harness metadata and appends compatible Claude metadata", () => {
    const original = structuredClone(sampleModels);
    const catalog = buildModelCatalog(sampleModels);
    expect(sampleModels).toEqual(original);
    expect(catalog.models.slice(0, 3)).toEqual(original.models);
    const claude = catalog.models[3];
    expect(claude).toMatchObject({
      slug: "claude-opus",
      default_reasoning_level: "high",
      context_window: 128000,
      input_modalities: ["text", "image"],
      use_responses_lite: false,
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      available_access_programs: { cyber: [] },
    });
    expect(
      claude.supported_reasoning_levels.map((value: { effort: string }) => value.effort),
    ).toEqual(["low", "medium", "high", "max"]);
    expect(claude.model_messages).toEqual(original.models[0].model_messages);
    expect(catalog).not.toHaveProperty("identity");
  });
  it("replaces only the known bridge boundary and removes the old implementation instruction", async () => {
    const section = await readFile(path.resolve("scripts/native-agents-section.md"), "utf8");
    const prefix =
      "## Claude Opus：创意主张、审美与设计决策\n\n保留审美要求。\n用户明确授权 Claude 实施时，可以通过 claude_implement 委托任务。\n\n";
    const nas = "## NAS 与 VPS 部署信息\n\nSSH 私钥路径和 NAS 原文均须保留。\n";
    const result = patchAgents(
      prefix + "### 当前 bridge 的调用边界\n\n- 旧 MCP 调用。\n\n" + nas,
      section,
    );
    expect(result).toContain("保留审美要求。");
    expect(result.endsWith(nas)).toBe(true);
    expect(result).toContain('model="claude-opus"');
    expect(result).toContain('fork_turns="3"');
    expect(result).toContain("collaboration.followup_task");
    expect(result).not.toContain("可以通过 claude_implement");
    expect(
      patchAgents(
        prefix + "### Opus 的委托边界\n\nGateway was rolled back.\n\n" + nas,
        section,
      ).endsWith(nas),
    ).toBe(true);
    expect(() => patchAgents("## Unknown rules\nDo not remove.\n", section)).toThrow(
      "Could not locate",
    );
  });
});

describe("current-user hidden task", () => {
  it("uses only public file paths, no password or execution-policy override, and verifies ownership for removal", () => {
    const options = {
      runtimeDirectory: path.resolve("user's gateway"),
      configFile: path.resolve("user's gateway/gateway.json"),
      nodeCommand: path.resolve("node.exe"),
    };
    const script = taskRegistrationScript(options);
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    expect(script).toContain("-AtLogOn -User $user");
    expect(script).toContain("Start-ScheduledTask");
    expect(script).not.toContain("-Force");
    expect(script).not.toMatch(/ExecutionPolicy|Password/i);
    const action = taskActionArgument(options);
    const child = Buffer.from(action.split("-EncodedCommand ")[1], "base64").toString("utf16le");
    expect(child).toContain("-WindowStyle Hidden -Wait -PassThru");
    expect(child).toContain("user''s gateway");
    expect(child).toContain("--config");
    expect(child).not.toContain(token);
    expect(script).not.toContain(token);
    expect(taskControlScript(options, "unregister")).toContain("Gateway task ownership mismatch");
    expect(taskControlScript(options, "disable")).toContain("-cne");
  });
});

describe("preparation and authenticated loopback control", () => {
  it("prepares a self-contained runtime and backs up changes without touching user configuration", async () => {
    const root = await temporaryDirectory();
    const codexHome = path.join(root, "codex");
    const sourceDist = path.join(root, "source-dist");
    const runtimeDirectory = path.join(root, "runtime");
    await mkdir(codexHome);
    await mkdir(sourceDist);
    await mkdir(runtimeDirectory);
    const originalConfig = 'model = "gpt-6.1-sol"\n';
    const originalAgents = "### 当前 bridge 的调用边界\nold rules\n";
    await writeFile(path.join(codexHome, "config.toml"), originalConfig);
    await writeFile(path.join(codexHome, "AGENTS.md"), originalAgents);
    await writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify(sampleModels));
    await writeFile(path.join(sourceDist, "native-gateway.mjs"), "// built gateway\n");
    await writeFile(path.join(sourceDist, "chunk.mjs"), "// dependency\n");
    const claudeCommand = path.join(root, "claude.exe");
    await writeFile(claudeCommand, "fixture native executable");
    const configFile = path.join(runtimeDirectory, "gateway.json");
    await writeFile(configFile, "previous local config\n");
    const result = await prepareInstallation({
      codexHome,
      sourceDist,
      runtimeDirectory,
      configFile,
      claudeCommand,
      port: await freePort(),
    });
    expect(await readFile(path.join(codexHome, "config.toml"), "utf8")).toBe(originalConfig);
    expect(await readFile(path.join(codexHome, "AGENTS.md"), "utf8")).toBe(originalAgents);
    const prepared = await readRuntimeConfig(configFile);
    expect(prepared.token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(prepared.token);
    expect(prepared).toMatchObject({
      host: "127.0.0.1",
      models: { "claude-opus": "opus" },
      maxClaudeConcurrency: 2,
      timeoutMs: 240000,
      workingDirectory: path.join(runtimeDirectory, "synthetic-empty"),
    });
    expect(await readdir(prepared.workingDirectory)).toEqual([]);
    expect(await readFile(path.join(runtimeDirectory, "dist", "chunk.mjs"), "utf8")).toBe(
      "// dependency\n",
    );
    expect(await readdir(path.join(runtimeDirectory, "scripts"))).toHaveLength(3);
    expect(await readFile(path.join(result.backupDirectory, "gateway.json.before"), "utf8")).toBe(
      "previous local config\n",
    );
    expect(await readdir(runtimeDirectory)).not.toContain("plugins");
    await writeFile(
      path.join(runtimeDirectory, "install-state.json"),
      JSON.stringify({ installed: true }),
    );
    await expect(
      prepareInstallation({
        codexHome,
        sourceDist,
        runtimeDirectory,
        configFile,
        claudeCommand,
        port: await freePort(),
      }),
    ).rejects.toThrow("Roll back");
    expect((await readRuntimeConfig(configFile)).token).toBe(prepared.token);
  });
  it("rejects ambiguous actions, duplicate options and non-loopback runtime configuration", () => {
    expect(() => parseArguments(["--prepare", "--install"])).toThrow();
    expect(() => parseArguments(["--prepare", "--port", "0"])).toThrow();
    expect(() => parseControlArguments(["--status", "--stop"])).toThrow();
    expect(() =>
      parseControlArguments([
        "--status",
        "--config-file",
        path.resolve("one"),
        "--config-file",
        path.resolve("two"),
      ]),
    ).toThrow();
    expect(() => validateRuntimeConfig({ ...config, host: "192.168.1.1" })).toThrow();
  });
  it("uses only the local authenticated endpoints and never returns raw server fields or the token", async () => {
    const requests: {
      url: string | undefined;
      method: string | undefined;
      token: string | string[] | undefined;
    }[] = [];
    const server = createHttpServer((request, response) => {
      requests.push({
        url: request.url,
        method: request.method,
        token: request.headers["x-native-gateway-token"],
      });
      if (request.headers["x-native-gateway-token"] !== token) {
        response.writeHead(401);
        response.end();
        return;
      }
      response.setHeader("Connection", "close");
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/shutdown") {
        response.end(JSON.stringify({ stopping: true }));
        server.close();
        return;
      }
      response.end(
        JSON.stringify({
          ready: true,
          models: ["claude-opus"],
          version: "fixture",
          active: 0,
          queued: 0,
          private: token,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const local = { ...config, port: (server.address() as net.AddressInfo).port };
    try {
      const status = await gatewayStatus(local);
      expect(status.status).toBe("ready");
      expect(JSON.stringify(status)).not.toContain(token);
      expect(status).not.toHaveProperty("private");
      await expect(gatewayRequest(local, "/other")).rejects.toThrow(
        "Invalid gateway control endpoint",
      );
      expect((await stopGateway(local)).status).toBe("stopped");
      expect(requests.map(({ url, method }) => [url, method])).toEqual([
        ["/health", "GET"],
        ["/shutdown", "POST"],
      ]);
      expect(requests.every((request) => request.token === token)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
