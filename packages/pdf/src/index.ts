/**
 * @nucleus/pdf — the PDF Workbench command pack.
 *
 * A PDF is modelled as an ordered list of `page` nodes, each pointing at a
 * source PDF (asset) and a source page index, plus a rotation. All edits are
 * ordinary commands on the shared bus, so CLI / UI / MCP all drive the same
 * document.
 */
import {
  CommandBus,
  createDocument,
  NucleusError,
  type DocumentState,
  type JsonSchema,
  type Node,
  type Patch,
} from "@nucleus/core";
import { degrees, PDFDocument } from "pdf-lib";

export const PDF_APP_ID = "nucleus.pdf";
export const PAGE_TYPE = "page";

const pageIdParam: JsonSchema = { type: "string", description: "Page node id." };

export interface AssetStore {
  get(id: string): Uint8Array | undefined;
  has(id: string): boolean;
  put(id: string, bytes: Uint8Array): void;
  ids(): string[];
}

export class MemoryAssetStore implements AssetStore {
  readonly #items = new Map<string, Uint8Array>();

  get(id: string): Uint8Array | undefined {
    return this.#items.get(id);
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }

  put(id: string, bytes: Uint8Array): void {
    this.#items.set(id, bytes);
  }

  ids(): string[] {
    return [...this.#items.keys()];
  }
}

export interface PdfSession {
  assets: AssetStore;
  doc: DocumentState;
  bus: CommandBus;
}

export interface PageView {
  id: string;
  order: number;
  rotation: number;
  sourceId: string;
  sourcePage: number;
}

export function pageViews(state: DocumentState): PageView[] {
  return pageNodes(state).map((node) => ({
    id: node.id,
    order: node.order,
    rotation: prop<number>(node, "rotation") ?? 0,
    sourceId: prop<string>(node, "sourceId"),
    sourcePage: prop<number>(node, "sourcePage"),
  }));
}

function pageNodes(state: DocumentState): Node[] {
  return Object.values(state.nodes)
    .filter((node) => node.type === PAGE_TYPE)
    .sort((a, b) => a.order - b.order);
}

function prop<T>(node: Node, key: string): T {
  return node.props[key] as T;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `page-${seq.toString(36)}-${Date.now().toString(36)}`;
}

export function registerPdfCommands(bus: CommandBus, assets: AssetStore): void {
  bus.register<{ sourceId: string; pages: number[] }, { ids: string[] }>({
    name: "pdf.importPages",
    title: "Import pages",
    description: "Append pages from a loaded source PDF to the document.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["sourceId", "pages"],
      properties: {
        sourceId: { type: "string", description: "Id of a loaded source PDF asset." },
        pages: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          description: "0-based source page indices to append, in order (1-based grammar lands with §5.1).",
        },
      },
    },
    result: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: pageIdParam } },
    },
    run(params, ctx) {
      if (!assets.has(params.sourceId)) {
        throw new NucleusError("not_found", `source not found: ${params.sourceId}`);
      }
      const patches: Patch[] = [];
      const ids: string[] = [];
      let order = pageNodes(ctx.state).length;
      for (const sourcePage of params.pages) {
        const id = nextId();
        ids.push(id);
        const node: Node = {
          id,
          type: PAGE_TYPE,
          parentId: null,
          order: order++,
          enabled: true,
          opacity: 1,
          props: { sourceId: params.sourceId, sourcePage, rotation: 0 },
        };
        patches.push({ op: "add", nodeId: id, after: node });
      }
      return { patches, result: { ids } };
    },
  });

  bus.register<{ id: string; degrees: number }, { id: string; rotation: number }>({
    name: "pdf.rotatePage",
    title: "Rotate page",
    description: "Rotate a page by a relative number of degrees (clockwise).",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id", "degrees"],
      properties: {
        id: pageIdParam,
        degrees: { type: "number", minimum: -360, maximum: 360, description: "Relative clockwise rotation." },
      },
    },
    result: {
      type: "object",
      required: ["id", "rotation"],
      properties: { id: pageIdParam, rotation: { type: "integer", minimum: 0, maximum: 359 } },
    },
    run(params, ctx) {
      const node = ctx.state.nodes[params.id];
      if (!node) throw new NucleusError("not_found", `page not found: ${params.id}`);
      const current = (node.props.rotation as number) ?? 0;
      const rotation = (((current + params.degrees) % 360) + 360) % 360;
      const after: Node = { ...node, props: { ...node.props, rotation } };
      return { patches: [{ op: "update", nodeId: params.id, after }], result: { id: params.id, rotation } };
    },
  });

  bus.register<{ id: string; to: number }, { id: string; order: number }>({
    name: "pdf.movePage",
    title: "Move page",
    description: "Move a page to a new zero-based position in the document.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id", "to"],
      properties: { id: pageIdParam, to: { type: "integer", minimum: 0 } },
    },
    result: {
      type: "object",
      required: ["id", "order"],
      properties: { id: pageIdParam, order: { type: "integer", minimum: 0 } },
    },
    run(params, ctx) {
      const pages = pageNodes(ctx.state);
      const from = pages.findIndex((p) => p.id === params.id);
      if (from < 0) throw new NucleusError("not_found", `page not found: ${params.id}`);
      const target = Math.max(0, Math.min(params.to, pages.length - 1));
      const [moved] = pages.splice(from, 1);
      if (!moved) throw new NucleusError("internal", "movePage: missing node");
      pages.splice(target, 0, moved);
      const patches: Patch[] = [];
      pages.forEach((node, index) => {
        if (node.order !== index) {
          patches.push({ op: "update", nodeId: node.id, after: { ...node, order: index } });
        }
      });
      return { patches, result: { id: params.id, order: target } };
    },
  });

  bus.register<{ id: string }, { id: string }>({
    name: "pdf.removePage",
    title: "Remove page",
    description: "Remove a page and close the gap in page order.",
    sideEffects: "destructive",
    reversible: true,
    params: { type: "object", required: ["id"], properties: { id: pageIdParam } },
    result: { type: "object", required: ["id"], properties: { id: pageIdParam } },
    run(params, ctx) {
      if (!ctx.state.nodes[params.id]) throw new NucleusError("not_found", `page not found: ${params.id}`);
      const patches: Patch[] = [{ op: "remove", nodeId: params.id }];
      pageNodes(ctx.state)
        .filter((n) => n.id !== params.id)
        .forEach((node, index) => {
          if (node.order !== index) {
            patches.push({ op: "update", nodeId: node.id, after: { ...node, order: index } });
          }
        });
      return { patches, result: { id: params.id } };
    },
  });

  bus.register<Record<string, never>, { pages: number; rotation: number[] }>({
    name: "pdf.stats",
    title: "PDF stats",
    description: "Read-only summary of the current page list.",
    sideEffects: "read",
    reversible: false,
    params: { type: "object", properties: {} },
    result: {
      type: "object",
      required: ["pages", "rotation"],
      properties: {
        pages: { type: "integer", minimum: 0 },
        rotation: { type: "array", items: { type: "number" } },
      },
    },
    run(_params, ctx) {
      const pages = pageNodes(ctx.state);
      return {
        result: { pages: pages.length, rotation: pages.map((p) => prop<number>(p, "rotation") ?? 0) },
      };
    },
  });
}

