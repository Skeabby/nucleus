// PDF Workbench 2.0 — Craft front-end. Every mutation goes through /api/op, so
// the tape, undo and agent proposals see exactly what the human sees.
//
// Selection model (DTP "Organize pages" conventions):
//   click  select · ctrl-click  toggle · shift-click  range from anchor
//   ctrl+A all · Delete removes · drag a card to reorder (selection moves too)
//   Space / double-click opens the page preview
//
// Bulk edits are ONE command each (pdf.rotatePages, pdf.removePages,
// pdf.duplicatePages, pdf.movePages): a 40-page rotate is one tape record and
// one undo step, not forty.

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");
const emptyEl = $("#empty");
const canvasBody = $("#canvasbody");
const statusEl = $("#status");
const dotEl = $("#dot");
const counterEl = $("#counter");
const undoBtn = $("#undo");
const redoBtn = $("#redo");
const sourcesEl = $("#sources");
const inspectorEl = $("#inspector");

const sourceNames = new Map();
let state = { pages: [], canUndo: false, canRedo: false };
let selection = new Set();
let anchor = null; // page id where a shift-range started
let filterSource = null; // sourceId shown (null = all)
let zoom = "m";
let busy = false;
let previewId = null;

// --- pdf.js (optional: thumbnails degrade gracefully if unavailable) --------
let pdfjsLib = null;
try {
  pdfjsLib = await import("/vendor/pdfjs/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
} catch (error) {
  console.warn("[workbench] pdf.js unavailable — page numbers only", error);
}

const thumbCache = new Map(); // "sourceId:sourcePage" -> dataURL
const sourceDocs = new Map(); // sourceId -> Promise<PDFDocumentProxy>
const pageInfo = new Map(); // "sourceId:sourcePage" -> { width, height }

function getSource(sourceId) {
  let doc = sourceDocs.get(sourceId);
  if (!doc) {
    doc = pdfjsLib.getDocument({ url: `/api/source/${encodeURIComponent(sourceId)}` }).promise;
    sourceDocs.set(sourceId, doc);
  }
  return doc;
}

/** Render a source page to a canvas, at `width` CSS pixels (DPR-aware).
 *  `rotation` is baked into the render (not a CSS transform) so a 90° page gets
 *  the right aspect ratio inside its card instead of being clipped. */
async function renderPage(sourceId, sourcePage, width, rotation = 0) {
  const pdf = await getSource(sourceId);
  const page = await pdf.getPage(sourcePage + 1);
  const base = page.getViewport({ scale: 1 });
  pageInfo.set(`${sourceId}:${sourcePage}`, { width: base.width, height: base.height });
  const viewport = page.getViewport({ scale: width / base.width, rotation });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.round(viewport.width)}px`;
  canvas.style.height = `${Math.round(viewport.height)}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvas;
}

async function renderThumb(sourceId, sourcePage, rotation) {
  const key = `${sourceId}:${sourcePage}:${rotation}`;
  const cached = thumbCache.get(key);
  if (cached) return cached;
  const canvas = await renderPage(sourceId, sourcePage, 300, rotation);
  const url = canvas.toDataURL("image/jpeg", 0.72);
  thumbCache.set(key, url);
  return url;
}

const pendingThumbs = new Map();
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const info = pendingThumbs.get(entry.target);
      if (!info) continue;
      observer.unobserve(entry.target);
      if (!pdfjsLib) continue;
      renderThumb(info.sourceId, info.sourcePage, info.rotation)
        .then((url) => {
          if (url) info.img.src = url;
          if (info.badge) info.badge.textContent = orientationOf(info.sourceId, info.sourcePage);
        })
        .catch(() => {});
    }
  },
  { rootMargin: "400px" },
);

// --- server plumbing --------------------------------------------------------

function setBusy(me) {
  busy = me;
  dotEl.classList.toggle("c-dot--busy", me);
  if (me) statusEl.textContent = "Working…";
}

function toastKit(message, kind) {
  if (window.NucleusKit?.toast) window.NucleusKit.toast(message, kind);
  else statusEl.textContent = message;
}

function markError(message) {
  dotEl.classList.add("c-dot--err");
  statusEl.textContent = message;
  toastKit(message, "error");
}

