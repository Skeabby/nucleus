import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBus, createDocument, registerCoreCommands, NucleusError } from "../src/index.js";

function setup() {
  const doc = createDocument("test.app");
  const bus = new CommandBus({ kind: "agent", id: "opencode" });
  registerCoreCommands(bus, { createId: () => `n${Object.keys(doc.nodes).length + 1}` });
  return { doc, bus };
}

describe("@nucleus/core command bus", () => {
  it("registers and lists commands", () => {
    const { bus } = setup();
    expect(bus.list()).toEqual([
      "doc.addNode",
      "doc.removeNode",
      "doc.stats",
      "doc.updateNodeProps",
      "tape.restore",
    ]);
  });

  it("invokes a command, returns a structured result and bumps docVersion", () => {
    const { doc, bus } = setup();
    const res = bus.invoke<{ id: string }>("doc.addNode", doc, { type: "layer" });
    expect(res.result.id).toBe("n1");
    expect(res.applied).toBe(1);
    expect(doc.nodes["n1"]?.type).toBe("layer");
    expect(doc.docVersion).toBe(1);
  });

  it("undoes a reversible command", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" });
    expect(bus.canUndo()).toBe(true);
    expect(bus.undo(doc)).toBe(true);
    expect(Object.keys(doc.nodes)).toHaveLength(0);
  });

  it("throws a typed NucleusError for unknown commands", () => {
    const { doc, bus } = setup();
    try {
      bus.invoke("nope.nope", doc);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NucleusError);
      expect((error as NucleusError).kind).toBe("not_found");
    }
  });

  it("does not record history for read-only commands", () => {
    const { doc, bus } = setup();
    const res = bus.invoke<{ nodes: number }>("doc.stats", doc);
    expect(res.result.nodes).toBe(0);
    expect(bus.canUndo()).toBe(false);
    expect(doc.docVersion).toBe(0);
  });

  it("supports dry-run without mutating", () => {
    const { doc, bus } = setup();
    const res = bus.invoke("doc.addNode", doc, { type: "layer" }, { dryRun: true });
    expect(res.applied).toBe(1);
    expect(Object.keys(doc.nodes)).toHaveLength(0);
    expect(doc.docVersion).toBe(0);
  });

  it("updates node props by merging", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer", props: { fill: "red" } });
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { opacity: 0.5 } });
    expect(doc.nodes["n1"]?.props).toEqual({ fill: "red", opacity: 0.5 });
  });

  it("redoes an undone command", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" });
    bus.undo(doc);
    expect(Object.keys(doc.nodes)).toHaveLength(0);
    expect(bus.canRedo()).toBe(true);
    expect(bus.redo(doc)).toBe(true);
    expect(doc.nodes["n1"]?.type).toBe("layer");
    expect(bus.canRedo()).toBe(false);
  });

  it("clears the redo branch once a new edit lands", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer" });
    bus.undo(doc);
    expect(bus.canRedo()).toBe(true);
    bus.invoke("doc.addNode", doc, { type: "shape" });
    expect(bus.canRedo()).toBe(false);
  });

  it("returns false when there is nothing to undo or redo", () => {
    const { doc, bus } = setup();
    expect(bus.undo(doc)).toBe(false);
    expect(bus.redo(doc)).toBe(false);
  });

  it("coalesces a burst of edits sharing a key into one undo step (F2)", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer", props: { fill: "red" } });
    // A typing/save burst: three updates under the same coalesce key.
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { opacity: 0.2 } }, { coalesceKey: "note:n1" });
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { opacity: 0.5 } }, { coalesceKey: "note:n1" });
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { opacity: 0.9 } }, { coalesceKey: "note:n1" });
    expect(doc.nodes["n1"]?.props).toEqual({ fill: "red", opacity: 0.9 });

    // One undo returns to the state before the whole burst.
    expect(bus.undo(doc)).toBe(true);
    expect(doc.nodes["n1"]?.props).toEqual({ fill: "red" });
    // The add is still a separate step.
    expect(bus.undo(doc)).toBe(true);
    expect(Object.keys(doc.nodes)).toHaveLength(0);
  });

  it("does not coalesce edits with different keys", () => {
    const { doc, bus } = setup();
    bus.invoke("doc.addNode", doc, { type: "layer", props: { fill: "red" } });
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { opacity: 0.2 } }, { coalesceKey: "a" });
    bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { opacity: 0.5 } }, { coalesceKey: "b" });
    expect(bus.undo(doc)).toBe(true);
    expect(doc.nodes["n1"]?.props).toEqual({ fill: "red", opacity: 0.2 });
    expect(bus.undo(doc)).toBe(true);
    expect(doc.nodes["n1"]?.props).toEqual({ fill: "red" });
  });

  it("starts a new step once the coalescing window has elapsed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const { doc, bus } = setup();
      bus.invoke("doc.addNode", doc, { type: "layer", props: { fill: "red" } });
      bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { opacity: 0.2 } }, { coalesceKey: "k" });
      // A pause past the window starts a fresh undo step.
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      bus.invoke("doc.updateNodeProps", doc, { id: "n1", props: { opacity: 0.5 } }, { coalesceKey: "k" });
      expect(bus.undo(doc)).toBe(true);
      expect(doc.nodes["n1"]?.props).toEqual({ fill: "red", opacity: 0.2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces automatically when the command declares a strategy", () => {
    const { doc, bus } = setup();
    bus.register<{ id: string; n: number }, { id: string }>({
      name: "test.touch",
      title: "Touch",
      description: "test command",
      sideEffects: "write",
      coalesce: { key: (params) => params.id },
      run(params, ctx) {
        const node = ctx.state.nodes[params.id];
        const after = { ...node, props: { ...node.props, n: params.n } };
        return { patches: [{ op: "update", nodeId: params.id, after }], result: { id: params.id } };
      },
    });
    bus.invoke("doc.addNode", doc, { type: "layer", props: { fill: "red" } });
    bus.invoke("test.touch", doc, { id: "n1", n: 1 });
    bus.invoke("test.touch", doc, { id: "n1", n: 2 });
    // One undo returns to before the burst, with no caller-supplied key.
    expect(bus.undo(doc)).toBe(true);
    expect(doc.nodes["n1"]?.props).toEqual({ fill: "red" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
