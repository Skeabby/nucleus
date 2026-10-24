/* shell.js — the shared app shell (@nucleus/app-kit, brief #3 §3.1).
   Vanilla JS, no framework, no remote asset.

   Apps stop hand-writing toolstrips: they describe *what* they can do and the
   shell decides *where* it goes.

     NucleusShell.mount({
       app:     { name, accent },
       menus:   [{ label, items: [{ id, label, shortcut, run, danger, confirm, command, checked }] }],
       primary: { id },                       // the one filled-accent action
       options: (ctx) => [...ids] | { ids, hint, label, right },
       rail:    [{ id, icon, label }],
       panels:  { left: (ctx) => Node, right: (ctx) => Node },
       status:  { left: (ctx) => string, right: (ctx) => Node | string },
       enabled: { "page.rotateLeft": (ctx) => ctx.selection.length > 0 },
       noun:    (nodeIds) => "2 pages",
       highlight: (nodeIds, kind) => {},
       main:    element | selector | () => element,
     });
     NucleusShell.setContext({ selection: [...] });

   Rules the shell enforces (and test/shell.test.ts asserts):
     - menu item ids are unique; duplicate shortcuts throw at mount
     - the options bar can only reference existing ids (no second implementation)
     - the palette (Ctrl+K) lists menu items + bus commands, de-duplicated by id
     - `danger` + `confirm` items always ask, and never appear in the options bar
     - one shortcut registry, bound by the shell (apps stop adding key handlers)
     - WAI-ARIA menubar: roles, arrow keys, Esc, typeahead, roving tabindex
     - icon-only buttons carry aria-label; reducer motion preference respected */
