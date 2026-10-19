import { describe, expect, it, vi } from "vitest";

import {
  CommandBus,
  NucleusError,
  createDocument,
  registerCoreCommands,
  type Actor,
  type DocumentState,
  type TapeRecord,
} from "../src/index.js";

function setup(): { doc: DocumentState; bus: CommandBus } {
  let n = 0; // fresh ids per test
  const doc = createDocument("test.app");
  const bus = new CommandBus();
  registerCoreCommands(bus, { createId: () => `n${++n}` });
  return { doc, bus };
}

const human = (id = "human"): Actor => ({ kind: "human", id });
const agent = (id = "opencode"): Actor => ({ kind: "agent", id });

describe("Core v2: CAS, validation, tape records and events", () => {
  it("refuses a stale expectedDocVersion with kind=conflict and details (D-protocol)", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" }); // docVersion -> 1
    try {
      bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: {} }, { expectedDocVersion: 0 });
      expect.unreachable("CAS must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(NucleusError);
      const err = error as NucleusError;
      expect(err.kind).toBe("conflict");
      expect(err.code).toBe(-32002);
      expect(err.details).toMatchObject({ expected: 0, actual: 1, command: "doc.updateNodeProps" });
    }
    // nothing modified
    expect(doc.docVersion).toBe(1);
  });

  it("accepts invoke when the caller saw the current version", () => {
    const { doc, bus } = setup();
    const before = bus.invoke("doc.addNode", doc, { type: "layer" }).docVersion;
    const outcome = bus.invoke(
      "doc.updateNodeProps",
      doc,
      { id: "n1", props: {} },
      { expectedDocVersion: before },
    );
    expect(outcome.docVersion).toBe(before + 1);
  });

  it("validates params against the descriptor schema BEFORE run (F11)", () => {
    const { doc, bus } = setup();
    try {
      bus.invoke("doc.updateNodeProps", doc, { props: {} });
      expect.unreachable("missing id must be rejected");
    } catch (error) {
      const err = error as NucleusError;
      expect(err.kind).toBe("validation");
      expect(err.message).toContain("invalid params for doc.updateNodeProps");
      expect(err.message).toContain("params.id: required");
    }
    expect(doc.docVersion).toBe(0);
  });

  it("attaches actor, label and timestamps to every tape record (F10)", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" }, { actor: agent(), label: "from an agent" });
    const record = bus.tapeRecords()[0] as TapeRecord;
    expect(record.command).toBe("doc.addNode");
    expect(record.actor).toMatchObject({ kind: "agent", id: "opencode" });
    expect(record.label).toBe("from an agent");
    expect(record.docVersionAfter).toBe(1);
    expect(record.seq).toBe(1);
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(record.redo).toHaveLength(1);
    expect(record.undo).toHaveLength(1);
  });

  it("keeps seq monotonic and docVersionAfter truthful across many commands", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "a" });
    bus.invoke("doc.addNode", doc, { type: "b" });
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { x: 1 } });
    bus.undo(doc);
    bus.redo(doc);
    const records = bus.tapeRecords();
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(records[records.length - 1]?.docVersionAfter).toBe(3);
    // undo/redo are navigation, not changes: no extra records
    expect(bus.tapeRecords()).toHaveLength(3);
  });

  it("emits command / undo / redo events and allows unsubscribing", () => {
    const { doc, bus } = setup();
    const events: string[] = [];
    const off = bus.subscribe((event) => events.push(event.type));
    bus.invoke("doc.addNode", doc, { type: "layer" });
    bus.undo(doc);
    bus.redo(doc);
    off();
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: {} });
    expect(events).toEqual(["command", "undo", "redo"]);
  });

  it("returns the patches on dryRun and touches nothing", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" });
    const outcome = bus.invoke("doc.removeNode", doc, { id: "n1" }, { dryRun: true });
    expect(outcome.applied).toBe(1);
    expect(outcome.patches).toEqual([{ op: "remove", nodeId: "n1" }]);
    expect(doc.nodes["n1"]).toBeDefined();
    expect(doc.docVersion).toBe(1);
    expect(bus.canUndo()).toBe(true); // only the first command is in history
    expect(bus.tapeRecords()).toHaveLength(1);
  });

  it("a broken listener never breaks the bus", () => {
    const { doc, bus } = setup();
    bus.subscribe(() => {
      throw new Error("listener bug");
    });
    expect(() => bus.invoke("doc.addNode", doc, { type: "layer" })).not.toThrow();
    expect(doc.nodes["n1"]).toBeDefined();
  });
});

