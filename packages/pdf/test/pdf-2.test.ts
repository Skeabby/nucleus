import { NucleusError } from "@nucleus/core";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { countPages, createPdfSession, exportPdf, pageViews, type PdfSession } from "../src/index.js";

/** Build an N-page blank PDF fixture (page i is `200+i` points wide). */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200 + i, 400]);
  return doc.save();
}

async function sessionWith(pages: number, sourceId = "src-a") {
  const session = createPdfSession();
  session.assets.put(sourceId, await makePdf(pages));
  return session;
}

/** Import a whole source and hand back the page ids in document order. */
function importAll(session: PdfSession, sourceId = "src-a", pages = 3): string[] {
  const { bus, doc } = session;
  const indices = Array.from({ length: pages }, (_, index) => index);
  return bus.invoke<{ ids: string[] }>("pdf.importPages", doc, { sourceId, pages: indices }).result.ids;
}

function orderOf(session: PdfSession): string[] {
  return Object.values(session.doc.nodes)
    .filter((node) => node.type === "page")
    .sort((a, b) => a.order - b.order)
    .map((node) => node.id);
}

function orders(session: PdfSession): number[] {
  return Object.values(session.doc.nodes)
    .filter((node) => node.type === "page")
    .sort((a, b) => a.order - b.order)
    .map((node) => node.order);
}

describe("@nucleus/pdf 2.0: bulk edits are one step", () => {
  it("rotates a whole selection in one tape record, and one undo reverts it", async () => {
    const session = await sessionWith(3);
    const ids = importAll(session);
    const before = session.bus.tapeRecords().length;

    const { result } = session.bus.invoke<{ ids: string[]; rotations: number[] }>("pdf.rotatePages", session.doc, {
      ids,
      degrees: 90,
    });
    expect(result.rotations).toEqual([90, 90, 90]);
    expect(session.bus.tapeRecords().length - before).toBe(1);

    session.bus.undo(session.doc);
    const stats = session.bus.invoke<{ rotation: number[] }>("pdf.stats", session.doc).result;
    expect(stats.rotation).toEqual([0, 0, 0]);
  });

  it("wraps negative and over-360 rotations", async () => {
    const session = await sessionWith(1);
    const [id] = importAll(session, "src-a", 1);
    session.bus.invoke("pdf.rotatePages", session.doc, { ids: [id], degrees: -90 });
    session.bus.invoke("pdf.rotatePages", session.doc, { ids: [id], degrees: -270 });
    expect(session.bus.invoke<{ rotation: number[] }>("pdf.stats", session.doc).result.rotation).toEqual([0]);
  });

  it("removes several pages and closes every gap", async () => {
    const session = await sessionWith(5);
    const ids = importAll(session, "src-a", 5);
    const removed = session.bus.invoke<{ removed: number }>("pdf.removePages", session.doc, {
      ids: [ids[1]!, ids[3]!],
    }).result;
    expect(removed.removed).toBe(2);
    expect(orderOf(session)).toEqual([ids[0], ids[2], ids[4]]);
    expect(orders(session)).toEqual([0, 1, 2]);

    session.bus.undo(session.doc);
    expect(orderOf(session)).toEqual(ids);
    expect(orders(session)).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses to remove an unknown page", async () => {
    const session = await sessionWith(1);
    importAll(session, "src-a", 1);
    expect(() => session.bus.invoke("pdf.removePages", session.doc, { ids: ["page-nope"] })).toThrowError(NucleusError);
  });
});

