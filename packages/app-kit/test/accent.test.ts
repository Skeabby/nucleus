/**
 * Accent guard (brief #3, P5): every app's accent is its launcher category
 * colour, and neither violet (launcher-only) nor cyan (agent-only) sneaks into
 * an app's chrome.
 *
 * The launcher's category table is the single source of truth, so it is parsed
 * from the Rust source instead of being duplicated here.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const appsDir = join(repo, "apps");
const widgets = join(repo, "launcher-rs", "crates", "nucleus-launcher", "src", "ui", "widgets.rs");

function launcherAccents(): Record<string, string> {
  const source = readFileSync(widgets, "utf8");
  const table: Record<string, string> = {};
  for (const match of source.matchAll(
    /Some\(Category::(\w+)\)\s*=>\s*super::theme::hex_color\("#([0-9A-Fa-f]{6})"\)/g,
  )) {
    table[(match[1] as string).toLowerCase()] = `#${(match[2] as string).toLowerCase()}`;
  }
  return table;
}

type App = { dir: string; category: string; accent: string };

function apps(): App[] {
  const found: App[] = [];
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(appsDir, entry.name);
    const manifest = join(dir, "nucleus.app.json");
    const html = join(dir, "public", "index.html");
    if (!existsSync(manifest) || !existsSync(html)) continue;
    const accent = /--nk-app-accent:\s*(#[0-9a-fA-F]{6})/.exec(readFileSync(html, "utf8"));
    if (!accent) continue;
    found.push({
      dir: entry.name,
      category: String(JSON.parse(readFileSync(manifest, "utf8")).category),
      accent: (accent[1] as string).toLowerCase(),
    });
  }
  return found;
}

const table = launcherAccents();
const all = apps();

describe("app accents", () => {
  it("the launcher category table is readable (PDF, Text, Image at least)", () => {
    expect(table.pdf).toBe("#e85a6c");
    expect(table.text).toBe("#8ab4f8");
    expect(table.image).toBe("#f472b6");
  });

  it("every app we ship declares its category colour", () => {
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const app of all) {
      expect(table[app.category], `no launcher colour for ${app.category}`).toBeDefined();
      expect(app.accent, `${app.dir} accent`).toBe(table[app.category]);
    }
  });

  it("violet stays launcher-only and cyan stays agent-only", () => {
    for (const app of all) {
      expect(["#7c5cff", "#6d5ef8"]).not.toContain(app.accent);
      expect(app.accent).not.toBe("#22d3ee");
    }
  });
});
