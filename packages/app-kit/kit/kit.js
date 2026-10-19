/* kit.js — shared app web kit (@nucleus/app-kit, §4.2/§4.3), vanilla JS.
   Mounts: Review drawer (pending proposals from the bus), Tape scrubber
   (seek preview / restore / fork), toasts, SSE live refresh. Apps may pass
   their own options or call nothing at all — the kit mounts itself. */
(function () {
  "use strict";

  const qs = (sel) => document.querySelector(sel);
  const state = {
    options: {
      highlight: null,
      onRestore: null,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--nk-app-accent") || "",
    },
    seeking: false,
    lastSeq: 0,
    events: null,
    drawer: null,
  };

  // ------------------------------------------------------------------ toasts

  function toast(message, kind) {
    let host = qs("#nk-toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "nk-toasts";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "nk-toast" + (kind ? " nk-" + kind : "");
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), message && kind === "error" ? 6000 : 3200);
  }

  // ------------------------------------------------------------------ review
  /* Review drawer: pending proposals. Keyboard: A accept, R reject. */

  async function refreshProposals() {
    let data;
    try {
      data = await fetch("/api/proposals", { headers: authHeaders() }).then((r) => r.json());
    } catch {
      return;
    }
    const pending = (data.proposals || []).filter((p) => p.status === "pending");
    if (pending.length === 0 && state.drawer) {
      state.drawer.classList.remove("nk-visible");
      state.drawer = null;
    }
    if (pending.length === 0) return;
    drawDrawer(pending);
  }

  function drawDrawer(pending) {
    if (!state.drawer) {
      const root = document.createElement("aside");
      root.id = "nk-review";
      root.innerHTML = [
        "<header><h3>Review</h3></header>",
        '<div class="nk-body"></div>',
        '<footer>A accept · R reject · Esc close</footer>',
      ].join("");
      document.body.appendChild(root);
      state.drawer = root;
    }
    const body = state.drawer.querySelector(".nk-body");
    body.innerHTML = "";
    for (const proposal of pending) {
      const card = document.createElement("div");
      card.className = "nk-proposal";
      card.innerHTML = [
        `<span class="nk-actor">${escapeHtml(proposal.actor.kind)} · ${escapeHtml(proposal.actor.id)}</span>`,
        '<div class="nk-cmd">' + escapeHtml(proposal.command) + "</div>",
        '<div class="nk-label">' + escapeHtml(proposal.touchedNodeIds.length + " node(s) touched") + "</div>",
        '<div class="nk-actions"><button class="nk-accept">Accept</button><button class="nk-reject">Reject</button></div>',
      ].join("");
      const [accept, reject] = card.querySelectorAll("button");
      accept.addEventListener("click", () => decide(proposal.id, "accept"));
      reject.addEventListener("click", () => decide(proposal.id, "reject"));
      body.appendChild(card);
    }
    state.drawer.classList.add("nk-visible");
  }

  async function decide(id, action) {
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(action + " failed");
      toast(action === "accept" ? "Change accepted" : "Proposal rejected");
      state.drawer && state.drawer.classList.remove("nk-visible");
      state.drawer = null;
      if (state.options.onRestore) state.options.onRestore();
    } catch (error) {
      toast(String(error), "error");
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const visible = state.drawer && state.drawer.classList.contains("nk-visible");
    if (!visible) return;
    if (event.key === "a" || event.key === "A") {
      const first = document.querySelector("#nk-review .nk-proposal .nk-accept");
      first && first.click();
    } else if (event.key === "r" || event.key === "R") {
      const first = document.querySelector("#nk-review .nk-proposal .nk-reject");
      first && first.click();
    } else if (event.key === "Escape") {
      state.drawer.classList.remove("nk-visible");
      state.drawer = null;
    }
  });

  // ---------------------------------------------------------------- scrubber
  /* Tape scrubber: markers per record, range over seq; scrub = seek preview. */

  async function buildScrubber() {
    const tape = await fetch("/api/tape", { headers: authHeaders() }).then((r) => r.json());
    if ((tape.records || []).length === 0) return;
    state.lastSeq = tape.records[tape.records.length - 1].seq;
    if (qs("#nk-scrubber")) return;

    const root = document.createElement("div");
    root.id = "nk-scrubber";
    root.classList.add("nk-visible");
    root.innerHTML = [
      '<div class="nk-row">',
      '  <span class="nk-label">TAPE</span>',
      '  <input type="range" min="0" max="' + state.lastSeq + '" value="' + state.lastSeq + '" />',
      '  <span class="nk-label nk-pos">' + state.lastSeq + "/" + state.lastSeq + "</span>",
      '  <button class="nk-primary" data-nk="restore">Restore here</button>',
      '  <button data-nk="fork">Fork</button>',
      '  <button data-nk="live">Live</button>',
      "</div>",
    ].join("");
    document.body.appendChild(root);

    const preview = document.createElement("div");
    preview.id = "nk-preview";
    preview.innerHTML = "<h4>Tape preview</h4><div class='nk-meta'></div>";
    document.body.appendChild(preview);

    const range = root.querySelector("input");
    const pos = root.querySelector(".nk-pos");
    const meta = preview.querySelector(".nk-meta");
    range.addEventListener("input", async () => {
      const seq = Number(range.value);
      pos.textContent = seq + "/" + state.lastSeq;
      if (seq === state.lastSeq) {
        preview.classList.remove("nk-visible");
        preview.dataset.seq = "";
        return;
      }
      preview.dataset.seq = String(seq);
      const seek = await fetch("/api/tape/seek", {
        method: "POST",
        headers: authHeaders("application/json"),
        body: JSON.stringify({ seq }),
      }).then((r) => r.json());
      if (seek.ok) {
        meta.textContent =
          "seq " + seq + " · " + Object.keys(seek.preview.nodes).length + " nodes · v" + seek.preview.docVersion;
        preview.classList.add("nk-visible");
      }
    });

    root.addEventListener("click", async (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = target && target.dataset.nk;
      if (!action) return;
      const seq = Number(preview.dataset.seq || range.value);
      if (action === "live") {
        preview.dataset.seq = "";
        preview.classList.remove("nk-visible");
        range.value = String(state.lastSeq);
        pos.textContent = state.lastSeq + "/" + state.lastSeq;
        return;
      }
      if (action === "restore") {
        const res = await fetch("/api/tape/restore", {
          method: "POST",
          headers: authHeaders("application/json"),
          body: JSON.stringify({ seq }),
        }).then((r) => r.json());
        if (!res.ok) return toast(res.error && res.error.message, "error");
        preview.dataset.seq = "";
        preview.classList.remove("nk-visible");
        toast("State restored to tape position " + seq);
        if (state.options.onRestore) state.options.onRestore();
      } else if (action === "fork") {
        const res = await fetch("/api/tape/fork", {
          method: "POST",
          headers: authHeaders("application/json"),
          body: JSON.stringify({ seq }),
        }).then((r) => r.json());
        if (!res.ok) return toast("Fork failed", "error");
        toast("Forked document captured — v" + res.state.docVersion + " (" + Object.keys(res.state.nodes).length + " nodes)");
      }
    });
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
        const scrubRange = qs("#nk-scrubber input[type=range]");
        const pos = qs("#nk-scrubber .nk-pos");
        if (scrubRange && !state.seeking) {
          scrubRange.max = String(record.seq);
          scrubRange.value = String(record.seq);
          if (pos) pos.textContent = record.seq + "/" + record.seq;
        } else if (pos) {
          pos.textContent = pos.textContent.replace(/\/\d+$/, "/" + record.seq);
          scrubRange && (scrubRange.max = String(record.seq));
        }
      } catch {
        /* a broken frame is dropped, never fatal */
      }
    });
    source.addEventListener("proposal", () => void refreshProposals());
    source.onerror = () => {
      /* EventSource auto-reconnects */
    };
  }

  // ------------------------------------------------------------------ utils

  function authHeaders(extra) {
    const headers = Object.assign({}, extra || {});
    return headers;
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ------------------------------------------------------- command palette
  /* ⌘K palette: every bus command, schema-driven. Reads /api/describe once,
     filters as you type, and builds an inline params form from the JSON
     Schema (strings, numbers, booleans; arrays via JSON or comma lists). */

  const palette = { root: null, input: null, list: null, foot: null, commands: [], view: [], index: 0, mode: "list", active: null, forms: null };

  async function paletteCommands() {
    if (palette.commands.length) return palette.commands;
    try {
      const data = await fetch("/api/describe", { headers: authHeaders() }).then((r) => r.json());
      palette.commands = (data.commands || []).filter((c) => c.sideEffects !== "read");
      palette.commands.push(...(data.commands || []).filter((c) => c.sideEffects === "read"));
    } catch {
      palette.commands = [];
    }
    return palette.commands;
  }

  function palEnsure() {
    if (palette.root) return;
    const root = document.createElement("div");
    root.id = "nk-palette";
    root.innerHTML = [
      '<div class="nk-palette__box">',
      '  <div class="nk-palette__inputrow"><span class="nk-palette__glyph">⌘</span>',
      '    <input type="text" placeholder="Type a command…" spellcheck="false" />',
      "  </div>",
      '  <div class="nk-palette__list" role="listbox"></div>',
      '  <div class="nk-palette__foot"><span>↑↓ move · ↵ run · Esc close</span><span class="nk-palette__count"></span></div>',
      "</div>",
    ].join("");
    document.body.appendChild(root);
    palette.root = root;
    palette.input = root.querySelector("input");
    palette.list = root.querySelector(".nk-palette__list");
    palette.foot = root.querySelector(".nk-palette__count");

    palette.input.addEventListener("input", () => {
      if (palette.mode === "params") return; // typing in the form must not refilter
      palette.view = palFilter(palette.input.value);
      palette.index = 0;
      palRender();
    });
    palette.input.addEventListener("keydown", (event) => {
      if (palette.mode === "params") {
        if (event.key === "Enter") { event.preventDefault(); void palRun(); }
        return;
      }
      if (event.key === "ArrowDown") { event.preventDefault(); palette.index = Math.min(palette.index + 1, palette.view.length - 1); palRender(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); palette.index = Math.max(palette.index - 1, 0); palRender(); }
      else if (event.key === "Enter") {
        event.preventDefault();
        const command = palette.view[palette.index];
        if (command) palOpenParams(command);
      }
    });
    root.addEventListener("mousedown", (event) => { if (event.target === root) palClose(); });
    root.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); palClose(); } });
  }

  function palFilter(query) {
    const needle = query.trim().toLowerCase();
    const all = palette.commands;
    if (!needle) return all;
    return all.filter((c) => c.name.toLowerCase().includes(needle) || (c.title || "").toLowerCase().includes(needle));
  }

  function palRender() {
    const list = palette.list;
    list.innerHTML = "";
    let lastSection = null;
    palette.view.forEach((command, i) => {
      const section = command.name.split(".")[0];
      if (section !== lastSection) {
        const head = document.createElement("div");
        head.className = "nk-palette__section";
        head.textContent = section;
        list.appendChild(head);
        lastSection = section;
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "nk-palette__item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === palette.index));
      item.innerHTML =
        '<span class="nk-palette__name">' + escapeHtml(command.name) + "</span>" +
        '<span class="nk-palette__title">' + escapeHtml(command.title) + "</span>" +
        '<span class="nk-palette__hint">' + escapeHtml(command.sideEffects) + "</span>";
      item.addEventListener("click", () => palOpenParams(command));
      item.addEventListener("mousemove", () => { palette.index = i; });
      list.appendChild(item);
    });
    if (palette.view.length === 0) {
      const note = document.createElement("div");
      note.className = "nk-palette__section";
      note.textContent = palette.commands.length ? "no matching command" : "describe unavailable";
      list.appendChild(note);
    }
    palette.foot.textContent = palette.view.length + "/" + palette.commands.length + " commands";
    const selected = list.querySelectorAll(".nk-palette__item")[palette.index];
    selected && selected.scrollIntoView({ block: "nearest" });
  }

  /* Build the inline params form from the command's JSON Schema (required
     fields only; everything else runs on defaults from the handler). */
  function palOpenParams(command) {
    const required = (command.params && command.params.required) || [];
    const props = (command.params && command.params.properties) || {};
    palette.active = command;
    palette.mode = "params";
    palette.list.innerHTML = "";
    const form = document.createElement("div");
    form.className = "nk-params";
    const title = document.createElement("div");
    title.className = "nk-palette__section";
    title.style.padding = "0";
    title.textContent = command.name + (required.length ? " — fill the required params" : " — runs with defaults");
    form.appendChild(title);
    palette.forms = [];
    for (const field of required) {
      const props2 = props[field] || { type: "string" };
      const row = document.createElement("div");
      row.className = "nk-params__row";
      const label = document.createElement("label");
      label.htmlFor = "nk-param-" + field;
      label.textContent = field + (props2.type === "boolean" ? "?" : "");
      row.appendChild(label);
      let input;
      if (props2.type === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
      } else {
        input = document.createElement(props2.type === "string" && (props2.maxLength || "") > 60 ? "textarea" : "input");
        input.type = props2.type === "number" || props2.type === "integer" ? "number" : "text";
        if (props2.type === "string" && props2.maxLength) input.maxLength = props2.maxLength;
      }
      input.id = "nk-param-" + field;
      input.dataset.field = field;
      input.dataset.ptype = props2.type === "integer" ? "integer" : props2.type || "string";
      row.appendChild(input);
      form.appendChild(row);
      palette.forms.push(input);
    }
    const actions = document.createElement("div");
    actions.className = "nk-params__row";
    actions.innerHTML = '<button type="button" class="c-btn c-btn--accent" data-nk="run">Run</button>' +
      '<button type="button" class="c-btn" data-nk="back">Back</button>';
    actions.querySelector('[data-nk="run"]').addEventListener("click", () => void palRun());
    actions.querySelector('[data-nk="back"]').addEventListener("click", () => palBack());
    form.appendChild(actions);
    palette.list.appendChild(form);
    const first = palette.forms[0];
    first && first.focus();
    palette.foot.textContent = command.name + (required.length ? "" : " · ↵  run");
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
      try { return JSON.parse(text); } catch { return text.split(",").map((piece) => piece.trim()); }
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
      toast(String(error.message || error), "error");
    }
  }

  function palClose() {
    palette.root && palette.root.classList.remove("nk-visible");
    palette.mode = "list";
    palette.active = null;
    palette.forms = null;
    if (palette.input) palette.input.value = "";
  }

  async function openPalette() {
    palEnsure();
    void paletteCommands().then((commands) => {
      palette.commands = commands;
      palette.view = palFilter("");
      palette.index = 0;
      palRender();
      palette.root.classList.add("nk-visible");
      palette.input.focus();
    });
  }

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
    void refreshProposals();
    void buildScrubber().then(connectEvents);
  }

  window.NucleusKit = Object.freeze({ mount, toast, openPalette });

  // auto-mount once the app page is ready (apps may re-mount with options)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mount());
  } else {
    mount();
  }
})();
