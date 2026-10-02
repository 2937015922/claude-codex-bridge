#!/usr/bin/env node
// Live subscription transport probe. Only fixed public fixtures go upstream.
// The actual Codex request (including global AGENTS) is discarded completely.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createGateway } from "../dist/native-gateway.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const cli =
  option("--codex-path") ??
  "C:/Users/user/AppData/Local/OpenAI/Codex/bin/c6fe824d725f02d7/codex.exe";
const installedFile = option("--config-file");
if (!path.isAbsolute(cli) || (installedFile && !path.isAbsolute(installedFile)))
  throw Error("CLI and optional gateway config paths must be absolute");
const dir = path.join(repo, ".personal-validation", "gpt-" + randomUUID());
fs.mkdirSync(dir, { recursive: true });
const work = path.join(dir, "synthetic-workspace");
fs.mkdirSync(work);
const model = "gpt-6.1-sol";
const publicMessage = "SYNTHETIC_CLAUDE_DISPATCH";
const namespaceName = process.argv.includes("--alias") ? "native_collaboration" : "collaboration";
const publicInstructions = `This is a public synthetic routing verification. Call ${namespaceName}.spawn_agent exactly once. Use task_name synthetic_probe, message SYNTHETIC_CLAUDE_DISPATCH, model claude-opus, and fork_turns none. Do not answer in prose.`;
const publicInput =
  "Request the synthetic Claude child using only the exact fixed arguments required by the supplied schema. This tool will not be executed.";
const report = {
  syntheticOnly: true,
  originalNativeContextForwarded: false,
  credentialFilesRead: false,
  credentialValuesLogged: false,
  officialCodexManagesAuth: true,
  expectedOfficialUpstream: "https://chatgpt.com/backend-api/codex/responses",
  gatewayMode: installedFile ? "installed" : "owned",
  cases: [],
};
let gateway;
let token;
let gatewayUrl;
let current;
let externalRequests = 0;
if (installedFile) {
  // Local capability is read only to contact the installed loopback gateway.
  // It is never printed, written to this report, or forwarded upstream.
  const config = JSON.parse(fs.readFileSync(installedFile, "utf8"));
  if (
    config.host !== "127.0.0.1" ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.token !== "string" ||
    config.token.length < 32
  )
    throw Error("Installed gateway config is not a valid loopback configuration");
  token = config.token;
  gatewayUrl = `http://127.0.0.1:${config.port}`;
} else {
  token = randomUUID() + randomUUID();
  gateway = createGateway(
    {
      host: "127.0.0.1",
      port: 0,
      token,
      claudeCommand: process.execPath,
      workingDirectory: work,
      models: {},
    },
    {
      inference: async () => {
        throw Error("This GPT transport probe never starts Claude");
      },
      upstream: async (target, init) => {
        const activeCase = current;
        if (target !== report.expectedOfficialUpstream)
          throw Error("Non-official upstream refused");
        if (++externalRequests > 2) throw Error("External fixture call budget exceeded");
        activeCase.directOfficialUpstreamObserved = true;
        const response = await fetch(target, { ...init, redirect: "error" });
        activeCase.actualUpstreamHttpStatus = response.status;
        activeCase.actualUpstreamContentType = response.headers.get("content-type");
        return response;
      },
    },
  );
  await gateway.listen();
  gatewayUrl = `http://127.0.0.1:${gateway.server.address().port}`;
}

