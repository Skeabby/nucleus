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
      accent: getComputedStyle(document.documentElement).getPropertyValue("--app-accent") || "",
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

  // ------------------------------------------------------------------ mount

  function mount(options) {
    Object.assign(state.options, options || {});
    if (state.options.accent) {
      document.documentElement.style.setProperty("--nk-accent", state.options.accent);
    }
    void refreshProposals();
    void buildScrubber().then(connectEvents);
  }

  window.NucleusKit = Object.freeze({ mount, toast });

  // auto-mount once the app page is ready (apps may re-mount with options)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mount());
  } else {
    mount();
  }
})();
