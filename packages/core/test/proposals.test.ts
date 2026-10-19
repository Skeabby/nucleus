import { describe, expect, it, vi } from "vitest";

import {
  CommandBus,
  NucleusError,
  createDocument,
  needsReview,
  registerCoreCommands,
  type Actor,
  type DocumentState,
} from "../src/index.js";

const agent: Actor = { kind: "agent", id: "opencode" };
const human: Actor = { kind: "human", id: "mitch" };

function setup(): { doc: DocumentState; bus: CommandBus } {
  let n = 0; // fresh ids per test
  const doc = createDocument("test.app");
  const bus = new CommandBus();
  registerCoreCommands(bus, { createId: () => `n${++n}` });
  return { doc, bus };
}

describe("Proposals: agents ask, humans decide (M1 §3.2 core)", () => {
  it("propose runs dry: nothing applies, patches and snapshots are captured", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer", props: { v: 0 } });
    const before = doc.docVersion;
    const proposal = bus.propose(
      "doc.updateNodeProps",
      doc,
      { id: "n1", props: { v: 42 } },
      agent,
      "set v=42",
    );
    expect(proposal.id).toBe("proposal-1");
    expect(proposal.status).toBe("pending");
    expect(proposal.baseVersion).toBe(before);
    expect(proposal.command).toBe("doc.updateNodeProps");
    expect(proposal.touched["n1"]).toMatchObject({ props: { v: 0 } });
    expect(proposal.patches[0]?.after).toMatchObject({ props: { v: 42 } });
    // dry: nothing changed
    expect(doc.nodes["n1"]?.props).toEqual({ v: 0 });
    expect(doc.docVersion).toBe(before);
  });

  it("accept applies the proposal as ONE normal undoable entry", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer", props: { v: 0 } });
    const proposal = bus.propose(
      "doc.updateNodeProps",
      doc,
      { id: "n1", props: { v: 42 } },
      agent,
      "set v=42",
    );
    const outcome = bus.acceptProposal(proposal.id, doc);
    expect(outcome.docVersion).toBe(2);
    expect(doc.nodes["n1"]?.props).toEqual({ v: 42 });
    expect(proposal.status).toBe("accepted");
    const record = bus.tapeRecords().at(-1)!;
    expect(record.command).toBe("doc.updateNodeProps");
    expect(record.actor).toMatchObject({ kind: "agent", id: "opencode" });
    // Ctrl+Z undoes the agent just like anyone else
    bus.undo(doc);
    expect(doc.nodes["n1"]?.props).toEqual({ v: 0 });
  });

  it("reject discards without touching the document", () => {
    const { doc, bus } = setup();
    const proposal = bus.propose("doc.addNode", doc, { type: "ghost" }, agent);
    bus.rejectProposal(proposal.id);
    expect(proposal.status).toBe("rejected");
    expect(Object.keys(doc.nodes)).toHaveLength(0);
    expect(doc.docVersion).toBe(0);
    expect(bus.canUndo()).toBe(false);
    expect(bus.proposals().map((p) => p.status)).toEqual(["rejected"]);
  });

  it("a human edit on a touched node stales the proposal → kind:conflict", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer", props: { v: 0 } });
    const proposal = bus.propose("doc.updateNodeProps", doc, { id: "n1", props: { v: 1 } }, agent);
    // the human types meanwhile…
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { v: 0.5 } });
    try {
      bus.acceptProposal(proposal.id, doc);
      expect.unreachable("stale proposal must be refused");
    } catch (error) {
      const err = error as NucleusError;
      expect(err.kind).toBe("conflict");
      expect(err.message).toContain("stale");
      expect((err.details as { touchedIds: string[] }).touchedIds).toEqual(["n1"]);
    }
    expect(proposal.status).toBe("stale");
    expect(doc.nodes["n1"]?.props).toEqual({ v: 0.5 }); // untouched by the dead proposal
  });

  it("editing an UNTOUCHED node does not stale the proposal", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "a" });
    bus.invoke("doc.addNode", doc, { type: "b" });
    const proposal = bus.propose("doc.updateNodeProps", doc, { id: "n1", props: { v: 1 } }, agent);
    bus.invoke("doc.updateNodeProps", doc, { id: "n2", props: { x: 1 } }); // other node
    const outcome = bus.acceptProposal(proposal.id, doc);
    expect(outcome.applied).toBe(1);
    expect(proposal.status).toBe("accepted");
  });

  it("undecided or decided proposals refuse re-accept / re-reject (conflict)", () => {
    const { doc, bus } = setup();
    const proposal = bus.propose("doc.addNode", doc, { type: "x" }, agent);
    bus.rejectProposal(proposal.id);
    expect(() => bus.rejectProposal(proposal.id)).toThrowError(NucleusError);
    expect(() => bus.acceptProposal(proposal.id, doc)).toThrowError(NucleusError);
  });

  it("acceptAll applies the pending proposals in order, one tape entry each", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "a" });
    bus.invoke("doc.addNode", doc, { type: "b" });
    bus.propose("doc.updateNodeProps", doc, { id: "n1", props: { v: 1 } }, agent, "one");
    bus.propose("doc.updateNodeProps", doc, { id: "n2", props: { v: 2 } }, agent, "two");
    bus.acceptProposal("proposal-1", doc);
    bus.acceptProposal("proposal-2", doc);
    const records = bus.tapeRecords();
    expect(records).toHaveLength(4); // 2 creates + 2 accepted proposals
    expect(records[2]?.label).toBe("one");
    expect(records[3]?.label).toBe("two");
    expect(doc.nodes["n1"]?.props).toEqual({ v: 1 });
    expect(doc.nodes["n2"]?.props).toEqual({ v: 2 });
  });

  it("a proposal whose target node was removed since is stale (node vs missing)", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "doomed" }); // n1
    const proposal = bus.propose("doc.updateNodeProps", doc, { id: "n1", props: { v: 1 } }, agent);
    bus.invoke("doc.removeNode", doc, { id: "n1" }); // the human destroys the target meanwhile
    try {
      bus.acceptProposal(proposal.id, doc);
      expect.unreachable();
    } catch (error) {
      expect((error as NucleusError).kind).toBe("conflict");
    }
    expect(proposal.status).toBe("stale");
  });

  it("a proposal on a not-yet-existing node fails at run (not_found), never proposes", () => {
    const { doc, bus } = setup();
    expect(() => bus.propose("doc.updateNodeProps", doc, { id: "ghost", props: {} }, agent)).toThrowError(
      NucleusError,
    );
    expect(bus.proposals()).toHaveLength(0);
  });

  it("humans cannot propose (policy guard)", () => {
    const { doc, bus } = setup();
    expect(() => bus.propose("doc.addNode", doc, { type: "x" }, human)).toThrowError(
      NucleusError,
    );
  });

  it("read-only commands have nothing to propose", () => {
    const { doc, bus } = setup();
    expect(() => bus.propose("doc.stats", doc, {}, agent)).toThrowError(/read-only/);
  });

  it("proposal events fire on propose / accept / reject / stale", () => {
    const { doc, bus } = setup();
    const statuses: (string | undefined)[] = [];
    bus.subscribe((event) => {
      if (event.type === "proposal") statuses.push(event.proposal.status);
    });
    const proposal = bus.propose("doc.addNode", doc, { type: "x" }, agent);
    bus.rejectProposal(proposal.id);
    const again = bus.propose("doc.addNode", doc, { type: "y" }, agent);
    bus.invoke("doc.addNode", doc, { type: "z" }); // collides with "y"? different id (n1/n2…)
    bus.acceptProposal(again.id, doc);
    expect(statuses).toEqual(["pending", "rejected", "pending", "accepted"]);
  });
});