function fixture(encrypted) {
  const tools = JSON.parse(
    fs.readFileSync(
      path.join(repo, "scripts", "fixtures", "native-collaboration-schema.json"),
      "utf8",
    ),
  );
  if (
    tools.name !== "collaboration" ||
    tools.tools.some((t) => t.type !== "function") ||
    /NAS 与 VPS|192\.168\.|C:\\\\Users/.test(JSON.stringify(tools))
  )
    throw Error("Public schema guard failed");
  tools.name = namespaceName;
  for (const tool of tools.tools)
    if (tool.parameters?.properties?.message)
      tool.parameters.properties.message.encrypted = encrypted;
  // Do not spread, reuse, or filter the native body. Every field is public/fixed.
  return {
    model,
    instructions: publicInstructions,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: publicInput }] },
    ],
    tools: [tools],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
}
function inspectPublicRequestError(text, credentialValues) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { jsonParsed: false };
  }
  const error = parsed?.error;
  const sanitize = (value, max) => {
    if (typeof value !== "string") return null;
    let clean = value;
    for (const secret of credentialValues)
      if (typeof secret === "string" && secret.length)
        clean = clean.replaceAll(secret, "[redacted]");
    clean = clean.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
    return clean.slice(0, max);
  };
  return {
    jsonParsed: true,
    code: sanitize(error?.code, 160),
    param: sanitize(error?.param, 160),
    message: sanitize(typeof error === "string" ? error : error?.message, 400),
  };
}
function encryptionState(item) {
  if (!Object.hasOwn(item, "encrypted_function_args")) return "missing";
  const value = item.encrypted_function_args;
  if (value === null) return "null";
  return Array.isArray(value) && value.length === 0 ? "[]" : "nonempty";
}
function inspectOfficial(text) {
  const calls = new Map();
  const eventTypes = new Set();
  const encryptionEvents = [];
  let completed = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let event;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (typeof event.type === "string") eventTypes.add(event.type);
    if (event.type === "response.completed") completed = true;
    const items = [...(event.item ? [event.item] : []), ...(event.response?.output ?? [])];
    if (Object.hasOwn(event, "encrypted_function_args"))
      encryptionEvents.push({
        eventType: event.type,
        fieldLocation: "event",
        state: encryptionState(event),
      });
    for (const item of items) {
      if (item.type !== "function_call") continue;
      encryptionEvents.push({
        eventType: event.type,
        fieldLocation: "item",
        state: encryptionState(item),
      });
      // output_item.done and response.completed replace incomplete added items.
      calls.set(item.call_id ?? item.id ?? `${item.namespace ?? ""}.${item.name}`, item);
    }
  }
  return {
    completed,
    eventTypes: [...eventTypes],
    encryptionEvents,
    functionCalls: [...calls.values()].map((item) => {
      let args;
      try {
        args = JSON.parse(item.arguments);
      } catch {}
      return {
        name: item.name,
        namespace: item.namespace ?? null,
        encryptedFunctionArgs: encryptionState(item),
        encryptedFunctionArgCount: Array.isArray(item.encrypted_function_args)
          ? item.encrypted_function_args.length
          : null,
        argumentsValidJson: Boolean(args && typeof args === "object"),
        messageExactFixture: args?.message === publicMessage,
        modelExactClaudeOpus: args?.model === "claude-opus",
        forkTurnsExactNone: args?.fork_turns === "none",
      };
    }),
  };
}
function fakeFinal(res, marker) {
  const id = "resp_synthetic_" + randomUUID().replaceAll("-", "");
  const item = {
    type: "message",
    id: "msg_synthetic_" + randomUUID().replaceAll("-", ""),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: marker, annotations: [] }],
  };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("response.created", {
    response: { id, object: "response", model, status: "in_progress", output: [] },
  });
  emit("response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
  emit("response.content_part.added", {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  emit("response.output_text.delta", {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: marker,
  });
  emit("response.output_text.done", {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text: marker,
  });
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", {
    response: {
      id,
      object: "response",
      model,
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  res.end();
}
const shim = http.createServer(async (req, res) => {
  const activeCase = current;
  if (req.method !== "POST" || req.url !== "/v1/responses" || !activeCase) {
    res.writeHead(404);
    res.end();
    return;
  }
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    // Native input is consumed and discarded; never serialized or logged.
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 48 * 1024 * 1024) throw Error("Native request size exceeded");
    }
    activeCase.nativeRequests++;
    activeCase.nativeAuth = {
      bearerAttached:
        typeof req.headers.authorization === "string" &&
        req.headers.authorization.startsWith("Bearer "),
      accountIdAttached:
        typeof req.headers["chatgpt-account-id"] === "string" &&
        Boolean(req.headers["chatgpt-account-id"].trim()),
    };
    if (activeCase.nativeRequests !== 1) throw Error("Additional native request refused");
    if (!activeCase.nativeAuth.bearerAttached || !activeCase.nativeAuth.accountIdAttached)
      throw Error("Native subscription auth was not attached");
    // Only two credential header values enter the local gateway. The native body,
    // cookies, arbitrary routing headers, and private AGENTS never leave the shim.
    const headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-native-gateway-token": token,
      authorization: req.headers.authorization,
      "chatgpt-account-id": req.headers["chatgpt-account-id"],
    };
    const response = await fetch(gatewayUrl + "/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(fixture(activeCase.messageEncryptedAnnotation)),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      redirect: "error",
    });
    activeCase.gatewayHttpStatus = response.status;
    activeCase.gatewayContentType = response.headers.get("content-type");
    const text = await response.text();
    activeCase.officialResponse = inspectOfficial(text);
    if (response.status >= 400)
      activeCase.publicRequestError = inspectPublicRequestError(text, [
        req.headers.authorization,
        req.headers.authorization.slice(7),
        req.headers["chatgpt-account-id"],
        token,
      ]);
    activeCase.fixtureSent = true;
  } catch (error) {
    // Error detail may include provider material; retain only an allowlisted category.
    activeCase.transportFailure =
      error?.name === "TimeoutError"
        ? "timeout"
        : error?.name === "AbortError"
          ? "cancelled"
          : "transport_or_auth_failure";
  }
  // Never deliver the upstream function call to Codex. No native child/tool runs.
  if (!res.destroyed) fakeFinal(res, activeCase.marker);
});

