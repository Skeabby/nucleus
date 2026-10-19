import { describe, expect, it } from "vitest";

import {
  CommandBus,
  NucleusError,
  createDocument,
  registerCoreCommands,
  tapeStateAt,
  replayTape,
  canonicalEqual,
  type Actor,
  type DocumentState,
  type TapeRecord,
} from "../src/index.js";

const agent: Actor = { kind: "agent", id: "opencode" };
const human: Actor = { kind: "human", id: "mitch" };

function setup(seed = 4): { doc: DocumentState; bus: CommandBus } {
  let n = 0; // fresh ids per test
  const doc = createDocument("test.app");
  const bus = new CommandBus();
  registerCoreCommands(bus, { createId: () => `n${++n}` });
  for (let i = 0; i < seed; i++) bus.invoke("doc.addNode", doc, { type: `t${i}`, props: { i } });
  return { doc, bus };
}

/**
 * A tiny deterministic PRNG so the property test explores the same space on
 * every run (no flakes, real coverage).
 */
function lcg(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

describe("The tape (M1 §3.1 core): records, replay, seek, restore, fork", () => {
  it("replay == live state after a long mixed history (property test, F12)", () => {
    const { doc, bus } = setup();
    const random = lcg(42);
    const picks = () => Object.keys(doc.nodes);
    for (let step = 0; step < 60; step++) {
      const ids = picks();
      const roll = random();
      if (roll < 0.35 || ids.length === 0) {
        bus.invoke("doc.addNode", doc, { type: `t${step}` });
      } else if (roll < 0.6) {
        const id = ids[Math.floor(random() * ids.length)] as string;
        bus.invoke("doc.updateNodeProps", doc, { id, props: { step } });
      } else if (roll < 0.85) {
        const id = ids[Math.floor(random() * ids.length)] as string;
        bus.invoke("doc.removeNode", doc, { id });
      } else {
        bus.invoke("doc.stats", doc, {});
      }
    }
    const replay = replayTape("test.app", bus.tapeRecords());
    expect(Object.keys(replay.nodes).sort()).toEqual(picks().sort());
    for (const [id, node] of Object.entries(replay.nodes)) {
      expect(canonicalEqual(node, doc.nodes[id])).toBe(true);
    }
    const last = bus.tapeRecords().at(-1) as TapeRecord;
    expect(replay.docVersion).toBe(last.docVersionAfter);
    expect(replay.appId).toBe("test.app");
  });

  it("replay applies recorded PATCHES, never re-runs commands (F12)", () => {
    const { doc, bus } = setup();
    // Random ids inside commands (as notes/pdf do) cannot be re-run twice.
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { tag: "v1" } });
    bus.invoke("doc.removeNode", doc, { id: "n2" });
    const records = bus.tapeRecords();
    // A fresh document + the same records yields the same state deterministically.
    const a = replayTape("test.app", records);
    const b = replayTape("test.app", records);
    expect(canonicalEqual(a.nodes, b.nodes)).toBe(true);
    expect(canonicalEqual(a.nodes, doc.nodes)).toBe(true);
  });

  it("tape.seek replays a PREFIX of the tape in seq order", () => {
    const { doc, bus } = setup(); // 4 nodes → 4 records
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { late: true } });
    const atThree = tapeStateAt("test.app", bus.tapeRecords(), 3);
    expect(Object.keys(atThree.nodes)).toHaveLength(3); // 3 records applied, the 4th node absent
    // the 5th record's late edit is absent too
    expect(atThree.nodes["n1"]?.props).toEqual({ i: 0 });
    const atAll = tapeStateAt("test.app", bus.tapeRecords(), 5);
    expect(atAll.nodes["n1"]?.props).toEqual({ i: 0, late: true });
    expect(atAll.docVersion).toBe(5);
  });

  it("seek at seq 0 gives the pristine document", () => {
    const { doc, bus } = setup();
    const pristine = tapeStateAt("test.app", bus.tapeRecords(), 0);
    expect(Object.keys(pristine.nodes)).toHaveLength(0);
    expect(pristine.docVersion).toBe(0);
    expect(doc.docVersion).toBeGreaterThan(0);
  });

  it('tape.restore diff-appends ONE record ("Restore here", never rewrites history)', () => {
    const { doc, bus } = setup();
    const before = bus.tapeRecords().length;
    bus.invoke("doc.removeNode", doc, { id: "n1" });
    bus.invoke("doc.updateNodeProps", doc, { id: "n2", props: { x: 1 } });
    // restore to where we were before those two commands
    bus.invoke(
      "tape.restore",
      doc,
      { seq: before },
      { actor: human, label: "back to good state" },
    );
    const record = bus.tapeRecords().at(-1) as TapeRecord;
    expect(record.command).toBe("tape.restore");
    expect(record.label).toBe("back to good state");
    // the two edits above are STILL in the tape (history preserved)
    expect(bus.tapeRecords().map((r) => r.command)).toContain("doc.removeNode");
    // live state is back: n1 present again, n2 without the late edit
    expect(doc.nodes["n1"]?.props).toEqual({ i: 0 });
    expect(doc.nodes["n2"]?.props).toEqual({ i: 1 });
    // and the restore itself is one undo step away
    bus.undo(doc);
    expect(doc.nodes["n1"]).toBeUndefined();
    expect(doc.nodes["n2"]?.props).toEqual({ i: 1, x: 1 });
  });

  it("importTape seeds the timeline across restarts (app-kit restore)", () => {
    const { doc, bus } = setup(0);
    bus.invoke("doc.addNode", doc, { type: "x" });
    bus.invoke("doc.removeNode", doc, { id: "n1" });
    const records = bus.tapeRecords();
    expect(records.map((r) => r.seq)).toEqual([1, 2]);
    // a "new" process: fresh bus, records replayed from persistence
    const fresh = new CommandBus();
    fresh.importTape(records);
    expect(fresh.tapeRecords().map((r) => r.seq)).toEqual([1, 2]);
    expect(fresh.tapeRecords().at(-1)?.command).toBe("doc.removeNode");
    // a re-import replaces, not appends
    fresh.importTape([]);
    expect(fresh.tapeRecords()).toHaveLength(0);
  });

  it("restoring to the last seq is a no-op", () => {
    const { doc, bus } = setup();
    const last = (bus.tapeRecords().at(-1) as TapeRecord).seq;
    const outcome = bus.invoke("tape.restore", doc, { seq: last });
    expect(outcome.result).toEqual({ seq: last, patches: 0 });
    expect(bus.tapeRecords()).toHaveLength(4); // nothing appended
    expect(doc.docVersion).toBe(4); // no new version either
  });

  it("fork returns a fresh document equal to the state at seq (same records, new doc)", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.removeNode", doc, { id: "n3" });
    const fork = replayTape("test.app", bus.tapeRecords().slice(0, 3)); // fork at seq 3
    expect(Object.keys(fork.nodes)).toHaveLength(3); // n1..n3, the 4th node not yet added
    expect(doc).not.toBe(fork);
    expect(doc.nodes["n3"]).toBeUndefined();
    expect(fork.nodes["n3"]).toBeDefined();
  });

  it("agents are refused on phantom CAS jumps (conflict details carry the ids)", () => {
    const { doc, bus } = setup();
    expect(() =>
      bus.invoke("doc.addNode", doc, { type: "x" }, { actor: agent, expectedDocVersion: 999 }),
    ).toThrowError(NucleusError);
    try {
      bus.invoke("doc.addNode", doc, { type: "x" }, { actor: agent, expectedDocVersion: 999 });
    } catch (error) {
      expect((error as NucleusError).kind).toBe("conflict");
    }
  });
});