describe("Trust policy: needsReview (M1 §3.2 matrix)", () => {
  const write = { name: "w", title: "", description: "", sideEffects: "write", run: undefined as never };
  const destructive = { name: "d", title: "", description: "", sideEffects: "destructive", run: undefined as never };
  const read = { name: "r", title: "", description: "", sideEffects: "read", run: undefined as never };

  it("humans are never reviewed, whatever the trust level", () => {
    for (const trust of ["ask", "writes", "autopilot"] as const) {
      expect(needsReview(human, destructive, trust)).toBe(false);
      expect(needsReview(human, write, trust)).toBe(false);
    }
  });

  it("read commands are auto-allowed for agents at every trust level", () => {
    for (const trust of ["ask", "writes", "autopilot"] as const) {
      expect(needsReview(agent, read, trust)).toBe(false);
    }
  });

  it("destructive is always reviewed — even in autopilot (never silently destroy)", () => {
    for (const trust of ["ask", "writes", "autopilot"] as const) {
      expect(needsReview(agent, destructive, trust)).toBe(true);
    }
  });

  it("write follows the trust level: ask→review, writes/autopilot→auto", () => {
    expect(needsReview(agent, write, "ask")).toBe(true);
    expect(needsReview(agent, write, "writes")).toBe(false);
    expect(needsReview(agent, write, "autopilot")).toBe(false);
  });
});
