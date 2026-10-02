import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execCommand, isTransientError } from "../src/lib/exec-runner.js";

const fixture = fileURLToPath(new URL("./fixtures/exec-process.mjs", import.meta.url));
const temporaryDirectories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-exec-test-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
}
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("execCommand", () => {
  it("captures stdout from a simple command", async () => {
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "stdout", "hello world"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr", async () => {
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "stderr", "error"],
    });
    expect(result.stderr.trim()).toBe("error");
  });

  it("reports non-zero exit code", async () => {
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "exit", "42"],
    });
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it("times out and kills long-running process", async () => {
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "sleep", "60000"],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  });

  it("throws BridgeError for missing command", async () => {
    await expect(
      execCommand({
        command: "nonexistent_command_xyz_12345",
        args: [],
      }),
    ).rejects.toThrow("not found");
  });

  it("respects cwd option", async () => {
    const cwd = await temporaryDirectory();
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "cwd"],
      cwd,
    });
    expect(result.stdout.trim()).toBe(cwd);
  });

  it("passes custom env vars", async () => {
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "env", "TEST_VAR"],
      env: { TEST_VAR: "bridge_test" },
    });
    expect(result.stdout.trim()).toBe("bridge_test");
  });

  it("increments BRIDGE_DEPTH in child env", async () => {
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "env", "BRIDGE_DEPTH"],
    });
    // Current depth is 0 (or whatever test env has), child should be +1
    const depth = parseInt(result.stdout.trim(), 10);
    expect(depth).toBeGreaterThanOrEqual(1);
  });

  it("passes Unicode and option-like input through stdin literally", async () => {
    const input = "--中文任务\n--help && $(literal) `unchanged`\n";
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "stdin"],
      input,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(input);
  });
});

describe("isTransientError", () => {
  it("returns false for exit code 0", () => {
    expect(
      isTransientError({ exitCode: 0, stdout: "", stderr: "rate limit", timedOut: false }),
    ).toBe(false);
  });

  it("returns false for timeouts", () => {
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "rate limit", timedOut: true }),
    ).toBe(false);
  });

  it("detects rate limit errors", () => {
    expect(
      isTransientError({
        exitCode: 1,
        stdout: "",
        stderr: "Error: rate limit exceeded",
        timedOut: false,
      }),
    ).toBe(true);
  });

  it("detects HTTP 429", () => {
    expect(
      isTransientError({
        exitCode: 1,
        stdout: "",
        stderr: "HTTP 429 Too Many Requests",
        timedOut: false,
      }),
    ).toBe(true);
  });

  it("detects connection errors", () => {
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "Error: ECONNRESET", timedOut: false }),
    ).toBe(true);
  });

  it("detects 502 bad gateway", () => {
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "502 Bad Gateway", timedOut: false }),
    ).toBe(true);
  });

  it("returns false for auth errors", () => {
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "Invalid API key", timedOut: false }),
    ).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(
      isTransientError({
        exitCode: 1,
        stdout: "",
        stderr: "SyntaxError: unexpected token",
        timedOut: false,
      }),
    ).toBe(false);
  });
});

describe("retry behavior", () => {
  it("retries on transient error and succeeds", async () => {
    const counterFile = join(await temporaryDirectory(), "attempts");
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "attempt", counterFile, "503 service unavailable", "2"],
      maxRetries: 2,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("success");
    expect(await readFile(counterFile, "utf8")).toBe("2");
  });

  it("does not retry non-transient errors", async () => {
    const counterFile = join(await temporaryDirectory(), "attempts");
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "attempt", counterFile, "invalid argument", "2"],
      maxRetries: 2,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe("invalid argument");
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  it("respects maxRetries: 0 to disable retry", async () => {
    const counterFile = join(await temporaryDirectory(), "attempts");
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "attempt", counterFile, "rate limit", "99"],
      maxRetries: 0,
    });
    expect(result.exitCode).toBe(1);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  it("gives up after exhausting retries", async () => {
    const counterFile = join(await temporaryDirectory(), "attempts");
    const result = await execCommand({
      command: process.execPath,
      args: [fixture, "attempt", counterFile, "connection refused", "99"],
      maxRetries: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("connection refused");
    expect(await readFile(counterFile, "utf8")).toBe("2");
  });
});
