#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_PORT = 53571;
export const TASK_NAME = "CodexNativeModelGateway";
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = ["plugins", "claude-personal-agents@claude-local"];
const PROVIDER = ["model_providers", "native-gateway"];
const NATIVE_HEADING = "### 原生 Opus 的委托边界";
const LEGACY_HEADING = "### 当前 bridge 的调用边界";
const NEUTRAL_HEADING = "### Opus 的委托边界";

export function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(process.env.USERPROFILE || homedir(), ".codex");
}
export function defaultRuntimeDirectory() {
  return path.join(defaultCodexHome(), "tools", "native-model-gateway");
}
function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0"))
    throw new Error(label + " must be an absolute path");
  return path.resolve(value);
}
export function parseArguments(argv) {
  const options = {};
  const actions = new Set(["--prepare", "--install", "--help"]);
  const names = new Map([
    ["--config-file", "configFile"],
    ["--runtime-directory", "runtimeDirectory"],
    ["--codex-home", "codexHome"],
    ["--models-cache", "modelsCache"],
    ["--claude-command", "claudeCommand"],
    ["--port", "port"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (actions.has(arg)) {
      if (options.action) throw new Error("Select exactly one action");
      options.action = arg.slice(2);
    } else if (names.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg);
      if (Object.hasOwn(options, names.get(arg))) throw new Error("Duplicate option " + arg);
      options[names.get(arg)] = value;
    } else throw new Error("Unknown option");
  }
  options.action ||= "help";
  if (options.port !== undefined) {
    options.port = Number(options.port);
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)
      throw new Error("Port must be an integer from 1024 to 65535");
  }
  return options;
}