function markReady(message = "Ready") {
  dotEl.classList.remove("c-dot--err", "c-dot--busy");
  statusEl.textContent = message;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

function settle(payload) {
  if (!payload.ok) {
    markError(`Error: ${payload.error?.message ?? "unknown"}`);
    return false;
  }
  dotEl.classList.remove("c-dot--err");
  state.pages = payload.pages ?? [];
  state.canUndo = Boolean(payload.canUndo);
  state.canRedo = Boolean(payload.canRedo);
  const alive = new Set(state.pages.map((page) => page.id));
  for (const id of selection) if (!alive.has(id)) selection.delete(id);
  if (previewId && !alive.has(previewId)) previewId = null;
  return true;
}

function apply(payload) {
  if (!settle(payload)) return false;
  render();
  return true;
}

async function refresh() {
  apply(await (await fetch("/api/state")).json());
  markReady();
}

/** Run one command and fold the returned snapshot in. */
async function op(name, params, label) {
  if (busy) return null;
  setBusy(true);
  try {
    const payload = await post("/api/op", { name, params, label });
    apply(payload);
    const chip = $("#bus-chip");
    if (chip) chip.textContent = label ?? name;
    if (!payload.ok) return null;
    markReady(`${label ?? name} — done`);
    return payload.result?.result ?? payload.result ?? {};
  } finally {
    setBusy(false);
    render();
  }
}

async function undo() {
  setBusy(true);
  try {
    const payload = await post("/api/undo", {});
    if (apply(payload)) markReady("Undone");
  } finally {
    setBusy(false);
    render();
  }
}

async function redo() {
  setBusy(true);
  try {
    const payload = await post("/api/redo", {});
    if (apply(payload)) markReady("Redone");
  } finally {
    setBusy(false);
    render();
  }
}

// --- files and projects ------------------------------------------------------

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadFiles(fileList) {
  const files = [...fileList].filter(
    (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
  );
  if (files.length === 0) return;
  setBusy(true);
  try {
    let done = 0;
    for (const file of files) {
      markReady(`Loading ${file.name} (${++done}/${files.length})…`);
      const dataBase64 = await fileToBase64(file);
      const loaded = await post("/api/load", { dataBase64, name: file.name });
      if (!loaded.ok) {
        markError(`Failed: ${loaded.error?.message ?? "unknown"}`);
        continue;
      }
      sourceNames.set(loaded.sourceId, file.name);
      filterSource = null;
      const pages = Array.from({ length: loaded.pageCount }, (_, index) => index);
      apply(
        await post("/api/op", {
          name: "pdf.importPages",
          params: { sourceId: loaded.sourceId, pages, name: file.name },
          label: `Import ${file.name}`,
        }),
      );
    }
    markReady(`Added ${files.length} file${files.length > 1 ? "s" : ""}.`);
  } finally {
    setBusy(false);
    render();
  }
}

async function doExport(ids) {
  if (state.pages.length === 0) {
    markError("Nothing to export — add a PDF first.");
    return;
  }
  setBusy(true);
  markReady(ids ? "Building selection PDF…" : "Building PDF…");
  try {
    const query = ids && ids.length > 0 ? `?ids=${encodeURIComponent(ids.join(","))}` : "";
    const res = await fetch(`/api/export${query}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      markError(`Export failed: ${err.error?.message ?? res.statusText}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = ids && ids.length > 0 ? "selection.pdf" : "workbench.pdf";
    link.click();
    URL.revokeObjectURL(url);
    markReady(`Exported ${ids ? ids.length : state.pages.length} page(s).`);
  } finally {
    setBusy(false);
  }
}

// --- derive ------------------------------------------------------------------

function visiblePages() {
  return filterSource ? state.pages.filter((page) => page.sourceId === filterSource) : state.pages;
}

function sourceSummaries() {
  const sources = [];
  const seen = new Map();
  for (const page of state.pages) {
    let summary = seen.get(page.sourceId);
    if (!summary) {
      summary = {
        sourceId: page.sourceId,
        name: nameFor(page.sourceId),
        pages: 0,
      };
      seen.set(page.sourceId, summary);
      sources.push(summary);
    }
    summary.pages += 1;
  }
  return sources;
}

/** Source display name: the page snapshot wins, then this session's uploads. */
function nameFor(sourceId) {
  const named = state.pages.find((page) => page.sourceId === sourceId && page.sourceName);
  return named?.sourceName ?? sourceNames.get(sourceId) ?? sourceId.slice(0, 12);
}

function orientationOf(sourceId, sourcePage) {
  const info = pageInfo.get(`${sourceId}:${sourcePage}`);
  if (!info) return "";
  return info.width > info.height ? "landscape" : "portrait";
}

function dimensionsOf(sourceId, sourcePage) {
  const info = pageInfo.get(`${sourceId}:${sourcePage}`);
  if (!info) return "—";
  const w = Math.round(info.width);
  const h = Math.round(info.height);
  return `${w} × ${h} pt`;
}

function selectedPages() {
  return state.pages.filter((page) => selection.has(page.id));
}

function selectedIndex() {
  if (!previewId) return -1;
  return state.pages.findIndex((page) => page.id === previewId);
}

// --- rendering ---------------------------------------------------------------

function render() {
  renderCards();
  renderSources();
  renderInspector();
  renderStatus();
  renderPreview();
}

function renderCards() {
  const pages = visiblePages();
  const has = state.pages.length > 0;
  emptyEl.style.display = has ? "none" : "";
  canvasBody.style.display = has ? "" : "none";
  grid.dataset.zoom = zoom;
  renderBulkStates();

  const frag = document.createDocumentFragment();
  const positionOf = new Map(state.pages.map((page, index) => [page.id, index]));
  pages.forEach((page, index) => {
    const card = document.createElement("div");
    card.className = "c-card";
    card.draggable = true;
    card.dataset.index = String(index);
    card.dataset.id = page.id;
    if (selection.has(page.id)) card.setAttribute("aria-selected", "true");
    if (page.id === previewId) card.classList.add("is-previewed");

    const thumbwrap = document.createElement("div");
    thumbwrap.className = "c-card__thumbwrap";
    const img = new Image();
    img.className = "c-card__thumb";
    img.alt = "";
    const no = document.createElement("span");
    no.className = "c-card__no";
    no.textContent = `#${(positionOf.get(page.id) ?? index) + 1} · p${page.sourcePage + 1}`;
    const rot = document.createElement("span");
    rot.className = "c-card__rot";
    rot.dataset.deg = String(page.rotation);
    rot.textContent = `${page.rotation}°`;
    const dim = document.createElement("span");
    dim.className = "c-card__dim";
    dim.textContent = orientationOf(page.sourceId, page.sourcePage);
    thumbwrap.append(img, no, rot, dim);

    const key = `${page.sourceId}:${page.sourcePage}:${page.rotation}`;
    if (thumbCache.has(key)) img.src = thumbCache.get(key);
    else if (pdfjsLib) {
      pendingThumbs.set(thumbwrap, {
        sourceId: page.sourceId,
        sourcePage: page.sourcePage,
        rotation: page.rotation,
        img,
        badge: dim,
      });
      observer.observe(thumbwrap);
    }

    const meta = document.createElement("div");
    meta.className = "c-card__meta";
    const name = document.createElement("span");
    name.className = "c-card__title";
    name.textContent = nameFor(page.sourceId);
    const pos = document.createElement("span");
    pos.textContent = `#${(positionOf.get(page.id) ?? index) + 1}`;
    meta.append(name, pos);

    card.append(thumbwrap, meta);
    frag.appendChild(card);
  });
  grid.replaceChildren(frag);
}

function renderBulkStates() {
  const count = selection.size;
  undoBtn.disabled = !state.canUndo || busy;
  redoBtn.disabled = !state.canRedo || busy;
  for (const id of ["#rot-left", "#rot-right", "#duplicate", "#remove"]) $(id).disabled = count === 0 || busy;
  $("#reverse").disabled = state.pages.length < 2 || busy;
  for (const id of ["#bar-rot-l", "#bar-rot-r", "#bar-dup", "#bar-remove"]) $(id).disabled = count === 0 || busy;
  $("#bar-clear").disabled = count === 0;
  $("#bar-export").disabled = count === 0 || busy;
  $("#sel-chip").textContent = count === 0 ? "0 selected" : `${count} selected`;
  $("#page-hint").textContent = count === 1 ? "Space previews the page" : "";
}

function renderSources() {
  const sources = sourceSummaries();
  $("#sources-count").textContent = String(sources.length);

  const rows = [];
  rows.push(
    `<button class="c-row" data-source="" aria-selected="${filterSource === null}">` +
      `<span class="c-row__title">All pages</span>` +
      `<span class="c-row__meta"><span class="c-row__snippet">${state.pages.length} pages</span></span>` +
      `</button>`,
  );
  for (const summary of sources) {
    rows.push(
      `<button class="c-row" data-source="${escapeHtml(summary.sourceId)}" aria-selected="${filterSource === summary.sourceId}">` +
        `<span class="c-row__title">${escapeHtml(summary.name)}</span>` +
        `<span class="c-row__meta"><span class="c-row__snippet">${summary.pages} page${summary.pages > 1 ? "s" : ""}</span></span>` +
        `<span class="c-row__tools">` +
        `<span class="c-mini" data-source-select="${escapeHtml(summary.sourceId)}" title="Select every page from this source">S</span>` +
        `<span class="c-mini" data-source-remove="${escapeHtml(summary.sourceId)}" title="Remove every page from this source">×</span>` +
        `</span>` +
        `</button>`,
    );
  }
  sourcesEl.innerHTML = rows.join("");
}

function propRow(label, value) {
  return (
    `<div class="c-prop"><span class="c-prop__label">${escapeHtml(label)}</span>` +
    `<span class="c-prop__value">${value}</span></div>`
  );
}

function renderInspector() {
  const selected = selectedPages();
  const parts = [];

  if (selected.length === 1) {
    const page = selected[0];
    const index = state.pages.findIndex((candidate) => candidate.id === page.id);
    parts.push('<div class="c-section">Page</div>');
    parts.push(propRow("Position", `#${index + 1} / ${state.pages.length}`));
    parts.push(propRow("Source page", `p${page.sourcePage + 1}`));
    parts.push(propRow("Source", escapeHtml(nameFor(page.sourceId))));
    parts.push(propRow("Rotation", `${page.rotation}°`));
    parts.push(propRow("Size", escapeHtml(dimensionsOf(page.sourceId, page.sourcePage))));
    parts.push(propRow("Orientation", escapeHtml(orientationOf(page.sourceId, page.sourcePage) || "—")));
    parts.push(propRow("Node", `<code>${escapeHtml(page.id)}</code>`));
    parts.push('<div class="c-section">Actions</div>');
    parts.push(
      '<div class="c-actions">' +
        '<button class="c-btn" data-act="preview">Preview</button>' +
        '<button class="c-btn" data-act="duplicate">Duplicate</button>' +
        "</div>" +
        '<div class="c-actions">' +
        '<button class="c-btn" data-act="rotate-left">Rotate left</button>' +
        '<button class="c-btn" data-act="rotate-right">Rotate right</button>' +
        "</div>" +
        '<div class="c-actions"><button class="c-btn c-btn--danger" data-act="remove">Remove page</button></div>',
    );
  } else if (selected.length > 1) {
    const rotated = selected.filter((page) => (page.rotation ?? 0) !== 0).length;
    const positions = selected
      .map((page) => `#${state.pages.findIndex((candidate) => candidate.id === page.id) + 1}`)
      .join(", ");
    parts.push('<div class="c-section">Selection</div>');
    parts.push(propRow("Pages", String(selected.length)));
    parts.push(propRow("Positions", escapeHtml(positions)));
    parts.push(propRow("Rotated", `${rotated} / ${selected.length}`));
    const sources = new Set(selected.map((page) => page.sourceId));
    parts.push(propRow("Sources", String(sources.size)));
    parts.push('<div class="c-section">Batch</div>');
    parts.push(
      '<div class="c-actions">' +
        '<button class="c-btn" data-act="duplicate">Duplicate</button>' +
        '<button class="c-btn" data-act="rotate-left">↺ 90</button>' +
        '<button class="c-btn" data-act="rotate-right">↻ 90</button>' +
        "</div>" +
        '<div class="c-actions"><button class="c-btn" data-act="export">Export selection</button></div>' +
        '<div class="c-actions"><button class="c-btn c-btn--danger" data-act="remove">Remove ' +
        selected.length +
        " pages</button></div>",
    );
    parts.push(
      '<div class="c-help"><p>Each batch is <b>one command</b>: a single tape record and a single undo step, however many pages you picked.</p></div>',
    );
  } else {
    const summary = summarise();
    parts.push('<div class="c-section">Document</div>');
    parts.push(propRow("Pages", String(summary.pages)));
    parts.push(propRow("Sources", String(summary.sources)));
    parts.push(propRow("Rotated", String(summary.rotated)));
    parts.push(propRow("Rotation mix", escapeHtml(summary.mix || "—")));
    parts.push(propRow("Can undo", state.canUndo ? "yes" : "no"));
    parts.push('<div class="c-section">Shortcuts</div>');
    parts.push(
      '<div class="c-help">' +
        "<p><b>click</b> select · <b>ctrl-click</b> toggle · <b>shift-click</b> range</p>" +
        "<p><kbd>Ctrl</kbd>+<kbd>A</kbd> all · <kbd>Del</kbd> remove · <kbd>Esc</kbd> clear</p>" +
        "<p><kbd>Space</kbd> preview · <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate · <kbd>Ctrl</kbd>+<kbd>R</kbd> rotate</p>" +
        "<p><b>drag</b> a card to reorder (a whole selection moves when one is dragged)</p>" +
        "</div>",
    );
  }
  inspectorEl.innerHTML = parts.join("");
}

function summarise() {
  const sources = new Map();
  const rotations = new Map();
  let rotated = 0;
  for (const page of state.pages) {
    sources.set(page.sourceId, (sources.get(page.sourceId) ?? 0) + 1);
    const rotation = ((page.rotation % 360) + 360) % 360;
    rotations.set(rotation, (rotations.get(rotation) ?? 0) + 1);
    if (rotation !== 0) rotated += 1;
  }
  const mix = [...rotations.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([degrees, count]) => `${degrees}°×${count}`)
    .join(" · ");
  return { pages: state.pages.length, sources: sources.size, rotated, mix };
}

function renderStatus() {
  const summary = summarise();
  counterEl.textContent =
    `${summary.pages} pages · ${selection.size} selected · ${summary.sources} source` +
    `${summary.sources === 1 ? "" : "s"}` +
    (summary.rotated > 0 ? ` · ${summary.rotated} rotated` : "");
}

// --- preview -----------------------------------------------------------------

function openPreview(id) {
  previewId = id ?? state.pages[0]?.id ?? null;
  if (!previewId) return;
  $("#preview").hidden = false;
  void renderPreview();
}

function closePreview() {
  previewId = null;
  $("#preview").hidden = true;
  renderCards();
}

async function renderPreview() {
  const overlay = $("#preview");
  if (overlay.hidden) return;
  const page = state.pages.find((entry) => entry.id === previewId);
  if (!page) {
    closePreview();
    return;
  }
  const index = state.pages.indexOf(page);
  $("#preview-label").textContent = `Page ${index + 1} of ${state.pages.length}`;
  $("#preview-foot").textContent =
    `${nameFor(page.sourceId)} · source page ${page.sourcePage + 1} · ` +
    `${page.rotation}° · ${dimensionsOf(page.sourceId, page.sourcePage)}`;

  const body = $("#preview-body");
  if (!pdfjsLib) {
    body.innerHTML = '<p class="c-help" style="padding:20px">pdf.js is unavailable — preview needs the bundled renderer.</p>';
    return;
  }
  try {
    const canvas = await renderPage(
      page.sourceId,
      page.sourcePage,
      Math.min(1000, window.innerWidth * 0.62),
      page.rotation,
    );
    if (previewId !== page.id) return; // a fast next/prev superseded this render
    canvas.style.maxWidth = "100%";
    canvas.style.maxHeight = "100%";
    body.replaceChildren(canvas);
  } catch (error) {
    body.innerHTML = `<p class="c-help" style="padding:20px">Preview failed: ${escapeHtml(String(error))}</p>`;
  }
}

function previewStep(delta) {
  const index = selectedIndex();
  if (index === -1) return;
  const next = state.pages[index + delta];
  if (!next) return;
  previewId = next.id;
  render();
  void renderPreview();
}

// --- batch actions -----------------------------------------------------------

async function rotateSelection(degrees) {
  const ids = [...selection];
  if (ids.length === 0) return;
  await op("pdf.rotatePages", { ids, degrees }, `Rotate ${ids.length} page${ids.length > 1 ? "s" : ""}`);
}

async function duplicateSelection() {
  const ids = [...selection];
  if (ids.length === 0) return;
  const result = await op("pdf.duplicatePages", { ids }, `Duplicate ${ids.length} page${ids.length > 1 ? "s" : ""}`);
  const created = result?.ids ?? [];
  if (created.length > 0) {
    selection = new Set(created);
    render();
  }
}

async function removeSelection() {
  const ids = [...selection];
  if (ids.length === 0) return;
  await op("pdf.removePages", { ids }, `Remove ${ids.length} page${ids.length > 1 ? "s" : ""}`);
  selection.clear();
  anchor = null;
  render();
}

async function reverseDocument() {
  await op("pdf.reverse", {}, "Reverse document");
}

async function removeSource(sourceId) {
  const pages = state.pages.filter((page) => page.sourceId === sourceId);
  if (pages.length === 0) return;
  const name = nameFor(sourceId);
  if (!confirm(`Remove the ${pages.length} page${pages.length === 1 ? "" : "s"} imported from "${name}"?`)) return;
  await op(
    "pdf.removePages",
    { ids: pages.map((page) => page.id) },
    `Remove source ${name}`,
  );
  if (filterSource === sourceId) filterSource = null;
  for (const page of pages) selection.delete(page.id);
  render();
}

// --- interactions ------------------------------------------------------------

grid.addEventListener("click", (event) => {
  const card = event.target instanceof HTMLElement ? event.target.closest(".c-card") : null;
  if (!card) return;
  const id = card.dataset.id;
  const pages = visiblePages();
  const index = pages.findIndex((page) => page.id === id);
  if (event.shiftKey && anchor) {
    const anchorIndex = pages.findIndex((page) => page.id === anchor);
    if (anchorIndex >= 0 && index >= 0) {
      selection.clear();
      for (let i = Math.min(anchorIndex, index); i <= Math.max(anchorIndex, index); i++) {
        selection.add(pages[i].id);
      }
    }
  } else if (event.ctrlKey || event.metaKey) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    anchor = id;
  } else {
    selection.clear();
    selection.add(id);
    anchor = id;
  }
  render();
});

grid.addEventListener("dblclick", (event) => {
  const card = event.target instanceof HTMLElement ? event.target.closest(".c-card") : null;
  if (card) openPreview(card.dataset.id);
});

grid.addEventListener("dragstart", (event) => {
  const card = event.target instanceof HTMLElement ? event.target.closest(".c-card") : null;
  if (!card) return;
  // Dragging a card that belongs to a selection drags the whole selection.
  // Update the DOM in place: replacing the nodes here would abort the drag.
  if (!selection.has(card.dataset.id)) {
    selection = new Set([card.dataset.id]);
    for (const el of grid.querySelectorAll(".c-card")) {
      el.setAttribute("aria-selected", String(selection.has(el.dataset.id)));
    }
    renderBulkStates();
  }
  card.classList.add("c-card--dragging");
  grid.dataset.dragIndex = card.dataset.index;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", card.dataset.id);
});

grid.addEventListener("dragend", (event) => {
  if (event.target instanceof Element) event.target.closest(".c-card")?.classList.remove("c-card--dragging");
  for (const el of grid.querySelectorAll(".c-card--dropzone")) el.classList.remove("c-card--dropzone");
  delete grid.dataset.dragIndex;
});

grid.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const card = event.target instanceof HTMLElement ? event.target.closest(".c-card") : null;
  for (const el of grid.querySelectorAll(".c-card--dropzone")) el.classList.remove("c-card--dropzone");
  card?.classList.add("c-card--dropzone");
});

