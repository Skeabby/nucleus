/**
 * Cross-app consistency (brief #3, U5): the three migrated apps must look like
 * one product. The shell owns the frame, so what is left to guard is the shape
 * of each app's declaration:
 *
 *   - one mount call per app, and the same menu skeleton (File first, Help last,
 *     one app-specific menu in between);
 *   - every `menu.item` id used by an options bar, an enabled rule or a context
 *     menu exists in that app's menus (the shell only warns at runtime, and a
 *     warning in the console is not a test);
 *   - the primary action is a real menu item;
 *   - the accent in app.js is the accent in index.html (accent.test.ts checks
 *     the HTML against the launcher table, this closes the other half).
 *
 * Everything here is a static read of the shipped files: no server, no DOM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

type App = { dir: string; menus: string[]; appMenu: string };

const APPS: App[] = [
  { dir: "pdf-workbench", menus: ["File", "Edit", "Page", "View", "Help"], appMenu: "Page" },
  { dir: "notes", menus: ["File", "Edit", "Format", "View", "Help"], appMenu: "Format" },
  { dir: "image-editor", menus: ["File", "Edit", "Image", "View", "Help"], appMenu: "Image" },
];

function source(app: string): string {
  return readFileSync(join(repo, "apps", app, "public", "app.js"), "utf8");
}

/** Menu labels, in declaration order, from the top-level `menus: [` block. */
function menuLabels(code: string): string[] {
  const start = code.indexOf("menus: [");
  if (start < 0) return [];
  const labels: string[] = [];
  let depth = 0;
  for (let index = start + "menus: [".length - 1; index < code.length; index += 1) {
    const char = code[index];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && char === "l") {
      const match = /^label:\s*"([^"]+)"/.exec(code.slice(index));
      if (match) labels.push(match[1] as string);
    }
  }
  return labels;
}

function declaredIds(code: string): Set<string> {
  return new Set([...code.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1] as string));
}

/** Ids the shell's standard menus contribute to every app that spreads them. */
const STANDARD_IDS = (() => {
  const shell = readFileSync(join(repo, "packages", "app-kit", "kit", "shell.js"), "utf8");
  const start = shell.indexOf("function standardViewMenu");
  const end = shell.indexOf("function standardHelpMenu");
  const block = shell.slice(start, end < 0 ? start + 4000 : end + 4000);
  return new Set([...block.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1] as string));
})();

function quoted(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

/** The two places an app names a menu item without declaring it: the `enabled`
 *  map (object keys) and the options bar (`ids` arrays and pushes). Bus
 *  commands (`op("pdf.reverse")`, `command: "tape.undo"`) never match. */
function referencedIds(code: string): string[] {
  const refs: string[] = [];
  for (const match of code.matchAll(/(?:^|[,{]\s*)\s*"([a-z]+\.[A-Za-z0-9]+)"\s*:/gm)) refs.push(match[1] as string);
  for (const match of code.matchAll(/\bids\s*=\s*\[([^\]]*)\]/g)) refs.push(...quoted(match[1]));
  for (const match of code.matchAll(/\bids\.(?:push|unshift)\(([^)]*)\)/g)) refs.push(...quoted(match[1]));
  return refs;
}

describe("apps on the shared shell", () => {
  for (const app of APPS) {
    const code = source(app.dir);

    it(`${app.dir}: mounts the shell exactly once`, () => {
      expect(code.match(/window\.NucleusShell\.mount\(/g)?.length).toBe(1);
    });

    it(`${app.dir}: menu skeleton is File, Edit, ${app.appMenu}, View, Help`, () => {
      expect(menuLabels(code)).toEqual(app.menus);
    });

    it(`${app.dir}: the primary action is a menu item`, () => {
      const primary = /primary:\s*\{\s*id:\s*"([^"]+)"/.exec(code)?.[1];
      expect(primary, "no primary action").toBeDefined();
      expect(declaredIds(code).has(primary as string), `${primary} is not in a menu`).toBe(true);
    });

    it(`${app.dir}: every referenced action exists in a menu`, () => {
      const known = new Set([...declaredIds(code), ...STANDARD_IDS]);
      const orphans = [...new Set(referencedIds(code))].filter((id) => !known.has(id));
      expect(orphans, `unknown menu ids: ${orphans.join(", ")}`).toEqual([]);
    });

    it(`${app.dir}: app.js and index.html agree on the accent`, () => {
      const html = readFileSync(join(repo, "apps", app.dir, "public", "index.html"), "utf8");
      const htmlAccent = /--nk-app-accent:\s*(#[0-9a-fA-F]{6})/.exec(html)?.[1]?.toLowerCase();
      const jsAccent = /app:\s*\{\s*name:\s*"[^"]+",\s*accent:\s*"(#[0-9a-fA-F]{6})"/.exec(code)?.[1]?.toLowerCase();
      expect(jsAccent, "no accent in the mount config").toBeDefined();
      expect(jsAccent).toBe(htmlAccent);
    });

    it(`${app.dir}: names its items with a noun, not a node count`, () => {
      expect(code).toMatch(/noun:\s*\(ids\)\s*=>/);
    });
  }

  it("the menu reader finds exactly the labels it should", () => {
    // Guards the guard: a nested array or a label inside an item must not leak.
    expect(menuLabels('menus: [ { label: "File", items: [ { label: "nope" } ] }, { label: "Help", items: [] } ]')).toEqual([
      "File",
      "Help",
    ]);
  });

  it("the reference reader ignores bus commands", () => {
    const code = 'items: [{ id: "edit.undo", command: "tape.undo", run: () => op("pdf.reverse", {}) }]';
    expect(referencedIds(code)).toEqual([]);
  });

  it("the reference reader sees the enabled map and the options bar", () => {
    const code = [
      'enabled: { "edit.undo": () => true },',
      'const ids = ["page.rotateLeft", "edit.duplicate"];',
      'ids.unshift("page.preview");',
      'ids.push("view.history");',
    ].join("\n");
    expect(referencedIds(code).sort()).toEqual(
      ["edit.duplicate", "edit.undo", "page.preview", "page.rotateLeft", "view.history"].sort(),
    );
  });
});
