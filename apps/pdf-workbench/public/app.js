// PDF Workbench — Craft front-end. Every mutation goes through /api/op, so
// the tape, undo and agent proposals see exactly what the human sees.
//
// Selection model (PdfCraft "Organize pages" conventions):
//   click  select · ctrl-click  toggle · shift-click  range from anchor
//   ctrl+A all · Delete removes · drag a card to reorder (drop = insertion)

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");
const emptyEl = $("#empty");
const canvasEl = $("#dropzone");
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
let anchor = null;        // page id where a shift-range started
let filterSource = null;  // sourceId shown (null = all)
let zoom = "m";
let busy = false;
let lastAction = null;

// --- pdf.js (optional: thumbnails degrade gracefully if unavailable) --------
let pdfjsLib = null;
try {
  pdfjsLib = await import("/vendor/pdfjs/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
} catch (error) {
  console.warn("[workbench] pdf.js unavailable — page numbers only", error);
}

const thumbCache = new Map(); // "sourceId:sourcePage" -> dataURL
const sourceDocs = new Map(); // "sourceId" -> Promise<PDFDocumentProxy>

function getSource(sourceId) {
  let doc = sourceDocs.get(sourceId);
  if (!doc) {
    doc = pdfjsLib.getDocument({ url: `/api/source/${encodeURIComponent(sourceId)}` }).promise;
    sourceDocs.set(sourceId, doc);
  }
  return doc;
}

async function renderThumb(sourceId, sourcePage) {
  const key = `${sourceId}:${sourcePage}`;
  const cached = thumbCache.get(key);
  if (cached) return cached;
  const pdf = await getSource(sourceId);
  const page = await pdf.getPage(sourcePage + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 300 / base.width });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
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
      renderThumb(info.sourceId, info.sourcePage)
        .then((url) => { if (url) info.img.src = url; })
        .catch(() => {});
    }
  },
  { rootMargin: "400px" },
);

// Template-literal safe accessor (kept from the old map-based flow).

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
  dotEl.classList.replace("c-dot", "c-dot--err");
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

function apply(payload) {
  if (!settle(payload)) return;
  render();
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
  return true;
}

