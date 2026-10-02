import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createGateway,
  runClaude,
  prepareResponsesRequest,
  decisionToResponse,
  responseToSse,
} from "../dist/native-gateway.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(repo, ".personal-validation", "native-" + randomUUID());
fs.mkdirSync(dir, { recursive: true });
const work = path.join(dir, "synthetic-workspace");
fs.mkdirSync(work);
const nonce = "NATIVE_TOOL_" + randomUUID().slice(0, 8);
const fixtureCode = "text(await tools.mcp__synthetic__read_fixture({}));";
const fixture = path.join(work, "synthetic-fixture.txt");
fs.writeFileSync(fixture, nonce);
const cli = "C:/Users/user/AppData/Local/OpenAI/Codex/bin/c6fe824d725f02d7/codex.exe";
const claude =
  "C:/Users/user/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
let token = "synthetic-" + randomUUID() + randomUUID();
const configIndex = process.argv.indexOf("--config-file");
const installedFile = configIndex < 0 ? null : process.argv[configIndex + 1];
const offlineMixed = process.argv.includes("--offline-mixed");
const protocolOnly = process.argv.includes("--protocol-only") || offlineMixed;
const codeMode = process.argv.includes("--code-mode");
const liveParent = process.argv.includes("--live-parent") || offlineMixed;
const parentContext = "ROOT_CONTEXT_" + randomUUID().slice(0, 8);
const report = {
  syntheticOnly: true,
  originalPrivateContextForwarded: false,
  gatewayMode: installedFile ? "installed" : "owned",
  rootBackend: liveParent && !offlineMixed ? "official GPT subscription" : "deterministic fixture",
  networkCalls: 0,
  payloadAudits: [],
  claudeBackend: protocolOnly ? "deterministic fixture" : "official installed CLI",
  requests: [],
  inferences: [],
  nonce,
  parentContext,
};
const gateway = createGateway(
  {
    host: "127.0.0.1",
    port: 0,
    token,
    claudeCommand: claude,
    workingDirectory: work,
    models: { "claude-opus": "opus" },
    timeoutMs: 120000,
  },
  {
    inference: async (options) => {
      if (
        options.prompt.includes("192.168.") ||
        options.prompt.includes("sudoers") ||
        options.prompt.includes("NAS 与 VPS")
      )
        throw Error("Synthetic isolation failed");
      if (liveParent) {
        if (!options.prompt.includes(parentContext))
          throw Error("Native fork omitted the synthetic parent context");
        report.nativeForkContextObserved = true;
      }
      const result = protocolOnly
        ? {
            model: "synthetic",
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            decision: options.prompt.includes(nonce)
              ? { kind: "final", text: nonce + (liveParent ? " " + parentContext : ""), calls: [] }
              : {
                  kind: "tool_calls",
                  text: "",
                  calls: [{ tool_id: "tool_0", input: codeMode ? fixtureCode : "{}" }],
                },
          }
        : await runClaude(options);
      report.inferences.push({ model: result.model, decision: result.decision });
      for (const call of result.decision.calls || []) {
        if (codeMode) {
          if (call.input !== fixtureCode) throw Error("Non-fixture code refused");
        } else {
          const args = JSON.parse(call.input);
          if (Object.keys(args).length !== 0) throw Error("Non-fixture tool arguments refused");
        }
      }
      return result;
    },
    upstream: offlineMixed
      ? async (_target, options) => {
          const request = JSON.parse(Buffer.from(options.body).toString());
          const prepared = prepareResponsesRequest({
            model: "claude-opus",
            input: "Synthetic local controller",
            tools: request.tools,
          });
          const call = (name, args) => ({
            kind: "tool_calls",
            text: "",
            calls: [
              {
                tool_id: prepared.tools.find((t) => t.name === name).id,
                input: JSON.stringify(args),
              },
            ],
          });
          let decision;
          if (rootStage === 0) {
            rootStage++;
            decision = call("spawn_agent", {
              task_name: "native_claude_probe",
              message: initialTask,
              model: "claude-opus",
              fork_turns: "3",
              reasoning_effort: "low",
            });
          } else if (!report.childResultReceived)
            decision = call("wait_agent", { timeout_ms: 10000 });
          else if (rootStage === 1) {
            rootStage++;
            decision = call("followup_task", {
              target: "native_claude_probe",
              message: followupTask,
            });
          } else if (!report.followupResultReceived)
            decision = call("wait_agent", { timeout_ms: 10000 });
          else decision = { kind: "final", text: "SYNTHETIC_NATIVE_COMPLETE", calls: [] };
          const response = decisionToResponse(decision, prepared);
          response.model = rootModel;
          return new Response(responseToSse(response), {
            headers: { "content-type": "text/event-stream" },
          });
        }
      : undefined,
  },
);
await gateway.listen();
let gatewayUrl = `http://127.0.0.1:${gateway.server.address().port}`;
if (installedFile) {
  if (!path.isAbsolute(installedFile) || offlineMixed || protocolOnly)
    throw Error("Installed live probe requires an absolute config path");
  const config = JSON.parse(fs.readFileSync(installedFile, "utf8"));
  if (
    config.host !== "127.0.0.1" ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.token !== "string" ||
    config.token.length < 32
  )
    throw Error("Invalid installed loopback config");
  gatewayUrl = `http://127.0.0.1:${config.port}`;
  token = config.token;
}
const rootModel = liveParent ? "gpt-6.1-sol" : "routing-parent-probe";
const initialTask =
  "SYNTHETIC_TASK Use the read_fixture MCP tool to read the synthetic fixture. You must request the tool before replying. Return only the exact file text after the tool result arrives." +
  (codeMode
    ? ` Use the native exec custom tool with exactly this JavaScript: ${fixtureCode}`
    : "") +
  (liveParent ? " Also append the ROOT_CONTEXT value from the forked parent user message." : "");
