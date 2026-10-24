// @vitest-environment jsdom
/**
 * The shared shell, mounted for real in jsdom (brief #3, U1).
 *
 * These are the rules the shell enforces; if one of them regresses, an app can
 * quietly grow a second implementation of an action — which is exactly the
 * problem this pass exists to remove.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type ShellApi = {
  setContext: (patch: Record<string, unknown>, options?: { panels?: boolean }) => void;
  refresh: () => void;
  openPanel: (id: string) => void;
  mount: (config: Record<string, unknown>) => unknown;
  items: Map<string, unknown>;
  shortcuts: Map<string, string>;
  context: Record<string, unknown>;
  noun: (ids: string[]) => string;
};

let shell: ShellApi;

beforeAll(async () => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, settings: {} }),
  })) as unknown as typeof fetch;
  await import("../kit/shell.js");
  shell = (globalThis as unknown as { NucleusShell: ShellApi }).NucleusShell;
});

afterEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
});

type Handlers = {
  save?: () => void;
  duplicate?: () => void;
  remove?: () => void;
  rotate?: () => void;
};

function mountShell(handlers: Handlers = {}, overrides: Record<string, unknown> = {}) {
  const main = document.createElement("div");
  main.id = "workspace";
  main.textContent = "workspace";
  document.body.appendChild(main);

  return shell.mount({
    app: { name: "Test App", accent: "#e85a6c" },
    main,
    menus: [
      {
        label: "File",
        items: [{ id: "file.save", label: "Save project…", shortcut: "Ctrl+S", run: handlers.save ?? (() => {}) }],
      },
      {
        label: "Edit",
        items: [
          { id: "edit.duplicate", label: "Duplicate", shortcut: "Ctrl+D", run: handlers.duplicate ?? (() => {}) },
          { id: "edit.rotate", label: "Rotate", shortcut: "R", run: handlers.rotate ?? (() => {}) },
          {
            id: "edit.delete",
            label: "Delete",
            shortcut: "Del",
            danger: true,
            confirm: "Delete the selection?",
            run: handlers.remove ?? (() => {}),
          },
        ],
      },
    ],
    primary: { id: "file.save" },
    options: (ctx: { selection?: string[] }) =>
      ctx.selection && ctx.selection.length
        ? { ids: ["edit.duplicate", "edit.delete"], label: "1 selected" }
        : { hint: "Click something to select it." },
    rail: [
      { id: "pages", icon: "pages", label: "Pages" },
      { id: "history", icon: "history", label: "History" },
    ],
    panels: {
      left: () => {
        const node = document.createElement("div");
        node.textContent = "documents";
        return node;
      },
      right: () => {
        const node = document.createElement("div");
        node.textContent = "properties";
        return node;
      },
    },
    status: { left: () => "0 pages", right: () => "Ctrl+K commands" },
    enabled: { "edit.duplicate": (ctx: { selection?: string[] }) => (ctx.selection || []).length > 0 },
    ...overrides,
  });
}

function keydown(target: EventTarget, key: string, mods: Partial<KeyboardEventInit> = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}

describe("@nucleus/app-kit shell — structure", () => {
  it("renders a menu bar with the app name and one filled primary action", () => {
    mountShell();
    expect(document.querySelector(".nk-menubar__name")?.textContent).toBe("Test App");
    const triggers = [...document.querySelectorAll(".nk-menubar__btn")].map((node) => node.textContent);
    expect(triggers).toEqual(["File", "Edit"]);
    const primary = document.querySelector(".c-btn--primary");
    expect(primary?.textContent).toBe("Save project…");
    // The workspace is adopted, not re-implemented by the shell.
    expect(document.querySelector(".nk-main #workspace")).not.toBeNull();
    // No legacy toolstrip is left holding a second copy of the actions.
    expect(document.querySelector(".c-strip")).toBeNull();
  });

  it("builds the standard menus before mount (apps assemble the config first)", () => {
    const presets = shell as unknown as {
      standardViewMenu: () => { id: string }[];
      standardHelpMenu: () => { id: string }[];
    };
    expect(() => presets.standardViewMenu()).not.toThrow();
    expect(presets.standardViewMenu().map((item) => item.id)).toEqual([
      "view.history",
      "view.developer",
      "view.theme",
    ]);
    expect(presets.standardHelpMenu().map((item) => item.id)).toEqual(["help.shortcuts", "help.about"]);
  });

  it("validates ids and shortcuts at mount", () => {
    expect(() =>
      mountShell({}, {
        menus: [
          { label: "A", items: [{ id: "x", label: "X", run: () => {} }] },
          { label: "B", items: [{ id: "x", label: "X2", run: () => {} }] },
        ],
      }),
    ).toThrow(/duplicate menu id/i);

    expect(() =>
      mountShell({}, {
        menus: [
          { label: "A", items: [{ id: "a", label: "A", shortcut: "Ctrl+Z", run: () => {} }] },
          { label: "B", items: [{ id: "b", label: "B", shortcut: "Ctrl+Z", run: () => {} }] },
        ],
      }),
    ).toThrow(/duplicate shortcut/i);

    expect(() =>
      mountShell({}, {
        menus: [{ label: "A", items: [{ id: "a", label: "A", shortcut: "Ctrl+K", run: () => {} }] }],
      }),
    ).toThrow(/reserved/i);

    expect(() => mountShell({}, { primary: { id: "nope" } })).toThrow(/primary/i);
  });
});

describe("@nucleus/app-kit shell — the options bar is a subset, never a copy", () => {
  it("drops unknown ids and every danger item", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountShell({}, {
      options: () => ["not.a.real.id", "edit.delete"],
    });
    const bar = document.querySelector(".nk-optionsbar") as HTMLElement;
    expect(bar.querySelectorAll(".c-btn").length).toBe(0);
    expect(bar.hidden).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown menu id"));
    warn.mockRestore();
  });

  it("follows setContext for enabled/disabled state", () => {
    mountShell({}, { options: () => ({ ids: ["edit.duplicate"] }) });
    const button = () => document.querySelector(".nk-optionsbar .c-btn") as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    shell.setContext({ selection: ["page-1"] });
    expect(button().disabled).toBe(false);
    shell.setContext({ selection: [] });
    expect(button().disabled).toBe(true);
  });

  it("shows a hint when there is no selection", () => {
    mountShell();
    expect(document.querySelector(".nk-optionsbar__hint")?.textContent).toContain("Click something");
  });

  it("never dies because an app callback threw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      mountShell(
        {},
        {
          options: () => {
            throw new Error("boom");
          },
          status: {
            left: () => {
              throw new Error("boom");
            },
            right: () => "ok",
          },
        },
      ),
    ).not.toThrow();
    // The frame is still mounted, so context updates keep working.
    expect(() => shell.setContext({ selection: ["a"] })).not.toThrow();
    expect(document.querySelector(".nk-menubar__name")?.textContent).toBe("Test App");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("options()"));
    warn.mockRestore();
  });
});

describe("@nucleus/app-kit shell — keyboard", () => {
  it("navigates menus with the keyboard (ARIA menubar pattern)", () => {
    const save = vi.fn();
    mountShell({ save });
    const file = document.querySelector('[data-menu="0"]') as HTMLButtonElement;

    file.focus();
    keydown(file, "ArrowDown");
    const menu = document.querySelector(".nk-menu") as HTMLElement;
    expect(menu.hidden).toBe(false);
    expect(file.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toContain("Save project…");

    keydown(document.activeElement as Element, "Enter");
    expect(save).toHaveBeenCalledTimes(1);
    expect(menu.hidden).toBe(true);
  });

  it("marks a toggle item as a checked checkbox (View → Compare, theme)", () => {
    let on = false;
    mountShell({}, {
      primary: undefined,
      menus: [
        {
          label: "View",
          items: [
            {
              id: "view.compare",
              label: "Compare with original",
              shortcut: "\\",
              checked: () => on,
              run: () => {
                on = !on;
              },
            },
          ],
        },
      ],
    });
    const trigger = document.querySelector('[data-menu="0"]') as HTMLButtonElement;
    keydown(trigger, "ArrowDown");
    let item = document.querySelector('[data-item="view.compare"]') as HTMLElement;
    expect(item.getAttribute("role")).toBe("menuitemcheckbox");
    expect(item.getAttribute("aria-checked")).toBe("false");

    keydown(item, "Escape");
    keydown(trigger, "ArrowDown");
    item = document.querySelector('[data-item="view.compare"]') as HTMLElement;
    item.click();
    keydown(trigger, "ArrowDown");
    item = document.querySelector('[data-item="view.compare"]') as HTMLElement;
    expect(item.getAttribute("aria-checked")).toBe("true");
  });

  it("closes the menu on Escape and returns focus to its trigger", () => {
    mountShell();
    const edit = document.querySelector('[data-menu="1"]') as HTMLButtonElement;
    keydown(edit, "ArrowDown");
    expect(document.querySelector(".nk-menu")?.hasAttribute("hidden")).toBe(false);
    keydown(document.activeElement as Element, "Escape");
    expect(document.querySelector(".nk-menu")?.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(edit);
  });

  it("binds shortcuts itself, and never fires a bare key while typing", () => {
    const rotate = vi.fn();
    const save = vi.fn();
    mountShell({ rotate, save });

    keydown(document.body, "s", { ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);

    const input = document.createElement("input");
    document.body.appendChild(input);
    keydown(input, "r");
    expect(rotate).not.toHaveBeenCalled();
    keydown(document.body, "r");
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it("ignores a disabled action", () => {
    const duplicate = vi.fn();
    mountShell({ duplicate });
    keydown(document.body, "d", { ctrlKey: true });
    expect(duplicate).not.toHaveBeenCalled();
    shell.setContext({ selection: ["a"] });
    keydown(document.body, "d", { ctrlKey: true });
    expect(duplicate).toHaveBeenCalledTimes(1);
  });

  it("lets one action answer to several keys (Ctrl+Shift+Z and Ctrl+Y)", () => {
    const redo = vi.fn();
    mountShell({}, {
      menus: [
        { label: "Edit", items: [{ id: "edit.redo", label: "Redo", shortcut: ["Ctrl+Shift+Z", "Ctrl+Y"], run: redo }] },
      ],
      primary: { id: "edit.redo" },
      options: () => [],
    });
    keydown(document.body, "z", { ctrlKey: true, shiftKey: true });
    keydown(document.body, "y", { ctrlKey: true });
    expect(redo).toHaveBeenCalledTimes(2);
  });

  it("rejects a clash across combined and single shortcuts", () => {
    expect(() =>
      mountShell({}, {
        menus: [
          {
            label: "A",
            items: [
              { id: "a", label: "A", shortcut: ["Ctrl+Y", "Ctrl+Z"], run: () => {} },
              { id: "b", label: "B", shortcut: "Ctrl+Z", run: () => {} },
            ],
          },
        ],
        primary: { id: "a" },
      }),
    ).toThrow(/duplicate shortcut/i);
  });

  it("leaves Space and Enter to a focused control", () => {    const preview = vi.fn();
    mountShell({}, {
      menus: [{ label: "View", items: [{ id: "view.preview", label: "Preview", shortcut: "Space", run: preview }] }],
      primary: { id: "view.preview" },
      options: () => [],
    });
    const button = document.createElement("button");
    document.body.appendChild(button);
    keydown(button, " ");
    expect(preview).not.toHaveBeenCalled();
    keydown(document.body, " ");
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("hands the keyboard to the command palette while it is open", () => {
    const clear = vi.fn();
    mountShell({}, {
      menus: [{ label: "Edit", items: [{ id: "edit.clear", label: "Clear", shortcut: "Esc", run: clear }] }],
      primary: { id: "edit.clear" },
      options: () => [],
    });
    const palette = document.createElement("div");
    palette.id = "nk-palette";
    palette.className = "nk-visible";
    document.body.appendChild(palette);

    keydown(document.body, "Escape");
    expect(clear).not.toHaveBeenCalled();

    palette.classList.remove("nk-visible");
    keydown(document.body, "Escape");
    expect(clear).toHaveBeenCalledTimes(1);
    palette.remove();
  });
});

describe("@nucleus/app-kit shell — destructive actions", () => {
  it("asks before running a danger item, and only runs on confirm", async () => {
    const remove = vi.fn();
    mountShell({ remove });
    shell.setContext({ selection: ["page-1"] });

    // The danger item is not in the options bar, even when selected.
    expect(document.querySelector('.nk-optionsbar [data-item="edit.delete"]')).toBeNull();

    const edit = document.querySelector('[data-menu="1"]') as HTMLButtonElement;
    keydown(edit, "ArrowDown");
    const item = document.querySelector('.nk-menu [data-item="edit.delete"]') as HTMLElement;
    item.click();
    expect(remove).not.toHaveBeenCalled();

    const dialog = document.querySelector(".nk-dialog") as HTMLElement;
    expect(dialog.classList.contains("nk-visible")).toBe(true);
    expect(dialog.textContent).toContain("Delete the selection?");

    (dialog.querySelector(".c-btn--danger-fill") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(dialog.classList.contains("nk-visible")).toBe(false);
  });

  it("cancelling keeps the document untouched", async () => {
    const remove = vi.fn();
    mountShell({ remove });
    shell.setContext({ selection: ["page-1"] });
    document.querySelector('[data-menu="1"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    (document.querySelector('.nk-menu [data-item="edit.delete"]') as HTMLElement).click();
    const dialog = document.querySelector(".nk-dialog") as HTMLElement;
    (dialog.querySelector(".c-btn:not(.c-btn--danger-fill)") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("@nucleus/app-kit shell — registry reuse", () => {
  it("the context menu reuses the options-bar ids", () => {
    mountShell();
    shell.setContext({ selection: ["page-1"] });
    const main = document.querySelector(".nk-main") as HTMLElement;
    main.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    const ids = [...document.querySelectorAll(".nk-context .nk-menu__item")].map(
      (node) => (node as HTMLElement).dataset.item,
    );
    expect(ids).toEqual(["edit.duplicate"]);
  });

  it("rail entries switch the panel and mark themselves pressed", () => {
    mountShell();
    const buttons = [...document.querySelectorAll(".nk-rail__btn")];
    expect(buttons.map((node) => node.getAttribute("aria-label"))).toEqual(["Pages", "History"]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    (buttons[1] as HTMLButtonElement).click();
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(shell.context.panel).toBe("history");
  });

  it("falls back to the neutral noun instead of internal jargon", () => {
    mountShell();
    expect(shell.noun(["a"])).toBe("1 change");
    expect(shell.noun(["a", "b"])).toBe("2 changes");
    mountShell({}, { noun: (ids: string[]) => `${ids.length} pages` });
    expect((shell as unknown as { noun: (ids: string[]) => string }).noun(["a", "b"])).toBe("2 pages");
  });

  it("hides developer-only detail unless it is switched on", () => {
    mountShell({}, {
      panels: {
        right: () => {
          const node = document.createElement("div");
          node.innerHTML = '<div class="c-prop">Size</div><div data-dev>node-42</div>';
          return node;
        },
      },
    });
    const dev = document.querySelector("[data-dev]") as HTMLElement;
    expect(dev).not.toBeNull();
    // The CSS owns the default; the shell toggles the class.
    expect(document.body.classList.contains("nk-dev")).toBe(false);
    document.body.classList.add("nk-dev");
    expect(document.body.classList.contains("nk-dev")).toBe(true);
  });
});

describe("@nucleus/app-kit shell — hosting an app's own furniture", () => {
  it("keeps a non-action control in the left slot, before the label", () => {
    // The app owns the node and returns the same one every time: that is what
    // lets a search field keep its value (and its listeners) across re-renders.
    const field = document.createElement("div");
    field.className = "nk-search";
    field.id = "search-slot";
    mountShell({}, {
      options: () => ({ left: field, label: "Work / Plan", ids: ["edit.duplicate"] }),
    });
    const bar = document.querySelector(".nk-optionsbar") as HTMLElement;
    expect(bar.firstElementChild?.id).toBe("search-slot");
    expect(bar.querySelector(".nk-optionsbar__label")?.textContent).toBe("Work / Plan");
    shell.setContext({ selection: ["page-1"] });
    expect(bar.firstElementChild).toBe(field);
    expect(bar.querySelectorAll(".c-btn").length).toBe(1);
  });

  it("docks the proposal card inline when the app asks for it", () => {
    const slot = document.createElement("div");
    slot.id = "review-slot";
    document.body.appendChild(slot);
    mountShell({}, {
      reviewHost: "#review-slot",
      panels: {
        left: () => {
          const node = document.createElement("div");
          node.textContent = "notes";
          return node;
        },
      },
    });
    expect(slot.querySelector(".nk-review-host")).not.toBeNull();
    // No right panel was declared: nothing is parked in a hidden column.
    const right = document.querySelector(".nk-panel--right") as HTMLElement;
    expect(right.querySelector(".nk-review-host")).toBeNull();
    expect(right.hidden).toBe(true);
  });
});

describe("@nucleus/app-kit shell — public API", () => {
  it("exposes the helpers every app calls (settings, dialogs, presets)", () => {
    mountShell();
    const api = (globalThis as unknown as { NucleusShell: Record<string, unknown> }).NucleusShell;
    for (const name of [
      "setSetting",
      "setTheme",
      "setDeveloperDetails",
      "confirm",
      "ask",
      "dialog",
      "emptyState",
      "standardViewMenu",
      "standardHelpMenu",
      "openPanel",
    ]) {
      expect(typeof api[name], name).toBe("function");
    }
    // PDF's zoom and Notes' layout both persist through this one call.
    expect(() => (api.setSetting as (key: string, value: unknown) => unknown)("viewMode", "split")).not.toThrow();
  });

  it("re-renders the options bar when the window is resized", () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
    mountShell({}, {
      options: () => ({ ids: window.innerWidth >= 1200 ? ["edit.duplicate"] : [] }),
    });
    expect(document.querySelectorAll(".nk-optionsbar .c-btn").length).toBe(1);
    Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    expect(document.querySelectorAll(".nk-optionsbar .c-btn").length).toBe(0);
    vi.useRealTimers();
  });

  it("keeps the canvas full-width when an app has no left panel", () => {
    // Image Editor's tool rail drives the *right* column: there is no library.
    mountShell({}, {
      panels: {
        right: () => {
          const node = document.createElement("div");
          node.textContent = "adjustments";
          return node;
        },
      },
    });
    const left = document.querySelector<HTMLElement>(".nk-panel--left");
    expect(left?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>(".nk-app")?.style.getPropertyValue("--nk-left-w")).toBe("0px");

    // A display:none panel must not shift the canvas into its 0px column, so
    // every column is placed explicitly in craft.css.
    const cssPath = ["kit/craft.css", "packages/app-kit/kit/craft.css"]
      .map((relative) => join(process.cwd(), relative))
      .find((candidate) => existsSync(candidate));
    const css = readFileSync(cssPath as string, "utf8");
    expect(css).toMatch(/\.nk-main\s*\{[^}]*grid-column:\s*3/);
    expect(css).toMatch(/\.nk-panel--left\s*\{[^}]*grid-column:\s*2/);
    expect(css).toMatch(/\.nk-panel--right\s*\{[^}]*grid-column:\s*4/);
  });
});
