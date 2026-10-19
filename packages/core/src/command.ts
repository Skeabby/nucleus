import type { DocumentState, Node } from "./document.js";
import { NucleusError } from "./errors.js";
import { canonicalEqual, validateJsonSchema, type JsonSchema } from "./schema.js";
import type { Proposal, TrustLevel } from "./proposals.js";
import { needsReview } from "./proposals.js";
import type { TapeRecord, TapeSink } from "./tape.js";

export type SideEffects = "read" | "write" | "destructive";

export interface Actor {
  kind: "human" | "agent" | "system";
  id: string;
  session?: string;
}

/** A reversible edit. Every mutation goes through patches. */
export interface Patch {
  op: "add" | "remove" | "update";
  nodeId: string;
  before?: Node;
  after?: Node;
}

export interface CommandContext {
  bus: CommandBus;
  actor: Actor;
  state: DocumentState;
}

export interface CommandOutcome<R> {
  patches?: Patch[];
  result: R;
}

/**
 * A self-describing command. Deliberately pure: it computes patches and a
 * result, but never mutates the document itself.
 *
 * Core v2 (brief §4.1) adds the agent surface: `params`/`result` JSON-Schema so
 * agents never guess parameters (F11), `examples`, an optional curated `mcp`
 * shortcut, and — like v1 — the `coalesce` burst strategy (F2).
 */
export interface CommandDescriptor<P = unknown, R = unknown> {
  name: string;
  title: string;
  description: string;
  sideEffects: SideEffects;
  reversible?: boolean;
  /** JSON-Schema validated BEFORE run(); exposed by `command.describe`. */
  params?: JsonSchema;
  /** What run() returns, for consumers that type-check agent replies. */
  result?: JsonSchema;
  examples?: { params: unknown; note?: string }[];
  /**
   * Declares that bursts of this command should share one undo entry. The key
   * is derived from the params (e.g. the edited node id) so consecutive edits to
   * the same target by the same actor coalesce without the caller doing
   * anything.
   */
  coalesce?: {
    key: (params: P, actor: Actor) => string | undefined;
    windowMs?: number;
  };
  /** Curated MCP shortcut (keep the total suite exposure ≤ 30, decision D5). */
  mcp?: { expose?: boolean; name?: string };
  run: (params: P, ctx: CommandContext) => CommandOutcome<R>;
}

export interface InvokeOptions {
  actor?: Actor;
  dryRun?: boolean;
  /**
   * Merge this command into the previous history entry when both share the key,
   * the same actor and land within the coalescing window (F2).
   */
  coalesceKey?: string;
  /** Window (ms) in which a shared `coalesceKey` merges. Default 800. */
  coalesceWindowMs?: number;
  /** Human-readable provenance, stored on the tape record. */
  label?: string;
  /**
   * Optimistic concurrency (CAS, D-protocol): refuse to invoke against a
   * version the caller has not seen. Mismatch → `NucleusError("conflict", …)`
   * with `{ expected, actual }` so agents re-read and re-plan.
   */
  expectedDocVersion?: number;
}

export interface InvokeResult<R = unknown> {
  result: R;
  applied: number;
  docVersion: number;
  /** Present on `dryRun` so callers (proposals, inspectors) can diff first. */
  patches?: Patch[];
}

/** The forward patch lists collected from the invokes inside one transaction. */
interface TxFrame {
  label: string;
  actor: Actor;
  /** The document state, captured from the first invoke inside the frame. */
  state: DocumentState | null;
  /** docVersion when the frame opened (restored on rollback). */
  docVersion: number;
  commands: string[];
  params?: unknown;
  redo: Patch[];
  inverses: Patch[][];
}

/** One undo/redo entry. `key`/`at`/actor drive coalescing of bursts (F2). */
interface HistoryEntry {
  patches: Patch[];
  key?: string;
  at: number;
  actor?: Actor;
  /**
   * Replayable forward patches (content-carrying), stored for transaction
   * entries whose merged inverse loses node content (delete-after-add chains).
   */
  reapply?: Patch[];
}