/** Number of pages in a PDF byte buffer. */
export async function countPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

/** Render the current page list to a new PDF. */
export async function exportPdf(state: DocumentState, assets: AssetStore): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const cache = new Map<string, PDFDocument>();

  for (const node of pageNodes(state)) {
    const sourceId = prop<string>(node, "sourceId");
    const sourcePage = prop<number>(node, "sourcePage");
    const rotation = prop<number>(node, "rotation") ?? 0;

    let source = cache.get(sourceId);
    if (!source) {
      const bytes = assets.get(sourceId);
      if (!bytes) throw new NucleusError("not_found", `source not found: ${sourceId}`);
      source = await PDFDocument.load(bytes);
      cache.set(sourceId, source);
    }

    const copiedPages = await out.copyPages(source, [sourcePage]);
    const copied = copiedPages[0];
    if (!copied) throw new NucleusError("validation", `source page missing: ${sourcePage}`);
    copied.setRotation(degrees(rotation));
    out.addPage(copied);
  }

  return out.save();
}

/** Create a ready-to-use PDF session (document + bus + assets). */
export function createPdfSession(): PdfSession {
  const assets = new MemoryAssetStore();
  const doc = createDocument(PDF_APP_ID);
  const bus = new CommandBus({ kind: "system", id: PDF_APP_ID });
  registerPdfCommands(bus, assets);
  return { assets, doc, bus };
}
