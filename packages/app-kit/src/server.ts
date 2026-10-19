/**
 * `createAppServer` — the one HTTP skeleton every Nucleus app reuses (F14:
 * ~200 duplicated lines paid down to one import).
 *
 * It bundles the entire M2 checklist: 127.0.0.1-only binding, the security
 * guard, the standard command surface (state/op/undo/redo/reset, tape
 * seek/restore/fork, proposals, describe-with-schemas), Server-Sent Events,
 * crash-safe persistence (F7) with legacy-project migration, the `.nucleus`
 * ZIP export and the shared web kit (/_kit).
 *
 * App-specific routes stay in the app; launching looks like:
 *
 *   const app = await createAppServer({ id, name, publicDir, createSession, routes });
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  tapeStateAt,
  replayTape,
  type CommandBus,
  type DocumentState,
  type TapeRecord,
} from "@nucleus/core";
import type { ControlServer } from "@nucleus/control";
import { guard, tokenCookie, type GuardOptions } from "./guard.js";
import { MIME, readJson, sendJson, serveStatic } from "./http.js";
import { SseHub } from "./sse.js";
import {
  applyPersistedDoc,
  defaultDataDir,
  DocStore,
  migrateLegacyProject,
} from "./persist.js";
import { assetBytesWithNames, buildNucleusZip } from "./nucleus-zip.js";

/** Optional content-addressed asset store (PDF sources…). */
export interface AssetStoreLike {
  get(id: string): Uint8Array | undefined;
  put(id: string, bytes: Uint8Array): void;
  ids(): string[];
  /** Optional membership probe (satisfied by @nucleus/pdf's AssetStore). */
  has?(id: string): boolean;
}

export interface AppKitSession {
  doc: DocumentState;
  bus: CommandBus;
  control: ControlServer;
  /** Extra fields for /api/state and SSE `state` frames (app views/stats). */
  snapshot?: () => Record<string, unknown>;
  assets?: AssetStoreLike;
}

export interface CreateAppServerOptions {
  id: string;
  name: string;
  publicDir: string;
  /** Fresh session factory (also used by /api/reset). */
  createSession: () => AppKitSession;
  /** App-specific routes, checked before the standard ones. */
  routes?: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    session: AppKitSession,
  ) => Promise<boolean> | boolean;
  /** Legacy save/open format banner, e.g. "nucleus.notes.project". */
  projectFormat?: string;
  /** Persistence root (default `%APPDATA%\Nucleus`). */
  dataDir?: string;
  /** Enable document+tape autosave (default true; tests may disable). */
  persist?: boolean;
  port?: number;
  token?: string;
}

export interface AppServer {
  readonly id: string;
  readonly name: string;
  get session(): AppKitSession;
  /** Actual listening port (useful with `port: 0` in tests). */
  port(): number;
  readonly dataDir: string | null;
  close(): Promise<void>;
}

const AUTOSAVE_DELAY_MS = 400;