grid.addEventListener("drop", (event) => {
  event.preventDefault();
  const card = event.target instanceof HTMLElement ? event.target.closest(".c-card") : null;
  const from = Number(grid.dataset.dragIndex ?? -1);
  if (!card || from < 0) return;
  const targetPage = visiblePages()[Number(card.dataset.index)];
  for (const el of grid.querySelectorAll(".c-card--dropzone")) el.classList.remove("c-card--dropzone");
  delete grid.dataset.dragIndex;
  if (!targetPage) return;

  const ids = [...selection];
  if (ids.length === 0) return;
  const moving = new Set(ids);
  if (moving.has(targetPage.id)) return; // dropped onto itself

  // `to` is the insertion index in the list with the moved pages lifted out:
  // count the untouched pages that sit before the drop target.
  const targetIndex = state.pages.indexOf(targetPage);
  const to = state.pages.slice(0, targetIndex).filter((page) => !moving.has(page.id)).length;
  void op("pdf.movePages", { ids, to }, "Move pages");
});

// Sources rail
sourcesEl.addEventListener("click", (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return;
  const selectAll = target.closest("[data-source-select]");
  if (selectAll) {
    event.stopPropagation();
    const sourceId = selectAll.dataset.sourceSelect;
    selection = new Set(state.pages.filter((page) => page.sourceId === sourceId).map((page) => page.id));
    anchor = null;
    render();
    return;
  }
  const remove = target.closest("[data-source-remove]");
  if (remove) {
    event.stopPropagation();
    void removeSource(remove.dataset.sourceRemove);
    return;
  }
  const row = target.closest("[data-source]");
  if (!row) return;
  const sourceId = row.dataset.source;
  filterSource = sourceId === "" || filterSource === sourceId ? null : sourceId;
  selection.clear();
  render();
});