describe("@nucleus/pdf 2.0: composing the document", () => {
  it("duplicates pages right after their originals", async () => {
    const session = await sessionWith(3);
    const ids = importAll(session);
    const { result } = session.bus.invoke<{ ids: string[] }>("pdf.duplicatePages", session.doc, {
      ids: [ids[1]!],
    });
    expect(result.ids).toHaveLength(1);
    expect(orderOf(session)).toEqual([ids[0], ids[1], result.ids[0], ids[2]]);
    expect(orders(session)).toEqual([0, 1, 2, 3]);

    const copies = Object.values(session.doc.nodes).filter((node) => node.id === result.ids[0]);
    expect(copies[0]?.props.sourcePage).toBe(1);
    expect(copies[0]?.props.sourceId).toBe("src-a");
  });

  it("moves a multi-page selection without reordering it", async () => {
    const session = await sessionWith(4);
    const ids = importAll(session, "src-a", 4);
    session.bus.invoke("pdf.movePages", session.doc, { ids: [ids[0]!, ids[1]!], to: 2 });
    expect(orderOf(session)).toEqual([ids[2], ids[3], ids[0], ids[1]]);
    expect(orders(session)).toEqual([0, 1, 2, 3]);

    session.bus.invoke("pdf.movePages", session.doc, { ids: [ids[3]!], to: 0 });
    expect(orderOf(session)).toEqual([ids[3], ids[2], ids[0], ids[1]]);
  });

  it("clamps a move target past the end", async () => {
    const session = await sessionWith(3);
    const ids = importAll(session);
    session.bus.invoke("pdf.movePages", session.doc, { ids: [ids[0]!], to: 99 });
    expect(orderOf(session)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("reverses the document, and undo puts it back", async () => {
    const session = await sessionWith(3);
    const ids = importAll(session);
    session.bus.invoke("pdf.reverse", session.doc, {});
    expect(orderOf(session)).toEqual([...ids].reverse());
    session.bus.undo(session.doc);
    expect(orderOf(session)).toEqual(ids);
  });

  it("replaces a page's source page, keeping position and rotation", async () => {
    const session = await sessionWith(2, "src-a");
    session.assets.put("src-b", await makePdf(3));
    const ids = importAll(session, "src-a", 2);
    session.bus.invoke("pdf.rotatePage", session.doc, { id: ids[0]!, degrees: 90 });

    session.bus.invoke("pdf.replacePage", session.doc, { id: ids[0]!, sourceId: "src-b", sourcePage: 2 });
    const page = session.doc.nodes[ids[0]!];
    expect(page?.props.sourceId).toBe("src-b");
    expect(page?.props.sourcePage).toBe(2);
    expect(page?.props.rotation).toBe(90);
    expect(orderOf(session)).toEqual(ids);

    expect(() =>
      session.bus.invoke("pdf.replacePage", session.doc, { id: ids[0]!, sourceId: "src-missing", sourcePage: 0 }),
    ).toThrowError(NucleusError);
  });
});

describe("@nucleus/pdf 2.0: summary and export ranges", () => {
  it("summarises sources and the rotation mix", async () => {
    const session = await sessionWith(2, "src-a");
    session.assets.put("src-b", await makePdf(2));
    const a = importAll(session, "src-a", 2);
    const b = importAll(session, "src-b", 2);
    session.bus.invoke("pdf.rotatePages", session.doc, { ids: [a[0]!, b[0]!], degrees: 90 });

    const summary = session.bus.invoke<{
      pages: number;
      sources: Array<{ sourceId: string; pages: number }>;
      rotations: Array<{ degrees: number; pages: number }>;
      rotated: number;
    }>("pdf.summary", session.doc).result;

    expect(summary.pages).toBe(4);
    expect(summary.sources).toEqual([
      { sourceId: "src-a", pages: 2 },
      { sourceId: "src-b", pages: 2 },
    ]);
    expect(summary.rotations).toEqual([
      { degrees: 0, pages: 2 },
      { degrees: 90, pages: 2 },
    ]);
    expect(summary.rotated).toBe(2);
  });

  it("exports only the requested page ids", async () => {
    const session = await sessionWith(4);
    const ids = importAll(session, "src-a", 4);
    const bytes = await exportPdf(session.doc, session.assets, [ids[0]!, ids[3]!]);
    expect(await countPages(bytes)).toBe(2);
  });

  it("keeps the source name for the UI and for projects", async () => {
    const session = await sessionWith(2);
    const { bus, doc } = session;
    bus.invoke("pdf.importPages", doc, { sourceId: "src-a", pages: [0, 1], name: "Annual report.pdf" });
    const views = pageViews(doc);
    expect(views.map((page) => page.sourceName)).toEqual(["Annual report.pdf", "Annual report.pdf"]);

    // replacing with a named source updates the label, not just the bytes
    session.assets.put("src-b", await makePdf(1));
    bus.invoke("pdf.replacePage", doc, {
      id: views[0]!.id,
      sourceId: "src-b",
      sourcePage: 0,
      name: "Contract.pdf",
    });
    expect(pageViews(doc)[0]?.sourceName).toBe("Contract.pdf");
  });

  it("every pdf.* command ships params and result schemas (F11)", () => {
    const { bus } = createPdfSession();
    const names = [
      "pdf.importPages",
      "pdf.rotatePage",
      "pdf.rotatePages",
      "pdf.movePage",
      "pdf.movePages",
      "pdf.removePage",
      "pdf.removePages",
      "pdf.duplicatePages",
      "pdf.reverse",
      "pdf.replacePage",
      "pdf.summary",
      "pdf.stats",
    ];
    for (const name of names) {
      const descriptor = bus.describe(name);
      expect(descriptor.params, `${name} params`).toBeDefined();
      expect(descriptor.result, `${name} result`).toBeDefined();
    }
  });
});
