/**
 * Cross-process instance lock (M3-lite, single-instance).
 *
 * Two app instances writing the same persisted document is the only real way
 * `%APPDATA%\Nucleus\docs/<appId>` can degrade silently (M2 persistence made
 * apps stateful), so `createAppServer` takes an exclusive lock per app id
 * before binding. Design:
 *
 *   <dataDir>/locks/<appId>/owner.json   created O_EXCL, { pid, startedAt }
 *
 * The file-create is the mutex; a leftover file from a crashed process is NOT
 * a permanent lock — the pid is probed (`process.kill(pid, 0)`), and a dead
 * owner file is replaced. Pid recycling can, in theory, confuse this; keeping
 * the window tiny (a per-machine desktop app) is the accepted trade-off
 * versus shipping a native mutex.
 */
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export class InstanceAlreadyRunningError extends Error {
  constructor(
    readonly appId: string,
    readonly ownerPid: number,
    readonly lockDir: string,
  ) {
    super(`app "${appId}" is already running (pid ${ownerPid})`);
    this.name = "InstanceAlreadyRunningError";
  }
}

export interface InstanceLock {
  readonly dir: string;
  release(): Promise<void>;
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Best-effort cross-platform pid liveness. `process.kill(pid, 0)` — ESRCH
 * means gone, anything else (EPERM…) means alive-but-unprobeable.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code !== "ESRCH";
  }
}

/** Fire-and-forget best-effort cleanup when the process exits WHILE holding the lock. */
function cleanupAtExit(lockFile: string, lockDir: string): void {
  try {
    rmSync(lockFile, { force: true });
    rmSync(lockDir, { force: true });
  } catch {
    /* file may be gone already */
  }
}

export async function acquireInstanceLock(
  dataDir: string,
  appId: string,
): Promise<InstanceLock> {
  const dir = join(dataDir, "locks", sanitizeId(appId));
  const file = join(dir, "owner.json");

  for (let attempt = 0; attempt < 2; attempt++) {
    await mkdir(dir, { recursive: true });
    try {
      const handle = await open(file, "wx"); // O_EXCL: the mutex
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 1),
      );
      await handle.close();
      process.on("exit", () => cleanupAtExit(file, dir));
      return {
        dir,
        release: async () => {
          await rm(file, { force: true });
          await rm(dir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
    // File exists: is the owner still alive?
    let owner: { pid?: number } | undefined;
    try {
      owner = JSON.parse(await readFile(file, "utf8")) as { pid?: number };
    } catch {
      owner = undefined; // unreadable/corrupt → treat as stale
    }
    if (owner?.pid !== undefined && pidAlive(owner.pid)) {
      throw new InstanceAlreadyRunningError(appId, owner.pid, dir);
    }
    await rm(file, { force: true }); // stale owner: replace and retry
  }
  throw new Error(`unable to acquire instance lock for "${appId}" (${dir})`);
}
