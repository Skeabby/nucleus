/**
 * Per-app UI settings (brief #3, §3.4) — the shell's memory.
 *
 * Why a server file and not `localStorage`: the launcher picks the port at
 * launch, so the origin changes between runs and every origin-scoped store is
 * lost. Settings live next to the document instead:
 *
 *   `<dataDir>/settings/<appId>.json`
 *
 * The store is intentionally dumb (a flat JSON object) and the router is
 * intentionally strict (an allowlist): an unknown key is a bug in the app, not
 * data to keep. Validation errors come back as `kind: "validation"` so the
 * server can answer 400 like every other bad request.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultDataDir } from "./persist.js";

export type SettingValue = boolean | number | string | string[] | Record<string, number>;

/** Accepted values per key. Anything else is refused with a validation error. */
export const SETTINGS_SCHEMA: Record<string, (value: unknown) => SettingValue | undefined> = {
  /** View → Developer details: internals, tape scrubber, node ids. */
  developerDetails: (value) => (typeof value === "boolean" ? value : undefined),
  /** "system" follows the OS; the shell resolves it to dark/light. */
  theme: (value) => (value === "dark" || value === "light" || value === "system" ? value : undefined),
  thumbnailSize: (value) => (value === "s" || value === "m" || value === "l" ? value : undefined),
  /** Notes: edit | split | preview. Image: adjust | filter | crop | resize. */
  viewMode: (value) =>
    value === "edit" ||
    value === "split" ||
    value === "preview" ||
    value === "write" ||
    value === "read" ||
    value === "adjust" ||
    value === "filter" ||
    value === "crop" ||
    value === "resize"
      ? value
      : undefined,
  /** Collapsed panel section ids (free-form, bounded). */
  collapsedSections: (value) => {
    if (!Array.isArray(value) || value.length > 64) return undefined;
    const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64);
    return ids.length === value.length ? ids : undefined;
  },
  /** Left/right panel widths in CSS px (kept inside the layout's bounds). */
  panelWidths: (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const out: Record<string, number> = {};
    for (const [side, width] of Object.entries(value as Record<string, unknown>)) {
      if (side !== "left" && side !== "right") return undefined;
      if (typeof width !== "number" || !Number.isFinite(width) || width < 180 || width > 480) return undefined;
      out[side] = Math.round(width);
    }
    return out;
  },
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMA);

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

/**
 * Keep only allowlisted keys with acceptable values. Returns a fresh object so
 * callers can merge without mutating their input.
 */
export function validateSettings(patch: unknown): Record<string, SettingValue> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new SettingsError("settings must be a JSON object");
  }
  const out: Record<string, SettingValue> = {};
  for (const [key, raw] of Object.entries(patch as Record<string, unknown>)) {
    const accept = SETTINGS_SCHEMA[key];
    if (!accept) throw new SettingsError(`unknown setting: ${key}`);
    const value = accept(raw);
    if (value === undefined) throw new SettingsError(`bad value for ${key}`);
    out[key] = value;
  }
  return out;
}

export class SettingsStore {
  readonly file: string;

  private constructor(file: string) {
    this.file = file;
  }

  static for(dataDir: string, appId: string): SettingsStore {
    // Same rule as DocStore: ids are package names, never trusted as path parts.
    const safeId = appId.replace(/[^A-Za-z0-9_-]/g, "_");
    return new SettingsStore(join(dataDir, "settings", `${safeId}.json`));
  }

  /** Missing or corrupt files read as "no settings" — never fatal. */
  async load(): Promise<Record<string, SettingValue>> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return {};
      return validateSettings(parsed);
    } catch {
      return {};
    }
  }

  /** Merge a validated patch, then replace the file atomically (temp + rename). */
  async save(patch: unknown): Promise<Record<string, SettingValue>> {
    const clean = validateSettings(patch);
    const merged = { ...(await this.load()), ...clean };
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(merged, null, 1)}\n`, "utf8");
    await rename(tmp, this.file);
    return merged;
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

/** Convenience for a server that only knows its id. */
export function settingsFor(appId: string, dataDir?: string): SettingsStore {
  return SettingsStore.for(dataDir ?? defaultDataDir(), appId);
}