// Inspector actions
inspectorEl.addEventListener("click", (event) => {
  const button = event.target instanceof HTMLElement ? event.target.closest("[data-act]") : null;
  if (!button) return;
  switch (button.dataset.act) {
    case "preview": openPreview([...selection][0]); break;
    case "duplicate": void duplicateSelection(); break;
    case "rotate-left": void rotateSelection(-90); break;
    case "rotate-right": void rotateSelection(90); break;
    case "remove": void removeSelection(); break;
    case "export": void doExport([...selection]); break;
    default: break;
  }
});

// Toolstrip + canvas bar
$("#rot-left").addEventListener("click", () => void rotateSelection(-90));
$("#rot-right").addEventListener("click", () => void rotateSelection(90));
$("#duplicate").addEventListener("click", () => void duplicateSelection());
$("#reverse").addEventListener("click", () => void reverseDocument());
$("#remove").addEventListener("click", () => void removeSelection());
$("#bar-rot-l").addEventListener("click", () => void rotateSelection(-90));
$("#bar-rot-r").addEventListener("click", () => void rotateSelection(90));
$("#bar-dup").addEventListener("click", () => void duplicateSelection());
$("#bar-remove").addEventListener("click", () => void removeSelection());
$("#bar-export").addEventListener("click", () => void doExport([...selection]));
$("#bar-clear").addEventListener("click", () => {
  selection.clear();
  anchor = null;
  render();
});