// Small lexical TOML editor: preserve every unrelated line and never deserialize secrets.
function keyPath(value) {
  const parts = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] || "") && index < value.length) index++;
    if (value[index] === '"' || value[index] === "'") {
      const quote = value[index++];
      const start = index;
      let escaped = false;
      while (index < value.length) {
        if (value[index] === quote && !escaped) break;
        escaped = quote === '"' && value[index] === "\\" && !escaped;
        if (value[index] !== "\\") escaped = false;
        index++;
      }
      if (index === value.length) return undefined;
      const raw = value.slice(start, index++);
      parts.push(quote === '"' ? JSON.parse('"' + raw + '"') : raw);
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(value.slice(index));
      if (!match) return undefined;
      parts.push(match[0]);
      index += match[0].length;
    }
    while (/\s/.test(value[index] || "") && index < value.length) index++;
    if (index === value.length) return parts;
    if (value[index++] !== ".") return undefined;
  }
  return parts.length ? parts : undefined;
}
function outsideStringLines(source) {
  const lines = [];
  let offset = 0;
  let multiline;
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) || []) {
    if (!multiline) lines.push({ start: offset, line });
    let quote;
    for (let index = 0; index < line.length; index++) {
      if (multiline) {
        if (line.slice(index, index + 3) === multiline) {
          multiline = undefined;
          index += 2;
        } else if (multiline === '"""' && line[index] === "\\") index++;
      } else if (quote) {
        if (quote === '"' && line[index] === "\\") index++;
        else if (line[index] === quote) quote = undefined;
      } else if (line[index] === "#") break;
      else if (line.slice(index, index + 3) === '"""' || line.slice(index, index + 3) === "'''") {
        multiline = line.slice(index, index + 3);
        index += 2;
      } else if (line[index] === '"' || line[index] === "'") quote = line[index];
    }
    offset += line.length;
  }
  if (multiline) throw new Error("Codex configuration contains an unterminated TOML string");
  return lines;
}
function sections(source) {
  const matches = outsideStringLines(source).flatMap(({ start, line }) => {
    const match = /^[ \t]*(\[\[?)([^\r\n]+?)\]\]?[ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$/.exec(line);
    return match
      ? [{ start, keys: keyPath(match[2]), array: match[1] === "[[", header: line }]
      : [];
  });
  return matches.map((match, index) => ({
    ...match,
    end: matches[index + 1]?.start ?? source.length,
    raw: source.slice(match.start, matches[index + 1]?.start ?? source.length),
  }));
}
function samePath(a, b) {
  return !!a && a.length === b.length && a.every((value, index) => value === b[index]);
}
function providerSection(section) {
  return (
    !section.array &&
    section.keys?.length >= 2 &&
    section.keys[0] === PROVIDER[0] &&
    section.keys[1] === PROVIDER[1]
  );
}
function withoutSections(source, predicate) {
  const ranges = sections(source).filter(predicate).reverse();
  for (const range of ranges) source = source.slice(0, range.start) + source.slice(range.end);
  return source;
}
export function removeLegacyPluginTable(source) {
  return withoutSections(source, (section) => !section.array && samePath(section.keys, PLUGIN));
}
function rootAssignment(source, key) {
  const prefix = source.slice(0, sections(source)[0]?.start ?? source.length);
  const pattern = new RegExp("^[ \\t]*" + key + "[ \\t]*=");
  const found = outsideStringLines(prefix).filter(({ line }) => pattern.test(line));
  if (found.length > 1) throw new Error("Duplicate top-level configuration key " + key);
  if (found[0]?.line.includes('"""') || found[0]?.line.includes("'''"))
    throw new Error("Routing keys must be single-line TOML assignments");
  return found[0]?.line ?? null;
}
function setRoot(source, key, assignment) {
  const found = rootAssignment(source, key);
  if (found !== null) {
    const at = outsideStringLines(
      source.slice(0, sections(source)[0]?.start ?? source.length),
    ).find(({ line }) => line === found).start;
    return source.slice(0, at) + (assignment || "") + source.slice(at + found.length);
  }
  if (!assignment) return source;
  const at = sections(source)[0]?.start ?? source.length;
  return (
    source.slice(0, at) +
    (at && !source.slice(0, at).endsWith("\n") ? "\n" : "") +
    assignment +
    source.slice(at)
  );
}
function tomlString(value) {
  return JSON.stringify(value);
}
export function patchCodexConfig(source, { config, catalogFile }) {
  const installedRoot = {
    model_provider: 'model_provider = "native-gateway"\n',
    model_catalog_json: "model_catalog_json = " + tomlString(catalogFile) + "\n",
  };
  const beforeRoot = Object.fromEntries(
    Object.keys(installedRoot).map((key) => [key, rootAssignment(source, key)]),
  );
  const beforeProvider = sections(source)
    .filter(providerSection)
    .map((section) => section.raw)
    .join("");
  let changed = withoutSections(removeLegacyPluginTable(source), providerSection);
  for (const [key, value] of Object.entries(installedRoot)) changed = setRoot(changed, key, value);
  const installedProvider =
    '[model_providers.native-gateway]\nname = "Native Model Gateway"\nbase_url = ' +
    tomlString(`http://127.0.0.1:${config.port}/v1`) +
    '\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nhttp_headers = { "x-native-gateway-token" = ' +
    tomlString(config.token) +
    " }\n";
  changed = changed.replace(/\s*$/, "") + "\n\n" + installedProvider;
  return { text: changed, patch: { beforeRoot, installedRoot, beforeProvider, installedProvider } };
}
export function rollbackCodexConfig(source, patch) {
  const conflicts = [];
  let changed = source;
  for (const [key, installed] of Object.entries(patch.installedRoot)) {
    if (rootAssignment(changed, key)?.trim() !== installed.trim()) {
      conflicts.push(key);
      continue;
    }
    changed = setRoot(changed, key, patch.beforeRoot[key]);
  }
  const current = sections(changed)
    .filter(providerSection)
    .map((section) => section.raw)
    .join("");
  if (current.trim() === patch.installedProvider.trim()) {
    changed = withoutSections(changed, providerSection);
    if (patch.beforeProvider) changed = changed.replace(/\s*$/, "") + "\n\n" + patch.beforeProvider;
  } else if (current) conflicts.push("model_providers.native-gateway");
  // An uninstalled bridge is intentionally never restored during gateway rollback.
  return { text: changed, conflicts };
}

export function buildModelCatalog(cache) {
  if (
    !cache ||
    !Array.isArray(cache.models) ||
    !cache.models.length ||
    cache.models.some((model) => typeof model?.slug !== "string")
  )
    throw new Error("A valid Codex models_cache.models array is required");
  const models = structuredClone(cache.models).filter((model) => model.slug !== "claude-opus");
  const base =
    models.find((model) => model.slug === "gpt-6.1-sol") ||
    models.find((model) => model.slug.startsWith("gpt-"));
  if (!base) throw new Error("Codex model catalog must contain a GPT model");
  const claude = {
    ...structuredClone(base),
    slug: "claude-opus",
    display_name: "Claude Opus",
    description:
      "Claude Opus through the local native model gateway and existing Claude Code CLI login.",
    default_reasoning_level: "high",
    supported_reasoning_levels: ["low", "medium", "high", "max"].map((effort) => ({
      effort,
      description: "Claude " + effort + " effort",
    })),
    priority:
      Math.max(...models.map((model) => (Number.isFinite(model.priority) ? model.priority : 0))) +
      1,
    additional_speed_tiers: [],
    service_tiers: [],
    available_access_programs: { cyber: [] },
    availability_nux: null,
    upgrade: null,
    default_reasoning_summary: "none",
    support_verbosity: false,
    context_window: 128000,
    max_context_window: 128000,
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: true,
    multi_agent_version: "v2",
    multi_agent_reasoning_effort: "high",
  };
  // GPT-owned prompt strings and tool declarations are preserved as Codex harness metadata.
  models.push(claude);
  return { models };
}
function sectionRange(source, heading) {
  const start = source.indexOf(heading);
  if (start < 0 || (start && source[start - 1] !== "\n")) return undefined;
  const after = start + heading.length;
  const next = /^#{1,3}\s/m.exec(source.slice(after));
  return { start, end: next ? after + next.index : source.length };
}
export function patchAgents(source, nativeSection) {
  const range =
    sectionRange(source, LEGACY_HEADING) ||
    sectionRange(source, NATIVE_HEADING) ||
    sectionRange(source, NEUTRAL_HEADING);
  if (!range)
    throw new Error("Could not locate the existing Opus bridge section; AGENTS was not changed");
  let changed =
    source.slice(0, range.start) + nativeSection.trimEnd() + "\n\n" + source.slice(range.end);
  changed = changed.replace(
    /^.*用户明确授权 Claude 实施时.*claude_implement.*$/m,
    "用户明确授权 Opus 实施时，可以通过原生子 agent 委托适合它的独立创意任务，给出清晰的修改范围和验收标准；Codex 负责验收与整合。",
  );
  return changed;
}

function powershellQuote(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}
export function taskActionArgument({
  runtimeDirectory,
  configFile,
  nodeCommand = process.execPath,
}) {
  const entrypoint = path.join(runtimeDirectory, "dist", "native-gateway.mjs");
  const logs = path.join(runtimeDirectory, "logs");
  const argumentsExpression = [entrypoint, "--config", configFile]
    .map((value) => powershellQuote('"' + value + '"'))
    .join(", ");
  const child =
    "$ErrorActionPreference = 'Stop'\n$p = Start-Process -FilePath " +
    powershellQuote(nodeCommand) +
    " -ArgumentList @(" +
    argumentsExpression +
    ") -WorkingDirectory " +
    powershellQuote(runtimeDirectory) +
    " -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput " +
    powershellQuote(path.join(logs, "stdout.log")) +
    " -RedirectStandardError " +
    powershellQuote(path.join(logs, "stderr.log")) +
    "\nexit $p.ExitCode";
  const encoded = Buffer.from(child, "utf16le").toString("base64");
  return "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encoded;
}
export function taskRegistrationScript(options) {
  const taskName = options.taskName || TASK_NAME;
  return (
    "$ErrorActionPreference = 'Stop'\n$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name\n$action = New-ScheduledTaskAction -Execute \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Argument " +
    powershellQuote(taskActionArgument(options)) +
    "\n$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user\n$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited\n$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries\nRegister-ScheduledTask -TaskName " +
    powershellQuote(taskName) +
    " -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null\nStart-ScheduledTask -TaskName " +
    powershellQuote(taskName)
  );
}
export function taskControlScript(options, operation) {
  if (!["disable", "unregister"].includes(operation)) throw new Error("Invalid task operation");
  return (
    "$ErrorActionPreference = 'Stop'\n$t = Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq " +
    powershellQuote(TASK_NAME) +
    " }\nif ($t) {\n if (@($t.Actions).Count -ne 1 -or $t.Actions[0].Arguments -cne " +
    powershellQuote(taskActionArgument(options)) +
    " -or $t.Actions[0].Execute -ine \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\") { throw 'Gateway task ownership mismatch' }\n " +
    (operation === "disable"
      ? "Disable-ScheduledTask -TaskName " + powershellQuote(TASK_NAME) + " | Out-Null"
      : "Unregister-ScheduledTask -TaskName " + powershellQuote(TASK_NAME) + " -Confirm:$false") +
    "\n}"
  );
}
export async function runPowerShell(script) {
  if (process.platform !== "win32")
    throw new Error("Windows Task Scheduler is required for installation");
  const command = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes < 1024 * 1024) chunks.push(chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows task operation timed out"));
    }, 30000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not run Windows task operation"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8").trim());
      else reject(new Error("Windows task operation failed"));
    });
  });
}
export async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", (error) => done(error.code !== "ECONNREFUSED"));
  });
}
async function ensurePortAvailable(port) {
  await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", () => reject(new Error("The selected loopback port is unavailable")));
    listener.listen(port, "127.0.0.1", () => listener.close(resolve));
  });
}
export function validateRuntimeConfig(config) {
  if (
    !config ||
    config.host !== "127.0.0.1" ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(config.token)
  )
    throw new Error("Invalid local gateway configuration");
  absolute(config.claudeCommand, "Claude executable");
  absolute(config.workingDirectory, "Claude working directory");
  if (config.models?.["claude-opus"] !== "opus")
    throw new Error("Configured Claude alias is missing");
  return config;
}
export async function readRuntimeConfig(configFile) {
  const target = absolute(configFile, "Configuration file");
  if ((await stat(target)).size > 32768) throw new Error("Gateway configuration is oversized");
  return validateRuntimeConfig(JSON.parse(await readFile(target, "utf8")));
}
export async function gatewayRequest(config, endpoint, method = "GET") {
  validateRuntimeConfig(config);
  if (!["/health", "/shutdown"].includes(endpoint))
    throw new Error("Invalid gateway control endpoint");
  const response = await fetch(`http://127.0.0.1:${config.port}${endpoint}`, {
    method,
    headers: { "x-native-gateway-token": config.token },
    redirect: "error",
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error("Gateway control refused the local request");
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0;
  if (!reader) throw new Error("Invalid gateway control response");
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > 8192) {
      await reader.cancel();
      throw new Error("Gateway control response is oversized");
    }
    chunks.push(Buffer.from(result.value));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid gateway control response");
  }
  return value;
}
async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function optionalRead(target) {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function noLinks(target) {
  const resolved = absolute(target, "Installation path");
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Installation paths must not contain links");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}
async function backupFile(target, directory, name) {
  const previous = await optionalRead(target);
  if (previous !== null) await atomicWrite(path.join(directory, name), previous);
  return previous;
}
async function discoverClaude() {
  const choices = [
    process.env.CLAUDE_CLI_PATH,
    process.env.APPDATA &&
      path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      ),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, ".local", "bin", "claude.exe"),
  ].filter(Boolean);
  for (const candidate of choices) {
    if (
      path.isAbsolute(candidate) &&
      (await stat(candidate).then(
        (info) => info.isFile(),
        () => false,
      ))
    )
      return candidate;
  }
  throw new Error("Specify the existing native Claude executable with --claude-command");
}
export async function prepareInstallation(options = {}) {
  const codexHome = absolute(options.codexHome || defaultCodexHome(), "Codex home");
  const runtimeDirectory = absolute(
    options.runtimeDirectory ||
      (options.configFile
        ? path.dirname(options.configFile)
        : path.join(codexHome, "tools", "native-model-gateway")),
    "Runtime directory",
  );
  const configFile = absolute(
    options.configFile || path.join(runtimeDirectory, "gateway.json"),
    "Configuration file",
  );
  if (path.dirname(configFile) !== runtimeDirectory)
    throw new Error("Configuration file must live in the runtime directory");
  const port = options.port || DEFAULT_PORT;
  await noLinks(runtimeDirectory);
  await ensurePortAvailable(port);
  const previousState = await optionalRead(path.join(runtimeDirectory, "install-state.json"));
  if (previousState && JSON.parse(previousState).installed === true)
    throw new Error("Roll back the installed gateway before replacing its runtime configuration");
  const sourceDist = absolute(
    options.sourceDist || path.join(SCRIPT_DIRECTORY, "..", "dist"),
    "Built dist directory",
  );
  if (!(await stat(path.join(sourceDist, "native-gateway.mjs"))).isFile())
    throw new Error("Build the native gateway before preparing installation");
  const claudeCommand = absolute(
    options.claudeCommand || (await discoverClaude()),
    "Claude executable",
  );
  if (
    !(await stat(claudeCommand)).isFile() ||
    (process.platform === "win32" && !claudeCommand.toLowerCase().endsWith(".exe"))
  )
    throw new Error("Claude must be an existing native executable");
  const cache = JSON.parse(
    await readFile(
      absolute(options.modelsCache || path.join(codexHome, "models_cache.json"), "Models cache"),
      "utf8",
    ),
  );
  const catalog = buildModelCatalog(cache);
  const backupDirectory = path.join(
    runtimeDirectory,
    "backups",
    new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID(),
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const catalogFile = path.join(runtimeDirectory, "models.json");
  await backupFile(configFile, backupDirectory, "gateway.json.before");
  await backupFile(catalogFile, backupDirectory, "models.json.before");
  await backupFile(
    path.join(runtimeDirectory, "prepared.json"),
    backupDirectory,
    "prepared.json.before",
  );
  if (
    await stat(path.join(runtimeDirectory, "dist")).then(
      () => true,
      () => false,
    )
  )
    await cp(path.join(runtimeDirectory, "dist"), path.join(backupDirectory, "dist"), {
      recursive: true,
      dereference: false,
    });
  if (sourceDist !== path.join(runtimeDirectory, "dist"))
    await cp(sourceDist, path.join(runtimeDirectory, "dist"), {
      recursive: true,
      dereference: false,
    });
  await mkdir(path.join(runtimeDirectory, "scripts"), { recursive: true, mode: 0o700 });
  for (const name of [
    "install-native-gateway.mjs",
    "control-native-gateway.mjs",
    "native-agents-section.md",
  ]) {
    const target = path.join(runtimeDirectory, "scripts", name);
    await backupFile(target, path.join(backupDirectory, "scripts"), name);
    if (path.join(SCRIPT_DIRECTORY, name) !== target)
      await cp(path.join(SCRIPT_DIRECTORY, name), target);
  }
  await mkdir(path.join(runtimeDirectory, "logs"), { recursive: true, mode: 0o700 });
  const workingDirectory = path.join(runtimeDirectory, "synthetic-empty");
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
  if ((await optionalRead(path.join(workingDirectory, "CLAUDE.md"))) !== null)
    throw new Error("Synthetic Claude directory must not contain CLAUDE.md");
  const config = {
    host: "127.0.0.1",
    port,
    token: randomBytes(32).toString("hex"),
    claudeCommand,
    workingDirectory,
    models: { "claude-opus": "opus" },
    maxClaudeConcurrency: 2,
    timeoutMs: 240000,
  };
  await atomicWrite(catalogFile, JSON.stringify(catalog, null, 2) + "\n");
  await atomicWrite(configFile, JSON.stringify(config, null, 2) + "\n");
  await atomicWrite(
    path.join(runtimeDirectory, "prepared.json"),
    JSON.stringify(
      { version: 1, runtimeDirectory, configFile, catalogFile, codexHome, backupDirectory },
      null,
      2,
    ) + "\n",
  );
  return {
    prepared: true,
    configFile,
    runtimeDirectory,
    catalogFile,
    port,
    model: "claude-opus",
    backupDirectory,
  };
}

export async function installPrepared(configFile) {
  if (process.platform !== "win32") throw new Error("Formal installation requires Windows");
  configFile = absolute(configFile, "Configuration file");
  const runtimeDirectory = path.dirname(configFile);
  await noLinks(runtimeDirectory);
  const prepared = JSON.parse(await readFile(path.join(runtimeDirectory, "prepared.json"), "utf8"));
  if (
    prepared.version !== 1 ||
    prepared.configFile !== configFile ||
    prepared.runtimeDirectory !== runtimeDirectory
  )
    throw new Error("Prepared installation identity mismatch");
  const config = await readRuntimeConfig(configFile);
  const stateFile = path.join(runtimeDirectory, "install-state.json");
  const priorState = await optionalRead(stateFile);
  if (priorState && JSON.parse(priorState).installed === true)
    throw new Error("Gateway is already installed; control it or roll it back before reinstalling");
  if (await portOpen(config.port))
    throw new Error(
      "Gateway port is already occupied; installation did not replace an existing process",
    );
  const codexConfigFile = path.join(absolute(prepared.codexHome, "Codex home"), "config.toml");
  const agentsFile = path.join(prepared.codexHome, "AGENTS.md");
  await noLinks(codexConfigFile);
  await noLinks(agentsFile);
  const beforeConfig = await readFile(codexConfigFile, "utf8");
  const beforeAgents = await readFile(agentsFile, "utf8");
  const section = await readFile(
    path.join(runtimeDirectory, "scripts", "native-agents-section.md"),
    "utf8",
  );
  const transformed = patchCodexConfig(beforeConfig, { config, catalogFile: prepared.catalogFile });
  const installedAgents = patchAgents(beforeAgents, section);
  const backupDirectory = path.join(
    runtimeDirectory,
    "backups",
    "activation-" + new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID(),
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await atomicWrite(path.join(backupDirectory, "config.toml.before"), beforeConfig);
  await atomicWrite(path.join(backupDirectory, "AGENTS.md.before"), beforeAgents);
  const existingTask = await runPowerShell(
    "$ErrorActionPreference = 'Stop'\n$t = Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq " +
      powershellQuote(TASK_NAME) +
      " }\nif ($t) { Export-ScheduledTask -TaskName " +
      powershellQuote(TASK_NAME) +
      " }",
  );
  if (existingTask) {
    await atomicWrite(path.join(backupDirectory, "scheduled-task.before.xml"), existingTask);
    throw new Error("A scheduled task with this name already exists; it was not overwritten");
  }
  const state = {
    version: 1,
    installed: false,
    taskName: TASK_NAME,
    runtimeDirectory,
    configFile,
    nodeCommand: process.execPath,
    codexConfigFile,
    agentsFile,
    backupDirectory,
    configPatch: transformed.patch,
    installedAgentsSection: section.trimEnd(),
    taskCreated: false,
  };
  await backupFile(stateFile, backupDirectory, "install-state.json.before");
  await atomicWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
  try {
    await runPowerShell(taskRegistrationScript({ runtimeDirectory, configFile }));
    state.taskCreated = true;
    await atomicWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
    const deadline = Date.now() + 20000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const health = await gatewayRequest(config, "/health");
        if (health.ready === true && health.models?.includes("claude-opus")) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!healthy) throw new Error("Gateway task started but its health was not verified");
    if (
      (await readFile(codexConfigFile, "utf8")) !== beforeConfig ||
      (await readFile(agentsFile, "utf8")) !== beforeAgents
    )
      throw new Error("Codex configuration changed during activation; refusing to overwrite it");
    await atomicWrite(codexConfigFile, transformed.text);
    state.configWritten = true;
    await atomicWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
    await atomicWrite(agentsFile, installedAgents);
    state.agentsWritten = true;
    state.installed = true;
    await atomicWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
    return {
      installed: true,
      runtimeDirectory,
      configFile,
      taskName: TASK_NAME,
      port: config.port,
      backupDirectory,
      requiresClientReload: true,
    };
  } catch (error) {
    if (state.configWritten)
      await atomicWrite(
        codexConfigFile,
        rollbackCodexConfig(await readFile(codexConfigFile, "utf8"), transformed.patch).text,
      ).catch(() => {});
    if (state.agentsWritten)
      await neutralizeAgents(agentsFile, state.installedAgentsSection, backupDirectory).catch(
        () => {},
      );
    await runPowerShell(taskControlScript(state, "unregister")).catch(() => {});
    await gatewayRequest(config, "/shutdown", "POST").catch(() => {});
    state.installed = false;
    state.activationFailed = true;
    await atomicWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
    throw error;
  }
}
async function neutralizeAgents(agentsFile, installedSection, backupDirectory) {
  const current = await readFile(agentsFile, "utf8");
  const range = sectionRange(current, NATIVE_HEADING);
  if (!range || current.slice(range.start, range.end).trim() !== installedSection.trim())
    return false;
  await atomicWrite(path.join(backupDirectory, "AGENTS.md.before-neutralization"), current);
  await atomicWrite(
    agentsFile,
    current.slice(0, range.start) +
      "### Opus 的委托边界\n\n- 使用当前实际验证可用的原生协作入口。未配置可用 Claude 模型时，说明限制并由 Codex 完成工作；不使用已卸载的 bridge MCP。\n\n" +
      current.slice(range.end),
  );
  return true;
}
export async function rollbackInstallation(configFile) {
  configFile = absolute(configFile, "Configuration file");
  const runtimeDirectory = path.dirname(configFile);
  const stateFile = path.join(runtimeDirectory, "install-state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  if (
    state.version !== 1 ||
    state.runtimeDirectory !== runtimeDirectory ||
    state.configFile !== configFile ||
    state.taskName !== TASK_NAME
  )
    throw new Error("Installation state identity mismatch");
  if (state.rolledBack === true && state.installed === false)
    return { rolledBack: true, alreadyRolledBack: true, bridgeRestored: false };
  const config = await readRuntimeConfig(configFile);
  await noLinks(state.codexConfigFile);
  await noLinks(state.agentsFile);
  await runPowerShell(taskControlScript(state, "disable"));
  await gatewayRequest(config, "/shutdown", "POST").catch(async () => {
    if (await portOpen(config.port))
      throw new Error("Gateway shutdown was not confirmed; rollback did not change Codex routing");
  });
  const deadline = Date.now() + 10000;
  while (await portOpen(config.port)) {
    if (Date.now() > deadline)
      throw new Error("Gateway exit is unconfirmed; Codex routing was not changed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const currentConfig = await readFile(state.codexConfigFile, "utf8");
  const restored = rollbackCodexConfig(currentConfig, state.configPatch);
  const rollbackBackup = path.join(runtimeDirectory, "backups", "rollback-" + randomUUID());
  await atomicWrite(path.join(rollbackBackup, "config.toml.before"), currentConfig);
  await atomicWrite(state.codexConfigFile, restored.text);
  await neutralizeAgents(state.agentsFile, state.installedAgentsSection, rollbackBackup);
  await runPowerShell(taskControlScript(state, "unregister"));
  state.installed = false;
  state.rolledBack = true;
  await atomicWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
  return {
    rolledBack: true,
    conflicts: restored.conflicts,
    backupDirectory: rollbackBackup,
    bridgeRestored: false,
  };
}
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.action === "help") {
    console.log(
      "Native gateway installer: --prepare | --install [--config-file ABSOLUTE] [--runtime-directory ABSOLUTE] [--codex-home ABSOLUTE] [--models-cache ABSOLUTE] [--claude-command ABSOLUTE] [--port 53571]. Preparation writes only its runtime artifacts; installation starts a current-user task and activates Codex routing.",
    );
    return;
  }
  if (options.action === "prepare") {
    console.log(JSON.stringify(await prepareInstallation(options), null, 2));
    return;
  }
  const configFile = absolute(
    options.configFile ||
      path.join(
        options.runtimeDirectory ||
          path.join(options.codexHome || defaultCodexHome(), "tools", "native-model-gateway"),
        "gateway.json",
      ),
    "Configuration file",
  );
  if (!(await optionalRead(configFile))) await prepareInstallation({ ...options, configFile });
  console.log(JSON.stringify(await installPrepared(configFile), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Native gateway installation failed. Existing credentials were not changed; inspect local backups and gateway logs. No token was printed.",
    );
    process.exitCode = 1;
  });
