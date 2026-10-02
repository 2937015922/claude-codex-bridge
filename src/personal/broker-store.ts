import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, open, readFile, readdir, realpath, rename, unlink, lstat } from "node:fs/promises";

interface Owner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}
const TASK_FILE = /^task-[0-9a-f-]{36}\.json$/;

/** One daemon owns a state directory; additional MCP clients must use that daemon. */
export class BrokerFileStore {
  private directory: string;
  private readonly owner: Owner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
  private acquired = false;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.directory = await realpath(this.directory);
    try {
      await this.claim();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await this.deadOwner()))
      throw new Error(
        "Broker state directory already has an active or unverifiable owner; connect to its daemon instead",
      );
    const recoveryPath = join(this.directory, ".broker-recovery.lock");
    let recovery;
    try {
      recovery = await open(recoveryPath, "wx", 0o600);
    } catch {
      throw new Error(
        "Broker owner recovery is already in progress or needs manual reconciliation",
      );
    }
    try {
      if (!(await this.deadOwner()))
        throw new Error("Broker owner changed during recovery; refusing a second writer");
      await unlink(this.lockPath);
      await this.claim();
    } finally {
      await recovery.close();
      await unlink(recoveryPath);
    }
  }

  private get lockPath(): string {
    return join(this.directory, ".broker-owner.json");
  }

  private async claim(): Promise<void> {
    const handle = await open(this.lockPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.owner));
      await handle.sync();
      this.acquired = true;
    } finally {
      await handle.close();
    }
  }

  private async deadOwner(): Promise<boolean> {
    let owner: Owner;
    try {
      owner = JSON.parse(await readFile(this.lockPath, "utf8"));
    } catch {
      return false;
    }
    if (owner.hostname !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0)
      return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private async assertOwner(): Promise<void> {
    if (!this.acquired) throw new Error("Broker store is not owned by this process");
    const owner: Owner = JSON.parse(await readFile(this.lockPath, "utf8"));
    if (owner.token !== this.owner.token)
      throw new Error("Broker state owner changed; refusing writes");
  }

  async load<T>(): Promise<T[]> {
    await this.assertOwner();
    const records: T[] = [];
    for (const file of (await readdir(this.directory))
      .filter((name) => TASK_FILE.test(name))
      .sort()) {
      const path = join(this.directory, file);
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("Broker refuses a symbolic-link task record");
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value?.taskId !== file.slice(5, -5))
        throw new Error("Broker task filename and record identity do not match");
      records.push(value as T);
    }
    return records;
  }

  async save(taskId: string, value: unknown): Promise<void> {
    const name = "task-" + taskId + ".json";
    if (!TASK_FILE.test(name)) throw new Error("Invalid task ID for persistence");
    await this.assertOwner();
    const destination = join(this.directory, name);
    const temporary = join(
      this.directory,
      "." + name + "." + this.owner.token + "." + randomUUID() + ".tmp",
    );
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }

  async close(): Promise<void> {
    if (!this.acquired) return;
    await this.assertOwner();
    await unlink(this.lockPath);
    this.acquired = false;
  }
}
