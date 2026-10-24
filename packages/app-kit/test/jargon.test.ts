/**
 * Jargon guard (brief #3, §5): the old internal vocabulary must not be visible
 * in the UI. Developer-only detail lives behind `[data-dev]` (View → Developer
 * details), which is stripped before the scan.
 *
 * Apps are added to MIGRATED as they move to the shared shell (U2–U4); the kit
 * itself is always covered, so the regression can never come from the shell.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const kit = new URL("../kit/", import.meta.url);
const repo = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Add an app id here when its migration lands. */
const MIGRATED: string[] = ["pdf-workbench", "notes"];

const VISIBLE_JARGON: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bbus command\b/i, replacement: "plain verbs (no architecture talk)" },
  { pattern: /\bnode\(s\)/i, replacement: "an app noun: 2 pages / 1 note" },
  { pattern: /\btape\b/i, replacement: "History" },
  { pattern: /\bfork\b/i, replacement: "Start a copy from here" },
  { pattern: /\brestore here\b/i, replacement: "Go back to this point" },
  { pattern: /\binspector\b/i, replacement: "Properties" },
  { pattern: /\bsources\b/i, replacement: "Documents" },
];

/** Strings the kit itself must never render again (case-sensitive on purpose:
 *  `/api/tape/restore` is a contract, "Tape preview" was a label). */
const KIT_JARGON = [/\bTape\b/, /\bFork\b/, /\bLive\b/, /\bInspector\b/, /Restore here/, /node\(s\)/, /bus command/];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function visibleStrings(html: string): string[] {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  // Developer details are allowed to speak the old language.
  for (const node of [...document.querySelectorAll("[data-dev]")]) node.remove();
  const strings: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = (node.textContent || "").trim();
      if (text) strings.push(text);
      return;
    }
    if (!(node instanceof dom.window.HTMLElement)) return;
    for (const attribute of ["title", "aria-label", "placeholder", "alt"]) {
      const value = node.getAttribute(attribute);
      if (value) strings.push(value);
    }
    for (const child of [...node.childNodes]) walk(child);
  };
  walk(document.body);
  return strings;
}

describe("UI vocabulary", () => {
  it("no app we ship still shows the old words", () => {
    for (const app of MIGRATED) {
      const html = readFileSync(join(repo, "apps", app, "public", "index.html"), "utf8");
      const strings = visibleStrings(html);
      for (const { pattern, replacement } of VISIBLE_JARGON) {
        const hit = strings.find((text) => pattern.test(text));
        expect(hit, `${app}: "${hit}" should be ${replacement}`).toBeUndefined();
      }
      // "Reset" survives only as part of something meaningful ("Reset adjustments").
      const bare = strings.filter((text) => /^reset$/i.test(text));
      expect(bare, `${app}: Reset → Start over… (File menu)`).toEqual([]);
    }
  });

  it("the shared kit speaks plain words", () => {
    for (const file of ["kit.js", "shell.js", "kit.css"]) {
      const source = stripComments(readFileSync(new URL(file, kit), "utf8"));
      for (const pattern of KIT_JARGON) {
        const match = pattern.exec(source);
        expect(match?.[0], `${file} still contains ${pattern}`).toBeUndefined();
      }
    }
  });

  it("the shell and the kit speak the new vocabulary", () => {
    const kitSource = readFileSync(new URL("kit.js", kit), "utf8");
    const shell = readFileSync(new URL("shell.js", kit), "utf8");
    expect(kitSource).toContain("Start a copy from here");
    expect(kitSource).toContain("Go back to this point");
    expect(kitSource).toContain("Back to now");
    expect(shell).toContain("History");
    expect(shell).toContain("Developer details");
  });

  it("the visible-string helper ignores developer-only blocks", () => {
    const strings = visibleStrings('<p>Pages</p><p data-dev>Every action is a bus command</p>');
    expect(strings).toEqual(["Pages"]);
  });
});