const cached = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8"),
);
const template = structuredClone(cached.models.find((entry) => entry.slug === model));
if (!template) throw Error("Requested GPT model was not present in the local public catalog");
template.model_messages = {
  instructions_template:
    "Public synthetic transport verification only. Return the requested marker.",
};
template.base_instructions = "Public synthetic transport verification only.";
template.experimental_supported_tools = [];
template.supports_search_tool = false;
template.use_responses_lite = false;
template.service_tiers = [];
template.additional_speed_tiers = [];
delete template.tool_mode;
const catalog = path.join(dir, "synthetic-catalog.json");
fs.writeFileSync(catalog, JSON.stringify({ models: [template] }));
const instructionsFile = path.join(dir, "synthetic-instructions.txt");
fs.writeFileSync(instructionsFile, template.base_instructions);

async function runCase(encrypted, base) {
  current = {
    messageEncryptedAnnotation: encrypted,
    nativeRequests: 0,
    marker: `SYNTHETIC_GPT_GATEWAY_${encrypted ? "ENCRYPTED" : "PLAIN"}_COMPLETE`,
  };
  report.cases.push(current);
  const config = [
    `model="${model}"`,
    'model_provider="gpt-fixture-loopback"',
    `model_catalog_json=${JSON.stringify(catalog.replaceAll("\\", "/"))}`,
    `model_instructions_file=${JSON.stringify(instructionsFile.replaceAll("\\", "/"))}`,
    `model_providers.gpt-fixture-loopback={name="Public synthetic fixture shim",base_url="${base}",wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
    'model_reasoning_effort="low"',
    "project_doc_max_bytes=0",
    'web_search="disabled"',
    "features.plugins=false",
    "features.apps=false",
    "features.memories=false",
    "features.hooks=false",
    "features.code_mode_host=false",
    "features.multi_agent=false",
    "features.skip_host_skill_discovery=true",
    'developer_instructions="Public synthetic transport verification only. Do not use tools."',
  ];
  const args = [
    "exec",
    "--ignore-user-config",
    "--strict-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "-C",
    work,
    ...config.flatMap((value) => ["-c", value]),
    `Return exactly ${current.marker}. Public synthetic fixture.`,
  ];
  const child = spawn(cli, args, {
    cwd: work,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderrBytes = 0;
  let spawnFailed = false;
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 4 * 1024 * 1024) stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });
  child.on("error", () => {
    spawnFailed = true;
  });
  const timer = setTimeout(() => child.kill(), 80_000);
  current.exitCode = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  current.spawnFailed = spawnFailed;
  current.stderrBytes = stderrBytes;
  current.syntheticFinalReturned = stdout.includes(current.marker);
  const calls = current.officialResponse?.functionCalls ?? [];
  current.passed =
    current.exitCode === 0 &&
    current.syntheticFinalReturned &&
    current.gatewayHttpStatus === 200 &&
    current.officialResponse.completed &&
    calls.length === 1 &&
    calls[0].name === "spawn_agent" &&
    calls[0].namespace === namespaceName &&
    calls[0].modelExactClaudeOpus &&
    calls[0].forkTurnsExactNone &&
    (!encrypted ? calls[0].messageExactFixture : true);
}

try {
  await new Promise((resolve) => shim.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${shim.address().port}/v1`;
  await runCase(false, base);
  if (!process.argv.includes("--only-unencrypted")) await runCase(true, base);
  report.passed = report.cases.every((entry) => entry.passed);
  report.actualDirectExternalRequests = installedFile ? null : externalRequests;
  report.nativeToolCallsExecuted = false;
} finally {
  shim.closeAllConnections();
  await new Promise((resolve) => shim.close(resolve));
  if (gateway) await gateway.shutdown();
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ report: path.join(dir, "report.json"), ...report }, null, 2));
if (!report.passed) process.exitCode = 1;