export async function createAppServer(options: CreateAppServerOptions): Promise<AppServer> {
  const token = options.token ?? process.env.NUCLEUS_TOKEN ?? randomBytes(16).toString("hex");
  const port = options.port ?? Number(process.env.PORT ?? 5173);
  const guardOptions: GuardOptions = { port, token };
  const persist = options.persist ?? true;
  const session0 = options.createSession();
  let session: AppKitSession = session0;

  const store = persist
    ? DocStore.for(options.dataDir ?? defaultDataDir(), options.id)
    : null;

  // ---------------------------------------------------------------- restore
  if (store) {
    const saved = await store.load();
    if (saved.doc) {
      applyPersistedDoc(session.doc, saved.doc);
      if (saved.tape) session.bus.importTape(saved.tape);
    }
  }

  // ------------------------------------------------------------- sse + save
  const hub = new SseHub();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = (): void => {
    if (!store) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void store.saveDoc(session.doc).catch((error) => console.error("[app-kit] save failed", error));
    }, AUTOSAVE_DELAY_MS);
  };

  // Tape appends are serialized: two concurrent appends could otherwise land
  // out of order (open+write per call).
  let tapeWrite: Promise<void> = Promise.resolve();
  function addToTape(record: TapeRecord): void {
    if (!store) return;
    tapeWrite = tapeWrite
      .then(() => store.appendRecord(record))
      .catch((error) => console.error("[app-kit] tape append failed", error));
  }

  const bindBus = (): (() => void) => {
    return session.bus.subscribe((event) => {
      if (event.type === "command") {
        addToTape(event.record);
        scheduleSave();
        hub.broadcast("command", event.record);
        hub.broadcast("state", stateFrame());
      } else if (event.type === "proposal") {
        hub.broadcast("proposal", {
          id: event.proposal.id,
          status: event.proposal.status,
          command: event.proposal.command,
          actor: event.proposal.actor,
          touchedNodeIds: Object.keys(event.proposal.touched),
        });
      } else {
        hub.broadcast("state", stateFrame());
      }
    });
  };
  let unbindBus = bindBus();

  function stateFrame(): Record<string, unknown> {
    return {
      docVersion: session.doc.docVersion,
      canUndo: session.bus.canUndo(),
      canRedo: session.bus.canRedo(),
      ...(session.snapshot?.() ?? {}),
    };
  }

  // ------------------------------------------------------------- swapping
  /**
   * Replace the session (reset / legacy project load) and rebind autosave +
   * SSE to the NEW bus, so events keep flowing after a swap.
   */
  async function swapSession(next: AppKitSession): Promise<void> {
    unbindBus();
    unbindBus = bindBus();
    session = next;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function baseSnapshot(): Record<string, unknown> {
    return stateFrame();
  }

  // ------------------------------------------------------------ routes
  async function standardApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (path === "/api/state" && method === "GET") {
      sendJson(res, 200, { ok: true, ...baseSnapshot() });
      return true;
    }

    if (path === "/api/op" && method === "POST") {
      const body = await readJson(req);
      const response = session.control.handle({ method: "command.invoke", params: body });
      if (!response.ok) {
        sendJson(res, 400, { ok: false, error: response.error, ...baseSnapshot() });
        return true;
      }
      sendJson(res, 200, { ok: true, result: response.result, ...baseSnapshot() });
      return true;
    }

    if (path === "/api/undo" && method === "POST") {
      const r = session.control.handle({ method: "history.undo" });
      const undone = (r.result as { undone?: boolean } | undefined)?.undone ?? false;
      sendJson(res, 200, { ok: true, undone, ...baseSnapshot() });
      return true;
    }

    if (path === "/api/redo" && method === "POST") {
      const r = session.control.handle({ method: "history.redo" });
      const redone = (r.result as { redone?: boolean } | undefined)?.redone ?? false;
      sendJson(res, 200, { ok: true, redone, ...baseSnapshot() });
      return true;
    }

    if (path === "/api/reset" && method === "POST") {
      const next = options.createSession();
      await swapSession(next);
      await store?.clear();
      sendJson(res, 200, { ok: true, ...baseSnapshot() });
      return true;
    }

    if (path === "/api/tape" && method === "GET") {
      sendJson(res, 200, { ok: true, records: session.bus.tapeRecords() });
      return true;
    }

    if (path === "/api/tape/seek" && method === "POST") {
      const { seq } = await readJson(req);
      const preview = tapeStateAt(session.doc.appId, session.bus.tapeRecords(), Number(seq));
      sendJson(res, 200, { ok: true, seq, preview });
      return true;
    }

    if (path === "/api/tape/restore" && method === "POST") {
      const { seq } = await readJson(req);
      const r = session.control.handle({
        method: "command.invoke",
        params: { name: "tape.restore", params: { seq: Number(seq) }, label: "Restore here" },
      });
      if (!r.ok) {
        sendJson(res, 400, { ok: false, error: r.error, ...baseSnapshot() });
        return true;
      }
      sendJson(res, 200, { ok: true, result: r.result, ...baseSnapshot() });
      return true;
    }

    if (path === "/api/tape/fork" && method === "POST") {
      const { seq } = await readJson(req);
      const at = Number(seq) || 0;
      const records = session.bus.tapeRecords().filter((r) => r.seq <= at);
      sendJson(res, 200, { ok: true, appId: session.doc.appId, state: replayTape(session.doc.appId, records) });
      return true;
    }

    if (path === "/api/proposals" && method === "GET") {
      sendJson(res, 200, {
        ok: true,
        proposals: session.bus.proposals().map((p) => ({
          id: p.id,
          status: p.status,
          command: p.command,
          actor: p.actor,
          label: p.label,
          baseVersion: p.baseVersion,
          touchedNodeIds: Object.keys(p.touched),
        })),
      });
      return true;
    }

    const proposalAction = /^\/api\/proposals\/([^/]+)\/(accept|reject)$/.exec(path);
    if (proposalAction && method === "POST") {
      const id = decodeURIComponent(proposalAction[1] ?? "");
      const action = proposalAction[2];
      const methodCall = action === "accept" ? "proposal.accept" : "proposal.reject";
      const r = session.control.handle({ method: methodCall, params: { id } });
      if (!r.ok) {
        sendJson(res, 400, { ok: false, error: r.error });
        return true;
      }
      sendJson(res, 200, { ok: true, result: r.result ?? { decided: id } });
      return true;
    }

    if (path === "/api/describe" && method === "GET") {
      sendJson(res, 200, {
        ok: true,
        app: { id: options.id, name: options.name },
        commands: session.bus.list().map((name) => {
          const d = session.bus.describe(name);
          return {
            name: d.name,
            title: d.title,
            description: d.description,
            sideEffects: d.sideEffects,
            reversible: d.reversible ?? true,
            params: d.params,
            result: d.result,
            examples: d.examples,
            mcp: d.mcp,
          };
        }),
      });
      return true;
    }

    if (path === "/api/events" && method === "GET") {
      const disconnect = hub.connect(res);
      res.on("close", disconnect);
      return true;
    }

    // Legacy save/open (pre-app-kit files keep working — migration test).
    if (path === "/api/project" && method === "GET") {
      const assets: Record<string, string> = {};
      for (const id of session.assets?.ids() ?? []) {
        const bytes = session.assets?.get(id);
        if (bytes) assets[id] = Buffer.from(bytes).toString("base64");
      }
      const project = {
        format: options.projectFormat ?? "nucleus.project",
        version: 1,
        app: session.doc.appId,
        savedAt: new Date().toISOString(),
        doc: session.doc,
        assets,
      };
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="project.nucleus.json"',
      });
      res.end(JSON.stringify(project));
      return true;
    }

    if (path === "/api/project" && method === "POST") {
      try {
        const body = await readJson(req);
        const { doc, assets } = migrateLegacyProject(body);
        const next = options.createSession();
        applyPersistedDoc(next.doc, doc);
        for (const [id, bytes] of Object.entries(assets)) next.assets?.put(id, bytes);
        await swapSession(next);
        await store?.clear();
        sendJson(res, 200, { ok: true, ...baseSnapshot() });
        return true;
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: { kind: "validation", message: error instanceof Error ? error.message : String(error) },
        });
        return true;
      }
    }

    // `.nucleus` ZIP export (document + tape + content-addressed assets).
    if (path === "/api/export.nucleus" && method === "GET") {
      const rawAssets: Record<string, Uint8Array> = {};
      for (const id of session.assets?.ids() ?? []) {
        const bytes = session.assets?.get(id);
        if (bytes) rawAssets[id] = bytes;
      }
      const zip = buildNucleusZip({
        doc: session.doc,
        tape: session.bus.tapeRecords(),
        assets: assetBytesWithNames(rawAssets),
      });
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${options.name.toLowerCase().replace(/\s+/g, "-")}.nucleus"`,
      });
      res.end(Buffer.from(zip));
      return true;
    }

    // Content-addressed asset bytes by id (thumbnails and pdf.js read this).
    if (path.startsWith("/api/source/") && method === "GET" && session.assets) {
      const id = decodeURIComponent(path.slice("/api/source/".length));
      const bytes = session.assets.get(id);
      if (!bytes) {
        sendJson(res, 404, { ok: false, error: { kind: "not_found", message: `source not found: ${id}` } });
        return true;
      }
      const isPdf =
        bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
      res.writeHead(200, {
        "content-type": isPdf ? "application/pdf" : "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(Buffer.from(bytes));
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------ kit assets
  const packagedKitDir = fileURLToPath(new URL("../kit", import.meta.url));
  function kitDirForRequest(): string {
    return existsSync(join(options.publicDir, "_kit")) ? join(options.publicDir, "_kit") : packagedKitDir;
  }

  // ------------------------------------------------------------ boot
  // Server first, then raise the guard's expected port (matters for port 0).
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        // The launcher opens `/?t=<token>`: adopt into an HttpOnly cookie and
        // redirect to the clean URL so the token never lingers in history.
        if (url.searchParams.get("t") === token) {
          res.writeHead(302, { "set-cookie": tokenCookie(token), location: url.pathname });
          res.end();
          return;
        }
        if (!guard(req, res, guardOptions)) return;
        if (url.pathname.startsWith("/api/")) {
          const custom = options.routes ? await options.routes(req, res, url, session) : false;
          if (custom) return;
          const handled = await standardApi(req, res, url);
          if (!handled) sendJson(res, 404, { ok: false, error: { kind: "not_found", message: "unknown endpoint" } });
          return;
        }
        if (url.pathname.startsWith("/_kit/")) {
          const kit = kitDirForRequest();
          const served = await serveStatic(res, url.pathname.replace(/^\/_kit\//, "/"), kit);
          if (!served.served) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not found");
          }
          return;
        }
        const served = await serveStatic(res, url.pathname, options.publicDir);
        if (!served.served) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
        }
        return;
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: { kind: "internal", message: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  guardOptions.port = actualPort;

  return {
    id: options.id,
    name: options.name,
    get session() {
      return session;
    },
    port(): number {
      return actualPort;
    },
    dataDir: store?.dir ?? null,
    async close(): Promise<void> {
      hub.close();
      unbindBus();
      if (saveTimer) clearTimeout(saveTimer);
      await tapeWrite; // the append chain may still hold the last record
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}

/** Re-exported so apps import one module instead of keeping local copies. */
export { guard, guard as guardRequest, tokenCookie } from "./guard.js";
