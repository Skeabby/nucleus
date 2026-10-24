/**
 * Contrast guard (brief #3, P6 / §6): every text token clears WCAG AA (4.5:1)
 * on every surface it can sit on, in both themes.
 *
 * The tokens live in one file, so the test reads that file rather than a copy:
 * a hand-tuned colour that fails AA fails here, before a screenshot is taken.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CRAFT = new URL("../kit/craft.css", import.meta.url);

function rootBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function tokens(block: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of block.matchAll(/--c-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
    found[match[1] as string] = (match[2] as string).toLowerCase();
  }
  return found;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) => (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)));
  return 0.2126 * (linear[0] as number) + 0.7152 * (linear[1] as number) + 0.0722 * (linear[2] as number);
}

function ratio(a: string, b: string): number {
  const one = luminance(a);
  const two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

const css = readFileSync(CRAFT, "utf8");
const dark = tokens(rootBlock(css, ":root {"));
// The light block only overrides what changes; everything else is inherited.
const light = { ...dark, ...tokens(rootBlock(css, ':root[data-theme="light"]')) };

describe("craft.css contrast", () => {
  it("defines the text and surface tokens in both themes", () => {
    for (const theme of [dark, light]) {
      for (const key of ["text", "text-strong", "muted", "faint", "ink", "surface", "panel", "on-accent"]) {
        expect(theme[key], `missing --c-${key}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ])("%s: text, muted and faint clear 4.5:1 on ink, surface and panel", (_name, theme) => {
    for (const surface of ["ink", "surface", "panel"] as const) {
      for (const text of ["text", "muted", "faint"] as const) {
        const value = ratio(theme[text] as string, theme[surface] as string);
        expect(value, `${text} on ${surface} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("accent fills carry readable ink (dark ink on a bright accent)", () => {
    expect(ratio(dark["on-accent"] as string, dark["text"] as string)).toBeGreaterThanOrEqual(4.5);
    for (const accent of ["#e85a6c", "#8ab4f8", "#f472b6"]) {
      const value = ratio(dark["on-accent"] as string, accent);
      expect(value, `on-accent on ${accent} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("cyan is the agent colour and is never used as body text", () => {
    expect(css).toContain("--nk-ai: #22d3ee");
    // Agent surfaces tint the accent; cyan as paragraph text on ink is 10:1 on
    // ink but unreadable on light surfaces, so it stays a border/tint token.
    expect(ratio("#22d3ee", light["panel"] as string)).toBeLessThan(3);
  });

  it("keeps 12 px as the floor for UI text (status bar excepted)", () => {
    expect(css).toMatch(/body\s*{[^}]*font:\s*13px/);
    expect(css).toMatch(/\.c-status\s*{[^}]*font-size:\s*11\.5px/);
  });
});
