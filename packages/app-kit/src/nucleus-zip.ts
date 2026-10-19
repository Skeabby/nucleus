/**
 * `.nucleus` archive format (fflate ZIP, pre-approved dependency):
 *   document.json   {"format":"nucleus.doc","version":2,...}
 *   tape.jsonl      one TapeRecord per line
 *   assets/<sha256>.<ext>   content-addressed, deduped
 */
import { createHash } from "node:crypto";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { DocumentState, TapeRecord } from "@nucleus/core";
import { assetFileName } from "./persist.js";

export interface NucleusArchive {
  format: "nucleus.doc";
  version: 2;
  doc: DocumentState;
}

/** Assets must be keyed by their content-addressed file name (see `assetFileName`). */
export function buildNucleusZip(input: {
  doc: DocumentState;
  tape: readonly TapeRecord[];
  assets: Record<string, Uint8Array>;
}): Uint8Array {
  const manifest: NucleusArchive = { format: "nucleus.doc", version: 2, doc: input.doc };
  const files: Record<string, Uint8Array> = {
    "document.json": strToU8(JSON.stringify(manifest, null, 1)),
    "tape.jsonl": strToU8(input.tape.map((r) => JSON.stringify(r)).join("\n")),
  };
  for (const [name, bytes] of Object.entries(input.assets)) {
    files[name] = bytes;
  }
  return zipSync(files);
}

export function assetBytesWithNames(
  assets: Record<string, Uint8Array> | Map<string, Uint8Array>,
): Record<string, Uint8Array> {
  const named: Record<string, Uint8Array> = {};
  const entries = assets instanceof Map ? assets.entries() : Object.entries(assets);
  for (const [, bytes] of entries) {
    named[assetFileName(bytes)] = bytes; // same content → same name → deduped
  }
  return named;
}

export function readNucleusZip(bytes: Uint8Array): {
  manifest: NucleusArchive;
  tape: TapeRecord[];
  assets: Record<string, Uint8Array>;
} {
  const files = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8Safe(files["document.json"])) as NucleusArchive;
  if (manifest?.format !== "nucleus.doc") {
    throw new Error("not a nucleus archive (document.json format ≠ nucleus.doc)");
  }
  const tape: TapeRecord[] = [];
  for (const line of strFromU8Safe(files["tape.jsonl"]).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length !== 0) tape.push(JSON.parse(trimmed) as TapeRecord);
  }
  const assets: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    if (name.startsWith("assets/")) assets[name] = content;
  }
  return { manifest, tape, assets };
}

function strFromU8Safe(bytes?: Uint8Array): string {
  if (!bytes) throw new Error("archive member missing");
  return new TextDecoder().decode(bytes);
}

/** Same hash as `assetFileName` — exported for tests. */
export function contentHashPrefix(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}
