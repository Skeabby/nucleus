import { NucleusError } from "@nucleus/core";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  countPages,
  createPdfSession,
  exportPdf,
  MemoryAssetStore,
} from "../src/index.js";

describe("@nucleus/pdf M1: every command is self-describing", () => {
  it("exposes params + result schemas for every pdf.* command (F11 acceptance)", () => {
    const { bus } = createPdfSession();
    for (const name of ["pdf.importPages", "pdf.rotatePage", "pdf.movePage", "pdf.removePage", "pdf.stats"]) {
      const descriptor = bus.describe(name);
      expect(descriptor.params, `${name} has a params schema`).toBeDefined();
      expect(descriptor.result, `${name} has a result schema`).toBeDefined();
    }
    expect(bus.describe("pdf.rotatePage").params?.properties.degrees.maximum).toBe(360);
  });

  it("rejects out-of-range rotation degrees through validation (F11)", () => {
    const { bus, doc } = createPdfSession();
    expect(() => bus.invoke("pdf.rotatePage", doc, { id: "x", degrees: 720 })).toThrowError(
      NucleusError,
    );
    try {
      bus.invoke("pdf.rotatePage", doc, { id: "x", degrees: 720 });
    } catch (error) {
      expect((error as NucleusError).kind).toBe("validation");
    }
  });
});

/** Build an N-page blank PDF fixture. */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200 + i, 200 + i]);
  return doc.save();
}

async function setupWithSource(pages: number) {
  const session = createPdfSession();
  const bytes = await makePdf(pages);
  session.assets.put("src-a", bytes);
  return session;
}

describe("@nucleus/pdf command pack", () => {
  it("imports pages from a source", async () => {
    const { bus, doc } = await setupWithSource(4);
    const res = bus.invoke<{ ids: string[] }>("pdf.importPages", doc, { sourceId: "src-a", pages: [0, 1, 2, 3] });
    expect(res.result.ids).toHaveLength(4);
    expect((bus.invoke<{ pages: number }>("pdf.stats", doc)).result.pages).toBe(4);
  });

  it("rotates a page (relative, wraps 360)", async () => {
    const { bus, doc } = await setupWithSource(1);
    const { result } = bus.invoke<{ ids: string[] }>("pdf.importPages", doc, { sourceId: "src-a", pages: [0] });
    const id = result.ids[0]!;
    bus.invoke("pdf.rotatePage", doc, { id, degrees: 90 });
    bus.invoke("pdf.rotatePage", doc, { id, degrees: 270 });
    expect((bus.invoke<{ rotation: number[] }>("pdf.stats", doc)).result.rotation).toEqual([0]);
  });

  it("moves a page and keeps order dense", async () => {
    const { bus, doc } = await setupWithSource(3);
    const { result } = bus.invoke<{ ids: string[] }>("pdf.importPages", doc, { sourceId: "src-a", pages: [0, 1, 2] });
    const [a, b, c] = result.ids;
    bus.invoke("pdf.movePage", doc, { id: c!, to: 0 });
    const { ids } = await exportOrder(bus, doc);
    expect(ids).toEqual([c, a, b]);
  });

  it("removes a page and closes the gap", async () => {
    const { bus, doc } = await setupWithSource(3);
    const { result } = bus.invoke<{ ids: string[] }>("pdf.importPages", doc, { sourceId: "src-a", pages: [0, 1, 2] });
    bus.invoke("pdf.removePage", doc, { id: result.ids[1]! });
    expect((bus.invoke<{ pages: number }>("pdf.stats", doc)).result.pages).toBe(2);
  });

  it("undo restores a removed page", async () => {
    const { bus, doc } = await setupWithSource(2);
    const { result } = bus.invoke<{ ids: string[] }>("pdf.importPages", doc, { sourceId: "src-a", pages: [0, 1] });
    bus.invoke("pdf.removePage", doc, { id: result.ids[0]! });
    bus.undo(doc);
    expect((bus.invoke<{ pages: number }>("pdf.stats", doc)).result.pages).toBe(2);
  });

  it("exports a valid PDF whose page count matches", async () => {
    const { bus, doc, assets } = await setupWithSource(3);
    bus.invoke("pdf.importPages", doc, { sourceId: "src-a", pages: [0, 1, 2] });
    const bytes = await exportPdf(doc, assets);
    expect(await countPages(bytes)).toBe(3);
    // and it should be a real PDF
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });

  it("counts pages of a raw buffer", async () => {
    const bytes = await makePdf(5);
    expect(await countPages(bytes)).toBe(5);
  });
});

/** Helper: read order of page ids by their `order` prop. */
async function exportOrder(bus: CommandBus, doc: ReturnType<typeof createDocument>) {
  const pages = Object.values(doc.nodes)
    .filter((n) => n.type === "page")
    .sort((a, b) => a.order - b.order);
  return { ids: pages.map((p) => p.id) };
}
