/**
 * The launcher's run registry (`%APPDATA%\Nucleus\run\apps.json`).
 *
 * The Rust `Runtime` rewrites this file atomically on every start/stop/exit
 * (§4.4), so it is a *full snapshot*, never a journal: reading it fresh is the
 * whole synchronisation story. A corrupt or half-written file parses as an
 * empty list — the launcher self-heals it on the next change, and the proxy
 * simply reports "no running apps" until then.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** One supervised app, as the launcher writes it (camelCase on disk). */
export interface RunningApp {
  id: string;
  name: string;
  port: number | null;
  token: string | null;
  pid: number | null;
  startedAt: string;
}

/** `%APPDATA%\Nucleus\run` — `NUCLEUS_RUN_DIR` wins (tests, portable installs). */
export function runDir(): string {
  const override = process.env.NUCLEUS_RUN_DIR;
  if (override && override.trim() !== "") return override;
  const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
  return path.join(appData, "Nucleus", "run");
}

/** Absolute path of the registry file. */
export function registryPath(): string {
  return path.join(runDir(), "apps.json");
}

/** Parse a registry payload, dropping entries that cannot be reached at all. */
export function parseRegistry(json: string): RunningApp[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const apps: RunningApp[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (id === "") continue;
    const port = typeof record.port === "number" ? record.port : null;
    apps.push({
      id,
      name: typeof record.name === "string" && record.name !== "" ? record.name : id,
      port,
      token: typeof record.token === "string" ? record.token : null,
      pid: typeof record.pid === "number" ? record.pid : null,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
    });
  }
  return apps;
}

/** Apps the proxy can actually talk to (an HTTP surface needs a port). */
export function reachable(apps: RunningApp[]): RunningApp[] {
  return apps.filter((app) => typeof app.port === "number" && app.port > 0);
}

/**
 * Read the registry from disk. A missing file is "nothing is running" (the
 * launcher only creates it once an app starts), never an error.
 */
export function readRegistry(file = registryPath()): RunningApp[] {
  try {
    return parseRegistry(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/**
 * A tiny mtime cache: MCP tools are called in bursts (apps → describe →
 * invoke), and re-reading a file the launcher did not touch is wasted I/O.
 */
export class Registry {
  #file: string;
  #mtimeMs = -1;
  #apps: RunningApp[] = [];

  constructor(file = registryPath()) {
    this.#file = file;
  }

  /** Running apps, re-read only when the launcher rewrote the file. */
  apps(): RunningApp[] {
    try {
      const stat = statSync(this.#file);
      if (stat.mtimeMs !== this.#mtimeMs) {
        this.#mtimeMs = stat.mtimeMs;
        this.#apps = readRegistry(this.#file);
      }
      return this.#apps;
    } catch {
      this.#mtimeMs = -1;
      this.#apps = [];
      return [];
    }
  }
}
