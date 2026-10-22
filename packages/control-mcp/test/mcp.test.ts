import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { AppClient, type CommandDescription, type Proposal } from "../src/client.js";
import { Registry, parseRegistry, readRegistry, runDir } from "../src/registry.js";
import { createServer } from "../src/server.js";
import { callTool, derivedToolName, listTools, type ToolContext } from "../src/tools.js";

// ---------------------------------------------------------------- fake app

interface FakeAppOptions {
  id?: string;
  name?: string;
  token?: string;
  commands?: CommandDescription[];
  proposals?: Proposal[];
  tape?: unknown[];
  /** Command names answered with a proposal instead of a result. */
  propose?: string[];
  /** Refuse every call (an app that died but is still in the registry). */
  offline?: boolean;
}

interface FakeApp {
  port: number;
  token: string;
  calls: Array<{ command: string; body: Record<string, unknown>; authorization: string }>;
  close: () => Promise<void>;
}

const NOTES_COMMANDS: CommandDescription[] = [
  {
    name: "note.create",
    title: "Create note",
    description: "Create a note",
    sideEffects: "write",
    params: {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" }, content: { type: "string" } },
    },
    mcp: { expose: true, name: "note_create" },
  },
  {
    name: "note.delete",
    title: "Delete note",
    description: "Delete a note",
    sideEffects: "write",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  },
];

const PDF_COMMANDS: CommandDescription[] = [
  {
    name: "pdf.stats",
    title: "Stats",
    description: "Page count",
    sideEffects: "read",
    params: { type: "object", properties: {} },
    mcp: { expose: true },
  },
  {
    name: "pdf.removePage",
    title: "Remove page",
    description: "Remove a page",
    sideEffects: "write",
    params: { type: "object", required: ["page"], properties: { page: { type: "integer" } } },
  },
];

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>));
      } catch {
        resolve({});
      }
    });
  });
}

