import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// This probe creates its own conversation and instruction files. It never reads
// or forwards a real Codex conversation, global AGENTS, credentials or reasoning.
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.join(root, ".personal-validation", randomUUID());
const project = path.join(fixture, "project");
const state = path.join(fixture, "state");
const live = process.argv.includes("--live");
const results = [];
const clients = [];
await mkdir(project, { recursive: true });
await mkdir(state, { recursive: true });
const env = Object.fromEntries(
  Object.entries({
    ...process.env,
    BRIDGE_STATE_DIR: state,
    BRIDGE_CONTEXT_TEST_MODE: "synthetic",
    BRIDGE_CONTEXT_TEST_INSTRUCTION_ROOTS: "[]",
    BRIDGE_CODEX_COMMAND: path.join(fixture, "intentionally-missing-codex"),
  }).filter(([, value]) => value !== undefined),
);
// No operator MCP configuration or policy is inherited by the isolated probe.
delete env.BRIDGE_CONTEXT_SHARING;
delete env.BRIDGE_MCP_CONFIG;
delete env.BRIDGE_MCP_ALLOWED_TOOLS;
delete env.BRIDGE_DAEMON_TOKEN;
async function run(relative, args = [], input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, relative), ...args], {
      env,
      cwd: project,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Synthetic validation child timed out"));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Validation child failed (${code}): ${stderr.slice(0, 1000)}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
async function connect() {
  const client = new Client({ name: "synthetic-personal-validation", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/personal-server.mjs")],
      env,
      cwd: project,
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return client;
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}
async function hook(parent, text, toolName, toolInput) {
  const transcript = path.join(fixture, `${parent}.jsonl`);
  await writeFile(
    transcript,
    [
      { type: "session_meta", payload: { id: parent, cwd: project } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          channel: "analysis",
          content: [{ type: "output_text", text: "SYNTHETIC_HIDDEN_REASONING_MUST_NOT_EXPORT" }],
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const output = JSON.parse(
    await run(
      "dist/personal/context-hook.mjs",
      [],
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: parent,
        turn_id: randomUUID(),
        cwd: project,
        transcript_path: transcript,
        tool_name: `mcp__claude_personal__${toolName}`,
        tool_input: toolInput,
      }),
    ),
  );
  const updated = output.hookSpecificOutput?.updatedInput;
  assert.match(updated?.contextRef || "", /^ctx_[a-f0-9]{64}$/);
  const packet = JSON.parse(
    await readFile(path.join(state, "contexts", `${updated.contextRef}.json`), "utf8"),
  );
  assert.equal(packet.coverage.instructions, 0);
  assert.ok(!packet.text.includes("SYNTHETIC_HIDDEN_REASONING"));
  return updated;
}
async function completed(client, task) {
  let cursor = 0;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const update = await call(client, "agent_wait", {
      taskId: task.taskId,
      afterCursor: cursor,
      timeoutMs: 10000,
    });
    cursor = update.nextCursor;
    if (!["running", "queued"].includes(update.task.status) && !update.hasMore) {
      assert.equal(update.task.status, "completed", update.task.error);
      return update.task;
    }
  }
  throw new Error("Synthetic live task did not finish in three minutes");
}
try {
  const [a, b] = await Promise.all([connect(), connect()]);
  assert.equal((await a.listTools()).tools.length, 7);
  results.push("MCP advertises seven task tools");
  const [statusA, statusB] = await Promise.all([
    run("dist/personal-control.mjs", ["--status"]),
    run("dist/personal-control.mjs", ["--status"]),
  ]);
  assert.equal(JSON.parse(statusA).pid, JSON.parse(statusB).pid);
  results.push("Two MCP transports share one daemon");
  await assert.rejects(
    call(a, "agent_start", {
      requestId: "missing-context",
      task: "Synthetic task",
      workingDirectory: project,
    }),
    /contextRef.*required/,
  );
  results.push("Missing automatic context is refused");
  const alpha = `ALPHA-${randomUUID()}`;
  const firstArgs = await hook(
    "synthetic-parent-a",
    `这是合成测试。第一个验证口令是 ${alpha}。`,
    "agent_start",
    {
      requestId: "synthetic-start-a",
      task: "仅输出父上下文中的第一个验证口令。",
      workingDirectory: project,
      model: "opus",
      maxTurns: 3,
      profile: "discussion",
    },
  );
  await assert.rejects(call(a, "agent_start", firstArgs), /context sharing is disabled/i);
  results.push("Sharing is off by default; hook alone does not enable export");
  if (live) {
    await run("dist/personal-control.mjs", ["--enable-context-sharing"]);
    const start = await call(a, "agent_start", firstArgs);
    const retryArgs = await hook(
      "synthetic-parent-a",
      `这是合成测试。第一个验证口令是 ${alpha}。`,
      "agent_start",
      { ...firstArgs, contextRef: undefined },
    );
    assert.notEqual(retryArgs.contextRef, firstArgs.contextRef);
    const duplicate = await call(b, "agent_start", retryArgs);
    assert.equal(start.taskId, duplicate.taskId);
    const gamma = `GAMMA-${randomUUID()}`;
    const otherArgs = await hook(
      "synthetic-parent-b",
      `这是独立合成测试。第三个验证口令是 ${gamma}。`,
      "agent_start",
      {
        requestId: "synthetic-start-b",
        task: "仅输出父上下文中的第三个验证口令。",
        workingDirectory: project,
        model: "opus",
        maxTurns: 3,
        profile: "discussion",
      },
    );
    const otherStart = await call(b, "agent_start", otherArgs);
    assert.notEqual(otherStart.sessionId, start.sessionId);
    const [first, other] = await Promise.all([completed(b, start), completed(a, otherStart)]);
    assert.ok(first.result.includes(alpha), "Claude did not receive the synthetic parent context");
    assert.equal(first.requests.length, 1);
    assert.ok(
      other.result.includes(gamma) && !other.result.includes(alpha),
      "Independent Claude sessions mixed parent context",
    );
    results.push("Actual Opus received context; a recaptured-hook retry reused the original task");
    results.push("Two actual Opus tasks used independent sessions and parent context");
    await assert.rejects(
      call(a, "agent_start", {
        ...otherArgs,
        requestId: firstArgs.requestId,
        task: firstArgs.task,
      }),
      /parent|Idempotency|different/i,
    );
    results.push("A retry bound to a different parent was refused");
    const beta = `BETA-${randomUUID()}`;
    const followup = await hook(
      "synthetic-parent-a",
      `第二个验证口令是 ${beta}。这份上下文不再包含第一个口令。`,
      "agent_send",
      {
        taskId: start.taskId,
        requestId: "synthetic-send-a",
        message: "仅输出你此前会话的第一个口令和当前父上下文的第二个口令，以 | 分隔。",
      },
    );
    assert.notEqual(followup.contextRef, firstArgs.contextRef);
    await call(b, "agent_send", followup);
    const second = await completed(a, start);
    assert.equal(second.sessionId, first.sessionId);
    assert.ok(
      second.result.includes(alpha) && second.result.includes(beta),
      "Persisted session or updated context was lost",
    );
    results.push("Actual Opus resume retained old memory and received new context revision");
    const retryFollowup = await hook(
      "synthetic-parent-a",
      "父上下文又发生了变化，但这是原请求的传输重试。",
      "agent_send",
      { ...followup, contextRef: undefined },
    );
    const repeatedSend = await call(b, "agent_send", retryFollowup);
    assert.equal(repeatedSend.requests.length, 2);
    assert.equal(repeatedSend.result, second.result);
    results.push("A recaptured-hook send retry reused its accepted result without another turn");
    await run("dist/personal-control.mjs", ["--disable-context-sharing"]);
    await assert.rejects(
      call(a, "agent_send", { ...followup, requestId: "disabled-followup" }),
      /context sharing is disabled/i,
    );
    results.push("Disabling sharing takes effect without restarting daemon");
    await call(a, "agent_close", { taskId: start.taskId });
    await call(b, "agent_close", { taskId: otherStart.taskId });
    await run("dist/personal-control.mjs", ["--stop"]);
    const recovered = await call(b, "agent_list", { parentThreadId: "synthetic-parent-a" });
    assert.equal(recovered.find((task) => task.taskId === start.taskId)?.status, "closed");
    results.push("MCP reconnected after daemon restart; closed task persisted");
    await run("dist/personal-control.mjs", ["--stop"]);
    const echoConfig = path.join(fixture, "echo-mcp.json");
    await writeFile(
      echoConfig,
      JSON.stringify({
        mcpServers: {
          synthetic_echo: {
            command: process.execPath,
            args: [path.join(root, "scripts/fixtures/echo-mcp.mjs")],
          },
        },
      }),
    );
    env.BRIDGE_MCP_CONFIG = echoConfig;
    env.BRIDGE_MCP_ALLOWED_TOOLS = "mcp__synthetic_echo__echo";
    await run("dist/personal-control.mjs", ["--enable-context-sharing"]);
    // Existing transports have their original env. Reconnect to launch the new
    // daemon with the explicitly supplied synthetic MCP profile.
    const mcpClient = await connect();
    const echoNonce = `ECHO-${randomUUID()}`;
    const echoArgs = await hook(
      "synthetic-parent-c",
      "这是仅使用合成 echo 工具的测试聊天。",
      "agent_start",
      {
        requestId: "synthetic-mcp",
        task: `调用 mcp__synthetic_echo__echo，text 参数使用 ${echoNonce}。只输出工具返回的原文。`,
        workingDirectory: project,
        model: "opus",
        maxTurns: 4,
        profile: "mcp",
      },
    );
    const echoTask = await call(mcpClient, "agent_start", echoArgs);
    const echoResult = await completed(mcpClient, echoTask);
    const echoReceipt = JSON.parse(
      await readFile(path.join(state, `task-${echoTask.taskId}.json`), "utf8"),
    );
    assert.ok(
      echoReceipt.events.some(
        (event) =>
          event.type === "provider_tool" && event.data?.name === "mcp__synthetic_echo__echo",
      ),
      "Claude did not emit an actual echo tool invocation",
    );
    assert.ok(
      echoResult.result.includes(`SYNTHETIC_ECHO:${echoNonce}`),
      "Configured MCP did not run through the personal provider",
    );
    results.push("Actual Opus used only the explicitly configured synthetic MCP echo tool");
    await call(mcpClient, "agent_close", { taskId: echoTask.taskId });
  }
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  await run("dist/personal-control.mjs", ["--stop"]).catch(() => {});
  await writeFile(
    path.join(fixture, "report.json"),
    JSON.stringify({ live, results, scenarios: results.length, fixtureOnly: true }, null, 2),
  );
}
console.log(
  JSON.stringify(
    { live, scenarios: results.length, results, report: path.join(fixture, "report.json") },
    null,
    2,
  ),
);