async function refresh() {
  apply(await (await fetch("/api/state")).json());
  markReady();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadFiles(fileList) {
  const files = [...fileList].filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
  if (files.length === 0) return true;
  setBusy(true);
  try {
    let done = 0;
    for (const file of files) {
      markReady(`Loading ${file.name} (${++done}/${files.length})…`);
      const dataBase64 = await fileToBase64(file);
      const loaded = await post("/api/load", { dataBase64, name: file.name });
      if (!loaded.ok) { markError(`Failed: ${loaded.error?.message ?? "unknown"}`); continue; }
      sourceNames.set(loaded.sourceId, file.name);
      filterSource = null;
      const pages = Array.from({ length: loaded.pageCount }, (_, i) => i);
      apply(await post("/api/op", { name: "pdf.importPages", params: { sourceId: loaded.sourceId, pages }, label: `Import ${file.name}` }));
    }
    render();
    markReady(`Added ${files.length} file${files.length > 1 ? "s" : ""}.`);
    return true;
  } finally {
    setBusy(false);
    render();
  }
}

async function op(name, params, label) {
  if (busy) return false;
  setBusy(true);
  try {
    apply(await post("/api/op", { name, params, label }));
    lastAction = label ?? name;
    const chip = $("#bus-chip");
    if (chip) chip.textContent = label ?? name;
    if (statusEl.textContent.startsWith("Error")) return false;
    markReady(`${label ?? name} — done`);
    return true;
  } finally {
    setBusy(false);
    render();
  }
}

/** Run one command per selected page, then a single refresh. */
async function batchOp(name, label, paramFor) {
  const ids = [...selection];
  if (ids.length === 0 || busy) return;
  setBusy(true);
  try {
    for (const id of ids) {
      const res2 = await post("/api/op", { name, params: paramFor(id), label });
      if (!settle(res2)) { render(); return; }
    }
    lastAction = `${label} (${ids.length})`;
    render();
    markReady(`${label}: ${ids.length} page${ids.length > 1 ? "s" : ""} — done`);
  } finally {
    setBusy(false);
    render();
  }
}

async function undo() {
  setBusy(true);
  try { apply(await post("/api/undo")); markReady("Undone"); }
  finally { setBusy(false); render(); }
}

async function redo() {
  setBusy(true);
  try { apply(await post("/api/redo")); markReady("Redone"); }
  finally { setBusy(false); render(); }
}

async function doExport() {
  if (state.pages.length === 0) { markError("Nothing to export — add a PDF first."); return; }
  setBusy(true);
  markReady("Building PDF…");
  try {
    const res = await fetch("/api/export");
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      markError(`Export failed: ${err.error?.message ?? res.statusText}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "workbench.pdf";
    a.click();
    URL.revokeObjectURL(url);
    markReady(`Exported ${state.pages.length} page(s).`);
  } finally {
    setBusy(false);
  }
}

// --- derive -----------------------------------------------------------------
function visiblePages() {
  return filterSource ? state.pages.filter((page) => page.sourceId === filterSource) : state.pages;
}

function sourceSummaries() {
  const sources = [];
  const seen = new Map();
  for (const page of state.pages) {
    let summary = seen.get(page.sourceId);
    if (!summary) {
      summary = { sourceId: page.sourceId, name: sourceNames.get(page.sourceId) ?? page.sourceId.slice(0, 12), pages: 0 };
      seen.set(page.sourceId, summary);
      sources.push(summary);
    }
    summary.pages++;
  }
  return sources;
}

// --- rendering ----------------------------------------------------------------
function rotationTransform(rotation) {
  return rotation % 180 === 0 ? `rotate(${rotation}deg)` : `rotate(${rotation}deg) scale(0.72)`;
}

function render() {
  renderCards();
  renderSources();
  renderInspector();
  renderStatus();
}

function renderCards() {
  const pages = visiblePages();
  emptyEl.style.display = pages.length === 0 ? "" : "none";
  canvasBody.style.display = pages.length === 0 ? "none" : "";
  grid.dataset.zoom = zoom;

  undoBtn.disabled = !state.canUndo || busy;
  redoBtn.disabled = !state.canRedo || busy;

  const selected = selection.size;
  $("#rot-left").disabled = $("#rot-right").disabled = $("#remove").disabled = selected === 0;
  $("#bar-rot-l").disabled = $("#bar-rot-r").disabled = $("#bar-remove").disabled = selected === 0 || busy;
  $("#bar-clear").disabled = selected === 0;
  $("#sel-chip").textContent = `${selected} selected`;

  const frag = document.createDocumentFragment();
  pages.forEach((page, index) => {
    const card = document.createElement("div");
    card.className = "c-card";
    card.draggable = true;
    card.dataset.index = String(index);
    card.dataset.id = page.id;
    if (selection.has(page.id)) card.setAttribute("aria-selected", "true");

    const thumbwrap = document.createElement("div");
    thumbwrap.className = "c-card__thumbwrap";
    const img = new Image();
    img.className = "c-card__thumb";
    img.alt = "";
    img.style.transform = rotationTransform(page.rotation);
    const no = document.createElement("span");
    no.className = "c-card__no";
    no.textContent = `#${index + 1} · p${page.sourcePage + 1}`;
    const rot = document.createElement("span");
    rot.className = "c-card__rot";
    rot.dataset.deg = String(page.rotation);
    rot.textContent = `${page.rotation}°`;
    thumbwrap.append(img, no, rot);

    const key = `${page.sourceId}:${page.sourcePage}`;
    if (thumbCache.has(key)) img.src = thumbCache.get(key);
    else if (pdfjsLib) {
      pendingThumbs.set(thumbwrap, { sourceId: page.sourceId, sourcePage: page.sourcePage, img });
      observer.observe(thumbwrap);
    }

    const meta = document.createElement("div");
    meta.className = "c-card__meta";
    const name = document.createElement("span");
    name.className = "c-card__title";
    name.textContent = sourceNames.get(page.sourceId) ?? page.sourceId.slice(0, 12);
    const pos = document.createElement("span");
    pos.textContent = `#${index + 1}`;
    meta.append(name, pos);

    card.append(thumbwrap, meta);
    frag.appendChild(card);
  });
  grid.replaceChildren(frag);
}

function renderSources() {
  const sources = sourceSummaries();
  $("#sources-count").textContent = String(sources.length);

  const frag = document.createDocumentFragment();
  const all = document.createElement("button");
  all.type = "button";
  all.className = "c-row";
  all.setAttribute("aria-selected", String(filterSource === null));
  all.innerHTML =
    '<span class="c-row__title">All pages</span>' +
    `<span class="c-row__meta"><span class="c-row__snippet">${state.pages.length} pages</span></span>`;
  all.addEventListener("click", () => { filterSource = null; render(); });
  frag.appendChild(all);

  for (const summary of sources) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "c-row";
    row.setAttribute("aria-selected", String(filterSource === summary.sourceId));
    row.innerHTML =
      `<span class="c-row__title">${escapeHtml(summary.name)}</span>` +
      `<span class="c-row__meta"><span class="c-row__snippet">${summary.pages} page${summary.pages > 1 ? "s" : ""}</span>` +
      `<span class="c-row__count">${summary.sourceId.slice(0, 8)}</span></span>`;
    row.addEventListener("click", () => {
      filterSource = filterSource === summary.sourceId ? null : summary.sourceId;
      selection.clear();
      render();
    });
    frag.appendChild(row);
  }
  sourcesEl.replaceChildren(frag);
}

