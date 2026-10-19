import { describe, expect, it } from "vitest";

import { createDocument, type DocumentState } from "@nucleus/core";
import { applyPersistedDoc, assetFileName, DocStore, defaultDataDir } from "../src/index.js";

describe("persist: crash-safe stores and migration helpers", () => {
  it("assetFileName is content-addressed + pdf-sniffed", () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const bytes = new TextEncoder().encode("whatever");
    expect(assetFileName(pdf)).toMatch(/^assets\/[0-9a-f]{32}\.pdf$/);
    expect(assetFileName(bytes)).toMatch(/^assets\/[0-9a-f]{32}\.bin$/);
    // same bytes → same name → dedup by construction
    expect(assetFileName(bytes)).toBe(assetFileName(new Uint8Array(bytes)));
  });

  it("defaultDataDir honours APPDATA and falls back to ~/.nucleus", () => {
    const saved = process.env.APPDATA;
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "C:\\Users\\test";
    process.env.APPDATA = "C:\\Users\\t\\AppData\\Roaming";
    expect(defaultDataDir()).toContain("Nucleus");
    delete process.env.APPDATA;
    expect(defaultDataDir()).toContain(home.replace(/\\/g, "\\").split("\\").pop() ?? "");
    if (saved) process.env.APPDATA = saved;
  });

  it("applyPersistedDoc keeps model invariants on a fresh doc", () => {
    const target = createDocument("nucleus.notes");
    const saved: DocumentState = {
      schemaVersion: 1,
      appId: "nucleus.pdf",
      docVersion: 9,
      selection: ["x"],
      nodes: {
        x: { id: "x", type: "page", parentId: null, order: 0, enabled: true, opacity: 1, props: {} },
      },
    };
    applyPersistedDoc(target, saved);
    expect(target.nodes["x"].type).toBe("page");
    expect(target.docVersion).toBe(9);
    expect(target.selection).toEqual(["x"]);
    // a hostile saved doc cannot crash the app
    applyPersistedDoc(target, { ...createDocument("kit"), selection: "oops", docVersion: NaN } as unknown as DocumentState);
    expect(target.selection).toEqual([]);
  });

  it("DocStore.for sanitizes hostile ids", () => {
    expect(DocStore.for("root", "..\\..\\evil", "..\\x").dir).not.toContain("..");
    expect(DocStore.for("root", "Nucleus:evil").dir).toMatch(/[A-Za-z0-9._-]+$/);
  });
});
