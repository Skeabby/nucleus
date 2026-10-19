import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { acquireInstanceLock, InstanceAlreadyRunningError } from "../src/index.js";

async function plantOwner(dir: string, body: unknown): Promise<string> {
  const file = join(dir, "locks", "nucleus_notes", "owner.json");
  await mkdir(join(dir, "locks", "nucleus_notes"), { recursive: true });
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

describe("instance lock: one app, one process (M3-lite single-instance)", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("second acquire on the same app id fails with the owner pid (cross-process)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-lock-"));
    dirs.push(dir);
    const first = await acquireInstanceLock(dir, "nucleus.notes");
    try {
      await expect(acquireInstanceLock(dir, "nucleus.notes")).rejects.toMatchObject({
        name: "InstanceAlreadyRunningError",
        appId: "nucleus.notes",
        ownerPid: process.pid,
      });
    } finally {
      await first.release();
    }
  });

  it("a DIFFERENT app id takes a different lock (notes ≠ pdf)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-lock-"));
    dirs.push(dir);
    const a = await acquireInstanceLock(dir, "nucleus.notes");
    const b = await acquireInstanceLock(dir, "nucleus.pdf-workbench");
    await a.release();
    await b.release();
  });

  it("release frees the lock for the next instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-lock-"));
    dirs.push(dir);
    const one = await acquireInstanceLock(dir, "nucleus.notes");
    await one.release();
    const two = await acquireInstanceLock(dir, "nucleus.notes");
    await two.release();
  });

  it("a DEAD owner pid is taken over, not refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-lock-"));
    dirs.push(dir);
    // a real process that exits immediately: its pid is dead but real
    const child = spawn("node", ["-e", "process.exit(0)"]);
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const dead = child.pid!;
    // ids are sanitized inside the lock dir (the dot of "nucleus.notes" is
    // gone — this bit us in tests the same way path-joiners get bitten in prod)
    const file = await plantOwner(dir, { pid: dead, startedAt: new Date().toISOString() });
    const lock = await acquireInstanceLock(dir, "nucleus.notes");
    expect(lock.dir).toContain("nucleus_notes");
    await lock.release();
  });

  it("an alive pid is refused, and the file must be removed to recover", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-lock-"));
    dirs.push(dir);
    // this vitest process is alive; pretend an instance "owns" the lock
    const file = await plantOwner(dir, { pid: process.pid, startedAt: new Date().toISOString() });
    await expect(acquireInstanceLock(dir, "nucleus.notes")).rejects.toBeInstanceOf(
      InstanceAlreadyRunningError,
    );
    await expect(acquireInstanceLock(dir, "nucleus.notes")).rejects.toMatchObject({
      ownerPid: process.pid,
    });
    await rm(file, { force: true });
    const lock = await acquireInstanceLock(dir, "nucleus.notes");
    await lock.release();
  });

  it("a corrupt owner file is treated as stale (taken over)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-lock-"));
    dirs.push(dir);
    await plantOwner(dir, "not json{{");
    const lock = await acquireInstanceLock(dir, "nucleus.notes");
    expect(lock.release).toBeTypeOf("function");
    await lock.release();
  });
});
