import type { CommandBus } from "./command.js";
import type { Node } from "./document.js";
import { NucleusError } from "./errors.js";
import { diffNodes, tapeStateAt, type JsonSchema } from "./index.js";

export interface CoreCommandOptions {
  /** Injectable id factory (deterministic for tests). */
  createId?: () => string;
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `node-${counter.toString(36)}`;
}

const idParam: JsonSchema = { type: "string", description: "Target node id." };

/** Registers the baseline document commands every app inherits. */
export function registerCoreCommands(bus: CommandBus, options: CoreCommandOptions = {}): void {
  const createId = options.createId ?? defaultId;

  bus.register<{ type: string; parentId?: string | null; props?: Record<string, unknown> }, { id: string }>({
    name: "doc.addNode",
    title: "Add node",
    description: "Add a node to the document and return its id.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string", description: "Node type, e.g. \"note\", \"page\", \"layer\"." },
        parentId: { type: ["string", "null"], description: "Parent id; null (or omitted) = root." },
        props: { type: "object", description: "Initial properties (shallow object, JSON only)." },
      },
    },
    result: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "The new node id." } },
    },
    examples: [
      { params: { type: "note", props: { title: "Hello" } }, note: "creates a root node" },
    ],
    run(params, ctx) {
      const id = createId();
      const node: Node = {
        id,
        type: params.type,
        parentId: params.parentId ?? null,
        order: Object.keys(ctx.state.nodes).length,
        enabled: true,
        opacity: 1,
        props: params.props ?? {},
      };
      return { patches: [{ op: "add", nodeId: id, after: node }], result: { id } };
    },
  });

  bus.register<{ id: string; props: Record<string, unknown> }, { id: string }>({
    name: "doc.updateNodeProps",
    title: "Update node props",
    description: "Shallow-merge properties into an existing node.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id", "props"],
      properties: {
        id: idParam,
        props: { type: "object", description: "Properties to shallow-merge into the node." },
      },
    },
    result: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    run(params, ctx) {
      const node = ctx.state.nodes[params.id];
      if (!node) throw new NucleusError("not_found", `node not found: ${params.id}`);
      const after: Node = { ...node, props: { ...node.props, ...params.props } };
      return { patches: [{ op: "update", nodeId: params.id, after }], result: { id: params.id } };
    },
  });

  bus.register<{ id: string }, { id: string }>({
    name: "doc.removeNode",
    title: "Remove node",
    description: "Remove a node from the document.",
    sideEffects: "destructive",
    reversible: true,
    params: {
      type: "object",
      required: ["id"],
      properties: { id: idParam },
    },
    result: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    run(params, ctx) {
      if (!ctx.state.nodes[params.id]) {
        throw new NucleusError("not_found", `node not found: ${params.id}`);
      }
      return { patches: [{ op: "remove", nodeId: params.id }], result: { id: params.id } };
    },
  });

  bus.register<Record<string, never>, { nodes: number; docVersion: number }>({
    name: "doc.stats",
    title: "Document stats",
    description: "Read-only summary of the document.",
    sideEffects: "read",
    reversible: false,
    params: { type: "object", properties: {} },
    result: {
      type: "object",
      required: ["nodes", "docVersion"],
      properties: {
        nodes: { type: "integer", minimum: 0, description: "Node count." },
        docVersion: { type: "integer", minimum: 0, description: "Current document version." },
      },
    },
    run(_params, ctx) {
      return {
        result: { nodes: Object.keys(ctx.state.nodes).length, docVersion: ctx.state.docVersion },
      };
    },
  });

  bus.register<{ seq: number }, { seq: number; patches: number }>({
    name: "tape.restore",
    title: "Restore tape position",
    description:
      "Diff the live document against the replayed state at `seq` and apply it as ONE undoable " +
      "step (\"Restore here\"). History is never rewritten: this appends a new tape record.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["seq"],
      properties: {
        seq: { type: "integer", minimum: 0, description: "Tape position to restore (0 = start)." },
      },
    },
    result: {
      type: "object",
      required: ["seq", "patches"],
      properties: {
        seq: { type: "integer" },
        patches: { type: "integer", minimum: 0, description: "Applied patch count (0 = already there)." },
      },
    },
    run({ seq }, ctx) {
      const preview = tapeStateAt(ctx.state.appId, ctx.bus.tapeRecords(), seq);
      const patches = diffNodes(ctx.state.nodes, preview.nodes);
      return { patches, result: { seq, patches: patches.length } };
    },
  });
}