describe("Core v2: same-actor coalescing (F2 hardening)", () => {
  it("coalesces bursts by the same actor into one undo entry", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" });
    for (let i = 0; i < 5; i++) {
      bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { i } }, { coalesceKey: "burst" });
    }
    expect(bus.canUndo()).toBe(true);
    // TWO steps total: the create, then the whole burst as ONE entry (F2).
    bus.undo(doc);
    expect(doc.nodes["n1"]?.props).toEqual({});
    expect(bus.undo(doc)).toBe(true);
    expect(doc.nodes["n1"]).toBeUndefined();
  });

  it("does NOT coalesce across different actors, even with the same key", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" });
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { i: 1 } }, { coalesceKey: "burst" });
    bus.invoke(
      "doc.updateNodeProps",
      doc,
      { id: "n1", props: { i: 2 } },
      { coalesceKey: "burst", actor: agent("other") },
    );
    let steps = 0;
    while (bus.undo(doc)) steps++;
    expect(steps).toBe(3); // create + human burst + agent burst (no cross-actor merge)
  });

  it("coalesces the tape record too: first undo, latest state (F2)", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" }); // separate irreversible step
    for (let i = 1; i <= 3; i++) {
      bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { i } }, { coalesceKey: "k" });
    }
    const burst = bus.tapeRecords().slice(1);
    expect(burst).toHaveLength(1);
    expect(burst[0]?.merged).toBe(true);
    expect(burst[0]?.docVersionAfter).toBe(4);
    expect(burst[0]?.redo).toHaveLength(3);
    // Undo returns to the state BEFORE the burst, not before its last command.
    bus.undo(doc);
    expect(doc.nodes["n1"]?.props).toEqual({});
  });

  it("declared coalesce (note.update style) merges within the window only", () => {
    vi.useFakeTimers();
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" });
    // registered strategy: same key within windowMs (default here = window 0 → custom)
    bus.invoke(
      "doc.updateNodeProps",
      doc,
      { id: "n1", props: { i: 1 } },
      { coalesceKey: "k", coalesceWindowMs: 10 },
    );
    vi.advanceTimersByTime(50);
    bus.invoke(
      "doc.updateNodeProps",
      doc,
      { id: "n1", props: { i: 2 } },
      { coalesceKey: "k", coalesceWindowMs: 10 },
    );
    let steps = 0;
    while (bus.undo(doc)) steps++;
    expect(steps).toBe(3); // create + first window burst + post-window burst
    vi.useRealTimers();
  });
});

describe("Core v2: transactions (N invokes → ONE undo entry / ONE tape record)", () => {
  it("wraps several invokes into a single history entry", () => {
    const { doc, bus } = setup();
    bus.transaction("build three nodes", human(), () => {
      for (let i = 0; i < 3; i++) {
        bus.invoke("doc.addNode", doc, { type: `t${i}` });
      }
    });
    expect(Object.keys(doc.nodes)).toHaveLength(3);
    let steps = 0;
    while (bus.undo(doc)) steps++;
    expect(steps).toBe(1); // one click back to empty
    expect(bus.redo(doc)).toBe(true);
    expect(Object.keys(doc.nodes)).toHaveLength(3);
    // docVersion: 3 invokes + 1 undo + 1 redo — every state change counts
    expect(doc.docVersion).toBe(5);
  });

  it("emits ONE tape record listing every command (provenance)", () => {
    const { doc, bus } = setup();
    bus.transaction("bulk add", human(), () => {
      bus.invoke("doc.addNode", doc, { type: "a" });
      bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { x: 1 } });
      bus.invoke("doc.addNode", doc, { type: "b" });
    });
    const record = bus.tapeRecords().at(-1) as TapeRecord;
    expect(record.command).toBe("doc.addNode");
    expect(record.commands).toEqual(["doc.addNode", "doc.updateNodeProps", "doc.addNode"]);
    expect(record.label).toBe("bulk add");
    expect(record.docVersionAfter).toBe(3);
    // replaying the forward patches rebuilds the same state
    expect(Object.keys(record.redo)).toHaveLength(3);
  });

  it("rolls the whole transaction back when fn throws (atomicity)", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "keep" });
    expect(() =>
      bus.transaction("doomed", human(), () => {
        bus.invoke("doc.addNode", doc, { type: "temp" });
        bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { x: 1 } });
        throw new Error("midway failure");
      }),
    ).toThrow("midway failure");
    expect(Object.keys(doc.nodes)).toEqual(["n1"]);
    expect(doc.nodes["n1"]?.props).toEqual({}); // the label edit is gone too
    expect(doc.docVersion).toBe(1); // back to the pre-transaction version
    expect(bus.canUndo()).toBe(true); // only the pre-tx command
    expect(bus.tapeRecords()).toHaveLength(1); // nothing recorded
  });

  it("a read-only transaction records nothing", () => {
    const { doc, bus } = setup();
    bus.transaction("inspect", human(), () => {
      bus.invoke("doc.stats", doc, {});
    });
    expect(bus.tapeRecords()).toHaveLength(0);
    expect(bus.canUndo()).toBe(false);
  });

  it("nested transactions fold into the outermost record", () => {
    const { doc, bus } = setup();
    bus.transaction("outer", human(), () => {
      bus.invoke("doc.addNode", doc, { type: "a" });
      bus.transaction("inner", human(), () => {
        bus.invoke("doc.addNode", doc, { type: "b" });
      });
    });
    expect(bus.tapeRecords()).toHaveLength(1);
    const record = bus.tapeRecords()[0] as TapeRecord;
    expect(record.commands).toEqual(["doc.addNode", "doc.addNode"]);
    let steps = 0;
    while (bus.undo(doc)) steps++;
    expect(steps).toBe(1);
    expect(Object.keys(doc.nodes)).toHaveLength(0);
  });

  it("undo/redo of a transaction returns to the exact pre/post states", () => {
    const { doc, bus } = setup();
    bus.transaction("mix", human(), () => {
      bus.invoke("doc.addNode", doc, { type: "x", props: { v: 1 } });
      bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { v: 2 } });
      bus.invoke("doc.removeNode", doc, { id: "n1" });
      bus.invoke("doc.addNode", doc, { type: "y" });
    });
    bus.undo(doc);
    expect(Object.keys(doc.nodes)).toHaveLength(0);
    expect(bus.redo(doc)).toBe(true);
    expect(Object.keys(doc.nodes)).toEqual(["n2"]); // x removed in-tx, y added
    expect(doc.nodes["n2"]?.type).toBe("y");
  });
});