(function () {
  "use strict";

  // ------------------------------------------------------------------ icons
  /* One small stroke set, reused by every app (no emoji, hard edges). */
  const PATHS = {
    pages: '<rect x="4" y="3" width="11" height="15"/><path d="M7 3v-1h13v15h-1"/>',
    search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="M15 15l5 5"/>',
    history: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    adjust: '<path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0"/><rect x="14" y="5" width="3" height="4"/><rect x="8" y="10" width="3" height="4"/><rect x="16" y="15" width="3" height="4"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
    crop: '<path d="M6 3v15h15M3 6h15v15"/>',
    resize: '<path d="M4 10V4h6M20 14v6h-6M4 4l6 6M20 20l-6-6"/>',
    image: '<rect x="3" y="4" width="18" height="16"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 3 3 3-3 5 5"/>',
    note: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    dot: '<circle cx="12" cy="12" r="1.5"/>',
  };

  const ICON_NS = "http://www.w3.org/2000/svg";

  function icon(name, size) {
    const wrap = document.createElement("span");
    wrap.className = "nk-icon";
    const svg = document.createElementNS(ICON_NS, "svg");
    svg.setAttribute("width", String(size || 16));
    svg.setAttribute("height", String(size || 16));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "square");
    svg.setAttribute("stroke-linejoin", "miter");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = PATHS[name] || PATHS.dot;
    wrap.appendChild(svg);
    return wrap;
  }

  // ------------------------------------------------------------------- state

  const state = {
    mounted: false,
    config: null,
    root: null,
    els: {},
    ctx: {},
    items: new Map(),
    menus: [],
    shortcuts: new Map(),
    openMenu: -1,
    options: [],
    settings: {},
    dialogResolve: null,
    kitWired: false,
    resizeTimer: null,
  };

  /** Shortcuts the shell owns; an app declaring them is a bug. */
  const RESERVED_SHORTCUTS = new Set(["ctrl+k"]);

  const KEY_ALIASES = {
    del: "delete",
    esc: "escape",
    space: " ",
    left: "arrowleft",
    right: "arrowright",
    up: "arrowup",
    down: "arrowdown",
    return: "enter",
  };

  // ------------------------------------------------------------------- utils

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeShortcut(text) {
    let raw = String(text).trim();
    let plusKey = false;
    if (raw.endsWith("++")) {
      plusKey = true;
      raw = raw.slice(0, -1);
    }
    const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
    const mods = { ctrl: false, meta: false, alt: false, shift: false };
    let key = "";
    for (const part of parts) {
      const word = part.toLowerCase();
      if (word === "ctrl" || word === "control") mods.ctrl = true;
      else if (word === "meta" || word === "cmd" || word === "win") mods.meta = true;
      else if (word === "alt" || word === "option") mods.alt = true;
      else if (word === "shift") mods.shift = true;
      else key = word;
    }
    if (plusKey) key = "+";
    if (!key) return "";
    const normalized = KEY_ALIASES[key] || key;
    const ordered = [];
    if (mods.ctrl) ordered.push("ctrl");
    if (mods.meta) ordered.push("meta");
    if (mods.alt) ordered.push("alt");
    if (mods.shift) ordered.push("shift");
    ordered.push(normalized);
    return ordered.join("+");
  }

  function comboFromEvent(event) {
    const raw = String(event.key || "").toLowerCase();
    const key = KEY_ALIASES[raw] || raw;
    if (!key) return "";
    const ordered = [];
    if (event.ctrlKey) ordered.push("ctrl");
    if (event.metaKey) ordered.push("meta");
    if (event.altKey) ordered.push("alt");
    if (event.shiftKey) ordered.push("shift");
    ordered.push(key);
    return ordered.join("+");
  }

  function isTypingTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  /** Space/Enter on a focused control belong to that control, not to the app. */
  function isInteractiveTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (isTypingTarget(target)) return true;
    return Boolean(target.closest("button, a[href], summary, [role='button'], [role='menuitem'], [role='tab']"));
  }

  /** One item may answer to several keys; the menu shows the first one. */
  function shortcutList(item) {
    if (!item || !item.shortcut) return [];
    return Array.isArray(item.shortcut) ? item.shortcut : [item.shortcut];
  }

  function shortcutLabel(item) {
    return shortcutList(item)[0] || "";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // ------------------------------------------------------------- validation

  function validate(config) {
    const items = new Map();
    const shortcuts = new Map();
    const menus = config.menus || [];
    for (const menu of menus) {
      for (const item of menu.items || []) {
        if (!item || item.sep) continue;
        if (!item.id) throw new Error("NucleusShell: a menu item in " + menu.label + " has no id");
        if (items.has(item.id)) throw new Error("NucleusShell: duplicate menu id: " + item.id);
        items.set(item.id, Object.assign({ menu: menu.label }, item));
        for (const text of shortcutList(item)) {
          const combo = normalizeShortcut(text);
          if (!combo) throw new Error("NucleusShell: bad shortcut: " + text);
          if (RESERVED_SHORTCUTS.has(combo)) {
            throw new Error("NucleusShell: " + text + " is reserved for the command palette");
          }
          const owner = shortcuts.get(combo);
          if (owner) {
            throw new Error("NucleusShell: duplicate shortcut " + text + " (" + owner + " and " + item.id + ")");
          }
          shortcuts.set(combo, item.id);
        }
      }
    }
    const primary = config.primary && config.primary.id;
    if (primary && !items.has(primary)) {
      throw new Error("NucleusShell: primary must reference a menu item: " + primary);
    }
    const rail = config.rail || [];
    const railIds = new Set();
    for (const entry of rail) {
      if (!entry.id) throw new Error("NucleusShell: a rail entry has no id");
      if (railIds.has(entry.id)) throw new Error("NucleusShell: duplicate rail id: " + entry.id);
      railIds.add(entry.id);
    }
    return { items, shortcuts, menus, rail, primary };
  }

  // ------------------------------------------------------------------ chrome

  function buildChrome() {
    const config = state.config;
    const app = config.app || { name: "Nucleus" };
    const root = el("div", "nk-app");
    root.setAttribute("data-nk-app", "");

    const menubar = el("header", "nk-menubar");
    menubar.setAttribute("role", "menubar");
    menubar.setAttribute("aria-label", app.name);

    const brand = el("div", "nk-menubar__brand");
    brand.appendChild(el("span", "nk-menubar__mark"));
    brand.appendChild(el("span", "nk-menubar__name", app.name));
    menubar.appendChild(brand);

    state.menus.forEach((menu, index) => {
      const trigger = el("button", "nk-menubar__btn", menu.label);
      trigger.type = "button";
      trigger.setAttribute("role", "menuitem");
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      trigger.dataset.menu = String(index);
      trigger.addEventListener("click", () => {
        if (state.openMenu === index) closeMenu();
        else openMenu(index, { focusFirst: false });
      });
      trigger.addEventListener("mouseenter", () => {
        if (state.openMenu !== -1 && state.openMenu !== index) openMenu(index, { focusFirst: false });
      });
      trigger.addEventListener("keydown", (event) => onTriggerKey(event, index));
      menubar.appendChild(trigger);
    });

    menubar.appendChild(el("span", "nk-menubar__spring"));

    const palette = el("button", "nk-menubar__palette", "Ctrl K");
    palette.type = "button";
    palette.title = "Command palette (Ctrl+K)";
    palette.setAttribute("aria-label", "Command palette (Ctrl+K)");
    palette.addEventListener("click", () => openPalette());
    menubar.appendChild(palette);

    const primary = config.primary && state.items.get(config.primary.id);
    const primaryBtn = el("button", "c-btn--primary", primary ? primary.label : "");
    primaryBtn.type = "button";
    if (primary) primaryBtn.dataset.item = primary.id;
    primaryBtn.hidden = !primary;
    primaryBtn.addEventListener("click", () => primary && void runItem(primary.id));
    menubar.appendChild(primaryBtn);

    // Options bar: a contextual subset of the menus, never a second registry.
    const optionsbar = el("div", "nk-optionsbar");
    optionsbar.setAttribute("role", "toolbar");
    optionsbar.setAttribute("aria-label", "Actions for the current selection");

    // Body: icon rail · left panel · main · right panel.
    const body = el("div", "nk-body");

    const rail = el("nav", "nk-rail");
    rail.setAttribute("aria-label", "Panels");
    state.rail.forEach((entry) => {
      const btn = el("button", "nk-rail__btn");
      btn.type = "button";
      btn.dataset.panel = entry.id;
      btn.setAttribute("aria-label", entry.label);
      btn.setAttribute("title", entry.label);
      btn.setAttribute("aria-pressed", "false");
      btn.appendChild(icon(entry.icon || "dot", 16));
      btn.addEventListener("click", () => selectPanel(entry.id));
      rail.appendChild(btn);
    });
    rail.hidden = state.rail.length === 0;

    const left = el("aside", "nk-panel nk-panel--left");
    left.setAttribute("aria-label", "Library");
    const right = el("aside", "nk-panel nk-panel--right");
    right.setAttribute("aria-label", "Properties");

    // The proposal card lives at the top of the right panel (or inline, if the
    // app moves this node into its own layout).
    const reviewHost = el("div", "nk-review-host");

    const main = el("main", "nk-main");
    main.setAttribute("aria-label", app.name + " workspace");

    body.appendChild(rail);
    body.appendChild(left);
    body.appendChild(main);
    body.appendChild(right);

    const statusbar = el("footer", "c-status nk-statusbar");
    const statusLeft = el("span", "nk-statusbar__left");
    const statusSpring = el("span", "c-status__spring");
    const statusRight = el("span", "nk-statusbar__right");
    statusbar.appendChild(statusLeft);
    statusbar.appendChild(statusSpring);
    statusbar.appendChild(statusRight);

    const menu = el("div", "nk-menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const context = el("div", "nk-menu nk-context");
    context.setAttribute("role", "menu");
    context.hidden = true;

    const dialog = el("div", "nk-dialog");
    dialog.innerHTML = [
      '<div class="nk-dialog__box" role="dialog" aria-modal="true" aria-labelledby="nk-dialog-title">',
      '  <h2 class="nk-dialog__title" id="nk-dialog-title"></h2>',
      '  <div class="nk-dialog__body"></div>',
      '  <div class="nk-dialog__actions"></div>',
      "</div>",
    ].join("");

    root.appendChild(menubar);
    root.appendChild(optionsbar);
    root.appendChild(body);
    root.appendChild(statusbar);

    Object.assign(state.els, {
      root,
      menubar,
      brand,
      palette,
      primary: primaryBtn,
      optionsbar,
      body,
      rail,
      left,
      right,
      main,
      reviewHost,
      statusbar,
      statusLeft,
      statusRight,
      menu,
      context,
      dialog,
    });

    return root;
  }

  // --------------------------------------------------------------- mounting

  function mount(config) {
    if (state.mounted) unmount();
    state.config = config || {};
    state.ctx = Object.assign({}, state.config.context || {});
    const validated = validate(state.config);
    state.items = validated.items;
    state.shortcuts = validated.shortcuts;
    state.menus = validated.menus;
    state.rail = validated.rail;

    const rootEl = buildChrome();
    document.body.classList.add("nk-shell");
    if (state.config.app && state.config.app.accent) {
      document.documentElement.style.setProperty("--nk-app-accent", state.config.app.accent);
    }

    const host = resolveHost(state.config.root);
    if (host === document.body) host.insertBefore(rootEl, host.firstChild);
    else host.replaceChildren(rootEl);

    // Attach the app's workspace into the shell (it keeps its own DOM).
    const mainEl = resolveMain(state.config.main);
    if (mainEl) state.els.main.appendChild(mainEl);

    // Panels: hidden until they have content, so an app with no library still
    // gets the full width for its canvas.
    state.els.left.hidden = !state.config.panels || !state.config.panels.left;
    state.els.right.hidden = !state.config.panels || !state.config.panels.right;
    // The proposal card lives at the top of the right panel by default. Notes
    // asks for it inline, above the title (brief #3 §4.2): `reviewHost` wins
    // over the right panel when it points at a real element.
    const inlineReview = resolveHost(state.config.reviewHost);
    if (inlineReview && inlineReview !== document.body) {
      inlineReview.appendChild(state.els.reviewHost);
    } else {
      state.els.right.insertBefore(state.els.reviewHost, state.els.right.firstChild);
    }

    document.body.appendChild(state.els.menu);
    document.body.appendChild(state.els.context);
    document.body.appendChild(state.els.dialog);

    // Panel widths (settings may override the defaults).
    setPanelWidths();

    const activePanel =
      state.ctx.panel || (state.rail[0] && state.rail[0].id) || null;
    if (activePanel) state.ctx.panel = activePanel;

    renderRail();
    renderOptions();
    renderPanels();
    renderStatus();
    renderPrimary();
    wireEvents();

    state.mounted = true;
    void loadSettings().then(() => {
      renderOptions();
      renderStatus();
      renderPanels();
      renderPrimary();
    });
    wireKit();

    return api;
  }

  function unmount() {
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("mousedown", onDocumentMouseDown, true);
    if (state.els.root && state.els.root.parentNode) state.els.root.parentNode.removeChild(state.els.root);
    for (const key of ["menu", "context", "dialog"]) {
      const node = state.els[key];
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    document.body.classList.remove("nk-shell");
    state.mounted = false;
  }

  function resolveHost(target) {
    if (!target) return document.body;
    if (typeof target === "string") return document.querySelector(target) || document.body;
    return target;
  }

  function resolveMain(target) {
    if (!target) return document.querySelector("[data-nk-main]") || null;
    if (typeof target === "function") return target();
    if (typeof target === "string") return document.querySelector(target);
    return target;
  }

  const api = {
    get el() {
      return state.els;
    },
    get ctx() {
      return state.ctx;
    },
    get reviewHost() {
      return state.els.reviewHost;
    },
    setContext,
    refresh,
    run: (id) => runItem(id),
    openPanel: selectPanel,
    confirm: (message, options) => confirmDialog(message, options),
    toast: (message, kind) => toast(message, kind),
    setDeveloperDetails,
    setTheme,
    setSetting,
    getSettings: () => Object.assign({}, state.settings),
    icon,
  };

  // ------------------------------------------------------------------ events

  function wireEvents() {
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("mousedown", onDocumentMouseDown, true);

    state.els.menu.addEventListener("keydown", onMenuKey);
    state.els.context.addEventListener("keydown", onMenuKey);
    state.els.dialog.addEventListener("keydown", onDialogKey);

    state.els.main.addEventListener("contextmenu", (event) => {
      if (!state.options.length) return;
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY);
    });

    window.addEventListener("resize", () => {
      if (state.openMenu !== -1) positionMenu(state.openMenu);
      // The options bar is contextual by width (Notes hides its formatting
      // row below 1200 px): re-read it, once the user stops dragging.
      clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(() => renderOptions(), 120);
    });
  }

  function onDocumentMouseDown(event) {
    if (state.openMenu === -1) return;
    const target = event.target;
    if (state.els.menu.contains(target)) return;
    if (target instanceof HTMLElement && target.closest(".nk-menubar")) return;
    closeMenu();
  }

  function onKeydown(event) {
    const combo = comboFromEvent(event);
    if (!combo) return;
    // The command palette is its own surface: it owns the keyboard while it is up.
    if (document.querySelector("#nk-palette.nk-visible")) return;
    if (isDialogOpen()) {
      if (combo === "escape") {
        event.preventDefault();
        resolveDialog(false);
      }
      return;
    }
    if (state.openMenu !== -1 && combo === "escape") {
      event.preventDefault();
      const trigger = triggerAt(state.openMenu);
      closeMenu();
      if (trigger) trigger.focus();
      return;
    }
    const id = state.shortcuts.get(combo);
    if (!id) return;
    const bare = !event.ctrlKey && !event.metaKey && !event.altKey;
    // Bare keys (R, H, Del…) must never fire while the user is typing.
    if (bare && isTypingTarget(event.target)) return;
    // Space and Enter activate the focused control; the shell must not steal them.
    if (bare && (combo === " " || combo === "enter") && isInteractiveTarget(event.target)) return;
    if (isDisabled(id)) return;
    event.preventDefault();
    void runItem(id);
  }

  // ------------------------------------------------------------------- menus

  function triggerAt(index) {
    return state.els.menubar.querySelector('[data-menu="' + index + '"]');
  }

  function onTriggerKey(event, index) {
    const key = event.key;
    if (key === "ArrowDown" || key === "Enter" || key === " ") {
      event.preventDefault();
      openMenu(index, { focusFirst: true });
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      const count = state.menus.length;
      const next = (index + (key === "ArrowRight" ? 1 : -1) + count) % count;
      const trigger = triggerAt(next);
      if (trigger) trigger.focus();
      if (state.openMenu !== -1) openMenu(next, { focusFirst: false });
    } else if (key === "Escape") {
      closeMenu();
    }
  }

  function openMenu(index, options) {
    const menu = state.menus[index];
    if (!menu) return;
    state.openMenu = index;
    const popup = state.els.menu;
    popup.innerHTML = "";
    popup.dataset.menu = String(index);
    let focusables = [];

    for (const item of menu.items || []) {
      if (!item || item.sep) {
        popup.appendChild(el("div", "nk-menu__sep"));
        popup.lastChild.setAttribute("role", "separator");
        continue;
      }
      const node = el("button", "nk-menu__item");
      node.type = "button";
      node.dataset.item = item.id;
      node.setAttribute("role", "menuitem");
      node.setAttribute("tabindex", "-1");
      // A toggle is a checkbox for assistive tech, not just a ✓ glyph.
      if (typeof item.checked === "function") {
        node.setAttribute("role", "menuitemcheckbox");
        node.setAttribute("aria-checked", String(checking(item)));
      }
      if (isDisabled(item.id)) node.setAttribute("aria-disabled", "true");
      if (item.danger) node.classList.add("nk-menu__item--danger");

      const mark = el("span", "nk-menu__check", checking(item) ? "\u2713" : "");
      mark.setAttribute("aria-hidden", "true");
      node.appendChild(mark);
      node.appendChild(el("span", "nk-menu__label", item.label));
      const keyLabel = shortcutLabel(item);
      if (keyLabel) node.appendChild(el("span", "nk-menu__key", keyLabel));

      node.addEventListener("click", () => void runItem(item.id));
      node.addEventListener("mouseenter", () => node.focus());
      popup.appendChild(node);
      if (!isDisabled(item.id)) focusables.push(node);
    }

    for (const trigger of state.els.menubar.querySelectorAll(".nk-menubar__btn")) {
      trigger.setAttribute("aria-expanded", String(Number(trigger.dataset.menu) === index));
    }

    popup.hidden = false;
    positionMenu(index);
    if (options && options.focusFirst && focusables[0]) focusables[0].focus();
  }

  function positionMenu(index) {
    const trigger = triggerAt(index);
    const popup = state.els.menu;
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    popup.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 240)) + "px";
    popup.style.top = Math.max(0, rect.bottom) + "px";
  }

  function closeMenu() {
    if (state.openMenu === -1) return;
    state.openMenu = -1;
    state.els.menu.hidden = true;
    state.els.menu.innerHTML = "";
    for (const trigger of state.els.menubar.querySelectorAll(".nk-menubar__btn")) {
      trigger.setAttribute("aria-expanded", "false");
    }
  }

  function onMenuKey(event) {
    const popup = event.currentTarget;
    const nodes = [...popup.querySelectorAll(".nk-menu__item:not([aria-disabled='true'])")];
    if (nodes.length === 0) return;
    const current = document.activeElement;
    const index = nodes.indexOf(current);
    const key = event.key;

    if (key === "ArrowDown") {
      event.preventDefault();
      nodes[(index + 1 + nodes.length) % nodes.length].focus();
    } else if (key === "ArrowUp") {
      event.preventDefault();
      nodes[(index - 1 + nodes.length) % nodes.length].focus();
    } else if (key === "Home") {
      event.preventDefault();
      nodes[0].focus();
    } else if (key === "End") {
      event.preventDefault();
      nodes[nodes.length - 1].focus();
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (current instanceof HTMLElement && current.dataset.item) void runItem(current.dataset.item);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      if (popup === state.els.context) return;
      event.preventDefault();
      const count = state.menus.length;
      const next = (state.openMenu + (key === "ArrowRight" ? 1 : -1) + count) % count;
      openMenu(next, { focusFirst: true });
    } else if (key === "Escape") {
      event.preventDefault();
      const trigger = triggerAt(state.openMenu);
      closeMenu();
      if (trigger) trigger.focus();
    } else if (key === "Tab") {
      closeMenu();
    } else if (key.length === 1 && /\S/.test(key)) {
      // First-letter typeahead, starting after the focused item.
      const needle = key.toLowerCase();
      const ordered = nodes.slice(index + 1).concat(nodes.slice(0, index + 1));
      const hit = ordered.find((node) => (node.textContent || "").trim().toLowerCase().startsWith(needle));
      if (hit) {
        event.preventDefault();
        hit.focus();
      }
    }
  }

  function openContextMenu(x, y) {
    const popup = state.els.context;
    popup.innerHTML = "";
    for (const id of state.options) {
      const item = state.items.get(id);
      if (!item) continue;
      const node = el("button", "nk-menu__item");
      node.type = "button";
      node.dataset.item = id;
      node.setAttribute("role", "menuitem");
      node.setAttribute("tabindex", "-1");
      if (isDisabled(id)) node.setAttribute("aria-disabled", "true");
      if (item.danger) node.classList.add("nk-menu__item--danger");
      node.appendChild(el("span", "nk-menu__check"));
      node.appendChild(el("span", "nk-menu__label", item.label));
      const keyLabel = shortcutLabel(item);
      if (keyLabel) node.appendChild(el("span", "nk-menu__key", keyLabel));
      node.addEventListener("click", () => void runItem(id));
      popup.appendChild(node);
    }
    popup.style.left = Math.min(x, window.innerWidth - 240) + "px";
    popup.style.top = Math.min(y, window.innerHeight - 40) + "px";
    popup.hidden = false;
    const first = popup.querySelector(".nk-menu__item:not([aria-disabled='true'])");
    if (first) first.focus();
    const dismiss = (event) => {
      if (popup.contains(event.target)) return;
      popup.hidden = true;
      popup.innerHTML = "";
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", onEsc, true);
    };
    const onEsc = (event) => {
      if (event.key !== "Escape") return;
      dismiss({ target: document.body });
      event.preventDefault();
    };
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", onEsc, true);
  }

  // ---------------------------------------------------------------- commands

  function isDisabled(id) {
    const guard = state.config.enabled && state.config.enabled[id];
    if (typeof guard !== "function") return false;
    try {
      return !guard(state.ctx);
    } catch {
      return false;
    }
  }

  function checking(item) {
    if (typeof item.checked === "function") {
      try {
        return !!item.checked(state.ctx);
      } catch {
        return false;
      }
    }
    return false;
  }

  async function runItem(id) {
    const item = state.items.get(id);
    if (!item || isDisabled(id)) return;
    closeMenu();
    if (item.danger && item.confirm) {
      const accepted = await confirmDialog(item.confirm, {
        title: item.label,
        confirmLabel: item.label.replace(/\u2026$/, ""),
        danger: true,
      });
      if (!accepted) return;
    }
    try {
      await item.run?.(state.ctx);
    } catch (error) {
      toast(String((error && error.message) || error), "error");
    }
    refresh({ panels: false });
  }

  // ---------------------------------------------------------------- options

  /** One app callback must never take the shell down: log it, keep the frame. */
  function safeCall(fn, fallback, label) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch (error) {
      if (typeof console !== "undefined") {
        console.warn("NucleusShell: " + label + " threw: " + ((error && error.message) || error));
      }
      return fallback;
    }
  }

  function renderOptions() {
    const bar = state.els.optionsbar;
    bar.innerHTML = "";
    const config = state.config;
    const result =
      typeof config.options === "function"
        ? safeCall(() => config.options(state.ctx), undefined, "options()")
        : config.options;

    let ids = [];
    let hint = "";
    let label = "";
    let right = null;
    let left = null;
    if (Array.isArray(result)) ids = result;
    else if (typeof result === "string") hint = result;
    else if (result && typeof result === "object") {
      ids = Array.isArray(result.ids) ? result.ids : [];
      hint = result.hint || "";
      label = result.label || "";
      right = result.right || null;
      left = result.left || null;
    }

    const usable = [];
    for (const id of ids) {
      const item = state.items.get(id);
      if (!item) {
        if (typeof console !== "undefined") {
          console.warn("NucleusShell: options bar references an unknown menu id: " + id);
        }
        continue;
      }
      // A destructive action never sits next to routine ones (P2).
      if (item.danger || item.confirm) continue;
      usable.push(item);
    }
    state.options = usable.map((item) => item.id);

    bar.hidden = usable.length === 0 && !hint && !label && !right && !left;
    state.els.root.style.setProperty("--nk-optionsbar-h", bar.hidden ? "0px" : "46px");

    // A control that is not an action (Notes' search field) sits at the far
    // left, before the label: the bar reads "where am I · what can I do".
    if (left) bar.appendChild(left);
    if (label) {
      const tag = el("span", "nk-optionsbar__label");
      tag.appendChild(document.createTextNode(label));
      bar.appendChild(tag);
    }
    for (const item of usable) {
      const btn = el("button", "c-btn", item.label);
      btn.type = "button";
      btn.dataset.item = item.id;
      const keyLabel = shortcutLabel(item);
      if (keyLabel) btn.title = item.label + " (" + keyLabel + ")";
      if (isDisabled(item.id)) btn.disabled = true;
      btn.addEventListener("click", () => void runItem(item.id));
      bar.appendChild(btn);
    }
    if (hint) bar.appendChild(el("span", "nk-optionsbar__hint", hint));
    if (right) {
      bar.appendChild(el("span", "nk-optionsbar__spring"));
      bar.appendChild(right);
    }
    renderPrimary();
    renderRail();
  }

  function renderPrimary() {
    const primary = state.config && state.config.primary && state.items.get(state.config.primary.id);
    const btn = state.els.primary;
    if (!btn) return;
    btn.hidden = !primary;
    if (primary) btn.disabled = isDisabled(primary.id);
  }

  function renderRail() {
    if (!state.els.rail) return;
    for (const btn of state.els.rail.querySelectorAll(".nk-rail__btn")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.panel === state.ctx.panel));
    }
  }

  function selectPanel(id) {
    state.ctx.panel = id;
    renderRail();
    renderPanels();
    const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1000px)").matches;
    if (narrow) {
      state.els.left.classList.add("nk-panel--open");
      state.els.left.hidden = false;
    }
    refresh({ panels: false });
  }

  function renderPanels() {
    const config = state.config;
    const left = state.els.left;
    const right = state.els.right;

    if (config.panels && typeof config.panels.left === "function") {
      const content = safeCall(() => config.panels.left(state.ctx, state.ctx.panel), null, "panels.left()");
      left.innerHTML = "";
      if (content) left.appendChild(content);
      else if (state.ctx.panel === "history") left.appendChild(historyFallback());
      left.hidden = left.childNodes.length === 0;
    } else {
      left.hidden = true;
    }

    if (config.panels && typeof config.panels.right === "function") {
      const content = safeCall(() => config.panels.right(state.ctx), null, "panels.right()");
      // The review card is the first child; keep it.
      for (const child of [...right.children]) {
        if (child !== state.els.reviewHost) child.remove();
      }
      if (content) right.appendChild(content);
      right.hidden = false;
    } else {
      right.hidden = true;
    }
    setPanelWidths();
  }

  function historyFallback() {
    const host = el("div", "nk-history");
    if (window.NucleusKit && typeof window.NucleusKit.historyView === "function") {
      window.NucleusKit.historyView(host, { appNoun: state.config.noun });
    } else {
      host.appendChild(el("div", "nk-history__empty", "History is unavailable in this build."));
    }
    return host;
  }

  function setPanelWidths() {
    const widths = state.settings.panelWidths || {};
    const leftW = clamp(Number(widths.left) || 264, 220, 280);
    const rightW = clamp(Number(widths.right) || 280, 220, 320);
    const root = state.els.root;
    if (!root) return;
    root.style.setProperty("--nk-left-w", state.els.left.hidden ? "0px" : leftW + "px");
    root.style.setProperty("--nk-right-w", state.els.right.hidden ? "0px" : rightW + "px");
    root.style.setProperty("--nk-iconrail-w", state.els.rail.hidden ? "0px" : "44px");
  }

  function renderStatus() {
    const config = state.config;
    const status = config.status || {};
    fill(
      state.els.statusLeft,
      typeof status.left === "function" ? safeCall(() => status.left(state.ctx), "", "status.left()") : status.left,
    );
    fill(
      state.els.statusRight,
      typeof status.right === "function" ? safeCall(() => status.right(state.ctx), "", "status.right()") : status.right,
    );
  }

  function fill(node, value) {
    if (!node) return;
    node.innerHTML = "";
    if (value === undefined || value === null || value === "") return;
    if (value instanceof Node) node.appendChild(value);
    else node.textContent = String(value);
  }

  // --------------------------------------------------------------- context

  function setContext(patch, options) {
    Object.assign(state.ctx, patch || {});
    renderOptions();
    renderStatus();
    if (!options || options.panels !== false) renderPanels();
    if (!options || options.menus !== false) {
      // An open menu keeps its position but re-reads enabled/checked states.
      if (state.openMenu !== -1) openMenu(state.openMenu, { focusFirst: false });
    }
  }

  function refresh(options) {
    renderOptions();
    renderStatus();
    renderPrimary();
    if (options && options.panels === false) return;
    renderPanels();
  }

  // ---------------------------------------------------------------- dialogs

  function isDialogOpen() {
    return state.els.dialog && state.els.dialog.classList.contains("nk-visible");
  }

  function openDialog(options) {
    const config = options || {};
    const dialog = state.els.dialog;
    dialog.querySelector(".nk-dialog__title").textContent = config.title || "";
    const body = dialog.querySelector(".nk-dialog__body");
    body.innerHTML = "";
    if (config.content instanceof Node) body.appendChild(config.content);
    else body.textContent = config.body || "";

    const actions = dialog.querySelector(".nk-dialog__actions");
    actions.innerHTML = "";
    const buttons = config.actions || [{ label: "OK", value: true, primary: true }];
    const nodes = [];
    for (const action of buttons) {
      const btn = el("button", "c-btn", action.label);
      btn.type = "button";
      if (action.primary) btn.classList.add("c-btn--primary");
      if (action.danger) btn.classList.add("c-btn--danger-fill");
      btn.addEventListener("click", () =>
        resolveDialog(typeof action.value === "function" ? action.value() : action.value),
      );
      actions.appendChild(btn);
      nodes.push(btn);
    }
    dialog.classList.add("nk-visible");
    const preferred = nodes.find((node) => node.classList.contains("c-btn--primary")) || nodes[0];
    if (preferred) preferred.focus();
  }

  function resolveDialog(value) {
    const dialog = state.els.dialog;
    if (dialog) dialog.classList.remove("nk-visible");
    const resolve = state.dialogResolve;
    state.dialogResolve = null;
    if (resolve) resolve(value);
  }

  function onDialogKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      resolveDialog(false);
    }
  }

  function confirmDialog(message, options) {
    const config = typeof message === "object" && message !== null ? message : Object.assign({ body: message }, options || {});
    return new Promise((resolve) => {
      if (state.dialogResolve) state.dialogResolve(false);
      state.dialogResolve = resolve;
      openDialog({
        title: config.title || "Are you sure?",
        body: config.body || "",
        actions: [
          { label: "Cancel", value: false },
          {
            label: config.confirmLabel || "Continue",
            value: true,
            danger: config.danger !== false,
          },
        ],
      });
    });
  }

  /**
   * One field, one answer. The shell owns the dialog so an app never invents
   * its own modal (Notes → New notebook / Rename notebook).
   */  function askDialog(message, options) {
    const config = typeof message === "object" && message !== null ? message : Object.assign({ body: message }, options || {});
    return new Promise((resolve) => {
      if (state.dialogResolve) state.dialogResolve(null);
      state.dialogResolve = resolve;
      const field = el("input", "nk-dialog__field");
      field.type = "text";
      field.value = config.value || "";
      field.placeholder = config.placeholder || "";
      field.spellcheck = false;
      field.setAttribute("aria-label", config.title || "Value");
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        resolveDialog(field.value.trim());
      });
      const wrap = el("div");
      if (config.body) wrap.appendChild(el("p", "nk-dialog__hint", config.body));
      wrap.appendChild(field);
      openDialog({
        title: config.title || "New name",
        content: wrap,
        actions: [
          { label: "Cancel", value: null },
          // Read at click time: the user typed after the dialog opened.
          { label: config.confirmLabel || "Save", value: () => field.value.trim(), primary: true },
        ],
      });
      field.focus();
      field.select();
    });
  }

  function showShortcuts() {
    const list = el("div", "nk-shortcuts");
    for (const item of state.items.values()) {
      const keys = shortcutList(item);
      if (!keys.length) continue;
      const row = el("div", "c-prop");
      row.appendChild(el("span", "c-prop__label", item.label));
      const value = el("span", "c-prop__value");
      for (const key of keys) value.appendChild(el("kbd", null, key));
      row.appendChild(value);
      list.appendChild(row);
    }
    openDialog({
      title: "Keyboard shortcuts",
      content: list,
      actions: [{ label: "Close", value: true, primary: true }],
    });
  }

  // ------------------------------------------------------------------ toast

  function toast(message, kind) {
    if (window.NucleusKit && typeof window.NucleusKit.toast === "function") {
      window.NucleusKit.toast(message, kind);
      return;
    }
    const host = document.getElementById("nk-toasts") || document.body.appendChild(el("div", "", ""));
    const node = el("div", "nk-toast" + (kind ? " nk-" + kind : ""), message);
    host.appendChild(node);
    setTimeout(() => node.remove(), 3200);
  }

  // ------------------------------------------------------------------ kit

  function wireKit() {
    const kit = window.NucleusKit;
    if (!kit) {
      document.addEventListener("DOMContentLoaded", wireKit, { once: true });
      return;
    }
    if (state.kitWired) return;
    state.kitWired = true;
    if (typeof kit.registerMenuItems === "function") {
      kit.registerMenuItems(
        [...state.items.values()].map((item) => ({
          id: item.id,
          label: item.label,
          menu: item.menu,
          shortcut: shortcutLabel(item) || undefined,
          command: item.command,
          danger: item.danger,
          run: () => runItem(item.id),
        })),
      );
    }
    if (typeof kit.mountReview === "function") {
      kit.mountReview(state.els.reviewHost, {
        noun: (ids) => noun(ids),
        highlight: (ids, kind) => {
          if (typeof state.config.highlight === "function") state.config.highlight(ids, kind);
        },
      });
    }
  }

  /** "2 pages" / "1 note" — the app supplies the noun, the shell never says "node(s)". */
  function noun(ids) {
    const list = Array.isArray(ids) ? ids : [];
    if (typeof state.config.noun === "function") {
      try {
        return String(state.config.noun(list));
      } catch {
        /* fall through to the neutral default */
      }
    }
    return list.length === 1 ? "1 change" : list.length + " changes";
  }

  // --------------------------------------------------------------- settings

  const SETTINGS_TIMEOUT = 1500;

  async function fetchSettings() {
    if (typeof fetch !== "function") return {};
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), SETTINGS_TIMEOUT) : null;
      const res = await fetch("/api/settings", controller ? { signal: controller.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) return {};
      const json = await res.json();
      return (json && json.settings) || {};
    } catch {
      return {};
    }
  }

  async function loadSettings() {
    state.settings = await fetchSettings();
    applySettings();
  }

  function applySettings() {
    const theme = state.settings.theme;
    document.documentElement.dataset.theme = theme === "light" ? "light" : theme === "dark" ? "dark" : "";
    if (!document.documentElement.dataset.theme) delete document.documentElement.dataset.theme;
    document.body.classList.toggle("nk-dev", !!state.settings.developerDetails);
    if (state.settings.thumbnailSize) state.ctx.thumbnailSize = state.settings.thumbnailSize;
    if (state.settings.viewMode) state.ctx.viewMode = state.settings.viewMode;
    setPanelWidths();
  }

  async function saveSettings(patch) {
    Object.assign(state.settings, patch);
    applySettings();
    if (typeof fetch !== "function") return;
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: patch }),
      });
    } catch {
      /* offline or closing: the in-memory value still applies */
    }
  }

  function setDeveloperDetails(on) {
    document.body.classList.toggle("nk-dev", !!on);
    return saveSettings({ developerDetails: !!on });
  }

  function setTheme(theme) {
    return saveSettings({ theme: theme === "light" || theme === "dark" ? theme : "system" });
  }

  function setSetting(key, value) {
    return saveSettings({ [key]: value });
  }

  // ------------------------------------------------------------- menu presets

  /** Safe before mount: apps build their config (and call the presets) first. */
  function appName() {
    const config = state.config || {};
    return (config.app && config.app.name) || "Nucleus";
  }

  /** View → History · Developer details · Theme (apps spread it into their View menu). */
  function standardViewMenu(extra) {
    const items = [
      {
        id: "view.history",
        label: "History",
        shortcut: "Ctrl+H",
        command: "tape.history",
        run: () => selectPanel("history"),
      },
      {
        id: "view.developer",
        label: "Developer details",
        checked: () => !!state.settings.developerDetails,
        run: () => void setDeveloperDetails(!state.settings.developerDetails),
      },
      {
        id: "view.theme",
        label: "Theme",
        checked: () => state.settings.theme === "light",
        run: () => void setTheme(state.settings.theme === "light" ? "dark" : "light"),
      },
    ];
    return extra ? items.concat(extra) : items;
  }

  /** Help → Keyboard shortcuts… · About (apps spread it into their Help menu). */
  function standardHelpMenu(extra) {
    const items = [
      { id: "help.shortcuts", label: "Keyboard shortcuts\u2026", command: "help.shortcuts", run: () => showShortcuts() },
      {
        id: "help.about",
        label: "About " + appName(),
        run: () =>
          openDialog({
            title: appName(),
            body: "Part of Nucleus \u2014 one command bus for the GUI, CLI, JSON-RPC and MCP.",
            actions: [{ label: "Close", value: true, primary: true }],
          }),
      },
    ];
    return extra ? items.concat(extra) : items;
  }

  /** The one empty state: one drop target, one call to action, no tips wall. */
  function emptyState(options) {
    const config = options || {};
    const node = el("div", "c-empty");
    if (config.kick) node.appendChild(el("div", "c-empty__kick", config.kick));
    if (config.title) node.appendChild(el("h1", null, config.title));
    if (config.body) node.appendChild(el("p", null, config.body));
    if (config.cta) {
      const btn = el("button", "c-btn--primary", config.cta);
      btn.type = "button";
      btn.addEventListener("click", () => config.onCta && config.onCta());
      const wrap = el("div", "c-empty__cta");
      wrap.style.marginTop = "14px";
      wrap.appendChild(btn);
      node.appendChild(wrap);
    }
    if (config.hint) node.appendChild(el("p", "c-empty__hint", config.hint));
    return node;
  }

  function openPalette() {
    if (window.NucleusKit && typeof window.NucleusKit.openPalette === "function") {
      window.NucleusKit.openPalette();
    } else {
      toast("Command palette unavailable");
    }
  }

  // ---------------------------------------------------------------- exports

  window.NucleusShell = Object.freeze({
    mount,
    setContext: (patch, options) => {
      if (!state.mounted) return;
      setContext(patch, options);
    },
    refresh: (options) => {
      if (state.mounted) refresh(options);
    },
    openPanel: (id) => {
      if (state.mounted) selectPanel(id);
    },
    confirm: (message, options) => confirmDialog(message, options),
    ask: (message, options) => askDialog(message, options),
    // A read-only dialog for "Details" surfaces (Image Editor → Image details…).
    dialog: (options) => openDialog(options || {}),
    setDeveloperDetails,
    setTheme,
    setSetting: (key, value) => setSetting(key, value),
    icon,
    emptyState,
    standardViewMenu,
    standardHelpMenu,
    noun: (ids) => noun(ids),
    get context() {
      return state.ctx;
    },
    get items() {
      return state.items;
    },
    get shortcuts() {
      return state.shortcuts;
    },
    normalizeShortcut,
  });
})();
