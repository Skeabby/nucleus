import { describe, expect, it } from "vitest";

import {
  CommandBus,
  createDocument,
  registerCoreCommands,
  NucleusError,
  type DocumentState,
} from "@nucleus/core";
import { ControlServer } from "../src/index.js";

function setup(trust: "ask" | "writes" | "autopilot" = "ask"): {
  doc: DocumentState;
  server: ControlServer;
} {
  let n = 0; // fresh ids per test
  const doc = createDocument("test.app");
  const bus = new CommandBus();
  registerCoreCommands(bus, { createId: () => `n${++n}` });
  return { doc, server: new ControlServer(bus, doc, { trust }) };
}

const agent = { kind: "agent", id: "opencode" } as const;

interface Handled {
  ok: boolean;
  result?: any;
  error?: { kind: string; message: string; details?: unknown };
}

function handle(server: ControlServer, method: string, params?: unknown): Handled {
  return server.handle({ method, params }) as Handled;
}

describe("ControlServer v2 (M1): describe / invoke / CAS / tape / proposals", () => {
  it("command.describe exposes params + result schemas + examples (F11)", () => {
    const { server } = setup();
    const described = handle(server, "command.describe", { name: "doc.addNode" });
    expect(described.ok).toBe(true);
    expect(described.result.params.required).toEqual(["type"]);
    expect(described.result.params.properties.type.type).toBe("string");
    expect(described.result.result.required).toEqual(["id"]);
    expect(described.result.examples[0].params).toEqual({ type: "note", props: { title: "Hello" } });
  });

  it("command.invoke validates params (validation error lists the path)", () => {
    const { server } = setup();
    const response = handle(server, "command.invoke", { name: "doc.updateNodeProps", params: {} });
    expect(response.ok).toBe(false);
    expect(response.error?.kind).toBe("validation");
    expect(response.error?.message).toContain("id: required");
  });

  it("command.invoke forwards expectedDocVersion → conflict; CAS dance then applies", () => {
    const { doc, server } = setup();
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "a" } });
    const stale = handle(server, "command.invoke", {
      name: "doc.removeNode",
      params: { id: "n1" },
      expectedDocVersion: 0,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error?.kind).toBe("conflict");
    // fresh read then act — the CAS dance an agent does
    const version = handle(server, "doc.snapshot").result.state.docVersion as number;
    const ok = handle(server, "command.invoke", {
      name: "doc.updateNodeProps",
      params: { id: "n1", props: {} },
      expectedDocVersion: version,
    });
    expect(ok.ok).toBe(true);
    expect(doc.docVersion).toBe(version + 1);
  });

  it("dryRun goes through the control surface and returns patches", () => {
    const { doc, server } = setup();
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "a" } });
    const version = doc.docVersion;
    const dry = handle(server, "command.invoke", {
      name: "doc.removeNode",
      params: { id: "n1" },
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    expect(dry.result.applied).toBe(1);
    expect(dry.result.patches).toEqual([{ op: "remove", nodeId: "n1" }]);
    expect(doc.docVersion).toBe(version); // nothing applied
  });

  it("label and actor travel onto the tape record", () => {
    const { server } = setup();
    handle(server, "command.invoke", {
      name: "doc.addNode",
      params: { type: "a" },
      actor: { kind: "human", id: "mitch" },
      label: "via CLI",
    });
    const records = handle(server, "tape.list").result.records as { label?: string; actor: unknown }[];
    expect(records[0].label).toBe("via CLI");
    expect(records[0].actor).toEqual({ kind: "human", id: "mitch" });
  });

  it("trust=ask: an agent write becomes a proposal, a human write applies", () => {
    const { server } = setup("ask");
    const proposed = handle(server, "command.invoke", {
      name: "doc.addNode",
      params: { type: "agent-made" },
      actor: agent,
    });
    expect(proposed.ok).toBe(true);
    expect(proposed.result.status).toBe("proposed");
    expect(proposed.result.proposalId).toBe("proposal-1");
    expect(handle(server, "proposal.list").result.proposals).toHaveLength(1);
    // human always applies immediately
    const humanOn = handle(server, "command.invoke", {
      name: "doc.addNode",
      params: { type: "human-made" },
    });
    expect(humanOn.result.status).toBeUndefined();
  });

  it("proposal.accept applies; re-accept conflicts; acceptAll drains pending in order", () => {
    const { doc, server } = setup("ask");
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "a" }, actor: agent });
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "b" }, actor: agent });
    const accepted = handle(server, "proposal.accept", { id: "proposal-1" });
    expect(accepted.ok).toBe(true);
    expect(accepted.result.docVersion).toBe(1); // the first accepted proposal
    expect(Object.keys(doc.nodes)).toEqual(["n1"]);
    const done = handle(server, "proposal.accept", { id: "proposal-1" });
    expect(done.error?.kind).toBe("conflict");
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "c" }, actor: agent });
    const all = handle(server, "proposal.acceptAll");
    expect(all.result.accepted).toEqual(["proposal-2", "proposal-3"]); // p2 was still pending
    expect(handle(server, "history.undo").result.undone).toBe(true);
    expect(Object.keys(doc.nodes)).toEqual(["n1", "n2"]); // undo only the LAST accepted
  });

  it("proposal.reject decides the proposal for good (conflict on repeat)", () => {
    const { server } = setup("ask");
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "a" }, actor: agent });
    handle(server, "proposal.reject", { id: "proposal-1" });
    expect(handle(server, "proposal.reject", { id: "proposal-1" }).error?.kind).toBe("conflict");
  });

  it("tape.seek previews the past without touching the live doc", () => {
    const { doc, server } = setup();
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "a" } });
    const seek = handle(server, "tape.seek", { seq: 0 });
    expect(seek.ok).toBe(true);
    expect(Object.keys(seek.result.preview.nodes)).toHaveLength(0);
    expect(Object.keys(doc.nodes)).toHaveLength(1);
  });

  it("tape.fork returns a brand-new state object at the requested seq", () => {
    const { doc, server } = setup();
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "a" } });
    const fork = handle(server, "tape.fork", { seq: 0 });
    expect(fork.result.appId).toBe("test.app");
    expect(fork.result.state).not.toBe(doc);
    expect(Object.keys(fork.result.state.nodes)).toHaveLength(0);
  });

  it("tape.restore applies the diff as ONE undoable entry", () => {
    const { doc, server } = setup();
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "a" } });
    handle(server, "command.invoke", { name: "doc.removeNode", params: { id: "n1" } });
    const restored = handle(server, "tape.restore", { seq: 1 });
    expect(restored.ok).toBe(true);
    expect(doc.nodes["n1"]).toBeDefined();
    // one undo from the restore lands on the post-removal state again
    handle(server, "history.undo");
    expect(doc.nodes["n1"]).toBeUndefined();
  });

  it("doc.snapshot returns the state plus tape bookkeeping", () => {
    const { server } = setup();
    handle(server, "command.invoke", { name: "doc.addNode", params: { type: "a" } });
    const snap = handle(server, "doc.snapshot");
    expect(snap.result.tape).toEqual({ length: 1, lastSeq: 1 });
    expect(snap.result.state.docVersion).toBe(1);
  });

  it("unknown methods and bad actors keep their structured kinds", () => {
    const { server } = setup();
    expect(handle(server, "nope").error?.kind).toBe("not_found");
    expect(
      handle(server, "command.invoke", {
        name: "doc.addNode",
        params: {},
        actor: { kind: "alien", id: "x" },
      }).error?.kind,
    ).toBe("validation");
  });

  it("NucleusError surfaces keep JSON-RPC-shaped kinds (sanity, F10 surface)", () => {
    expect(new NucleusError("conflict", "x").code).toBe(-32002);
  });
});