export type BusEvent =
  | { type: "command"; record: TapeRecord }
  | { type: "proposal"; proposal: Proposal }
  | { type: "undo"; label?: string }
  | { type: "redo"; label?: string };

/** Default window for coalescing a burst of edits into one undo step. */
const DEFAULT_COALESCE_WINDOW_MS = 800;

/**
 * Merge a later inverse onto an earlier one for coalescing. The earliest patch
 * per node wins, so undoing the merged entry restores the state from before the
 * *first* command in the burst.
 */
function mergeInverse(earlier: Patch[], later: Patch[]): Patch[] {
  const byNode = new Map<string, Patch>();
  for (const patch of later) byNode.set(patch.nodeId, patch);
  for (const patch of earlier) byNode.set(patch.nodeId, patch);
  return [...byNode.values()];
}

function sameActor(a: Actor | undefined, b: Actor): boolean {
  return a !== undefined && a.kind === b.kind && a.id === b.id;
}

export class CommandBus {
  readonly #handlers = new Map<string, CommandDescriptor<any, any>>();
  readonly #history: HistoryEntry[] = [];
  readonly #redo: HistoryEntry[] = [];
  readonly #tape: TapeRecord[] = [];
  readonly #proposals: Proposal[] = [];
  readonly #listeners = new Set<(event: BusEvent) => void>();
  readonly #txFrames: TxFrame[] = [];
  #defaultActor: Actor;
  #seq = 0;
  #proposalSeq = 0;
  #sink: TapeSink | null = null;

  constructor(defaultActor: Actor = { kind: "system", id: "core" }) {
    this.#defaultActor = defaultActor;
  }

  register<P, R>(descriptor: CommandDescriptor<P, R>): void {
    if (this.#handlers.has(descriptor.name)) {
      throw new NucleusError("internal", `duplicate command: ${descriptor.name}`);
    }
    this.#handlers.set(descriptor.name, descriptor as CommandDescriptor<any, any>);
  }

  has(name: string): boolean {
    return this.#handlers.has(name);
  }

  list(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  describe(name: string): CommandDescriptor<any, any> {
    const descriptor = this.#handlers.get(name);
    if (!descriptor) throw new NucleusError("not_found", `unknown command: ${name}`);
    return descriptor;
  }

  /** Watch every applied command / proposal / undo / redo. Returns unsubscriber. */
  subscribe(listener: (event: BusEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: BusEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A broken listener must never break the bus.
      }
    }
  }

  /** Attach an optional persistence sink (the app-kit JSONL sink, M2). */
  setTapeSink(sink: TapeSink | null): void {
    this.#sink = sink;
  }

  /** Ask the sink to flush, when one is attached. */
  flushTape(): void {
    this.#sink?.flush?.();
  }

  tapeRecords(): readonly TapeRecord[] {
    return this.#tape;
  }