for (const button of document.querySelectorAll("#zoom-seg button")) {
  button.addEventListener("click", () => {
    zoom = button.dataset.zoom;
    for (const other of document.querySelectorAll("#zoom-seg button")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    render();
  });
}

// Preview overlay
$("#preview-close").addEventListener("click", closePreview);
$("#preview-prev").addEventListener("click", () => previewStep(-1));
$("#preview-next").addEventListener("click", () => previewStep(1));
$("#preview-rot").addEventListener("click", async () => {
  if (!previewId) return;
  await op("pdf.rotatePages", { ids: [previewId], degrees: 90 }, "Rotate page");
  await renderPreview();
});
$("#preview").addEventListener("click", (event) => {
  if (event.target === $("#preview")) closePreview();
});

// Files
$("#file-input").addEventListener("change", (event) => void loadFiles(event.target.files));
$("#add-rail").addEventListener("click", () => $("#file-input").click());
$("#export-all").addEventListener("click", () => void doExport());
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);
$("#palette").addEventListener("click", () => window.NucleusKit?.openPalette());

$("#reset").addEventListener("click", async () => {
  if (state.pages.length > 0 && !confirm("Clear the document and every loaded source?")) return;
  setBusy(true);
  try {
    sourceNames.clear();
    thumbCache.clear();
    sourceDocs.clear();
    pageInfo.clear();
    selection.clear();
    filterSource = null;
    apply(await post("/api/reset"));
    markReady("Reset.");
  } finally {
    setBusy(false);
    render();
  }
});