function propRow(label, value) {
  return `<div class="c-prop"><span class="c-prop__label">${escapeHtml(label)}</span>` +
    `<span class="c-prop__value">${value}</span></div>`;
}

function renderInspector() {
  const pages = visiblePages();
  const selected = state.pages.filter((page) => selection.has(page.id));
  const parts = [];

  if (selected.length === 1) {
    const page = selected[0];
    const index = state.pages.findIndex((candidate) => candidate.id === page.id);
    parts.push('<div class="c-section">Page</div>');
    parts.push(propRow("Position", `#${index + 1}`));
    parts.push(propRow("Source page", `p${page.sourcePage + 1}`));
    parts.push(propRow("Rotation", `${page.rotation}°`));
    parts.push(propRow("Source", escapeHtml(sourceNames.get(page.sourceId) ?? page.sourceId.slice(0, 12))));
    parts.push(propRow("Node", `<code>${escapeHtml(page.id)}</code>`));
  } else if (selected.length > 1) {
    const rotated = selected.filter((page) => (page.rotation ?? 0) !== 0).length;
    parts.push('<div class="c-section">Selection</div>');
    parts.push(propRow("Pages", String(selected.length)));
    parts.push(propRow("Positions", selected.map((page) => `#${state.pages.findIndex((c) => c.id === page.id) + 1}`).join(", ")));
    parts.push(propRow("Rotated", `${rotated} / ${selected.length}`));
    parts.push('<div class="c-section">Batch</div>');
    parts.push('<div class="c-help"><p>Use the sticky bar above the canvas or the toolstrip: rotate / remove apply to every selected page as one labelled step each.</p></div>');
  } else {
    parts.push('<div class="c-section">Document</div>');
    parts.push(propRow("Pages", String(state.pages.length)));
    parts.push(propRow("Sources", String(sourceSummaries().length)));
    parts.push(propRow("Can undo", state.canUndo ? "yes" : "no"));
    parts.push('<div class="c-section">Shortcuts</div>');
    parts.push('<div class="c-help">' +
      '<p><b>click</b> select · <b>ctrl-click</b> toggle · <b>shift-click</b> range</p>' +
      '<p><kbd>Ctrl</kbd>+<kbd>A</kbd> all · <kbd>Del</kbd> remove · <kbd>Esc</kbd> clear</p>' +
      '<p><b>drag</b> a card to reorder · rotate / tools must be <b>water-tight</b> in the toolstrip</p>' +
      "</div>");
  }
  inspectorEl.innerHTML = parts.join("");
}

function renderStatus() {
  const sources = sourceSummaries().length;
  counterEl.textContent = `${state.pages.length} pages · ${selection.size} selected · ${sources} source${sources > 1 ? "s" : ""}`;
}

// --- interactions -------------------------------------------------------------
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
      for (let i = Math.min(anchorIndex, index); i <= Math.max(anchorIndex, index); i++) selection.add(pages[i].id);
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