async function fakeApp(options: FakeAppOptions = {}): Promise<FakeApp> {
  const id = options.id ?? "nucleus.notes";
  const token = options.token ?? "tok-123";
  const calls: FakeApp["calls"] = [];
  const propose = new Set(options.propose ?? []);
  let proposals = options.proposals ?? [];

  const server: Server = createHttpServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (options.offline) {
      req.socket.destroy();
      return;
    }
    if (String(req.headers.authorization ?? "") !== `Bearer ${token}`) {
      send(401, { ok: false, error: "missing token" });
      return;
    }
    // Mirror the app guard: writes must announce JSON.
    if (req.method === "POST" && String(req.headers["content-type"] ?? "") !== "application/json") {
      send(415, { ok: false, error: "bad content-type" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/describe") {
      send(200, {
        app: { id, name: options.name ?? id },
        commands: options.commands ?? NOTES_COMMANDS,
      });
      return;
    }
    if (url.pathname === "/api/state") {
      send(200, { ok: true });
      return;
    }
    if (url.pathname === "/api/op" && req.method === "POST") {
      const body = await readBody(req);
      const command = String(body.name ?? "");
      calls.push({ command, body, authorization: String(req.headers.authorization ?? "") });
      if (propose.has(command)) {
        const proposal = {
          id: `p-${command}`,
          status: "pending",
          command,
          actor: body.actor as Proposal["actor"],
        };
        proposals = [...proposals, proposal];
        send(200, { ok: true, result: { status: "proposed", proposalId: proposal.id } });
        return;
      }
      send(200, { ok: true, result: { ok: true, command, echo: body.params } });
      return;
    }
    if (url.pathname === "/api/proposals") {
      send(200, { proposals });
      return;
    }
    if (url.pathname === "/api/tape") {
      send(200, { records: options.tape ?? [] });
      return;
    }
    if (url.pathname === "/api/undo" && req.method === "POST") {
      send(200, { ok: true, undone: true });
      return;
    }
    send(404, { ok: false, error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    token,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function clientFor(app: FakeApp, id = "nucleus.notes", name = id): AppClient {
  return new AppClient({
    id,
    name,
    port: app.port,
    token: app.token,
    pid: 4242,
    startedAt: "2026-10-22T00:00:00Z",
  });
}

const agent = { kind: "agent", id: "opencode" } as const;
const ctx = (clients: AppClient[]): ToolContext => ({ clients, actor: agent });

/** A fresh `apps.json` inside a throwaway directory. */
function registryFile(apps: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nucleus-mcp-"));
  const file = path.join(dir, "apps.json");
  writeFileSync(file, typeof apps === "string" ? apps : JSON.stringify(apps), "utf8");
  return file;
}

const open: FakeApp[] = [];

async function startApp(options: FakeAppOptions = {}): Promise<FakeApp> {
  const app = await fakeApp(options);
  open.push(app);
  return app;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

// ---------------------------------------------------------------- registry

describe("run registry (§4.4)", () => {
  it("parses the launcher's camelCase records", () => {
    const apps = parseRegistry(
      JSON.stringify([
        {
          id: "nucleus.notes",
          name: "Notes",
          port: 51234,
          token: "t",
          pid: 7,
          startedAt: "2026-10-22T10:00:00Z",
        },
      ]),
    );
    expect(apps).toEqual([
      {
        id: "nucleus.notes",
        name: "Notes",
        port: 51234,
        token: "t",
        pid: 7,
        startedAt: "2026-10-22T10:00:00Z",
      },
    ]);
  });

  it("treats a corrupt or missing registry as 'nothing is running'", () => {
    expect(parseRegistry("{not json")).toEqual([]);
    expect(parseRegistry('{"apps":[]}')).toEqual([]);
    expect(readRegistry(path.join(tmpdir(), "nucleus-nope", "apps.json"))).toEqual([]);
  });

  it("drops entries without an id but keeps the rest", () => {
    const apps = parseRegistry(JSON.stringify([{ name: "no id" }, { id: "a.b" }]));
    expect(apps.map((app) => app.id)).toEqual(["a.b"]);
    expect(apps[0]?.port).toBeNull();
    expect(apps[0]?.name).toBe("a.b");
  });

  it("re-reads only when the launcher rewrote the file", () => {
    const file = registryFile([{ id: "a.b", name: "B", port: 1, token: null }]);
    const registry = new Registry(file);
    expect(registry.apps().map((app) => app.id)).toEqual(["a.b"]);
    writeFileSync(file, JSON.stringify([{ id: "c.d", name: "D", port: 2, token: null }]), "utf8");
    // mtime granularity: force a distinct value so the cache invalidates.
    utimesSync(file, new Date(), new Date(Date.now() + 2_000));
    expect(registry.apps().map((app) => app.id)).toEqual(["c.d"]);
  });

  it("honours NUCLEUS_RUN_DIR", () => {
    const previous = process.env.NUCLEUS_RUN_DIR;
    process.env.NUCLEUS_RUN_DIR = path.join(tmpdir(), "nucleus-run-override");
    try {
      expect(runDir()).toBe(path.join(tmpdir(), "nucleus-run-override"));
    } finally {
      if (previous === undefined) delete process.env.NUCLEUS_RUN_DIR;
      else process.env.NUCLEUS_RUN_DIR = previous;
    }
  });
});

// ---------------------------------------------------------------- generic tools

describe("nucleus_apps / nucleus_describe", () => {
  it("summarises reachable apps and flags the unreachable ones", async () => {
    const notes = await startApp();
    const dead = await startApp({ id: "nucleus.pdf", offline: true });
    const result = (await callTool(
      "nucleus_apps",
      {},
      ctx([clientFor(notes, "nucleus.notes"), clientFor(dead, "nucleus.pdf")]),
    )) as { apps: Array<Record<string, unknown>> };

    expect(result.apps[0]).toMatchObject({
      id: "nucleus.notes",
      reachable: true,
      commands: 2,
      writes: 2,
      shortcuts: 1,
    });
    expect(result.apps[1]).toMatchObject({ id: "nucleus.pdf", reachable: false });
    expect(String(result.apps[1]?.error)).toContain("unreachable");
  });

  it("returns every command with its param schema", async () => {
    const notes = await startApp();
    const result = (await callTool(
      "nucleus_describe",
      { app: "nucleus.notes" },
      ctx([clientFor(notes)]),
    )) as { commands: CommandDescription[] };
    expect(result.commands.map((command) => command.name)).toEqual(["note.create", "note.delete"]);
    expect(result.commands[0]?.params).toMatchObject({ required: ["title"] });
  });

  it("returns a single command, and names the running apps otherwise", async () => {
    const notes = await startApp();
    const context = ctx([clientFor(notes)]);
    const one = (await callTool("nucleus_describe", { app: "nucleus.notes", command: "note.delete" }, context)) as {
      command: CommandDescription;
    };
    expect(one.command.name).toBe("note.delete");

    await expect(callTool("nucleus_describe", { app: "nucleus.notes", command: "nope" }, context)).rejects.toThrow(
      /has no command/,
    );
    await expect(callTool("nucleus_describe", { app: "nucleus.pdf" }, context)).rejects.toThrow(
      /not running \(running: nucleus\.notes\)/,
    );
  });

  it("resolves an app by display name as well as by id", async () => {
    const notes = await startApp({ name: "Notes" });
    const result = (await callTool(
      "nucleus_describe",
      { app: "Notes" },
      ctx([clientFor(notes, "nucleus.notes", "Notes")]),
    )) as { app: string };
    expect(result.app).toBe("nucleus.notes");
  });
});

// ---------------------------------------------------------------- invoke

describe("nucleus_invoke", () => {
  it("drives the app with its bearer and the agent actor", async () => {
    const notes = await startApp();
    const result = await callTool(
      "nucleus_invoke",
      { app: "nucleus.notes", command: "note.create", params: { title: "Shopping" }, label: "add note" },
      ctx([clientFor(notes)]),
    );
    expect(result).toMatchObject({ ok: true, command: "note.create" });
    expect(notes.calls).toHaveLength(1);
    expect(notes.calls[0]?.authorization).toBe(`Bearer ${notes.token}`);
    expect(notes.calls[0]?.body).toMatchObject({
      name: "note.create",
      params: { title: "Shopping" },
      label: "add note",
      actor: { kind: "agent", id: "opencode" },
    });
  });

  it("defaults params to {} and passes a proposal through untouched", async () => {
    const pdf = await startApp({ id: "nucleus.pdf", commands: PDF_COMMANDS, propose: ["pdf.removePage"] });
    const result = await callTool(
      "nucleus_invoke",
      { app: "nucleus.pdf", command: "pdf.removePage" },
      ctx([clientFor(pdf, "nucleus.pdf")]),
    );
    expect(result).toEqual({ status: "proposed", proposalId: "p-pdf.removePage" });
    expect(pdf.calls[0]?.body.params).toEqual({});
  });

  it("surfaces a validation error from the app", async () => {
    const notes = await startApp();
    const failing = new AppClient({
      id: "nucleus.notes",
      name: "nucleus.notes",
      port: notes.port,
      token: "wrong",
      pid: null,
      startedAt: "",
    });
    await expect(
      callTool("nucleus_invoke", { app: "nucleus.notes", command: "note.create" }, ctx([failing])),
    ).rejects.toThrow(/app nucleus\.notes: missing token/);
  });

  it("requires a command", async () => {
    const notes = await startApp();
    await expect(callTool("nucleus_invoke", { app: "nucleus.notes" }, ctx([clientFor(notes)]))).rejects.toThrow(
      /missing "command"/,
    );
  });
});

// ---------------------------------------------------------------- proposals

describe("nucleus_proposals / nucleus_wait", () => {
  it("lists proposals", async () => {
    const notes = await startApp({
      proposals: [{ id: "p1", status: "pending", command: "note.delete" }],
    });
    const result = (await callTool("nucleus_proposals", { app: "nucleus.notes" }, ctx([clientFor(notes)]))) as {
      proposals: Proposal[];
    };
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.id).toBe("p1");
  });

  it("returns as soon as the proposal is decided", async () => {
    const notes = await startApp({ proposals: [{ id: "p1", status: "accepted", command: "note.delete" }] });
    const result = (await callTool(
      "nucleus_wait",
      { proposalId: "p1" },
      ctx([clientFor(notes)]),
    )) as { proposal: Proposal };
    expect(result.proposal.status).toBe("accepted");
  });

  it("times out on a proposal still pending", async () => {
    const notes = await startApp({ proposals: [{ id: "p1", status: "pending", command: "note.delete" }] });
    const result = (await callTool(
      "nucleus_wait",
      { proposalId: "p1", timeoutMs: 0 },
      ctx([clientFor(notes)]),
    )) as { status: string };
    expect(result.status).toBe("timeout");
  });
});

// ---------------------------------------------------------------- tape / undo

describe("nucleus_tape / nucleus_undo", () => {
  it("filters tape records by seq", async () => {
    const notes = await startApp({
      tape: [
        { seq: 1, command: "note.create" },
        { seq: 2, command: "note.update" },
        { seq: 3, command: "note.delete" },
      ],
    });
    const result = (await callTool("nucleus_tape", { app: "nucleus.notes", since: 1 }, ctx([clientFor(notes)]))) as {
      records: Array<{ seq: number }>;
    };
    expect(result.records.map((record) => record.seq)).toEqual([2, 3]);
  });

  it("reports whether the undo did anything", async () => {
    const notes = await startApp();
    const result = await callTool("nucleus_undo", { app: "nucleus.notes" }, ctx([clientFor(notes)]));
    expect(result).toEqual({ app: "nucleus.notes", undone: true });
  });
});

// ---------------------------------------------------------------- shortcuts

describe("curated shortcuts (mcp.expose)", () => {
  it("exposes one tool per opted-in descriptor, named explicitly or derived", async () => {
    const notes = await startApp();
    const pdf = await startApp({ id: "nucleus.pdf", commands: PDF_COMMANDS });
    const tools = await listTools(ctx([clientFor(notes, "nucleus.notes"), clientFor(pdf, "nucleus.pdf")]));
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("note_create");
    expect(names).toContain("pdf.stats".replace(".", "_"));
    expect(names).not.toContain("note_delete");
    expect(names.slice(0, 7)).toEqual([
      "nucleus_apps",
      "nucleus_describe",
      "nucleus_invoke",
      "nucleus_proposals",
      "nucleus_wait",
      "nucleus_tape",
      "nucleus_undo",
    ]);

    const shortcut = tools.find((tool) => tool.name === "note_create");
    expect(shortcut?.inputSchema).toMatchObject({ required: ["title"] });
    expect(shortcut?.description).toContain("shortcut for note.create");
  });

  it("invokes the bound command with the tool arguments", async () => {
    const notes = await startApp();
    const context = ctx([clientFor(notes)]);
    const result = await callTool("note_create", { title: "Ideas", content: "- ship M4" }, context);
    expect(result).toMatchObject({ ok: true, command: "note.create" });
    expect(notes.calls[0]?.body).toMatchObject({
      name: "note.create",
      params: { title: "Ideas", content: "- ship M4" },
      label: "agent: note.create",
    });
  });

  it("does not hide the other apps when one is down", async () => {
    const dead = await startApp({ id: "nucleus.pdf", commands: PDF_COMMANDS, offline: true });
    const notes = await startApp();
    const tools = await listTools(ctx([clientFor(dead, "nucleus.pdf"), clientFor(notes)]));
    expect(tools.map((tool) => tool.name)).toContain("note_create");
  });

  it("derives snake_case names from command names", () => {
    expect(derivedToolName("note.create")).toBe("note_create");
    expect(derivedToolName("pdf.removePage")).toBe("pdf_removePage");
  });

  it("rejects an unknown tool", async () => {
    const notes = await startApp();
    await expect(callTool("nope", {}, ctx([clientFor(notes)]))).rejects.toThrow(/unknown tool: nope/);
  });
});

// ---------------------------------------------------------------- server

describe("JSON-RPC over stdio", () => {
  function harness(clients: () => AppClient[]) {
    const out: string[] = [];
    const server = createServer({ clients, write: (line) => out.push(line) });
    const messages = () => out.map((line) => JSON.parse(line) as Record<string, any>);
    return { server, messages };
  }

  it("answers initialize with the protocol version and renames the actor", async () => {
    const { server, messages } = harness(() => []);
    await server.handle({ id: 1, method: "initialize", params: { clientInfo: { name: "OpenCode" } } });
    expect(messages()[0]?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "nucleus-mcp" },
    });
    expect(server.actor()).toEqual({ kind: "agent", id: "OpenCode" });
  });

  it("lists the generic tools and calls one", async () => {
    const notes = await startApp();
    const { server, messages } = harness(() => [clientFor(notes)]);
    await server.handle({ id: 1, method: "initialize", params: { clientInfo: { name: "OpenCode" } } });
    await server.handle({ id: 2, method: "tools/list" });
    await server.handle({
      id: 3,
      method: "tools/call",
      params: { name: "nucleus_invoke", arguments: { app: "nucleus.notes", command: "note.create" } },
    });

    const [init, list, call] = messages();
    expect(init?.result?.protocolVersion).toBe("2025-06-18");
    expect((list?.result?.tools as Array<{ name: string }>).length).toBeGreaterThanOrEqual(7);
    const payload = JSON.parse(call?.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, command: "note.create" });
    expect(notes.calls[0]?.body.actor).toEqual({ kind: "agent", id: "OpenCode" });
  });

  it("turns a tool failure into an isError result, not a crash", async () => {
    const { server, messages } = harness(() => []);
    await server.handle({ id: 1, method: "tools/call", params: { name: "nucleus_describe", arguments: {} } });
    expect(messages()[0]?.result).toMatchObject({ isError: true });
    expect(String(messages()[0]?.result?.content?.[0]?.text)).toContain('missing "app"');
  });

  it("rejects an unknown method with -32601 and ignores notifications", async () => {
    const { server, messages } = harness(() => []);
    await server.handle({ method: "notifications/initialized" });
    expect(messages()).toHaveLength(0);
    await server.handle({ id: 9, method: "does/not/exist" });
    expect(messages()[0]?.error).toMatchObject({ code: -32601 });
  });
});
