import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ClaudeCliProvider,
  type ClaudeCliProviderOptions,
} from "../src/personal/claude-provider.js";
import type { ProviderRequest } from "../src/personal/types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    sessionId: randomUUID(),
    resume: false,
    prompt: "请检查合成场景 🌆\nprivate-prompt-8274",
    workingDirectory: process.cwd(),
    model: "opus",
    maxTurns: 3,
    profile: "discussion",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function synthetic(body: string, options: ClaudeCliProviderOptions = {}): ClaudeCliProvider {
  const script = `
    const args = process.argv.slice(1);
    const sessionId = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
    const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
    const init = extra => send({type:'system',subtype:'init',session_id:sessionId,model:'synthetic',...extra});
    const result = (extra = {}) => send({type:'result',subtype:'success',is_error:false,session_id:sessionId,result:'ok',...extra});
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', async () => { ${body} });
  `;
  return new ClaudeCliProvider({
    command: process.execPath,
    prefixArgs: ["-e", script, "--"],
    timeoutMs: 3000,
    terminationGraceMs: 30,
    ...options,
  });
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ccb-provider-"));
  temporaryDirectories.push(path);
  return path;
}

describe("ClaudeCliProvider", () => {
  it("passes the Unicode prompt only through stdin and selects the exact session ID", async () => {
    const req = request({ model: "" });
    const provider = synthetic(
      "init(); result({result:JSON.stringify({args,input}),total_cost_usd:0.125});",
    );
    const value = await provider.run(req, () => {});
    expect(value.status).toBe("completed");
    expect(value.sessionId).toBe(req.sessionId);
    expect(value.costUsd).toBe(0.125);
    const received = JSON.parse(value.text);
    expect(received.input).toBe(req.prompt);
    expect(received.args.join(" ")).not.toContain("private-prompt-8274");
    expect(received.args).toContain("--session-id");
    expect(received.args).not.toContain("--resume");
    expect(received.args[received.args.indexOf("--model") + 1]).toBe("opus");
    expect(received.args).toContain("--safe-mode");
    expect(received.args[received.args.indexOf("--tools") + 1]).toBe("");
    expect(received.args).not.toContain("--no-session-persistence");
  });

  it("uses resume rather than continue and retains only review tools", async () => {
    const value = await synthetic("init(); result({result:JSON.stringify(args)});").run(
      request({ resume: true, profile: "review" }),
      () => {},
    );
    const args: string[] = JSON.parse(value.text);
    expect(value.status).toBe("completed");
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--continue");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args).not.toContain("--bare");
  });

  it("preserves a narrower reviewer allowlist without expanding access", async () => {
    const provider = synthetic("init(); result({result:JSON.stringify(args)});");
    const value = await provider.run(
      request({ profile: "review", reviewTools: ["Read"] }),
      () => {},
    );
    const args: string[] = JSON.parse(value.text);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    expect(args).not.toContain("Grep");
    expect(args).not.toContain("Glob");
    const rejected = await provider.run(
      request({ profile: "review", reviewTools: ["Bash"] }),
      () => {},
    );
    expect(rejected.status).toBe("failed");
  });

  it("decodes fragmented UTF-8 and NDJSON, including a final line without newline", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const provider = synthetic(`
      const messages = [
        {type:'system',subtype:'init',session_id:sessionId},
        {type:'stream_event',session_id:sessionId,event:{delta:{type:'text_delta',text:'北京 🌆'}}},
        {type:'result',session_id:sessionId,subtype:'success',is_error:false,result:'你好 🌆'}
      ];
      const bytes = Buffer.from(messages.map(x=>JSON.stringify(x)).join('\\n'));
      for (let i=0;i<bytes.length;i++) {
        process.stdout.write(bytes.subarray(i,i+1));
        if (i % 3 === 0) await new Promise(resolve=>setTimeout(resolve,1));
      }
    `);
    const value = await provider.run(request(), (type, data) => events.push({ type, data }));
    expect(value.status).toBe("completed");
    expect(value.text).toBe("你好 🌆");
    expect(events).toContainEqual({ type: "provider_text", data: { text: "北京 🌆" } });
  });

  it.each([
    ["wrong session", "result({session_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});"],
    ["missing session", "result({session_id:undefined});"],
    ["error flag", "result({is_error:true});"],
    ["error subtype", "result({subtype:'error_max_turns'});"],
    ["nonzero exit", "result(); process.exitCode=7;"],
    ["missing result", "init();"],
    ["multiple results", "result(); result();"],
    ["malformed stream", "process.stdout.write('not-json\\n');"],
  ])("does not report %s as success", async (_name, body) => {
    const value = await synthetic(body).run(request(), () => {});
    expect(value.status).toBe("failed");
    expect(value.error).toBeTruthy();
    expect(value.outcomeUnknown).toBe(true);
  });

  it("distinguishes a trustworthy terminal CLI error from an unknown execution outcome", async () => {
    const value = await synthetic(
      "result({subtype:'error_max_turns',is_error:true,result:''});",
    ).run(request(), () => {});
    expect(value.status).toBe("failed");
    expect(value.outcomeUnknown).toBeUndefined();
  });

  it("reports spawn failure without rejecting or hanging", async () => {
    const value = await new ClaudeCliProvider({
      command: join(process.cwd(), "definitely-missing-cli-8274.exe"),
    }).run(request(), () => {});
    expect(value.status).toBe("failed");
    expect(value.error).toContain("spawn");
    expect(value.outcomeUnknown).toBeUndefined();
  });

  it("does not spawn when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const value = await new ClaudeCliProvider({ command: "not-present" }).run(
      request({ signal: controller.signal }),
      () => {},
    );
    expect(value.status).toBe("interrupted");
  });

  it("cancels an active owned process tree while leaving an unrelated worker running", async () => {
    const directory = await temporaryDirectory();
    const pidFile = join(directory, "child-pid.json");
    const controller = new AbortController();
    const sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    let grandchildPid: number | undefined;
    try {
      const provider = synthetic(`
        const child = require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(child.pid));
        init(); setInterval(()=>{},1000);
      `);
      const value = await provider.run(request({ signal: controller.signal }), (type) => {
        if (type === "provider_init") controller.abort();
      });
      grandchildPid = JSON.parse(await readFile(pidFile, "utf8"));
      expect(value.status).toBe("interrupted");
      expect(sibling.exitCode).toBeNull();
      expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
      expect(() => process.kill(grandchildPid!, 0)).toThrow();
    } finally {
      sibling.kill();
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {}
      }
    }
  }, 10000);

  it("times out without retrying, including after a transient error", async () => {
    const directory = await temporaryDirectory();
    const counter = join(directory, "attempts.txt");
    const provider = synthetic(
      `
      require('node:fs').appendFileSync(${JSON.stringify(counter)},'one\\n');
      process.stderr.write('503 private-prompt-should-not-be-forwarded');
      init(); setInterval(()=>{},1000);
    `,
      { timeoutMs: 150 },
    );
    const events: unknown[] = [];
    const value = await provider.run(request(), (type, data) => events.push({ type, data }));
    expect(value.status).toBe("failed");
    expect(value.error).toContain("timed out");
    expect(value.outcomeUnknown).toBe(true);
    expect(await readFile(counter, "utf8")).toBe("one\n");
    expect(JSON.stringify(events)).not.toContain("private-prompt-should-not-be-forwarded");
  });

  it("does not replay a failed turn after stderr mentions a transient API error", async () => {
    const counter = join(await temporaryDirectory(), "attempts.txt");
    const provider = synthetic(`
      require('node:fs').appendFileSync(${JSON.stringify(counter)},'one\\n');
      process.stderr.write('503 service unavailable'); process.exitCode=1;
    `);
    const value = await provider.run(request(), () => {});
    expect(value.status).toBe("failed");
    expect(await readFile(counter, "utf8")).toBe("one\n");
  });

  it("bounds progress separately and fails closed on excessive result/output", async () => {
    const events: string[] = [];
    const progressOnly = await synthetic(
      `
      for(let i=0;i<30;i++) send({type:'stream_event',event:{delta:{type:'text_delta',text:'more'}}});
      result();
    `,
      { maxProgressEvents: 3 },
    ).run(request(), (type) => events.push(type));
    expect(progressOnly.status).toBe("completed");
    expect(events.filter((type) => type === "provider_text")).toHaveLength(3);
    expect(events.filter((type) => type === "provider_progress_truncated")).toHaveLength(1);
    const tooLong = await synthetic("result({result:'x'.repeat(500)});", {
      maxResultChars: 100,
    }).run(request(), () => {});
    expect(tooLong.status).toBe("failed");
    const tooManyBytes = await synthetic("process.stdout.write('x'.repeat(2000));", {
      maxOutputBytes: 100,
    }).run(request(), () => {});
    expect(tooManyBytes.status).toBe("failed");
  });

  it("requires trusted MCP configuration and checks the actual tool inventory", async () => {
    const path = join(await temporaryDirectory(), "mcp.json");
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: { bridge_probe: { type: "stdio", command: process.execPath, args: [] } },
      }),
    );
    const req = request({
      profile: "mcp",
      mcpConfigPath: path,
      mcpAllowedTools: ["mcp__bridge_probe__echo"],
    });
    const good = await synthetic(`
      init({tools:['mcp__bridge_probe__echo'],mcp_servers:[{name:'bridge_probe',status:'connected'}]});
      result({result:JSON.stringify(args)});
    `).run(req, () => {});
    expect(good.status).toBe("completed");
    const args: string[] = JSON.parse(good.text);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--settings") + 1]).toBe(
      '{"disableAllHooks":true,"autoMemoryEnabled":false}',
    );
    expect(args).not.toContain("--safe-mode");
    expect(args).not.toContain("--bare");
    const extra = await synthetic(
      "init({tools:['mcp__bridge_probe__echo','Read'],mcp_servers:[{name:'bridge_probe',status:'connected'}]});result();",
    ).run(req, () => {});
    expect(extra.status).toBe("failed");
    const missing = await synthetic("result();").run(request({ profile: "mcp" }), () => {});
    expect(missing.status).toBe("failed");
    const wildcard = await synthetic("result();").run(
      { ...req, mcpAllowedTools: ["mcp__bridge_probe__*"] },
      () => {},
    );
    expect(wildcard.status).toBe("failed");
  });
});
