/* kit.js — shared app web kit (@nucleus/app-kit), vanilla JS.
   Mounts: the command palette (Ctrl+K), the History panel, the review card for
   pending proposals, toasts and the SSE refresh. Apps may pass their own
   options or call nothing at all — the kit mounts itself.

   Brief #3 vocabulary: History, "Go back to this point", "Start a copy from
   here", "Back to now". The fixed bottom scrubber is gone; History is a panel
   and the numeric scrubber only comes back under View → Developer details. */
(function () {
  "use strict";

  const state = {
    options: { onRestore: null, accent: "" },
    settings: {},
    lastSeq: 0,
    events: null,
    review: { host: null, options: {}, pending: [] },
    history: { host: null, options: {}, records: [], previewSeq: null },
  };

  // ------------------------------------------------------------------ utils

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function authHeaders(extra) {
    return Object.assign({}, extra || {});
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** "just now" · "4 min ago" · "2 h ago" — never a raw ISO stamp in the UI. */
  function relativeTime(iso) {
    const then = Date.parse(String(iso || ""));
    if (!Number.isFinite(then)) return "";
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + " min ago";
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + " h ago";
    const days = Math.round(hours / 24);
    return days + " d ago";
  }

  /** A bus command name is provenance, not a sentence: "pdf.rotatePages" → "Rotate pages". */
  function plainLabel(record) {
    if (record.label) return record.label;
    const tail = String(record.command || "").split(".").pop() || "Change";
    const spaced = tail.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function isTypingTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  // ------------------------------------------------------------------ toasts

  function toast(message, kind) {
    let host = document.getElementById("nk-toasts");
    if (!host) {
      host = el("div");
      host.id = "nk-toasts";
      document.body.appendChild(host);
    }
    const node = el("div", "nk-toast" + (kind ? " nk-" + kind : ""), message);
    host.appendChild(node);
    setTimeout(() => node.remove(), kind === "error" ? 6000 : 3200);
  }

  // ------------------------------------------------------------------ review
  /* A pending proposal is a card at the top of the right panel (or an inline
     banner in Notes). Plain words, agent id from the proposal itself, and the
     app's own noun for what changed. */

  const REVIEW_KINDS = { added: "added", removed: "removed", changed: "changed" };

  function mountReview(host, options) {
    state.review.host = host;
    state.review.options = options || {};
    if (host) host.hidden = true;
    void refreshProposals();
  }

  /**
   * Apps that have not migrated to the shared shell still get the card: it
   * docks bottom-right, where the old drawer used to be. The shell passes its
   * own host instead.
   */
  function ensureReviewHost() {
    if (state.review.host && state.review.host.isConnected) return state.review.host;
    // A host that left the document (shell re-render, session restart) is not
    // a host any more: fall back to the docked card rather than vanish.
    state.review.host = null;
    if (!document.body) return null;
    let host = document.getElementById("nk-review-host");
    if (!host) {
      host = el("div");
      host.id = "nk-review-host";
      document.body.appendChild(host);
    }
    state.review.host = host;
    return host;
  }

  async function refreshProposals() {
    const host = ensureReviewHost();
    if (!host) return;
    let data;
    try {
      data = await fetch("/api/proposals", { headers: authHeaders() }).then((r) => r.json());
    } catch {
      return;
    }
    const pending = (data.proposals || []).filter((proposal) => proposal.status === "pending");
    state.review.pending = pending;
    if (pending.length === 0) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    drawReview(pending);
  }

  function drawReview(pending) {
    const host = ensureReviewHost();
    if (!host) return;
    const proposal = pending[0];
    const ids = proposal.touchedNodeIds || [];
    const actorId = (proposal.actor && proposal.actor.id) || "An agent";

    host.innerHTML = "";
    const card = el("div", "nk-review");

    const head = el("div", "nk-review__head");
    head.appendChild(el("span", "nk-review__who", actorId + "\u2019s proposal"));
    head.appendChild(el("span", "nk-review__count", noun(ids)));
    card.appendChild(head);

    card.appendChild(el("p", "nk-review__label", proposal.label || plainLabel(proposal)));

    const actions = el("div", "nk-review__actions");
    const accept = el("button", "c-btn nk-review__accept", "Accept");
    accept.type = "button";
    accept.title = "Accept (A)";
    accept.addEventListener("click", () => void decide(proposal.id, "accept"));
    const reject = el("button", "c-btn", "Reject");
    reject.type = "button";
    reject.title = "Reject (R)";
    reject.addEventListener("click", () => void decide(proposal.id, "reject"));
    actions.appendChild(accept);
    actions.appendChild(reject);
    if (pending.length > 1) {
      actions.appendChild(el("span", "nk-review__count", "and " + (pending.length - 1) + " more"));
    }
    card.appendChild(actions);

    card.addEventListener("mouseenter", () => preview(ids, "changed"));
    card.addEventListener("mouseleave", () => preview([], "changed"));

    host.appendChild(card);
    host.hidden = false;
  }

  function noun(ids) {
    const shell = window.NucleusShell;
    if (shell && typeof shell.noun === "function") return shell.noun(ids);
    return ids.length === 1 ? "1 change" : ids.length + " changes";
  }

  function preview(ids, kind) {
    const highlight = state.review.options && state.review.options.highlight;
    if (typeof highlight === "function") highlight(ids, REVIEW_KINDS[kind] || "changed");
  }

  async function decide(id, action) {
    try {
      const res = await fetch("/api/proposals/" + encodeURIComponent(id) + "/" + action, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(action === "accept" ? "Could not accept the change" : "Could not reject it");
      toast(action === "accept" ? "Change accepted" : "Proposal rejected");
      preview([], "changed");
      await refreshProposals();
      if (state.options.onRestore) state.options.onRestore();
    } catch (error) {
      toast(String((error && error.message) || error), "error");
    }
  }

  document.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) return;
    if (!state.review.pending || state.review.pending.length === 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector("#nk-palette.nk-visible") || document.querySelector(".nk-dialog.nk-visible")) return;
    if (event.key === "a" || event.key === "A") {
      const proposal = state.review.pending[0];
      if (proposal) {
        event.preventDefault();
        void decide(proposal.id, "accept");
      }
    } else if (event.key === "r" || event.key === "R") {
      const proposal = state.review.pending[0];
      if (proposal) {
        event.preventDefault();
        void decide(proposal.id, "reject");
      }
    }
  });

  // ----------------------------------------------------------------- history
  /* History is a panel: every step, who took it, when, and the two things a
     person actually wants ("Go back to this point", "Start a copy from here"). */

  function historyView(host, options) {
    state.history.host = host;
    state.history.options = options || {};
    host.innerHTML = "";
    host.dataset.nkHistory = "";
    void loadHistory();
    return host;
  }

  async function loadHistory() {
    const host = state.history.host;
    if (!host) return;
    let tape;
    try {
      tape = await fetch("/api/tape", { headers: authHeaders() }).then((r) => r.json());
    } catch {
      host.innerHTML = '<div class="nk-history__empty">History is unavailable right now.</div>';
      return;
    }
    const records = (tape.records || []).slice().reverse();
    state.history.records = records;
    if (records.length > 0) state.lastSeq = records[0].seq;
    drawHistory();
  }

  function drawHistory() {
    const host = state.history.host;
    if (!host) return;
    const records = state.history.records;
    host.innerHTML = "";

    if (records.length === 0) {
      host.appendChild(el("div", "nk-history__empty", "No changes yet. Every action lands here, in order."));
      return;
    }

    const list = el("div", "nk-history__list");
    list.setAttribute("role", "list");
    for (const record of records.slice(0, 200)) {
      const row = el("div", "nk-history__row");
      row.setAttribute("role", "listitem");
      row.dataset.seq = String(record.seq);

      const label = el("div", "nk-history__label");
      const agent = record.actor && record.actor.kind && record.actor.kind !== "human";
      const badge = el("span", "nk-actor" + (agent ? " nk-actor--agent" : ""), agent ? record.actor.id : "You");
      label.appendChild(badge);
      label.appendChild(el("span", "nk-history__title", plainLabel(record)));
      row.appendChild(label);
      row.appendChild(el("span", "nk-history__time", relativeTime(record.ts)));

      const actions = el("div", "nk-history__actions");
      actions.hidden = true;
      const back = el("button", "c-btn", "Go back to this point");
      back.type = "button";
      back.addEventListener("click", () => void goBack(record.seq));
      const copy = el("button", "c-btn", "Start a copy from here");
      copy.type = "button";
      copy.addEventListener("click", () => void startCopy(record.seq));
      actions.appendChild(back);
      actions.appendChild(copy);
      row.appendChild(actions);

      const reveal = () => {
        actions.hidden = false;
      };
      const conceal = () => {
        actions.hidden = true;
      };
      row.addEventListener("mouseenter", reveal);
      row.addEventListener("focusin", reveal);
      row.addEventListener("mouseleave", conceal);
      row.addEventListener("focusout", conceal);

      list.appendChild(row);
    }
    host.appendChild(list);

    // The numeric scrubber was the old bottom bar; it only exists here, and
    // only when Developer details is on.
    const scrub = el("div", "nk-history__scrub");
    scrub.hidden = !document.body.classList.contains("nk-dev");
    scrub.innerHTML = [
      '<div class="nk-label">Step <span class="nk-pos">' + state.lastSeq + "/" + state.lastSeq + "</span></div>",
      '<input type="range" min="0" max="' + state.lastSeq + '" value="' + state.lastSeq + '" />',
      '<div class="nk-actions"><button class="c-btn" data-nk="now" disabled>Back to now</button></div>',
    ].join("");
    const range = scrub.querySelector("input");
    const pos = scrub.querySelector(".nk-pos");
    const now = scrub.querySelector('[data-nk="now"]');
    range.addEventListener("input", () => {
      state.history.previewSeq = Number(range.value);
      pos.textContent = range.value + "/" + state.lastSeq;
      now.disabled = Number(range.value) >= state.lastSeq;
    });
    now.addEventListener("click", () => {
      range.value = String(state.lastSeq);
      pos.textContent = state.lastSeq + "/" + state.lastSeq;
      state.history.previewSeq = null;
      now.disabled = true;
      if (state.options.onRestore) state.options.onRestore();
    });
    host.appendChild(scrub);
  }

  async function goBack(seq) {
    try {
      const res = await fetch("/api/tape/restore", {
        method: "POST",
        headers: authHeaders("application/json"),
        body: JSON.stringify({ seq }),
      }).then((r) => r.json());
      if (!res.ok) throw new Error((res.error && res.error.message) || "Could not go back");
      toast("Went back to step " + seq);
      if (state.options.onRestore) state.options.onRestore();
      await loadHistory();
    } catch (error) {
      toast(String((error && error.message) || error), "error");
    }
  }

  async function startCopy(seq) {
    try {
      const res = await fetch("/api/tape/fork", {
        method: "POST",
        headers: authHeaders("application/json"),
        body: JSON.stringify({ seq }),
      }).then((r) => r.json());
      if (!res.ok) throw new Error("Could not start a copy from that step");
      toast("A copy from step " + seq + " is ready to save");
    } catch (error) {
      toast(String((error && error.message) || error), "error");
    }
  }

  // ------------------------------------------------------------------- sse

  function connectEvents() {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/events");
    state.events = source;
    source.addEventListener("command", (event) => {
      try {
        const record = JSON.parse(event.data);
        state.lastSeq = record.seq || state.lastSeq;
        if (state.history.host) void loadHistory();
      } catch {
        /* a broken frame is dropped, never fatal */
      }
    });
    source.addEventListener("proposal", () => void refreshProposals());
    source.onerror = () => {
      /* EventSource auto-reconnects */
    };
  }

  // ------------------------------------------------------- command palette
  /* Ctrl+K lists the app's own menu items first, then every bus command that
     no menu item already exposes — de-duplicated by id, not by label. */

  const palette = {
    root: null,
    input: null,
    list: null,
    foot: null,
    commands: [],
    menuItems: [],
    entries: null,
    view: [],
    index: 0,
    mode: "list",
    active: null,
    forms: null,
  };

  function registerMenuItems(items) {
    palette.menuItems = Array.isArray(items) ? items : [];
    palette.entries = null;
    return palette.menuItems.length;
  }

  async function paletteCommands() {
    if (palette.commands.length) return palette.commands;
    try {
      const data = await fetch("/api/describe", { headers: authHeaders() }).then((r) => r.json());
      const all = data.commands || [];
      palette.commands = all.filter((command) => command.sideEffects !== "read").concat(
        all.filter((command) => command.sideEffects === "read"),
      );
    } catch {
      palette.commands = [];
    }
    return palette.commands;
  }

  /** Menu items win over the bus command they wrap (same id, one row). */
  function paletteEntries() {
    if (palette.entries) return palette.entries;
    const used = new Set();
    const entries = [];
    for (const item of palette.menuItems) {
      used.add(item.id);
      if (item.command) used.add(item.command);
      entries.push({
        key: item.id,
        kind: "menu",
        label: item.label,
        menu: item.menu || "Menu",
        hint: item.shortcut || "",
        section: "Menu",
        item,
      });
    }
    for (const command of palette.commands) {
      if (used.has(command.name)) continue;
      used.add(command.name);
      entries.push({
        key: command.name,
        kind: "command",
        label: command.title || command.name,
        hint: command.sideEffects === "read" ? "read" : command.name,
        section: command.name.split(".")[0],
        command,
      });
    }
    palette.entries = entries;
    return entries;
  }

  function palEnsure() {
    if (palette.root) return;
    const root = el("div");
    root.id = "nk-palette";
    root.innerHTML = [
      '<div class="nk-palette__box">',
      '  <div class="nk-palette__inputrow"><span class="nk-palette__glyph">\u2318</span>',
      '    <input type="text" placeholder="Type a command\u2026" spellcheck="false" aria-label="Search commands" />',
      "  </div>",
      '  <div class="nk-palette__list" role="listbox"></div>',
      '  <div class="nk-palette__foot"><span>\u2191\u2193 move \u00b7 \u21b5 run \u00b7 Esc close</span><span class="nk-palette__count"></span></div>',
      "</div>",
    ].join("");
    document.body.appendChild(root);
    palette.root = root;
    palette.input = root.querySelector("input");
    palette.list = root.querySelector(".nk-palette__list");
    palette.foot = root.querySelector(".nk-palette__count");

    palette.input.addEventListener("input", () => {
      if (palette.mode === "params") return;
      palette.view = palFilter(palette.input.value);
      palette.index = 0;
      palRender();
    });
    palette.input.addEventListener("keydown", (event) => {
      if (palette.mode === "params") {
        if (event.key === "Enter") {
          event.preventDefault();
          void palRun();
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        palette.index = Math.min(palette.index + 1, palette.view.length - 1);
        palRender();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        palette.index = Math.max(palette.index - 1, 0);
        palRender();
      } else if (event.key === "Enter") {
        event.preventDefault();
        const entry = palette.view[palette.index];
        if (entry) palOpen(entry);
      }
    });
    root.addEventListener("mousedown", (event) => {
      if (event.target === root) palClose();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        palClose();
      }
    });
  }

  function palFilter(query) {
    const entries = paletteEntries();
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (entry) =>
        entry.key.toLowerCase().includes(needle) ||
        String(entry.label).toLowerCase().includes(needle) ||
        (entry.kind === "command" && entry.command.name.toLowerCase().includes(needle)),
    );
  }

  function palRender() {
    const list = palette.list;
    list.innerHTML = "";
    let lastSection = null;
    palette.view.forEach((entry, i) => {
      const section = entry.section;
      if (section !== lastSection) {
        list.appendChild(el("div", "nk-palette__section", section));
        lastSection = section;
      }
      const item = el("button", "nk-palette__item");
      item.type = "button";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === palette.index));
      item.innerHTML =
        '<span class="nk-palette__name">' + escapeHtml(entry.kind === "menu" ? entry.menu : entry.command.name) + "</span>" +
        '<span class="nk-palette__title">' + escapeHtml(entry.label) + "</span>" +
        '<span class="nk-palette__hint">' + escapeHtml(entry.kind === "menu" ? entry.hint : entry.command.sideEffects) + "</span>";
      item.addEventListener("click", () => palOpen(entry));
      item.addEventListener("mousemove", () => {
        palette.index = i;
      });
      list.appendChild(item);
    });
    if (palette.view.length === 0) {
      list.appendChild(el("div", "nk-palette__section", paletteEntries().length ? "no matching command" : "describe unavailable"));
    }
    palette.foot.textContent = palette.view.length + "/" + paletteEntries().length + " commands";
    const selected = list.querySelectorAll(".nk-palette__item")[palette.index];
    if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: "nearest" });
  }

  function palOpen(entry) {
    if (!entry) return;
    if (entry.kind === "menu") {
      palClose();
      try {
        entry.item.run();
      } catch (error) {
        toast(String((error && error.message) || error), "error");
      }
      return;
    }
    palOpenParams(entry.command);
  }

  /* Build the inline params form from the command's JSON Schema (required
     fields only; everything else runs on defaults from the handler). */
  function palOpenParams(command) {
    const required = (command.params && command.params.required) || [];
    const props = (command.params && command.params.properties) || {};
    palette.active = command;
    palette.mode = "params";
    palette.list.innerHTML = "";
    const form = el("div", "nk-params");
    const title = el("div", "nk-palette__section", command.name + (required.length ? " \u2014 fill the required params" : " \u2014 runs with defaults"));
    title.style.padding = "0";
    form.appendChild(title);
    palette.forms = [];
    for (const field of required) {
      const spec = props[field] || { type: "string" };
      const row = el("div", "nk-params__row");
      const label = el("label", null, field + (spec.type === "boolean" ? "?" : ""));
      label.htmlFor = "nk-param-" + field;
      row.appendChild(label);
      let input;
      if (spec.type === "boolean") {
        input = el("input");
        input.type = "checkbox";
      } else {
        input = el(spec.type === "string" && (spec.maxLength || 0) > 60 ? "textarea" : "input");
        input.type = spec.type === "number" || spec.type === "integer" ? "number" : "text";
        if (spec.type === "string" && spec.maxLength) input.maxLength = spec.maxLength;
      }
      input.id = "nk-param-" + field;
      input.dataset.field = field;
      input.dataset.ptype = spec.type === "integer" ? "integer" : spec.type || "string";
      row.appendChild(input);
      form.appendChild(row);
      palette.forms.push(input);
    }
    const actions = el("div", "nk-params__row");
    actions.innerHTML =
      '<button type="button" class="c-btn c-btn--primary" data-nk="run">Run</button>' +
      '<button type="button" class="c-btn" data-nk="back">Back</button>';
    actions.querySelector('[data-nk="run"]').addEventListener("click", () => void palRun());
    actions.querySelector('[data-nk="back"]').addEventListener("click", () => palBack());
    form.appendChild(actions);
    palette.list.appendChild(form);
    const first = palette.forms[0];
    if (first) first.focus();
    palette.foot.textContent = command.name + (required.length ? "" : " \u00b7 \u21b5 run");
  }

  function palBack() {
    palette.mode = "list";
    palette.active = null;
    palRender();
    palette.input.focus();
  }

  function castValue(input) {
    const type = input.dataset.ptype;
    const raw = input.type === "checkbox" ? input.checked : input.value;
    if (type === "boolean") return raw;
    if (type === "number" || type === "integer") {
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error("not a number: " + input.dataset.field);
      return value;
    }
    if (type === "array") {
      const text = String(raw).trim();
      if (!text) return [];
      try {
        return JSON.parse(text);
      } catch {
        return text.split(",").map((piece) => piece.trim());
      }
    }
    return raw;
  }

  async function palRun() {
    const command = palette.active;
    if (!command) return;
    const params = {};
    for (const input of palette.forms || []) params[input.dataset.field] = castValue(input);
    try {
      const res = await fetch("/api/op", {
        method: "POST",
        headers: authHeaders("application/json"),
        body: JSON.stringify({ name: command.name, params, label: command.title }),
      }).then((r) => r.json());
      if (!res.ok) throw new Error((res.error && res.error.message) || "command failed");
      palClose();
      toast("Ran " + command.name);
      if (state.options.onRestore) state.options.onRestore();
    } catch (error) {
      toast(String((error && error.message) || error), "error");
    }
  }

  function palClose() {
    if (palette.root) palette.root.classList.remove("nk-visible");
    palette.mode = "list";
    palette.active = null;
    palette.forms = null;
    if (palette.input) palette.input.value = "";
  }

  async function openPalette() {
    palEnsure();
    await paletteCommands();
    palette.entries = null;
    palette.view = palFilter("");
    palette.index = 0;
    palRender();
    palette.root.classList.add("nk-visible");
    palette.input.focus();
  }

  // The palette is the kit's: one binding, whichever chrome the app uses.
  // The shell registers its menu items on top, so Ctrl+K lists both.
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      void openPalette();
    }
  });

  // ------------------------------------------------------------------ mount

  function mount(options) {
    Object.assign(state.options, options || {});
    if (state.options.accent) {
      document.documentElement.style.setProperty("--nk-accent", state.options.accent);
    }
    // Always show pending proposals: the shell uses its own host, an app that
    // has not migrated gets the card docked bottom-right.
    void refreshProposals();
    connectEvents();
  }

  window.NucleusKit = Object.freeze({
    mount,
    toast,
    openPalette,
    registerMenuItems,
    mountReview,
    historyView,
    refreshProposals,
    get menuCount() {
      return palette.menuItems.length;
    },
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mount());
  } else {
    mount();
  }
})();