$("#save").addEventListener("click", () => {
  if (state.pages.length === 0) {
    markError("Nothing to save yet.");
    return;
  }
  markReady("Saving project…");
  const link = document.createElement("a");
  link.href = "/api/project";
  link.download = "workbench.nucleus.json";
  link.click();
});

$("#project-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy(true);
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    sourceNames.clear();
    thumbCache.clear();
    sourceDocs.clear();
    pageInfo.clear();
    selection.clear();
    filterSource = null;
    apply(await post("/api/project", payload));
    markReady(`Opened ${file.name}.`);
  } catch (error) {
    markError(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
    render();
    event.target.value = "";
  }
});

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const typing =
    event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

  if (!mod && event.key === " " && !typing && !$("#preview").hidden) {
    // Space pages forward inside the preview, closes it at the end.
    event.preventDefault();
    if (selectedIndex() < state.pages.length - 1) previewStep(1);
    else closePreview();
    return;
  }
  if (!mod && event.key === " " && !typing) {
    event.preventDefault();
    openPreview([...selection][0]);
    return;
  }
  if (event.key === "Escape") {
    if (!$("#preview").hidden) {
      closePreview();
      return;
    }
    selection.clear();
    anchor = null;
    render();
    return;
  }
  if (!$("#preview").hidden && event.key === "ArrowLeft") {
    event.preventDefault();
    previewStep(-1);
    return;
  }
  if (!$("#preview").hidden && event.key === "ArrowRight") {
    event.preventDefault();
    previewStep(1);
    return;
  }
  if (mod && key === "z" && !event.shiftKey) { event.preventDefault(); void undo(); }
  else if (mod && ((key === "z" && event.shiftKey) || key === "y")) { event.preventDefault(); void redo(); }
  else if (mod && key === "a" && state.pages.length > 0) {
    event.preventDefault();
    selection = new Set(visiblePages().map((page) => page.id));
    anchor = null;
    render();
  } else if (mod && key === "d") { event.preventDefault(); void duplicateSelection(); }
  else if (mod && key === "r" && event.shiftKey) { event.preventDefault(); void rotateSelection(-90); }
  else if (mod && key === "r") { event.preventDefault(); void rotateSelection(90); }
  else if (mod && (key === "=" || key === "+")) { event.preventDefault(); cycleZoom(1); }
  else if (mod && key === "-") { event.preventDefault(); cycleZoom(-1); }
  else if (!mod && !event.altKey && !typing && (event.key === "Delete" || event.key === "Backspace") && selection.size) {
    event.preventDefault();
    void removeSelection();
  }
});

function cycleZoom(delta) {
  const order = ["s", "m", "l"];
  const next = order[Math.max(0, Math.min(order.length - 1, order.indexOf(zoom) + delta))];
  zoom = next;
  for (const button of document.querySelectorAll("#zoom-seg button")) {
    button.setAttribute("aria-pressed", String(button.dataset.zoom === zoom));
  }
  render();
}

// Native file drops anywhere on the canvas.
const dropzone = $("#dropzone");
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("--dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("--dragover"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("--dragover");
  if (event.dataTransfer?.files?.length) void loadFiles(event.dataTransfer.files);
});

// Other tabs / agents: the app-kit hub broadcasts a state frame per command.
if (typeof EventSource !== "undefined") {
  let timer = null;
  const events = new EventSource("/api/events");
  events.addEventListener("state", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 250);
  });
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

void refresh();
