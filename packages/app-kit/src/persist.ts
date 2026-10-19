/**
 * Crash-safe document + tape persistence (F7: "nothing persists").
 *
 * Layout: `<dataDir>/docs/<appId>/<docId>/document.json` (the current state,
 * atomically rewritten) + `tape.jsonl` (append-only tape records, one JSON
 * object per line). Autosave is debounce-free for the tape (append is cheap)
 * and debounced for the document JSON.
 *
 * Writes land in a temp file first and rename over the target — a crash mid
 * write never truncates the good copy.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDocument, type DocumentState, type TapeRecord } from "@nucleus/core";

export interface PersistOptions {
  /** Root of the Nucleus data directory. Defaults to `%APPDATA%\Nucleus`. */
  dataDir?: string;
}

export function defaultDataDir(): string {
  return join(process.env.APPDATA ?? join(homedir(), ".nucleus"), "Nucleus");
}

export class DocStore {
  readonly dir: string;
  readonly #docFile: string;
  readonly #tapeFile: string;
  readonly #tmpFile: string;

  private constructor(dir: string) {
    this.dir = dir;
    this.#docFile = join(dir, "document.json");
    this.#tapeFile = join(dir, "tape.jsonl");
    this.#tmpFile = join(dir, "document.json.tmp");
  }

  static for(dataDir: string, appId: string, docId = "default"): DocStore {
    // <appId> is a package id ("nucleus.notes") — safe for a path segment, but
    // never trust callers: dots are dropped entirely (no "..", single ".",
    // trailing-dot tricks) and everything outside the allowlist is underscored.
    const safeId = appId.replace(/[^A-Za-z0-9_-]/g, "_");
    return new DocStore(join(dataDir, "docs", safeId, docId.replace(/[^A-Za-z0-9_-]/g, "_")));
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async load(): Promise<{ doc?: DocumentState; tape?: TapeRecord[] }> {
    const doc = await this.#loadDoc();
    const tape = await this.#loadTape();
    return { doc, tape };
  }

  async #loadDoc(): Promise<DocumentState | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.#docFile, "utf8")) as {
        format?: string;
        doc?: DocumentState;
      };
      if (parsed.format === "nucleus.persisted" && parsed.doc) return parsed.doc;
      return undefined;
    } catch {
      return undefined;
    }
  }

  async #loadTape(): Promise<TapeRecord[] | undefined> {
    try {
      const lines = (await readFile(this.#tapeFile, "utf8")).split("\n");
      const records: TapeRecord[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          records.push(JSON.parse(trimmed) as TapeRecord);
        } catch {
          // A torn last line (crash mid-append) is ignored — older lines win.
          break;
        }
      }
      return records.length > 0 ? records : undefined;
    } catch {
      return undefined;
    }
  }

  /** Atomic document write: temp file, then rename over the target. */
  async saveDoc(doc: DocumentState): Promise<void> {
    await this.ensureDir();
    const body = JSON.stringify({ format: "nucleus.persisted", version: 2, doc }, null, 1);
    await writeFile(this.#tmpFile, body, "utf8");
    await rename(this.#tmpFile, this.#docFile);
  }

  async appendRecord(record: TapeRecord): Promise<void> {
    await this.ensureDir();
    await appendFile(this.#tapeFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** Fill a fresh document with persisted content, keeping the model invariants. */
export function applyPersistedDoc(target: DocumentState, saved: DocumentState): void {
  target.nodes = saved.nodes ?? {};
  target.selection = Array.isArray(saved.selection) ? saved.selection : [];
  target.docVersion = typeof saved.docVersion === "number" ? saved.docVersion : 0;
  target.schemaVersion = saved.schemaVersion ?? 1;
  if (saved.appId) target.appId = saved.appId;
}

/**
 * Legacy project loader / migration (acceptance: "old project files still
 * open"). Accepts `nucleus.project` and `nucleus.notes.project` v1 JSON — the
 * two formats the pre-app-kit apps exported — and returns the document plus
 * base64-decoded assets.
 */
export interface LegacyProject {
  doc: DocumentState;
  assets: Record<string, Uint8Array>;
}

export function migrateLegacyProject(body: unknown): LegacyProject {
  const json = body as {
    format?: string;
    doc?: Partial<DocumentState>;
    assets?: Record<string, string>;
  };
  if (
    json?.format !== "nucleus.project" &&
    json?.format !== "nucleus.notes.project"
  ) {
    throw new Error("not a legacy Nucleus project (expected nucleus.project | nucleus.notes.project)");
  }
  if (!json.doc || typeof json.doc !== "object") {
    throw new Error("project has no document");
  }
  const doc = createDocument(json.doc.appId ?? "nucleus.app");
  applyPersistedDoc(doc, json.doc as DocumentState);
  const assets: Record<string, Uint8Array> = {};
  for (const [id, b64] of Object.entries(json.assets ?? {})) {
    assets[id] = Buffer.from(b64, "base64");
  }
  return { doc, assets };
}

/** Content-addressed asset filename: `<sha256>.<ext>` (deduped by construction). */
export function assetFileName(bytes: Uint8Array): string {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const head = bytes.subarray(0, 5);
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  return `assets/${hash}.${isPdf ? "pdf" : "bin"}`;
}
