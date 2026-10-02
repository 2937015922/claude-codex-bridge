import { spawn, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolve a native executable without invoking a shell or inspecting credentials. */
export async function discoverClaudeExecutable(): Promise<string> {
  const override = process.env.CLAUDE_CLI_PATH;
  if (override && isAbsolute(override)) {
    if (process.platform === "win32" && !override.toLowerCase().endsWith(".exe")) {
      throw new Error("CLAUDE_CLI_PATH must point to a native .exe on Windows");
    }
    if (!(await executable(override))) throw new Error("CLAUDE_CLI_PATH is not executable");
    return override;
  }
  const candidates: string[] = [];
  if (!override && process.platform === "win32") {
    if (process.env.APPDATA) {
      candidates.push(
        join(process.env.APPDATA, "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
      );
    }
    if (process.env.USERPROFILE)
      candidates.push(join(process.env.USERPROFILE, ".local/bin/claude.exe"));
  }
  const name = override || (process.platform === "win32" ? "claude.exe" : "claude");
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("CLAUDE_CLI_PATH must be absolute or an executable name on PATH");
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(name)) {
    throw new Error("Claude shell wrappers are not supported; select the native executable");
  }
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, name));
    if (process.platform === "win32" && !name.toLowerCase().endsWith(".exe")) {
      candidates.push(join(directory, `${name}.exe`));
    }
  }
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  throw new Error("Claude native executable was not found; set CLAUDE_CLI_PATH");
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Only operates on this spawned child/group. It never finds processes by name. */
export async function terminateClaudeTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    // Avoid targeting an already reaped PID. Existing/shared MCP services are not descendants.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Owned parent already exited; descendant termination is unconfirmed");
    }
    const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe");
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      const timer = setTimeout(
        () => {
          killer.kill();
          reject(new Error("Owned process-tree termination timed out"));
        },
        Math.max(1000, graceMs),
      );
      killer.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not start owned process-tree termination"));
      });
      killer.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("Could not confirm owned process-tree termination"));
      });
    });
    return;
  }
  // The provider starts a dedicated process group with detached:true on POSIX.
  if (!groupExists(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  if (groupExists(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + Math.max(500, graceMs);
  while (groupExists(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (groupExists(pid)) throw new Error("Owned process group termination is unconfirmed");
}
