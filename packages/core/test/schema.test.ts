import { describe, expect, it } from "vitest";

import {
  canonicalEqual,
  validateJsonSchema,
  type JsonSchema,
} from "../src/index.js";

const objectWith = (schema: JsonSchema): JsonSchema => ({ type: "object", properties: schema });

describe("JSON-Schema subset validator (M1, no dependency)", () => {
  it("accepts a well-typed value and reports nothing", () => {
    expect(
      validateJsonSchema(
        objectWith({ title: { type: "string" }, count: { type: "integer", minimum: 0 } }),
        { title: "hello", count: 3 },
      ),
    ).toEqual([]);
  });

  it("rejects a wrong type with the offending path", () => {
    const errors = validateJsonSchema(objectWith({ title: { type: "string" } }), { title: 5 });
    expect(errors).toEqual(["params.title: expected a string"]);
  });

  it("reports EVERY bad field at once, not just the first", () => {
    const errors = validateJsonSchema(
      objectWith({ a: { type: "string" }, b: { type: "boolean" }, c: { type: "integer" } }),
      { a: 1, b: "yes", c: 1.5 },
    );
    expect(errors).toHaveLength(3);
    expect(errors.join(" | ")).toContain("params.a");
    expect(errors.join(" | ")).toContain("params.c: expected an integer");
  });

  it("enforces required fields", () => {
    const errors = validateJsonSchema(
      { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      {},
    );
    expect(errors).toEqual(["params.id: required"]);
  });

  it("accepts null only when the schema type list allows it", () => {
    const schema = objectWith({
      parentId: { type: ["string", "null"] },
      id: { type: ["string", "null"] },
    });
    expect(validateJsonSchema(schema, { parentId: null, id: "n1" })).toEqual([]);
    const errors = validateJsonSchema(objectWith({ id: { type: "string" } }), { id: null });
    expect(errors).toEqual(["params.id: expected a string"]);
  });

  it("validates enum members", () => {
    const schema = objectWith({ size: { enum: ["A4", "Letter"] } });
    expect(validateJsonSchema(schema, { size: "A4" })).toEqual([]);
    expect(validateJsonSchema(schema, { size: "A3" })).toEqual([
      'params.size: must be one of "A4", "Letter"',
    ]);
  });

  it("validates numeric bounds", () => {
    const schema = objectWith({ degrees: { type: "number", minimum: -360, maximum: 360 } });
    expect(validateJsonSchema(schema, { degrees: 90 })).toEqual([]);
    expect(validateJsonSchema(schema, { degrees: 720 })).toEqual(["params.degrees: must be <= 360"]);
    // NaN is not a finite number
    expect(validateJsonSchema(schema, { degrees: Number.NaN })).toEqual([
      "params.degrees: expected a number",
    ]);
  });

  it("validates array items with indexed paths", () => {
    const schema = objectWith({ ids: { type: "array", items: { type: "string" } } });
    expect(validateJsonSchema(schema, { ids: ["a", "b"] })).toEqual([]);
    expect(validateJsonSchema(schema, { ids: ["a", 3] })).toEqual([
      "params.ids[1]: expected a string",
    ]);
  });

  it("rejects unknown types deeply (object received where string expected)", () => {
    const errors = validateJsonSchema(objectWith({ title: { type: "string" } }), {
      title: { nested: true },
    });
    expect(errors).toEqual(["params.title: expected a string"]);
  });

  it("treats absent fields as fine unless required", () => {
    const errors = validateJsonSchema(objectWith({ title: { type: "string" } }), {});
    expect(errors).toEqual([]);
  });

  it("canonicalEqual compares structurally, order-insensitive", () => {
    expect(canonicalEqual({ a: 1, b: [true, "x"] }, { b: [true, "x"], a: 1 })).toBe(true);
    expect(canonicalEqual({ a: 1, b: ["x", true] }, { b: [true, "x"], a: 1 })).toBe(false);
    expect(canonicalEqual(null, undefined)).toBe(false);
    expect(canonicalEqual({ id: "n" }, { id: "n", extra: undefined })).toBe(false);
  });
});
