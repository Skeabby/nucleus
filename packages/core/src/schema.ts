/**
 * A deliberate JSON-Schema subset for command descriptors — the vocabulary an
 * agent needs to call a command without guessing (`params`) and to read the
 * reply (`result`). ~80 lines, **no new dependency**: full JSON-Schema is
 * overkill for a local bus, and every feature we skip (`$ref`, `allOf`,
 * `patternProperties`…) is one we do not want agents relying on either.
 *
 * Errors are ordinary strings ("path: why"); throwing stays in the caller so
 * the same validator can power dry-run reports later.
 */

export interface JsonSchema {
  /** A type, or a list of acceptable types (JSON-Schema allows both). */
  type?: JsonObjectSchemaType | JsonObjectSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
}

export type JsonObjectSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/**
 * Validate `value` against `schema`. Returns every violation, each formatted
 * `"<path>: <reason>"`, so one failed call reports *all* bad fields at once.
 * `undefined` leaf values count as "absent": they are only a problem when the
 * parent declares them required.
 */
export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  path = "params",
): string[] {
  const errors: string[] = [];
  collect(schema, value, path, errors);
  return errors;
}

function collect(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    return; // absent: the required check on the parent decides
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected ${describe(schema.type)}`);
    return; // further checks would only cascade
  }
  if (schema.enum && !schema.enum.some((candidate) => canonicalEqual(candidate, value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (schema.type === "object" || (schema.properties && isPlainObject(value))) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) {
        errors.push(`${path}.${key}: required`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      collect(child, record[key], `${path}.${key}`, errors);
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => collect(schema.items!, item, `${path}[${index}]`, errors));
  }
}

function typeMatches(
  type: JsonObjectSchemaType | JsonObjectSchemaType[],
  value: unknown,
): boolean {
  if (Array.isArray(type)) {
    return type.some((candidate) => typeMatches(candidate, value));
  }
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
  }
}

function describe(type: JsonObjectSchemaType | JsonObjectSchemaType[]): string {
  if (Array.isArray(type)) {
    return type.map((candidate) => describe(candidate)).join(" or ");
  }
  return type === "integer" ? "an integer" : `a ${type}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Order-insensitive structural equality for JSON data. Used to compare nodes
 * (staleness of proposals) and to verify tape replays against live state.
 */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** A stable string form of any JSON value (object keys sorted). */
export function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
