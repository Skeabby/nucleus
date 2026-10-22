/**
 * @nucleus/image — the Image Editor command pack.
 *
 * The document is a single `image` node holding a *non-destructive* edit stack:
 * a crop, a quarter-turn rotation, two flips, a named filter and a set of
 * adjustments. Nothing is ever resampled here — the pixels stay in the asset
 * store and the app renders the stack on a canvas, so every slider move is one
 * cheap, reversible command instead of a rewrite of the bytes.
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

export const IMAGE_APP_ID = "nucleus.image";
export const IMAGE_TYPE = "image";

export type ImageFilter = "none" | "grayscale" | "sepia" | "invert" | "warm" | "cool";
export const IMAGE_FILTERS: ImageFilter[] = ["none", "grayscale", "sepia", "invert", "warm", "cool"];

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Adjustments {
  /** -100..100, 0 is untouched. */
  brightness: number;
  /** -100..100. */
  contrast: number;
  /** -100..100, -100 is fully desaturated. */
  saturation: number;
  /** -180..180 degrees of hue rotation. */
  hue: number;
  /** -100..100: negative cools the image, positive warms it. */
  temperature: number;
  /** 0..50 pixels of gaussian blur. */
  blur: number;
  /** 0..100 corner darkening. */
  vignette: number;
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  temperature: 0,
  blur: 0,
  vignette: 0,
};

const ADJUSTMENT_RANGES: Record<keyof Adjustments, { min: number; max: number }> = {
  brightness: { min: -100, max: 100 },
  contrast: { min: -100, max: 100 },
  saturation: { min: -100, max: 100 },
  hue: { min: -180, max: 180 },
  temperature: { min: -100, max: 100 },
  blur: { min: 0, max: 50 },
  vignette: { min: 0, max: 100 },
};

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

export interface ImageView {
  id: string;
  sourceId: string;
  name: string;
  mime: string;
  naturalWidth: number;
  naturalHeight: number;
  crop: Crop | null;
  rotation: 0 | 90 | 180 | 270;
  flipX: boolean;
  flipY: boolean;
  filter: ImageFilter;
  adjustments: Adjustments;
  resize: Size | null;
  /** Final output size after crop, rotation and an explicit resize. */
  width: number;
  height: number;
  /** Human-readable list of what is currently applied. */
  edits: string[];
}

export interface ImageSession {
  assets: AssetStore;
  doc: DocumentState;
  bus: CommandBus;
}

const cropSchema: JsonSchema = {
  type: "object",
  required: ["x", "y", "width", "height"],
  properties: {
    x: { type: "integer", minimum: 0, description: "Left edge in source pixels." },
    y: { type: "integer", minimum: 0, description: "Top edge in source pixels." },
    width: { type: "integer", minimum: 1, description: "Crop width in source pixels." },
    height: { type: "integer", minimum: 1, description: "Crop height in source pixels." },
  },
};

const sizeSchema: JsonSchema = {
  type: "object",
  required: ["width", "height"],
  properties: {
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
  },
};

const adjustmentsSchema: JsonSchema = {
  type: "object",
  properties: Object.fromEntries(
    Object.entries(ADJUSTMENT_RANGES).map(([key, range]) => [
      key,
      {
        type: "number",
        minimum: range.min,
        maximum: range.max,
        description: `${key} (${range.min}..${range.max})`,
      } satisfies JsonSchema,
    ]),
  ),
};

function nodes(state: DocumentState): Node[] {
  return Object.values(state.nodes).filter((node) => node.type === IMAGE_TYPE);
}

/** The document holds at most one image: the editor edits one picture at a time. */
export function imageNode(state: DocumentState): Node | null {
  return nodes(state)[0] ?? null;
}

function adjustOf(node: Node): Adjustments {
  const raw = node.props.adjustments;
  const merged = { ...NEUTRAL_ADJUSTMENTS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(NEUTRAL_ADJUSTMENTS) as Array<keyof Adjustments>) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) merged[key] = clamp(key, value);
    }
  }
  return merged;
}

