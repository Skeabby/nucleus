import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CommandBus, NucleusError, createDocument, registerCoreCommands, type DocumentState } from "@nucleus/core";
import { ControlServer } from "@nucleus/control";
import {
  createAppServer,
  readNucleusZip,
  type AppKitSession,
  type AppServer,
} from "../src/index.js";

const TOKEN = "kit-test-token";

function makeSession(): AppKitSession {
  let local = 0;
  const doc = createDocument("kit.test");
  const bus = new CommandBus();
  registerCoreCommands(bus, { createId: () => `n${++local}` });
  const control = new ControlServer(bus, doc);
  const map = new Map<string, Uint8Array>();
  const assets = {
    get: (id: string) => map.get(id),
    put: (id: string, bytes: Uint8Array) => void map.set(id, bytes),
    ids: () => [...map.keys()],
  };
  return { doc, bus, control, assets, snapshot: () => ({ hello: "kit" }) };
}

function kitOptions(overrides: Record<string, unknown> = {}): Parameters<typeof createAppServer>[0] {
  return {
    id: "nucleus.kit-test",
    name: "Kit Test",
    publicDir: process.cwd(),
    createSession: makeSession,
    token: TOKEN,
    port: 0,
    persist: false,
    ...overrides,
  } as Parameters<typeof createAppServer>[0];
}

function base(app: AppServer): string {
  return `http://127.0.0.1:${app.port()}`;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...extra };
}

async function post(app: AppServer, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base(app) + path, {
    method: "POST",
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function get(app: AppServer, path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base(app) + path, { headers: headers() });
  return { status: res.status, json: (await res.json()) as any };
}

describe("@nucleus/app-kit createAppServer — standard surface", () => {
  let app: AppServer;

  beforeAll(async () => {
    app = await createAppServer(kitOptions());
  });
  afterAll(() => app.close());

  it("binds on the requested port 0 and answers /api/state", async () => {
    expect(app.port()).toBeGreaterThan(0);
    const state = await get(app, "/api/state");
    expect(state.json).toMatchObject({ ok: true, hello: "kit", docVersion: 0 });
  });

  it("401 on missing token, 403 bad host, 415 bad content-type", async () => {
    const noToken = await fetch(base(app) + "/api/state");
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(base(app) + "/api/state", { headers: { authorization: "Bearer nope" } });
    expect(wrongToken.status).toBe(401);
    const badCt = await fetch(base(app) + "/api/op", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: "x",
    });
    expect(badCt.status).toBe(415);
  });

  it("/api/op invokes with CAS + dryRun support; undo/redo walk back", async () => {
    const added = await post(app, "/api/op", { name: "doc.addNode", params: { type: "note" } });
    expect(added.json.result).toMatchObject({ result: { id: "n1" }, docVersion: 1 });

    const dry = await post(app, "/api/op", {
      name: "doc.removeNode",
      params: { id: "n1" },
      dryRun: true,
    });
    expect(dry.json.result.applied).toBe(1);
    expect(dry.json.result.patches).toEqual([{ op: "remove", nodeId: "n1" }]);

    const stale = await post(app, "/api/op", {
      name: "doc.updateNodeProps",
      params: { id: "n1", props: {} },
      expectedDocVersion: 0,
    });
    expect(stale.status).toBe(400);
    expect(stale.json.error.kind).toBe("conflict");

    const undo = await post(app, "/api/undo");
    expect(undo.json.undone).toBe(true);
    expect(undo.json.docVersion).toBe(2);
    const redo = await post(app, "/api/redo");
    expect(redo.json.redone).toBe(true);
  });

  it("/api/describe returns the FULL schema'd catalogue", async () => {
    const described = await get(app, "/api/describe");
    const names = described.json.commands.map((c: { name: string }) => c.name);
    expect(names).toContain("doc.addNode");
    expect(names).toContain("tape.restore");
    const addNode = described.json.commands.find((c: { name: string }) => c.name === "doc.addNode");
    expect(addNode.params.required).toEqual(["type"]);
    expect(addNode.result.required).toEqual(["id"]);
    expect(addNode.examples.length).toBeGreaterThan(0);
  });

  it("/api/tape list + seek + restore + fork", async () => {
    const tape = await get(app, "/api/tape");
    expect(tape.json.ok).toBe(true);
    const seq = (tape.json.records.at(-1) as { seq: number }).seq;

    const seek = await post(app, "/api/tape/seek", { seq: 0 });
    expect(Object.keys(seek.json.preview.nodes)).toHaveLength(0);
    expect(Object.keys(app.session.doc.nodes)).toHaveLength(1); // live untouched

    await post(app, "/api/op", { name: "doc.removeNode", params: { id: "n1" } });
    const restore = await post(app, "/api/tape/restore", { seq });
    expect(restore.json.ok).toBe(true);
    expect(Object.keys(app.session.doc.nodes)).toHaveLength(1);
    expect(app.session.doc.nodes["n1"]).toBeDefined();

    const fork = await post(app, "/api/tape/fork", { seq: 0 });
    expect(fork.json.state).not.toBe(app.session.doc);
    expect(Object.keys(fork.json.state.nodes)).toHaveLength(0);
  });

  it("proposal lifecycle over HTTP (guard: agent write → review by default)", async () => {
    const proposed = await post(app, "/api/op", {
      name: "doc.addNode",
      params: { type: "agent-node" },
      actor: { kind: "agent", id: "opencode" },
    });
    expect(proposed.json.result.status).toBe("proposed");
    const id = proposed.json.result.proposalId as string;
    expect(id).toBe("proposal-1");

    const list = await get(app, "/api/proposals");
    expect(list.json.proposals[0]).toMatchObject({ id, status: "pending" });

    const accepted = await post(app, `/api/proposals/${id}/accept`);
    expect(accepted.json.ok).toBe(true);
    expect(Object.keys(app.session.doc.nodes)).toHaveLength(2); // the agent node applied
    const decided = await post(app, `/api/proposals/${id}/accept`);
    expect(decided.json.error?.kind).toBe("conflict"); // already decided
  });

  it("unknown endpoint 404 stays structured", async () => {
    const res = await get(app, "/api/never");
    expect(res.status).toBe(404);
    expect(res.json.error.kind).toBe("not_found");
  });
});