const followupTask =
  "SYNTHETIC_TASK Follow-up: reply with the same file value from this native conversation. Do not run a tool again.";
const rootPrompt = liveParent
  ? `Synthetic native tool test only. Parent context value is ${parentContext}. Use spawn_agent with task_name native_claude_probe, model claude-opus, fork_turns 3, reasoning_effort low and message exactly: ${initialTask} After it completes, use followup_task with message exactly: ${followupTask} Wait for its second final reply. Return SYNTHETIC_NATIVE_COMPLETE and the read file value only after both child replies. Do not create any other agent or use other tools.`
  : "Synthetic native tool test only. Delegate the synthetic fixture reading to the configured Claude native child.";
let rootStage = 0;
function responseItems(text) {
  const items = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let event;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    for (const item of [
      ...(event.type === "response.output_item.done" ? [event.item] : []),
      ...(event.type === "response.completed" ? event.response?.output || [] : []),
    ])
      if (item) items.set(item.id || item.call_id, item);
  }
  return [...items.values()];
}
function verifyFixtureCalls(text, provider) {
  const items = responseItems(text);
  for (const item of items.filter((x) => ["function_call", "custom_tool_call"].includes(x.type))) {
    if (provider === "claude") {
      if (codeMode) {
        if (item.type !== "custom_tool_call" || item.name !== "exec" || item.input !== fixtureCode)
          throw Error("Non-fixture native code refused");
      } else if (
        !item.name.includes("read_fixture") ||
        Object.keys(JSON.parse(item.arguments)).length
      )
        throw Error("Non-fixture MCP call refused");
    } else {
      const args = JSON.parse(item.arguments);
      if (item.namespace !== "collaboration") throw Error("Non-synthetic parent namespace refused");
      if (item.name === "spawn_agent") {
        if (
          args.message !== initialTask ||
          args.model !== "claude-opus" ||
          args.task_name !== "native_claude_probe" ||
          args.fork_turns !== "3"
        )
          throw Error("Non-synthetic dispatch refused");
      } else if (item.name === "followup_task") {
        if (
          args.message !== followupTask ||
          !["native_claude_probe", "/root/native_claude_probe"].includes(args.target)
        )
          throw Error("Non-synthetic followup refused");
      } else if (item.name !== "wait_agent") throw Error("Non-synthetic parent tool refused");
    }
  }
  return items;
}
const shim = http.createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    report.requests.push({
      model: body.model,
      nativeGlobalInstructionsDetected: raw.includes("NAS 与 VPS") || raw.includes("# AGENTS.md"),
      keys: Object.keys(body),
      inputTypes: (body.input || []).map((x) => x.type || "message"),
      agentMessages: (body.input || [])
        .filter((x) => x.type === "agent_message")
        .map((x) => ({
          author: x.author,
          recipient: x.recipient,
          content: x.content.map((c) => ({
            type: c.type,
            length: (c.text || c.encrypted_content || "").length,
            exactInitialTask: (c.text || c.encrypted_content) === initialTask,
            exactFollowup: (c.text || c.encrypted_content) === followupTask,
            containsNonce: (c.text || c.encrypted_content || "").includes(nonce),
            looksJson: (c.encrypted_content || "").startsWith("{"),
          })),
        })),
    });
    if (body.model === "claude-opus") {
      report.childToolShapes ??= prepareResponsesRequest({
        ...body,
        input: "Synthetic tool shape",
      }).tools.map((x) => ({ name: x.name, namespace: x.namespace, type: x.type }));
      try {
        prepareResponsesRequest(body);
        report.originalNativeProtocolAccepted = true;
      } catch (error) {
        report.originalProtocolError = {
          message: error.message,
          code: error.code,
          param: error.param,
        };
      }
      // Build an exact synthetic conversation. Global AGENTS never crosses this test boundary.
      const allowedHistory = (body.input || []).filter((item) => {
        if (item.type === "agent_message") {
          if (
            !item.content.some(
              (c) =>
                c.type === "input_text" &&
                [initialTask, followupTask].some(
                  (t) => c.text.endsWith(t) && c.text.length <= t.length + 512,
                ),
            ) ||
            item.content.some((c) => c.type !== "input_text")
          )
            throw Error("Non-synthetic or opaque agent task refused");
          return true;
        }
        if (
          liveParent &&
          item.role === "user" &&
          item.content?.some((c) => c.type === "input_text" && c.text === rootPrompt)
        )
          return true;
        return (
          [
            "function_call",
            "function_call_output",
            "custom_tool_call",
            "custom_tool_call_output",
          ].includes(item.type) ||
          (item.role === "assistant" && ["message", undefined].includes(item.type))
        );
      });
      if (!allowedHistory.some((item) => item.type === "agent_message"))
        throw Error("Native synthetic agent task is missing");
      const onlyFixture = (tools) =>
        tools.flatMap((tool) =>
          tool.type === "namespace"
            ? [{ ...tool, tools: onlyFixture(tool.tools || []) }].filter(
                (tool) => tool.tools.length,
              )
            : tool.name?.includes("read_fixture") ||
                (codeMode && tool.type === "custom" && tool.name === "exec")
              ? [tool]
              : [],
        );
      const tools = onlyFixture(body.tools || []);
      if (!tools.length) throw Error("Native synthetic MCP tool is missing");
      const synthetic = {
        ...body,
        instructions:
          "Synthetic native tool execution test only. Use only the supplied synthetic MCP. Follow the actual native agent_message conversation." +
          (codeMode
            ? ` The exec custom tool accepts JavaScript; it has a tools object with the read-only function mcp__synthetic__read_fixture and a text(value) output helper. Invoke exactly: ${fixtureCode}`
            : ""),
        input: allowedHistory,
        tools,
      };
      report.payloadAudits.push({
        provider: "claude",
        inputTypes: allowedHistory.map((x) => x.type || "message"),
        knownGlobalInstructionsPresent:
          JSON.stringify(synthetic).includes("# AGENTS.md") ||
          JSON.stringify(synthetic).includes("NAS 与 VPS"),
        knownTaskRequired: true,
      });
      if (report.payloadAudits.some((x) => x.knownGlobalInstructionsPresent))
        throw Error("Private instruction audit failed");
      if (installedFile && liveParent) {
        if (!prepareResponsesRequest(synthetic).prompt.includes(parentContext))
          throw Error("Installed native fork lost its parent context");
        report.nativeForkContextObserved = true;
      }
      const response = await fetch(gatewayUrl + "/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "x-native-gateway-token": token },
        body: JSON.stringify(synthetic),
      });
      const responseText = await response.text();
      const items = verifyFixtureCalls(responseText, "claude");
      if (installedFile && items.length) {
        const calls = items.filter((x) => ["function_call", "custom_tool_call"].includes(x.type));
        report.inferences.push({
          model: "installed claude-opus",
          decision: {
            kind: calls.length ? "tool_calls" : "final",
            text: items
              .filter((x) => x.type === "message")
              .flatMap((x) => x.content || [])
              .map((x) => x.text || "")
              .join(""),
            calls: calls.map((x) => ({ input: x.arguments || x.input })),
          },
        });
      }
      if (response.status >= 400 || responseText.includes("event: error")) {
        report.gatewayErrors ??= [];
        report.gatewayErrors.push({ status: response.status, text: responseText.slice(0, 1000) });
      }
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") || "application/json",
      });
      res.end(responseText);
      return;
    }
    const prepared = prepareResponsesRequest({
      model: "claude-opus",
      input: "Synthetic controller",
      tools: body.tools,
    });
    const tools = prepared.tools;
    report.rootToolShapes ??= tools.map((x) => ({
      name: x.name,
      namespace: x.namespace,
      type: x.type,
    }));
    const nativeCollaboration = (body.tools || []).find(
      (x) => x.type === "namespace" && x.name === "collaboration",
    );
    if (nativeCollaboration)
      fs.writeFileSync(
        path.join(repo, ".personal-validation", "public-collaboration-schema.json"),
        JSON.stringify(nativeCollaboration, null, 2),
      );
    if (liveParent) {
      const history = (body.input || []).filter(
        (item) =>
          ["function_call", "function_call_output", "reasoning", "agent_message"].includes(
            item.type,
          ) ||
          (item.role === "assistant" && ["message", undefined].includes(item.type)),
      );
      report.childResultReceived ||= history.some(
        (item) => item.type === "agent_message" && JSON.stringify(item).includes(nonce),
      );
      report.followupResultReceived ||=
        history.filter(
          (item) => item.type === "agent_message" && JSON.stringify(item).includes(nonce),
        ).length >= 2;
      report.parentContextReceived ||= history.some(
        (item) => item.type === "agent_message" && JSON.stringify(item).includes(parentContext),
      );
      const safe = {
        model: rootModel,
        instructions:
          "Run the exact synthetic delegation workflow requested by the user. Native tools only; no other work. Use tool messages exactly as provided.",
        input: [{ role: "user", content: rootPrompt }, ...history],
        tools: [nativeCollaboration],
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: { effort: "low", summary: "auto" },
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      };
      if (JSON.stringify(safe).includes("NAS 与 VPS") || JSON.stringify(safe).includes("192.168."))
        throw Error("Synthetic parent isolation failed");
      report.payloadAudits.push({
        provider: "gpt",
        inputTypes: safe.input.map((x) => x.type || "message"),
        fixedRootPrompt: true,
        knownGlobalInstructionsPresent:
          JSON.stringify(safe).includes("# AGENTS.md") ||
          JSON.stringify(safe).includes("NAS 与 VPS"),
      });
      if (report.payloadAudits.some((x) => x.knownGlobalInstructionsPresent))
        throw Error("Private instruction audit failed");
      const headers = { "content-type": "application/json", "x-native-gateway-token": token };
      for (const key of ["authorization", "chatgpt-account-id"])
        if (req.headers[key]) headers[key] = req.headers[key];
      const response = await fetch(gatewayUrl + "/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify(safe),
      });
      if (!offlineMixed) report.networkCalls++;
      const text = await response.text();
      verifyFixtureCalls(text, "gpt");
      if (response.status >= 400 || text.includes("event: error")) {
        report.gatewayErrors ??= [];
        report.gatewayErrors.push({ status: response.status, text: text.slice(0, 1000) });
      }
      res.writeHead(response.status, { "content-type": "text/event-stream" });
      res.end(text);
      return;
    }
    const call = (name, args) => ({
      kind: "tool_calls",
      text: "",
      calls: [
        { tool_id: tools.find((tool) => tool.name === name).id, input: JSON.stringify(args) },
      ],
    });
    let decision;
    if (rootStage === 0) {
      rootStage++;
      decision = call("spawn_agent", {
        task_name: "native_claude_probe",
        message: initialTask,
        model: "claude-opus",
        fork_turns: "none",
        reasoning_effort: "low",
      });
    } else if (rootStage === 1) {
      rootStage++;
      decision = call("wait_agent", { timeout_ms: 10000 });
    } else if (rootStage === 2) {
      report.childResultReceived = (body.input || []).some(
        (item) => item.type !== "function_call" && JSON.stringify(item).includes(nonce),
      );
      if (report.gatewayErrors?.length || report.error) {
        rootStage = 4;
        decision = { kind: "final", text: "SYNTHETIC_NATIVE_FAILED", calls: [] };
      } else if (!report.childResultReceived) {
        decision = call("wait_agent", { timeout_ms: 10000 });
      } else {
        rootStage++;
        decision = call("followup_task", { target: "native_claude_probe", message: followupTask });
      }
    } else if (rootStage === 3) {
      rootStage++;
      decision = call("wait_agent", { timeout_ms: 10000 });
    } else {
      report.followupResultReceived =
        (body.input || []).filter(
          (item) => item.type !== "function_call" && JSON.stringify(item).includes(nonce),
        ).length >= 2;
      decision = { kind: "final", text: "SYNTHETIC_NATIVE_COMPLETE", calls: [] };
    }
    const response = decisionToResponse(decision, prepared);
    response.model = rootModel;
    for (const item of response.output)
      if (item.type === "function_call" && ["spawn_agent", "followup_task"].includes(item.name))
        item.encrypted_function_args = [];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(responseToSse(response));
  } catch (error) {
    report.error = { message: error.message, code: error.code, param: error.param };
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((resolve) => shim.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${shim.address().port}/v1`;
const cached = JSON.parse(fs.readFileSync("C:/Users/user/.codex/models_cache.json", "utf8"));
const template = structuredClone(cached.models[0]);
template.model_messages = {
  instructions_template: "Synthetic native gateway verification assistant.",
};
template.base_instructions = "Synthetic verification only.";
template.experimental_supported_tools = [];
template.supports_search_tool = false;
template.use_responses_lite = false;
template.additional_speed_tiers = [];
template.service_tiers = [];
template.multi_agent_version = "v2";
delete template.tool_mode;
if (codeMode) template.tool_mode = "code_mode_only";
const catalog = path.join(dir, "catalog.json");
fs.writeFileSync(
  catalog,
  JSON.stringify({
    models: [rootModel, "claude-opus"].map((slug) => ({
      ...template,
      slug,
      display_name: slug,
      description: "Synthetic fixture model",
    })),
  }),
);
const mcpScript = path.join(repo, "scripts", "fixtures", "read-synthetic-mcp.mjs");
const config = [
  `model="${rootModel}"`,
  'model_provider="synthetic-native"',
  `model_catalog_json=${JSON.stringify(catalog.replaceAll("\\", "/"))}`,
  `model_providers.synthetic-native={name="Synthetic native gateway",base_url="${base}",wire_api="responses",requires_openai_auth=${liveParent},supports_websockets=false}`,
  `mcp_servers.synthetic={command=${JSON.stringify(process.execPath.replaceAll("\\", "/"))},args=[${JSON.stringify(mcpScript.replaceAll("\\", "/"))},${JSON.stringify(fixture.replaceAll("\\", "/"))}]}`,
  "project_doc_max_bytes=0",
  'web_search="disabled"',
  "features.multi_agent_v2=true",
  `features.code_mode_host=${codeMode}`,
  "features.plugins=false",
  "features.apps=false",
  "features.memories=false",
  "features.hooks=false",
  "features.skip_host_skill_discovery=true",
];
const args = [
  "exec",
  "--ignore-user-config",
  ...(!liveParent ? ["--ephemeral"] : []),
  "--strict-config",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "--json",
  "-C",
  work,
  ...config.flatMap((value) => ["-c", value]),
  rootPrompt,
];
const child = spawn(cli, args, { cwd: work, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "",
  stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const timer = setTimeout(() => child.kill(), 210000);
report.exitCode = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);
report.nativeEvents = stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { type: "text", text: line };
    }
  });
report.stderr = stderr;
report.passed =
  report.exitCode === 0 &&
  report.childResultReceived === true &&
  report.followupResultReceived === true &&
  report.inferences.length >= 3 &&
  report.inferences.some((x) => x.decision.kind === "tool_calls") &&
  !report.originalProtocolError &&
  (!liveParent || report.parentContextReceived === true);
fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
await new Promise((resolve) => shim.close(resolve));
await gateway.shutdown();
console.log(
  JSON.stringify(
    {
      report: path.join(dir, "report.json"),
      passed: report.passed,
      exitCode: report.exitCode,
      originalNativeProtocolAccepted: report.originalNativeProtocolAccepted,
      originalProtocolError: report.originalProtocolError,
      error: report.error,
      gatewayErrors: report.gatewayErrors,
      childResultReceived: report.childResultReceived,
      followupResultReceived: report.followupResultReceived,
      models: report.inferences.map((x) => x.model),
      decisions: report.inferences.map((x) => x.decision.kind),
      requestKeys: report.requests[0]?.keys,
      stderr: stderr.slice(-1600),
    },
    null,
    2,
  ),
);
if (!report.passed) process.exitCode = 1;