grid.addEventListener("dragstart", (event) => {
  const card = event.target instanceof HTMLElement ? event.target.closest(".c-card") : null;
  if (!card) return;
  card.classList.add("c-card--dragging");
  grid.dataset.dragIndex = card.dataset.index;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", card.dataset.id);
});
grid.addEventListener("dragend", (event) => {
  event.target instanceof Element && event.target.closest(".c-card")?.classList.remove("c-card--dragging");
  grid.querySelectorAll(".c-card--dropzone").forEach((el) => el.classList.remove("c-card--dropzone"));
  delete grid.dataset.dragIndex;
});
grid.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const card = event.target instanceof HTMLElement ? event.target.closest(".c-card") : null;
  grid.querySelectorAll(".c-card--dropzone").forEach((el) => el.classList.remove("c-card--dropzone"));
  card && card.classList.add("c-card--dropzone");
});
grid.addEventListener("drop", (event) => {
  event.preventDefault();
  const card = event.target instanceof HTMLElement ? event.target.closest(".c-card") : null;
  const from = Number(grid.dataset.dragIndex ?? -1);
  if (!card || from < 0) return;
  const to = Number(card.dataset.index);
  // movePage removes `from` first: dropping before original index i lands at
  // i-1 when the drag came from earlier in the list.
  const target = to > from ? to - 1 : to;
  grid.querySelectorAll(".c-card--dropzone").forEach((el) => el.classList.remove("c-card--dropzone"));
  if (target !== from) {
    const id = state.pages[from].id;
    void op("pdf.movePage", { id, to: target }, "Move page");
  }
  delete grid.dataset.dragIndex;
});

// Toolstrip + canvasbar batch actions
$("#rot-left").addEventListener("click", () => void batchOp("pdf.rotatePage", "Rotate pages", (id) => ({ id, degrees: -90 })));
$("#rot-right").addEventListener("click", () => void batchOp("pdf.rotatePage", "Rotate pages", (id) => ({ id, degrees: 90 })));
$("#remove").addEventListener("click", () => void batchOp("pdf.removePage", "Remove pages", (id) => ({ id })));
$("#bar-rot-l").addEventListener("click", () => void batchOp("pdf.rotatePage", "Rotate pages", (id) => ({ id, degrees: -90 })));
$("#bar-rot-r").addEventListener("click", () => void batchOp("pdf.rotatePage", "Rotate pages", (id) => ({ id, degrees: 90 })));
$("#bar-remove").addEventListener("click", () => void batchOp("pdf.removePage", "Remove pages", (id) => ({ id })));
$("#bar-clear").addEventListener("click", () => { selection.clear(); anchor = null; render(); });

for (const button of document.querySelectorAll("#zoom-seg button")) {
  button.addEventListener("click", () => {
    zoom = button.dataset.zoom;
    for (const other of document.querySelectorAll("#zoom-seg button")) other.setAttribute("aria-pressed", String(other === button));
    render();
  });
}

// Files
$("#file-input").addEventListener("change", (event) => void loadFiles(event.target.files));
$("#add-rail").addEventListener("click", () => void $("#file-input").click());
$("#export").addEventListener("click", doExport);
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);
$("#palette").addEventListener("click", () => window.NucleusKit?.openPalette());

$("#reset").addEventListener("click", async () => {
  setBusy(true);
  try {
    sourceNames.clear();
    thumbCache.clear();
    sourceDocs.clear();
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
  if (state.pages.length === 0) { markError("Nothing to save yet."); return; }
  markReady("Saving project…");
  const a = document.createElement("a");
  a.href = "/api/project";
  a.download = "workbench.nucleus.json";
  a.click();
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
  if (mod && key === "z" && !event.shiftKey) { event.preventDefault(); void undo(); }
  else if (mod && ((key === "z" && event.shiftKey) || key === "y")) { event.preventDefault(); void redo(); }
  else if (mod && key === "a" && state.pages.length) {
    event.preventDefault();
    selection = new Set(visiblePages().map((page) => page.id));
    anchor = null;
    render();
  } else if (!mod && !event.altKey && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)
    && (event.key === "Delete" || event.key === "Backspace") && selection.size) {
    event.preventDefault();
    void batchOp("pdf.removePage", "Remove pages", (id) => ({ id }));
  } else if (event.key === "Escape") {
    selection.clear();
    anchor = null;
    render();
  }
});

const dropzone = $("#dropzone");
dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("--dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("--dragover"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("--dragover");
  if (event.dataTransfer?.files?.length) void loadFiles(event.dataTransfer.files);
});

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

void refresh();