function clamp(key: keyof Adjustments, value: number): number {
  const range = ADJUSTMENT_RANGES[key];
  return Math.max(range.min, Math.min(range.max, value));
}

function cropOf(node: Node): Crop | null {
  const raw = node.props.crop;
  if (!raw || typeof raw !== "object") return null;
  const crop = raw as Record<string, unknown>;
  if (
    typeof crop.x !== "number" ||
    typeof crop.y !== "number" ||
    typeof crop.width !== "number" ||
    typeof crop.height !== "number"
  ) {
    return null;
  }
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

function rotationOf(node: Node): 0 | 90 | 180 | 270 {
  const value = node.props.rotation;
  const rotation = typeof value === "number" ? ((value % 360) + 360) % 360 : 0;
  return (rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0) as 0 | 90 | 180 | 270;
}

function resizeOf(node: Node): Size | null {
  const raw = node.props.resize;
  if (!raw || typeof raw !== "object") return null;
  const size = raw as Record<string, unknown>;
  if (typeof size.width !== "number" || typeof size.height !== "number") return null;
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

function filterOf(node: Node): ImageFilter {
  const value = node.props.filter;
  return IMAGE_FILTERS.includes(value as ImageFilter) ? (value as ImageFilter) : "none";
}

function requireImage(state: DocumentState): Node {
  const node = imageNode(state);
  if (!node) throw new NucleusError("not_found", "no image loaded");
  return node;
}

/** Final size: an explicit resize wins, otherwise the crop with the turn applied. */
export function outputSize(node: Node): Size {
  const naturalWidth = Number(node.props.naturalWidth ?? 0);
  const naturalHeight = Number(node.props.naturalHeight ?? 0);
  const crop = cropOf(node);
  const resize = resizeOf(node);
  if (resize) return resize;
  const width = crop?.width ?? naturalWidth;
  const height = crop?.height ?? naturalHeight;
  return rotationOf(node) % 180 === 0 ? { width, height } : { width: height, height: width };
}

/** Everything currently applied, for an inspector or an agent. */
export function editsOf(node: Node): string[] {
  const edits: string[] = [];
  const crop = cropOf(node);
  if (crop) edits.push(`crop ${crop.width}×${crop.height} at ${crop.x},${crop.y}`);
  const rotation = rotationOf(node);
  if (rotation !== 0) edits.push(`rotate ${rotation}°`);
  if (node.props.flipX === true) edits.push("flip horizontal");
  if (node.props.flipY === true) edits.push("flip vertical");
  const filter = filterOf(node);
  if (filter !== "none") edits.push(`filter ${filter}`);
  const adjust = adjustOf(node);
  for (const [key, value] of Object.entries(adjust)) {
    if (value !== 0) edits.push(`${key} ${value > 0 ? "+" : ""}${round(value)}`);
  }
  const resize = resizeOf(node);
  if (resize) edits.push(`resize ${resize.width}×${resize.height}`);
  return edits;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function imageView(state: DocumentState): ImageView | null {
  const node = imageNode(state);
  if (!node) return null;
  const size = outputSize(node);
  return {
    id: node.id,
    sourceId: String(node.props.sourceId ?? ""),
    name: String(node.props.name ?? "image"),
    mime: String(node.props.mime ?? "image/png"),
    naturalWidth: Number(node.props.naturalWidth ?? 0),
    naturalHeight: Number(node.props.naturalHeight ?? 0),
    crop: cropOf(node),
    rotation: rotationOf(node),
    flipX: node.props.flipX === true,
    flipY: node.props.flipY === true,
    filter: filterOf(node),
    adjustments: adjustOf(node),
    resize: resizeOf(node),
    width: size.width,
    height: size.height,
    edits: editsOf(node),
  };
}

export function registerImageCommands(bus: CommandBus, assets: AssetStore): void {
  // ── loading ────────────────────────────────────────────────────────────

  bus.register<
    { sourceId: string; name?: string; mime?: string; naturalWidth: number; naturalHeight: number },
    { id: string }
  >({
    name: "image.load",
    title: "Load an image",
    description: "Set the image being edited (replaces the previous one).",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["sourceId", "naturalWidth", "naturalHeight"],
      properties: {
        sourceId: { type: "string", description: "Id of a stored image asset." },
        name: { type: "string", description: "File name to show and to export as." },
        mime: { type: "string", description: "Image MIME type (image/png, image/jpeg, …)." },
        naturalWidth: { type: "integer", minimum: 1, description: "Source width in pixels." },
        naturalHeight: { type: "integer", minimum: 1, description: "Source height in pixels." },
      },
    },
    result: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run(params, ctx) {
      if (!assets.has(params.sourceId)) {
        throw new NucleusError("not_found", `source not found: ${params.sourceId}`);
      }
      const id = `img-${Date.now().toString(36)}`;
      const patches: Patch[] = nodes(ctx.state).map((node) => ({ op: "remove" as const, nodeId: node.id }));
      patches.push({
        op: "add",
        nodeId: id,
        after: {
          id,
          type: IMAGE_TYPE,
          parentId: null,
          order: 0,
          enabled: true,
          opacity: 1,
          props: {
            sourceId: params.sourceId,
            name: params.name ?? "image",
            mime: params.mime ?? "image/png",
            naturalWidth: params.naturalWidth,
            naturalHeight: params.naturalHeight,
            crop: null,
            rotation: 0,
            flipX: false,
            flipY: false,
            filter: "none",
            adjustments: { ...NEUTRAL_ADJUSTMENTS },
            resize: null,
          },
        },
      });
      return { patches, result: { id } };
    },
  });

  // ── geometry ───────────────────────────────────────────────────────────

  bus.register<Crop, { id: string }>({
    name: "image.crop",
    title: "Crop",
    description: "Keep a rectangle of the source image (in source pixels).",
    sideEffects: "write",
    reversible: true,
    params: cropSchema,
    result: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run(params, ctx) {
      const node = requireImage(ctx.state);
      const naturalWidth = Number(node.props.naturalWidth ?? 0);
      const naturalHeight = Number(node.props.naturalHeight ?? 0);
      const x = Math.round(params.x);
      const y = Math.round(params.y);
      const width = Math.round(params.width);
      const height = Math.round(params.height);
      if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > naturalWidth || y + height > naturalHeight) {
        throw new NucleusError(
          "validation",
          `crop out of bounds: ${width}×${height} at ${x},${y} inside ${naturalWidth}×${naturalHeight}`,
        );
      }
      return {
        patches: [{
          op: "update",
          nodeId: node.id,
          after: { ...node, props: { ...node.props, crop: { x, y, width, height } } },
        }],
        result: { id: node.id },
      };
    },
  });

  bus.register<Record<string, never>, { id: string }>({
    name: "image.clearCrop",
    title: "Reset crop",
    description: "Use the whole source image again.",
    sideEffects: "write",
    reversible: true,
    params: { type: "object", properties: {} },
    result: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run(_params, ctx) {
      const node = requireImage(ctx.state);
      return {
        patches: [{ op: "update", nodeId: node.id, after: { ...node, props: { ...node.props, crop: null } } }],
        result: { id: node.id },
      };
    },
  });

  bus.register<{ degrees: number }, { id: string; rotation: number }>({
    name: "image.rotate",
    title: "Rotate",
    description: "Turn the image by a multiple of 90 degrees (relative).",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["degrees"],
      properties: {
        degrees: { type: "number", enum: [-270, -180, -90, 90, 180, 270], description: "Relative quarter turns." },
      },
    },
    result: {
      type: "object",
      required: ["id", "rotation"],
      properties: { id: { type: "string" }, rotation: { type: "integer", minimum: 0, maximum: 359 } },
    },
    run(params, ctx) {
      const node = requireImage(ctx.state);
      const rotation = (((rotationOf(node) + params.degrees) % 360) + 360) % 360;
      return {
        patches: [{
          op: "update",
          nodeId: node.id,
          after: { ...node, props: { ...node.props, rotation } },
        }],
        result: { id: node.id, rotation },
      };
    },
  });

  bus.register<{ axis: "x" | "y" }, { id: string; flipX: boolean; flipY: boolean }>({
    name: "image.flip",
    title: "Flip",
    description: "Toggle a mirror flip on the horizontal (x) or vertical (y) axis.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["axis"],
      properties: { axis: { type: "string", enum: ["x", "y"], description: "x mirrors left↔right, y mirrors top↔bottom." } },
    },
    result: {
      type: "object",
      required: ["id", "flipX", "flipY"],
      properties: { id: { type: "string" }, flipX: { type: "boolean" }, flipY: { type: "boolean" } },
    },
    run(params, ctx) {
      const node = requireImage(ctx.state);
      const flipX = params.axis === "x" ? node.props.flipX !== true : node.props.flipX === true;
      const flipY = params.axis === "y" ? node.props.flipY !== true : node.props.flipY === true;
      return {
        patches: [{ op: "update", nodeId: node.id, after: { ...node, props: { ...node.props, flipX, flipY } } }],
        result: { id: node.id, flipX, flipY },
      };
    },
  });

  bus.register<Partial<Size>, { id: string; width: number; height: number }>({
    name: "image.resize",
    title: "Resize",
    description: "Set the output size; omit one side to keep the aspect ratio.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      properties: {
        width: { type: "integer", minimum: 1, description: "Output width in pixels." },
        height: { type: "integer", minimum: 1, description: "Output height in pixels." },
      },
    },
    result: {
      type: "object",
      required: ["id", "width", "height"],
      properties: { id: { type: "string" }, width: { type: "integer" }, height: { type: "integer" } },
    },
    run(params, ctx) {
      const node = requireImage(ctx.state);
      if (params.width === undefined && params.height === undefined) {
        throw new NucleusError("validation", "resize needs a width or a height");
      }
      const naturalWidth = Number(node.props.naturalWidth ?? 0);
      const naturalHeight = Number(node.props.naturalHeight ?? 0);
      const crop = cropOf(node);
      const rotation = rotationOf(node);
      const baseWidth = rotation % 180 === 0 ? (crop?.width ?? naturalWidth) : (crop?.height ?? naturalHeight);
      const baseHeight = rotation % 180 === 0 ? (crop?.height ?? naturalHeight) : (crop?.width ?? naturalWidth);
      let width: number;
      let height: number;
      if (params.width !== undefined && params.height !== undefined) {
        width = Math.round(params.width);
        height = Math.round(params.height);
      } else if (params.width !== undefined) {
        width = Math.round(params.width);
        height = Math.max(1, Math.round((width * baseHeight) / baseWidth));
      } else {
        height = Math.round(params.height as number);
        width = Math.max(1, Math.round((height * baseWidth) / baseHeight));
      }
      const resize = { width, height };
      return {
        patches: [{ op: "update", nodeId: node.id, after: { ...node, props: { ...node.props, resize } } }],
        result: { id: node.id, width, height },
      };
    },
  });

  bus.register<Record<string, never>, { id: string }>({
    name: "image.clearResize",
    title: "Reset size",
    description: "Drop the explicit output size and go back to the crop's dimensions.",
    sideEffects: "write",
    reversible: true,
    params: { type: "object", properties: {} },
    result: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run(_params, ctx) {
      const node = requireImage(ctx.state);
      return {
        patches: [{ op: "update", nodeId: node.id, after: { ...node, props: { ...node.props, resize: null } } }],
        result: { id: node.id },
      };
    },
  });

  // ── colour ─────────────────────────────────────────────────────────────

  bus.register<Partial<Adjustments>, { id: string; adjustments: Adjustments }>({
    name: "image.adjust",
    title: "Adjust colours",
    description: "Merge a partial set of adjustments; omitted keys keep their value.",
    sideEffects: "write",
    reversible: true,
    params: adjustmentsSchema,
    result: {
      type: "object",
      required: ["id", "adjustments"],
      properties: { id: { type: "string" }, adjustments: { type: "object" } },
    },
    // A slider drag on one key collapses into a single undo step (F2).
    coalesce: {
      key: (params) => Object.keys(params).sort().join(","),
      windowMs: 1200,
    },
    run(params, ctx) {
      const node = requireImage(ctx.state);
      const adjustments = { ...adjustOf(node) };
      for (const key of Object.keys(NEUTRAL_ADJUSTMENTS) as Array<keyof Adjustments>) {
        const value = params[key];
        if (typeof value === "number") adjustments[key] = round(clamp(key, value));
      }
      return {
        patches: [{ op: "update", nodeId: node.id, after: { ...node, props: { ...node.props, adjustments } } }],
        result: { id: node.id, adjustments },
      };
    },
  });

  bus.register<{ filter: ImageFilter }, { id: string; filter: ImageFilter }>({
    name: "image.setFilter",
    title: "Filter",
    description: "Apply one of the named looks (grayscale, sepia, invert, warm, cool) or none.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["filter"],
      properties: {
        filter: { type: "string", enum: IMAGE_FILTERS, description: "Named filter, or none." },
      },
    },
    result: {
      type: "object",
      required: ["id", "filter"],
      properties: { id: { type: "string" }, filter: { type: "string", enum: IMAGE_FILTERS } },
    },
    run(params, ctx) {
      const node = requireImage(ctx.state);
      if (!IMAGE_FILTERS.includes(params.filter)) {
        throw new NucleusError("validation", `unknown filter: ${params.filter}`);
      }
      return {
        patches: [{ op: "update", nodeId: node.id, after: { ...node, props: { ...node.props, filter: params.filter } } }],
        result: { id: node.id, filter: params.filter },
      };
    },
  });

  bus.register<Record<string, never>, { id: string }>({
    name: "image.reset",
    title: "Reset edits",
    description: "Clear every edit (crop, rotation, flips, filter, adjustments, resize).",
    sideEffects: "write",
    reversible: true,
    params: { type: "object", properties: {} },
    result: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run(_params, ctx) {
      const node = requireImage(ctx.state);
      return {
        patches: [{
          op: "update",
          nodeId: node.id,
          after: {
            ...node,
            props: {
              ...node.props,
              crop: null,
              rotation: 0,
              flipX: false,
              flipY: false,
              filter: "none",
              adjustments: { ...NEUTRAL_ADJUSTMENTS },
              resize: null,
            },
          },
        }],
        result: { id: node.id },
      };
    },
  });

  bus.register<Record<string, never>, ImageView | { image: null }>({
    name: "image.summary",
    title: "Describe the image",
    description: "Read-only: current output size and the list of applied edits.",
    sideEffects: "read",
    reversible: false,
    params: { type: "object", properties: {} },
    result: { type: "object" },
    run(_params, ctx) {
      return { result: imageView(ctx.state) ?? { image: null } };
    },
  });
}

/** Create a ready-to-use Image session (document + bus + assets). */
export function createImageSession(): ImageSession {
  const assets = new MemoryAssetStore();
  const doc = createDocument(IMAGE_APP_ID);
  const bus = new CommandBus({ kind: "system", id: IMAGE_APP_ID });
  registerImageCommands(bus, assets);
  return { assets, doc, bus };
}