  /**
   * Run one command. Validation → CAS → run → apply → history + tape + event.
   * Inside `transaction()` the frame absorbs the patches and the caller gets an
   * ordinary result; history/tape are touched once at commit.
   */
  invoke<R = unknown>(
    name: string,
    state: DocumentState,
    params: unknown = {},
    options: InvokeOptions = {},
  ): InvokeResult<R> {
    const descriptor = this.describe(name);
    const actor = options.actor ?? this.#defaultActor;

    if (options.expectedDocVersion !== undefined && state.docVersion !== options.expectedDocVersion) {
      throw new NucleusError(
        "conflict",
        `docVersion moved: expected ${options.expectedDocVersion}, actual ${state.docVersion}`,
        { command: name, expected: options.expectedDocVersion, actual: state.docVersion },
      );
    }
    if (descriptor.params) {
      const errors = validateJsonSchema(descriptor.params, params ?? {});
      if (errors.length > 0) {
        throw new NucleusError(
          "validation",
          `invalid params for ${name}: ${errors.join("; ")}`,
          errors,
        );
      }
    }

    const outcome = descriptor.run(params, { bus: this, actor, state });
    const patches = outcome.patches ?? [];
    if (options.dryRun) {
      return { result: outcome.result as R, applied: patches.length, docVersion: state.docVersion, patches };
    }
    if (patches.length === 0) {
      return { result: outcome.result as R, applied: 0, docVersion: state.docVersion };
    }

    const inverse = applyPatches(state, patches);
    state.docVersion += 1;

    const frame = this.#txFrames[this.#txFrames.length - 1];
    if (frame) {
      if (!frame.state) {
        frame.state = state;
        frame.docVersion = state.docVersion - 1; // before this first apply
      }
      frame.commands.push(name);
      if (frame.params === undefined) frame.params = structuredCloneOrJson(params);
      frame.redo.push(...patches);
      frame.inverses.push(inverse);
      return { result: outcome.result as R, applied: patches.length, docVersion: state.docVersion };
    }

    if (descriptor.reversible !== false) {
      const key = options.coalesceKey ?? descriptor.coalesce?.key?.(params as never, actor);
      const window =
        options.coalesceWindowMs ?? descriptor.coalesce?.windowMs ?? DEFAULT_COALESCE_WINDOW_MS;
      const mergedInverse = this.#pushHistory(inverse, actor, key, window);
      if (mergedInverse) {
        const record: TapeRecord = {
          seq: ++this.#seq,
          ts: new Date().toISOString(),
          actor: { ...actor },
          label: options.label,
          command: name,
          params: structuredCloneOrJson(params),
          docVersionAfter: state.docVersion,
          redo: patches,
          undo: inverse,
        };
        this.#mergeTapeLast(record, mergedInverse);
        return { result: outcome.result as R, applied: patches.length, docVersion: state.docVersion };
      }
    }
    // A fresh edit invalidates any redo branch.
    this.#redo.length = 0;

    const record: TapeRecord = {
      seq: ++this.#seq,
      ts: new Date().toISOString(),
      actor: { ...actor },
      label: options.label,
      command: name,
      params: structuredCloneOrJson(params),
      docVersionAfter: state.docVersion,
      redo: patches,
      undo: inverse,
    };
    this.#commitRecord(record);
    return { result: outcome.result as R, applied: patches.length, docVersion: state.docVersion };
  }

