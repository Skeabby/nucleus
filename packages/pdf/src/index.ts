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
  sourceName: string | null;
  sourcePage: number;
}

export interface PdfSummary {
  pages: number;
  sources: Array<{ sourceId: string; pages: number }>;
  rotations: Array<{ degrees: number; pages: number }>;
  rotated: number;
}

export function pageViews(state: DocumentState): PageView[] {
  return pageNodes(state).map((node) => ({
    id: node.id,
    order: node.order,
    rotation: prop<number>(node, "rotation") ?? 0,
    sourceId: prop<string>(node, "sourceId"),
    sourceName: (prop<string | undefined>(node, "sourceName") ?? null) as string | null,
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

/** Patches that close the gaps after a reorder (only nodes that actually moved). */
function reindex(ordered: Node[]): Patch[] {
  const patches: Patch[] = [];
  ordered.forEach((node, index) => {
    if (node.order !== index) {
      patches.push({ op: "update", nodeId: node.id, after: { ...node, order: index } });
    }
  });
  return patches;
}

export function registerPdfCommands(bus: CommandBus, assets: AssetStore): void {
  bus.register<{ sourceId: string; pages: number[]; name?: string }, { ids: string[] }>({
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
        name: { type: "string", description: "Human name for the source (shown in the UI, kept in projects)." },
      },
    },
    result: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: pageIdParam } },
    },
    mcp: { expose: true, name: "pdf_import_pages" },
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
          props: {
            sourceId: params.sourceId,
            sourcePage,
            rotation: 0,
            ...(params.name !== undefined ? { sourceName: params.name } : {}),
          },
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
    // Destructive but reversible — the review policy still routes agents to a
    // proposal when the app runs in `ask` trust (§3.2).
    mcp: { expose: true, name: "pdf_remove_page" },
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

  // ── bulk edits: one command, one undo step ─────────────────────────────
  //
  // The UI used to loop over pages, which turned a 40-page rotate into 40 tape
  // records and 40 undo steps. These commands take the whole selection.

  bus.register<{ ids: string[]; degrees: number }, { ids: string[]; rotations: number[] }>({
    name: "pdf.rotatePages",
    title: "Rotate pages",
    description: "Rotate several pages by the same relative angle, in one step.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["ids", "degrees"],
      properties: {
        ids: { type: "array", items: pageIdParam, description: "Page node ids to rotate." },
        degrees: { type: "number", minimum: -360, maximum: 360, description: "Relative clockwise rotation." },
      },
    },
    result: {
      type: "object",
      required: ["ids", "rotations"],
      properties: {
        ids: { type: "array", items: pageIdParam },
        rotations: { type: "array", items: { type: "integer", minimum: 0, maximum: 359 } },
      },
    },
    run(params, ctx) {
      const rotations: number[] = [];
      const patches: Patch[] = [];
      for (const id of params.ids) {
        const node = ctx.state.nodes[id];
        if (!node || node.type !== PAGE_TYPE) throw new NucleusError("not_found", `page not found: ${id}`);
        const current = prop<number>(node, "rotation") ?? 0;
        const rotation = (((current + params.degrees) % 360) + 360) % 360;
        rotations.push(rotation);
        patches.push({ op: "update", nodeId: id, after: { ...node, props: { ...node.props, rotation } } });
      }
      return { patches, result: { ids: [...params.ids], rotations } };
    },
  });

  bus.register<{ ids: string[] }, { ids: string[]; removed: number }>({
    name: "pdf.removePages",
    title: "Remove pages",
    description: "Remove several pages and close the gaps in one step.",
    sideEffects: "destructive",
    reversible: true,
    params: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: pageIdParam, description: "Page node ids to remove." } },
    },
    result: {
      type: "object",
      required: ["ids", "removed"],
      properties: {
        ids: { type: "array", items: pageIdParam },
        removed: { type: "integer", minimum: 0 },
      },
    },
    run(params, ctx) {
      const doomed = new Set(params.ids);
      for (const id of doomed) {
        if (!ctx.state.nodes[id]) throw new NucleusError("not_found", `page not found: ${id}`);
      }
      const patches: Patch[] = params.ids.map((nodeId) => ({ op: "remove" as const, nodeId }));
      patches.push(...reindex(pageNodes(ctx.state).filter((node) => !doomed.has(node.id))));
      return { patches, result: { ids: [...params.ids], removed: params.ids.length } };
    },
  });

  bus.register<{ ids: string[] }, { ids: string[] }>({
    name: "pdf.duplicatePages",
    title: "Duplicate pages",
    description: "Copy pages right after their originals, keeping the selection's order.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: pageIdParam, description: "Page node ids to copy." } },
    },
    result: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: pageIdParam, description: "The new page ids." } },
    },
    run(params, ctx) {
      const wanted = new Set(params.ids);
      for (const id of wanted) {
        if (!ctx.state.nodes[id]) throw new NucleusError("not_found", `page not found: ${id}`);
      }
      const patches: Patch[] = [];
      const created: string[] = [];
      const order: Node[] = [];
      for (const node of pageNodes(ctx.state)) {
        order.push(node);
        if (!wanted.has(node.id)) continue;
        const id = nextId();
        created.push(id);
        order.push({
          id,
          type: PAGE_TYPE,
          parentId: null,
          order: 0,
          enabled: true,
          opacity: 1,
          props: { ...node.props },
        });
      }
      order.forEach((node, index) => {
        if (!ctx.state.nodes[node.id]) {
          patches.push({ op: "add", nodeId: node.id, after: { ...node, order: index } });
        } else if (ctx.state.nodes[node.id]!.order !== index) {
          patches.push({ op: "update", nodeId: node.id, after: { ...node, order: index } });
        }
      });
      return { patches, result: { ids: created } };
    },
  });

  bus.register<{ ids: string[]; to: number }, { ids: string[] }>({
    name: "pdf.movePages",
    title: "Move pages",
    description: "Move a selection of pages to a new position, preserving their order.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["ids", "to"],
      properties: {
        ids: { type: "array", items: pageIdParam, description: "Page node ids to move." },
        to: { type: "integer", minimum: 0, description: "Zero-based target position in the resulting list." },
      },
    },
    result: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: pageIdParam } },
    },
    run(params, ctx) {
      const wanted = new Set(params.ids);
      const all = pageNodes(ctx.state);
      for (const id of wanted) {
        if (!all.some((node) => node.id === id)) throw new NucleusError("not_found", `page not found: ${id}`);
      }
      const moving = all.filter((node) => wanted.has(node.id));
      const rest = all.filter((node) => !wanted.has(node.id));
      const target = Math.max(0, Math.min(params.to, rest.length));
      const result = [...rest.slice(0, target), ...moving, ...rest.slice(target)];
      return { patches: reindex(result), result: { ids: moving.map((node) => node.id) } };
    },
  });

  bus.register<Record<string, never>, { pages: number }>({
    name: "pdf.reverse",
    title: "Reverse document",
    description: "Reverse the page order (last page first).",
    sideEffects: "write",
    reversible: true,
    params: { type: "object", properties: {} },
    result: {
      type: "object",
      required: ["pages"],
      properties: { pages: { type: "integer", minimum: 0 } },
    },
    run(_params, ctx) {
      const reversed = [...pageNodes(ctx.state)].reverse();
      return { patches: reindex(reversed), result: { pages: reversed.length } };
    },
  });

  bus.register<{ id: string; sourceId: string; sourcePage: number; name?: string }, { id: string }>({
    name: "pdf.replacePage",
    title: "Replace page",
    description: "Point a page at a different source page, keeping its position and rotation.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id", "sourceId", "sourcePage"],
      properties: {
        id: pageIdParam,
        sourceId: { type: "string", description: "Loaded source PDF id." },
        sourcePage: { type: "integer", minimum: 0, description: "0-based page index in that source." },
        name: { type: "string", description: "Name to show for the new source (optional)." },
      },
    },
    result: { type: "object", required: ["id"], properties: { id: pageIdParam } },
    run(params, ctx) {
      const node = ctx.state.nodes[params.id];
      if (!node || node.type !== PAGE_TYPE) throw new NucleusError("not_found", `page not found: ${params.id}`);
      if (!assets.has(params.sourceId)) {
        throw new NucleusError("not_found", `source not found: ${params.sourceId}`);
      }
      return {
        patches: [{
          op: "update",
          nodeId: params.id,
          after: {
            ...node,
            props: {
              ...node.props,
              sourceId: params.sourceId,
              sourcePage: params.sourcePage,
              ...(params.name !== undefined ? { sourceName: params.name } : {}),
            },
          },
        }],
        result: { id: params.id },
      };
    },
  });

  bus.register<Record<string, never>, PdfSummary>({
    name: "pdf.summary",
    title: "Document summary",
    description: "Page count, per-source breakdown, rotation mix and portrait/landscape split.",
    sideEffects: "read",
    reversible: false,
    params: { type: "object", properties: {} },
    result: { type: "object" },
    run(_params, ctx) {
      const pages = pageNodes(ctx.state);
      const bySource = new Map<string, number>();
      const rotations = new Map<number, number>();
      for (const node of pages) {
        const sourceId = prop<string>(node, "sourceId");
        bySource.set(sourceId, (bySource.get(sourceId) ?? 0) + 1);
        const rotation = (((prop<number>(node, "rotation") ?? 0) % 360) + 360) % 360;
        rotations.set(rotation, (rotations.get(rotation) ?? 0) + 1);
      }
      return {
        result: {
          pages: pages.length,
          sources: [...bySource.entries()].map(([sourceId, count]) => ({ sourceId, pages: count })),
          rotations: [...rotations.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([degrees, count]) => ({ degrees, pages: count })),
          rotated: pages.filter((node) => (prop<number>(node, "rotation") ?? 0) !== 0).length,
        },
      };
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
    mcp: { expose: true, name: "pdf_stats" },
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

/** Render the current page list to a new PDF (optionally only some page ids). */
export async function exportPdf(
  state: DocumentState,
  assets: AssetStore,
  only?: Iterable<string>,
): Promise<Uint8Array> {
  const wanted = only ? new Set(only) : null;
  const out = await PDFDocument.create();
  const cache = new Map<string, PDFDocument>();

  for (const node of pageNodes(state)) {
    if (wanted && !wanted.has(node.id)) continue;
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
