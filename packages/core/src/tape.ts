/**
 * The tape: a replayable, attributable timeline of every applied change.
 *
 * Core rule (F12 — commands use `randomUUID`/`Date.now`, so re-running them
 * would fork history): **replay applies the recorded patches**, never the
 * recorded commands. `command`/`params` on a record are provenance for the UI
 * and for agents, not replay inputs.
 */
import type { Actor, Patch } from "./command.js";
import type { DocumentState, Node } from "./document.js";
import { applyPatches } from "./command.js";
import { createDocument } from "./document.js";
import { canonical } from "./schema.js";

/** One applied change, appended once per invocation (or once per transaction). */
export interface TapeRecord {
  seq: number; // 1-based, monotonic inside a bus
  ts: string; // ISO-8601
  actor: Actor;
  label?: string;
  command: string; // first (or only) command; provenance, not replay input
  params?: unknown; // provenance
  docVersionAfter: number;
  /** Forward patches, in apply order. */
  redo: Patch[];
  /** Inverse patches (apply order), what undo of this record does. */
  undo: Patch[];
  /** Set when coalescing merged a burst into this record (F2). */
  merged?: boolean;
  /** For transactions: every command that ran inside (F14 bulk = one step). */
  commands?: string[];
}

/**
 * Where the tape is persisted. The bus always keeps the full in-memory tape;
 * a sink additionally receives records (the app-kit JSONL sink lands in M2).
 * `mergeLast` is optional: coalescing merges the *in-memory* entry, and a sink
 * eager enough to merge too (same target file) can implement it — otherwise
 * the burst simply persists as separate records, which stays honest.
 */
export interface TapeSink {
  append(rec: TapeRecord): void;
  flush?(): void;
  mergeLast?(rec: TapeRecord): void;
}

/**
 * Rebuild a document from scratch by applying the forward patches of `records`
 * in seq order. Works on an empty document because every `add`/`update` patch
 * carries the full node content — no snapshot needed for M1-sized tapes.
 */
export function replayTape(appId: string, records: readonly TapeRecord[]): DocumentState {
  return tapeStateAt(appId, records, Number.POSITIVE_INFINITY);
}

/**
 * The document as it looked right after the last record with `seq <= at`
 * (`at = 0` → the pristine document).
 */
export function tapeStateAt(
  appId: string,
  records: readonly TapeRecord[],
  at: number,
): DocumentState {
  const state = createDocument(appId);
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    if (record.seq > at) break;
    applyPatches(state, record.redo);
    state.docVersion = record.docVersionAfter;
  }
  return state;
}

/**
 * Minimal diff between two node tables: the patch list that turns `current`
 * into `target`. Used by `tape.restore` ("Restore here" appends a new record —
 * history is never rewritten) and by tests.
 */
export function diffNodes(
  current: Record<string, Node>,
  target: Record<string, Node>,
): Patch[] {
  const patches: Patch[] = [];
  for (const id of Object.keys(target)) {
    const t = target[id];
    const c = current[id];
    if (!c) {
      patches.push({ op: "add", nodeId: id, after: structuredClone(t) });
    } else if (canonical(c) !== canonical(t)) {
      patches.push({ op: "update", nodeId: id, after: structuredClone(t) });
    }
  }
  for (const id of Object.keys(current)) {
    if (!target[id]) patches.push({ op: "remove", nodeId: id });
  }
  return patches.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}