  /**
   * Group N invokes into ONE undo step and ONE tape record (F14 bulk).
   * `fn()` runs synchronously; a nested inner transaction just folds into the
   * outermost frame. Failure rolls *everything* back (patches and docVersion).
   */
  transaction<T>(label: string, actor: Actor, fn: () => T): T {
    const frame: TxFrame = {
      label,
      actor: { ...actor },
      state: null,
      docVersion: 0,
      commands: [],
      redo: [],
      inverses: [],
    };
    this.#txFrames.push(frame);
    try {
      const out = fn();
      this.#commitTx(frame);
      return out;
    } catch (error) {
      this.#rollbackTx(frame);
      throw error;
    } finally {
      if (this.#txFrames[this.#txFrames.length - 1] === frame) this.#txFrames.pop();
    }
  }

  #commitTx(frame: TxFrame): void {
    const parent = this.#txFrames[this.#txFrames.length - 2];
    if (parent) {
      // Inner frame folds into the outermost one.
      parent.commands.push(...frame.commands);
      parent.redo.push(...frame.redo);
      parent.inverses.push(...frame.inverses);
      if (parent.params === undefined) parent.params = frame.params;
      return;
    }
    if (frame.inverses.length === 0 || !frame.state) return; // read-only transaction
    const state = frame.state;
    let mergedUndo: Patch[] = [];
    for (const batch of frame.inverses) {
      mergedUndo = mergedUndo.length === 0 ? batch : mergeInverse(mergedUndo, batch);
    }
    this.#history.push({
      patches: mergedUndo,
      at: Date.now(),
      actor: frame.actor,
      // Replaying the forward patches needs node content the merged inverse
      // can lose (delete-after-add chains), so transactions carry their own.
      reapply: frame.redo,
    });
    this.#redo.length = 0;
    this.#commitRecord({
      seq: ++this.#seq,
      ts: new Date().toISOString(),
      actor: frame.actor,
      label: frame.label,
      command: frame.commands[0] ?? "transaction",
      commands: [...frame.commands],
      params: frame.params,
      docVersionAfter: state.docVersion,
      redo: frame.redo,
      undo: mergedUndo,
    });
  }

  #rollbackTx(frame: TxFrame): void {
    const state = frame.state;
    if (!state) return; // nothing invoked inside the frame
    for (const batch of [...frame.inverses].reverse()) {
      applyPatches(state, batch);
    }
    state.docVersion = frame.docVersion;
  }

  #pushHistory(patches: Patch[], actor: Actor, key: string | undefined, window: number): Patch[] | undefined {
    const now = Date.now();
    const last = this.#history[this.#history.length - 1];
    if (
      key !== undefined &&
      last !== undefined &&
      last.key === key &&
      sameActor(last.actor, actor) &&
      now - last.at <= window &&
      last.reapply === undefined // never merge into a transaction entry
    ) {
      const merged = mergeInverse(last.patches, patches);
      last.patches = merged;
      last.at = now;
      return merged;
    }
    this.#history.push({ patches, key, at: now, actor: { ...actor } });
    return undefined;
  }

  /** One applied change: in-memory tape + optional sink + event. */
  #commitRecord(record: TapeRecord): void {
    this.#tape.push(record);
    this.#sink?.append(record);
    this.#emit({ type: "command", record });
  }

  /** Coalescing (F2): the burst keeps ONE record — first undo, latest state. */
  #mergeTapeLast(record: TapeRecord, mergedInverse: Patch[]): void {
    const last = this.#tape[this.#tape.length - 1];
    if (!last || last.command !== record.command || !sameActor(last.actor, record.actor)) {
      this.#commitRecord(record);
      return;
    }
    last.redo = [...last.redo, ...record.redo];
    last.undo = mergedInverse;
    last.params = record.params;
    last.docVersionAfter = record.docVersionAfter;
    last.merged = true;
    if (this.#sink?.mergeLast) {
      this.#sink.mergeLast(last);
    } else if (this.#sink) {
      this.#sink.append(last);
    }
    this.#emit({ type: "command", record: last });
  }

  canUndo(): boolean {
    return this.#history.length > 0;
  }

  canRedo(): boolean {
    return this.#redo.length > 0;
  }

  undo(state: DocumentState): boolean {
    const entry = this.#history.pop();
    if (!entry) return false;
    // Applies the undo and returns the content-carrying redo for the stack.
    const redo = applyPatches(state, entry.patches);
    this.#redo.push({ patches: redo, at: Date.now(), actor: entry.actor, reapply: entry.reapply });
    state.docVersion += 1;
    this.#emit({ type: "undo", label: entry.key });
    return true;
  }

  redo(state: DocumentState): boolean {
    const entry = this.#redo.pop();
    if (!entry) return false;
    const inverse = entry.reapply ? applyPatches(state, entry.reapply) : applyPatches(state, entry.patches);
    this.#history.push({
      patches: inverse,
      at: Date.now(),
      actor: entry.actor,
      reapply: entry.reapply,
    });
    state.docVersion += 1;
    this.#emit({ type: "redo", label: entry.key });
    return true;
  }

  /**
   * Dry-run an agent command into a Proposal: patches + touched-node snapshots
   * + baseVersion. Nothing touches the doc; `accept` applies it as a normal,
   * undoable entry, `reject` discards it.
   */
  propose(
    name: string,
    state: DocumentState,
    params: unknown = {},
    actor: Actor = { kind: "agent", id: "agent" },
    label?: string,
  ): Proposal {
    const descriptor = this.describe(name);
    if (actor.kind !== "agent") {
      throw new NucleusError("validation", "only agent actors can propose");
    }
    if (descriptor.sideEffects === "read") {
      throw new NucleusError("validation", `${name} is read-only: nothing to propose`);
    }
    if (descriptor.params) {
      const errors = validateJsonSchema(descriptor.params, params ?? {});
      if (errors.length > 0) {
        throw new NucleusError(
          "validation",
          `invalid params for ${name}: ${errors.join("; ")}`,
          errors,
        );
      }
    }
    const outcome = descriptor.run(params, { bus: this, actor, state });
    const patches = outcome.patches ?? [];
    if (patches.length === 0) {
      throw new NucleusError("validation", `${name} produced no patches to propose`);
    }
    const touched: Record<string, Node | null> = {};
    for (const id of [...new Set(patches.map((patch) => patch.nodeId))]) {
      const current = state.nodes[id];
      touched[id] = current ? (structuredClone(current) as Node) : null;
    }
    const proposal: Proposal = {
      id: `proposal-${++this.#proposalSeq}`,
      ts: new Date().toISOString(),
      actor: { ...actor },
      label,
      command: name,
      params: structuredCloneOrJson(params),
      patches,
      result: outcome.result,
      baseVersion: state.docVersion,
      touched,
      status: "pending",
    };
    this.#proposals.push(proposal);
    this.#emit({ type: "proposal", proposal });
    return proposal;
  }

  /** Apply a pending proposal. Stale → status `stale` + `kind: "conflict"`. */
  acceptProposal(id: string, state: DocumentState): InvokeResult<unknown> {
    const proposal = this.#proposal(id);
    if (proposal.status !== "pending") {
      throw new NucleusError("conflict", `proposal ${id} already ${proposal.status}`);
    }
    const mismatches: { nodeId: string }[] = [];
    for (const [nodeId, snapshot] of Object.entries(proposal.touched)) {
      if (!canonicalEqual(state.nodes[nodeId] ?? null, snapshot)) {
        mismatches.push({ nodeId });
      }
    }
    if (mismatches.length > 0) {
      proposal.status = "stale";
      this.#emit({ type: "proposal", proposal });
      throw new NucleusError(
        "conflict",
        `proposal ${id} is stale: ${mismatches.length} touched node(s) changed since proposal`,
        { proposalId: id, touchedIds: mismatches.map((m) => m.nodeId) },
      );
    }
    const inverse = applyPatches(state, proposal.patches);
    state.docVersion += 1;
    this.#pushHistory(inverse, proposal.actor, undefined, DEFAULT_COALESCE_WINDOW_MS);
    this.#redo.length = 0;
    this.#commitRecord({
      seq: ++this.#seq,
      ts: new Date().toISOString(),
      actor: { ...proposal.actor },
      label: proposal.label,
      command: proposal.command,
      params: proposal.params,
      docVersionAfter: state.docVersion,
      redo: [...proposal.patches],
      undo: inverse,
    });
    proposal.status = "accepted";
    this.#emit({ type: "proposal", proposal });
    return { result: proposal.result, applied: proposal.patches.length, docVersion: state.docVersion };
  }

  rejectProposal(id: string): void {
    const proposal = this.#proposal(id);
    if (proposal.status !== "pending") {
      throw new NucleusError("conflict", `proposal ${id} already ${proposal.status}`);
    }
    proposal.status = "rejected";
    this.#emit({ type: "proposal", proposal });
  }

  proposals(): readonly Proposal[] {
    return this.#proposals;
  }

  /** Trust-policy convenience: would this invocation need human review? */
  needsReview(actor: Actor, name: string, trust: TrustLevel): boolean {
    return needsReview(actor, this.describe(name), trust);
  }

  #proposal(id: string): Proposal {
    const proposal = this.#proposals.find((candidate) => candidate.id === id);
    if (!proposal) throw new NucleusError("not_found", `unknown proposal: ${id}`);
    return proposal;
  }
}

function structuredCloneOrJson(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  }
}

/**
 * Applies patches in place and returns the inverse patches (for undo).
 * The inverse list is reversed so it can be replayed directly to restore state.
 */
export function applyPatches(state: DocumentState, patches: Patch[]): Patch[] {
  const inverse: Patch[] = [];

  for (const patch of patches) {
    const before = state.nodes[patch.nodeId];

    if (patch.op === "remove") {
      if (before) {
        delete state.nodes[patch.nodeId];
        inverse.push({ op: "add", nodeId: patch.nodeId, after: before });
      }
      continue;
    }

    const after = patch.after ?? before;
    if (!after) continue;
    state.nodes[patch.nodeId] = after;
    inverse.push(
      before
        ? { op: "update", nodeId: patch.nodeId, after: before }
        : { op: "remove", nodeId: patch.nodeId },
    );
  }

  return inverse.reverse();
}
