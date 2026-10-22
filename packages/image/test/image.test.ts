import { NucleusError } from "@nucleus/core";
import { describe, expect, it } from "vitest";
import { createImageSession, imageView, type ImageSession } from "../src/index.js";

const SOURCE = "src-test";

function session(): ImageSession {
  const created = createImageSession();
  created.assets.put(SOURCE, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  return created;
}

/** Load a 1600×1000 image and return the session + node id. */
function loaded(width = 1600, height = 1000): { session: ImageSession; id: string } {
  const created = session();
  const { result } = created.bus.invoke<{ id: string }>("image.load", created.doc, {
    sourceId: SOURCE,
    name: "photo.png",
    mime: "image/png",
    naturalWidth: width,
    naturalHeight: height,
  });
  return { session: created, id: result.id };
}

describe("@nucleus/image: loading", () => {
  it("creates a neutral document (natural size, no edits)", () => {
    const { session: s } = loaded();
    const view = imageView(s.doc);
    expect(view).not.toBeNull();
    expect(view!.width).toBe(1600);
    expect(view!.height).toBe(1000);
    expect(view!.rotation).toBe(0);
    expect(view!.filter).toBe("none");
    expect(view!.edits).toEqual([]);
    expect(view!.adjustments.brightness).toBe(0);
  });

  it("replaces the previous image instead of stacking nodes", () => {
    const { session: s } = loaded();
    s.assets.put("src-second", new Uint8Array([1, 2, 3]));
    s.bus.invoke("image.load", s.doc, {
      sourceId: "src-second",
      name: "second.jpg",
      naturalWidth: 400,
      naturalHeight: 400,
    });
    const images = Object.values(s.doc.nodes).filter((node) => node.type === "image");
    expect(images).toHaveLength(1);
    expect(imageView(s.doc)!.name).toBe("second.jpg");
  });

  it("refuses a source that was never uploaded", () => {
    const s = session();
    expect(() =>
      s.bus.invoke("image.load", s.doc, {
        sourceId: "nope",
        naturalWidth: 10,
        naturalHeight: 10,
      }),
    ).toThrowError(NucleusError);
  });

  it("rejects edits when no image is loaded", () => {
    const s = session();
    expect(() => s.bus.invoke("image.rotate", s.doc, { degrees: 90 })).toThrowError(NucleusError);
  });
});

describe("@nucleus/image: geometry", () => {
  it("crops and reports the new output size", () => {
    const { session: s, id } = loaded();
    s.bus.invoke("image.crop", s.doc, { x: 100, y: 50, width: 800, height: 400 });
    const view = imageView(s.doc)!;
    expect(view.crop).toEqual({ x: 100, y: 50, width: 800, height: 400 });
    expect([view.width, view.height]).toEqual([800, 400]);
    expect(view.edits[0]).toBe("crop 800×400 at 100,50");

    s.bus.invoke("image.clearCrop", s.doc, {});
    expect(imageView(s.doc)!.crop).toBeNull();
    expect(imageView(s.doc)!.width).toBe(1600);
    expect(id).toBe(view.id);
  });

  it("refuses a crop outside the source", () => {
    const { session: s } = loaded();
    expect(() =>
      s.bus.invoke("image.crop", s.doc, { x: 1500, y: 0, width: 200, height: 100 }),
    ).toThrowError(NucleusError);
    expect(() => s.bus.invoke("image.crop", s.doc, { x: 0, y: 0, width: 0, height: 100 })).toThrowError(
      NucleusError,
    );
  });

  it("normalises rotations and swaps the output axes on quarter turns", () => {
    const { session: s } = loaded();
    expect(s.bus.invoke<{ rotation: number }>("image.rotate", s.doc, { degrees: 90 }).result.rotation).toBe(90);
    expect([imageView(s.doc)!.width, imageView(s.doc)!.height]).toEqual([1000, 1600]);

    s.bus.invoke("image.rotate", s.doc, { degrees: 270 });
    expect(imageView(s.doc)!.rotation).toBe(0);
    expect([imageView(s.doc)!.width, imageView(s.doc)!.height]).toEqual([1600, 1000]);

    s.bus.invoke("image.rotate", s.doc, { degrees: -90 });
    expect(imageView(s.doc)!.rotation).toBe(270);
  });

  it("crops first, then turns: the output follows the crop", () => {
    const { session: s } = loaded();
    s.bus.invoke("image.crop", s.doc, { x: 0, y: 0, width: 300, height: 900 });
    s.bus.invoke("image.rotate", s.doc, { degrees: 90 });
    const view = imageView(s.doc)!;
    expect([view.width, view.height]).toEqual([900, 300]);
  });

  it("toggles flips independently", () => {
    const { session: s } = loaded();
    s.bus.invoke("image.flip", s.doc, { axis: "x" });
    expect(imageView(s.doc)!.flipX).toBe(true);
    expect(imageView(s.doc)!.flipY).toBe(false);
    s.bus.invoke("image.flip", s.doc, { axis: "y" });
    s.bus.invoke("image.flip", s.doc, { axis: "x" });
    expect(imageView(s.doc)!.flipX).toBe(false);
    expect(imageView(s.doc)!.flipY).toBe(true);
    expect(imageView(s.doc)!.edits).toContain("flip vertical");
  });

  it("resizes from one side, keeping the aspect of the cropped result", () => {
    const { session: s } = loaded();
    s.bus.invoke("image.crop", s.doc, { x: 0, y: 0, width: 800, height: 400 });
    const { result } = s.bus.invoke<{ width: number; height: number }>("image.resize", s.doc, { width: 200 });
    expect([result.width, result.height]).toEqual([200, 100]);
    expect([imageView(s.doc)!.width, imageView(s.doc)!.height]).toEqual([200, 100]);

    s.bus.invoke("image.clearResize", s.doc, {});
    expect(imageView(s.doc)!.resize).toBeNull();
    expect(imageView(s.doc)!.width).toBe(800);
  });

  it("does not let a resize hide the rotation", () => {
    const { session: s } = loaded();
    s.bus.invoke("image.rotate", s.doc, { degrees: 90 });
    const { result } = s.bus.invoke<{ width: number; height: number }>("image.resize", s.doc, { height: 500 });
    // Base after rotation is 1000×1600, so height 500 ⇒ width 312.5 ⇒ 313
    expect(result.height).toBe(500);
    expect(result.width).toBe(313);
  });

  it("refuses a resize with neither side", () => {
    const { session: s } = loaded();
    expect(() => s.bus.invoke("image.resize", s.doc, {})).toThrowError(NucleusError);
  });
});

describe("@nucleus/image: colour", () => {
  it("merges partial adjustments and clamps to the documented ranges", () => {
    const { session: s } = loaded();
    s.bus.invoke("image.adjust", s.doc, { brightness: 40 });
    s.bus.invoke("image.adjust", s.doc, { contrast: 100, saturation: -100 });
    const view = imageView(s.doc)!;
    expect(view.adjustments.brightness).toBe(40);
    expect(view.adjustments.contrast).toBe(100);
    expect(view.adjustments.saturation).toBe(-100);
    expect(view.adjustments.blur).toBe(0);

    // Out-of-range values never reach the document: the schema rejects them.
    expect(() => s.bus.invoke("image.adjust", s.doc, { contrast: 500 })).toThrowError(NucleusError);
  });

  it("collapses a slider drag into one undo step", () => {
    const { session: s } = loaded();
    const before = s.bus.tapeRecords().length;
    for (const value of [5, 12, 20, 31, 44]) {
      s.bus.invoke("image.adjust", s.doc, { brightness: value });
    }
    expect(imageView(s.doc)!.adjustments.brightness).toBe(44);
    // The burst coalesces: one tape record, and one undo returns to neutral.
    expect(s.bus.tapeRecords().length - before).toBe(1);
    s.bus.undo(s.doc);
    expect(imageView(s.doc)!.adjustments.brightness).toBe(0);
  });

  it("applies named filters and rejects invented ones", () => {
    const { session: s } = loaded();
    s.bus.invoke("image.setFilter", s.doc, { filter: "sepia" });
    expect(imageView(s.doc)!.filter).toBe("sepia");
    expect(() => s.bus.invoke("image.setFilter", s.doc, { filter: "vaporwave" })).toThrowError(NucleusError);
  });

  it("resets everything in one reversible step", () => {
    const { session: s } = loaded();
    s.bus.invoke("image.crop", s.doc, { x: 10, y: 10, width: 500, height: 500 });
    s.bus.invoke("image.rotate", s.doc, { degrees: 90 });
    s.bus.invoke("image.flip", s.doc, { axis: "y" });
    s.bus.invoke("image.adjust", s.doc, { contrast: 30, blur: 12 });
    s.bus.invoke("image.setFilter", s.doc, { filter: "invert" });
    s.bus.invoke("image.resize", s.doc, { width: 64 });
    expect(imageView(s.doc)!.edits.length).toBeGreaterThan(4);

    s.bus.invoke("image.reset", s.doc, {});
    const view = imageView(s.doc)!;
    expect(view.edits).toEqual([]);
    expect([view.width, view.height]).toEqual([1600, 1000]);

    s.bus.undo(s.doc);
    expect(imageView(s.doc)!.filter).toBe("invert");
  });

  it("describes the applied stack for agents", () => {
    const { session: s } = loaded();
    s.bus.invoke("image.adjust", s.doc, { brightness: 25, blur: 4 });
    s.bus.invoke("image.setFilter", s.doc, { filter: "cool" });
    s.bus.invoke("image.crop", s.doc, { x: 0, y: 0, width: 400, height: 400 });
    const summary = s.bus.invoke<{ edits: string[]; width: number; height: number }>("image.summary", s.doc).result;
    expect(summary.edits).toContain("crop 400×400 at 0,0");
    expect(summary.edits).toContain("filter cool");
    expect(summary.edits).toContain("brightness +25");
    expect(summary.edits).toContain("blur +4");
    expect([summary.width, summary.height]).toEqual([400, 400]);
  });
});

describe("@nucleus/image: self-description", () => {
  it("ships params + result schemas for every image.* command (F11)", () => {
    const { bus } = createImageSession();
    const names = [
      "image.load",
      "image.crop",
      "image.clearCrop",
      "image.rotate",
      "image.flip",
      "image.resize",
      "image.clearResize",
      "image.adjust",
      "image.setFilter",
      "image.reset",
      "image.summary",
    ];
    for (const name of names) {
      const descriptor = bus.describe(name);
      expect(descriptor.params, `${name} params`).toBeDefined();
      expect(descriptor.result, `${name} result`).toBeDefined();
      expect(descriptor.description.length, `${name} documents itself`).toBeGreaterThan(10);
    }
    expect(bus.describe("image.adjust").params?.properties.brightness.maximum).toBe(100);
    expect(bus.describe("image.setFilter").params?.properties.filter.enum).toEqual([
      "none",
      "grayscale",
      "sepia",
      "invert",
      "warm",
      "cool",
    ]);
  });

  it("marks the reversible commands reversible and the summary read-only", () => {
    const { bus } = createImageSession();
    expect(bus.describe("image.crop").reversible).toBe(true);
    expect(bus.describe("image.summary").sideEffects).toBe("read");
    expect(bus.describe("image.load").sideEffects).toBe("write");
  });
});