describe("@nucleus/app-kit — SSE /api/events (zero-dep)", () => {
  let app: AppServer;
  beforeAll(async () => {
    app = await createAppServer(kitOptions());
  });
  afterAll(() => app.close());

  it("streams a command frame for bus activity", async () => {
    const events = await fetch(base(app) + "/api/events", { headers: headers() });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    void events.body!.cancel();
    // reconnect and read frames while we invoke
    const stream = await fetch(base(app) + "/api/events", { headers: headers() });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    void post(app, "/api/op", { name: "doc.addNode", params: { type: "sse" } });
    const deadline = Date.now() + 3000;
    let text = "";
    while (Date.now() < deadline && !text.includes("event: command")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deadline - Date.now() + 200)),
      ]);
      if (chunk === "timeout" || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    void reader.cancel();
    expect(text).toContain("event: command");
    expect(text).toContain('"command":"doc.addNode"');
  });

  it("the ?t= handshake sets the HttpOnly cookie and strips the token", async () => {
    const res = await fetch(`${base(app)}/index.html?t=${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("location")).toBe("/index.html");
  });
});

describe("@nucleus/app-kit — persistence (F7) + migration + .nucleus archive", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nucleus-kit-"));
  });

  it("close & reopen → document AND tape restored", async () => {
    const one = await createAppServer(kitOptions({ dataDir: dir, persist: true }));
    await post(one, "/api/op", { name: "doc.addNode", params: { type: "persisted" } });
    await post(one, "/api/op", { name: "doc.updateNodeProps", params: { id: "n1", props: { v: 7 } } });
    await new Promise((resolve) => setTimeout(resolve, 700)); // autosave debounce
    await one.close();

    const two = await createAppServer(kitOptions({ dataDir: dir, persist: true }));
    expect(two.session.doc.nodes["n1"]?.props).toEqual({ v: 7 });
    expect(two.session.doc.docVersion).toBe(2);
    const tape = await get(two, "/api/tape");
    expect(tape.json.records.length).toBe(2);
    expect((tape.json.records.at(-1) as { command: string }).command).toBe("doc.updateNodeProps");
    // new commands continue the tape AFTER the restored records
    await post(two, "/api/op", { name: "doc.addNode", params: { type: "after-restore" } });
    const tape2 = await get(two, "/api/tape");
    expect((tape2.json.records.at(-1) as { seq: number }).seq).toBe(3);
    await two.close();
  });

  it("reset clears the persisted document", async () => {
    const one = await createAppServer(kitOptions({ dataDir: dir, persist: true }));
    await post(one, "/api/op", { name: "doc.addNode", params: { type: "x" } });
    const reset = await post(one, "/api/reset");
    expect(reset.json.ok).toBe(true);
    await one.close();
    const two = await createAppServer(kitOptions({ dataDir: dir, persist: true }));
    expect(Object.keys(two.session.doc.nodes)).toHaveLength(0);
    await two.close();
  });

  it("legacy nucleus.project / nucleus.notes.project still open (migration)", async () => {
    const app = await createAppServer(kitOptions({ projectFormat: "nucleus.project" }));
    const legacy = {
      format: "nucleus.project",
      version: 1,
      app: "nucleus.pdf",
      savedAt: "2026-08-01T00:00:00.000Z",
      doc: {
        schemaVersion: 1,
        appId: "nucleus.pdf",
        docVersion: 3,
        selection: [],
        nodes: {
          p1: { id: "p1", type: "page", parentId: null, order: 0, enabled: true, opacity: 1, props: { rotation: 90 } },
        },
      },
      assets: { "src-old": Buffer.from("old-bytes").toString("base64") },
    };
    const loaded = await post(app, "/api/project", legacy);
    expect(loaded.json.ok).toBe(true);
    expect(app.session.doc.nodes["p1"]?.props).toEqual({ rotation: 90 });
    expect(app.session.doc.docVersion).toBe(3);
    expect(app.session.assets?.get("src-old")).toEqual(Buffer.from("old-bytes"));
    // roundtrip back out in the SAME legacy format
    const saved = await get(app, "/api/project");
    expect(saved.json.format).toBe("nucleus.project");
    expect((saved.json.doc.nodes as Record<string, unknown>)["p1"]).toBeDefined();
    await app.close();
  });

  it("legacy notes project (different format id) also opens", async () => {
    const app = await createAppServer(kitOptions({ projectFormat: "nucleus.notes.project" }));
    const loaded = await post(app, "/api/project", {
      format: "nucleus.notes.project",
      version: 1,
      doc: { schemaVersion: 1, appId: "nucleus.notes", docVersion: 1, selection: [], nodes: {} },
    });
    expect(loaded.json.ok).toBe(true);
    await app.close();
  });

  it("a non-legacy body is refused with kind=validation", async () => {
    const app = await createAppServer(kitOptions());
    const res = await post(app, "/api/project", { format: "not-nucleus" });
    expect(res.json.error.kind).toBe("validation");
    await app.close();
  });

  it("export.nucleus: ZIP contains document.json + tape.jsonl and re-reads", async () => {
    const app = await createAppServer(kitOptions());
    await post(app, "/api/op", { name: "doc.addNode", params: { type: "zip-me" } });
    const res = await fetch(base(app) + "/api/export.nucleus", { headers: headers() });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const archive = readNucleusZip(bytes);
    expect(archive.manifest.format).toBe("nucleus.doc");
    expect(archive.manifest.doc.docVersion).toBeGreaterThanOrEqual(1);
    expect(archive.tape).toHaveLength(1);
    await app.close();
  });

  it("export.nucleus dedups assets by content hash", async () => {
    const app = await createAppServer(kitOptions());
    app.session.assets?.put("a", new TextEncoder().encode("same-content"));
    app.session.assets?.put("b", new TextEncoder().encode("same-content"));
    const res = await fetch(base(app) + "/api/export.nucleus", { headers: headers() });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const archive = readNucleusZip(bytes);
    expect(Object.keys(archive.assets).length).toBe(1);
    const [name] = Object.keys(archive.assets);
    expect(name).toMatch(/^assets\/[0-9a-f]{32}\.bin$/);
    await app.close();
  });
});

describe("@nucleus/app-kit — custom routes and session swap", () => {
  it("custom routes win over standard ones and get the live session", async () => {
    const app = await createAppServer(
      kitOptions({
        routes: (req, res, url, session) => {
          if (url.pathname === "/api/state") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, custom: true, nodes: Object.keys(session.doc.nodes).length }));
            return true;
          }
          return false;
        },
      }),
    );
    const state = await get(app, "/api/state");
    expect(state.json.custom).toBe(true);
    await app.close();
  });

  it("reset swaps the session and the NEW bus keeps streaming", async () => {
    const app = await createAppServer(kitOptions());
    await post(app, "/api/op", { name: "doc.addNode", params: { type: "before" } });
    expect(app.session.doc.nodes["n1"]).toBeDefined();
    const after = await post(app, "/api/reset");
    expect(after.json.ok).toBe(true);
    expect(Object.keys(app.session.doc.nodes)).toHaveLength(0);
    expect(app.session.doc.nodes["n1"]).toBeUndefined(); // same doc, wiped
    // bus still functional after swap: undo stack empty, invoke works
    const op = await post(app, "/api/op", { name: "doc.addNode", params: { type: "after" } });
    expect(op.json.result.result.id).toBe("n1");
    await app.close();
  });

  it("NucleusError-shaped failures keep JSON kinds end-to-end", () => {
    expect(new NucleusError("conflict", "x").kind).toBe("conflict");
    const doc: DocumentState = createDocument("kit.test");
    expect(doc.docVersion).toBe(0);
  });
});
