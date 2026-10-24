// PDF Workbench — the front-end, sitting on the shared Nucleus shell (brief #3 §3.2).
//
// The chrome is not this app's business any more. NucleusShell owns the menubar,
// the contextual options bar, the single shortcut registry, the icon rail, the
// panels, the status bar and the confirmation dialogs. What is left here is the
// document: import, select, reorder, rotate, duplicate, export.
//
// Every mutation still goes through /api/op, so History, undo and agent
// proposals see exactly what the human sees.
//
// Selection model (DTP "Organize pages" conventions):
//   click select · ctrl-click toggle · shift-click range · Ctrl+A all
//   drag a card to reorder (the whole selection moves) · double-click previews
//
// Bulk edits are ONE command each (pdf.rotatePages, pdf.removePages,
// pdf.duplicatePages, pdf.movePages): a 40-page rotate is one tape record and
// one undo step, not forty.

const $ = (sel) => document.querySelector(sel);

const emptyEl = $("#empty");
const grid = $("#grid");
const workspace = $("#workspace");
const fileInput = $("#file-input");
const projectInput = $("#project-input");
const previewEl = $("#preview");

const sourceNames = new Map();
let state = { pages: [], canUndo: false, canRedo: false };
let selection = new Set();
let anchor = null; // page id where a shift-range started
let filterSource = null; // documents panel: one source only (null = all)
let query = ""; // find panel: text filter over file name / positions
let zoom = "m";
let busy = false;
let previewId = null;
let lastCommand = ""; // information only (Properties → developer details)
let status = { text: "Ready", kind: "ready" };

// --- pdf.js (optional: thumbnails degrade gracefully if unavailable) --------
let pdfjsLib = null;
try {
  pdfjsLib = await import("/vendor/pdfjs/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
} catch (error) {
  console.warn("[workbench] pdf.js unavailable — page numbers only", error);
}

const thumbCache = new Map(); // "sourceId:sourcePage:rotation" -> dataURL
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

// --- status -----------------------------------------------------------------

function sync(options) {
  // Panels are rebuilt by the shell; pass { panels: false } while a field in a
  // panel has focus (the find box), so typing never loses the caret.
  window.NucleusShell.setContext(
    {
      selection: [...selection],
      pages: state.pages.length,
      preview: previewId,
      filter: filterSource,
    },
    options,
  );
}

function setStatus(text, kind = "ready") {
  status = { text, kind };
  sync();
}

function setBusy(me) {
  busy = me;
  if (me) setStatus("Working…", "busy");
  else sync();
}

function toastKit(message, kind) {
  if (window.NucleusKit?.toast) window.NucleusKit.toast(message, kind);
  else status = { text: message, kind: kind || "ready" };
}

function markError(message) {
  status = { text: message, kind: "error" };
  toastKit(message, "error");
  sync();
}

function markReady(message = "Ready") {
  status = { text: message, kind: "ready" };
  sync();
}

// --- server plumbing ---------------------------------------------------------

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
    lastCommand = label ?? name;
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
      setStatus(`Loading ${file.name} (${++done}/${files.length})…`, "busy");
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
  setStatus(ids && ids.length ? "Building selection PDF…" : "Building PDF…", "busy");
  try {
    const queryString = ids && ids.length > 0 ? `?ids=${encodeURIComponent(ids.join(","))}` : "";
    const res = await fetch(`/api/export${queryString}`);
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
    markReady(`Exported ${ids && ids.length ? ids.length : state.pages.length} page(s).`);
  } finally {
    setBusy(false);
  }
}

function saveProject() {
  if (state.pages.length === 0) {
    markError("Nothing to save yet.");
    return;
  }
  markReady("Saving project…");
  const link = document.createElement("a");
  link.href = "/api/project";
  link.download = "workbench.nucleus.json";
  link.click();
}

async function openProject(file) {
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
    query = "";
    apply(await post("/api/project", payload));
    markReady(`Opened ${file.name}.`);
  } catch (error) {
    markError(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
    render();
  }
}

async function startOver() {
  setBusy(true);
  try {
    sourceNames.clear();
    thumbCache.clear();
    sourceDocs.clear();
    pageInfo.clear();
    selection.clear();
    anchor = null;
    filterSource = null;
    query = "";
    apply(await post("/api/reset"));
    markReady("Started over.");
  } finally {
    setBusy(false);
    render();
  }
}

// --- derive ------------------------------------------------------------------

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
  return `${Math.round(info.width)} × ${Math.round(info.height)} pt`;
}

function visiblePages() {
  const text = query.trim().toLowerCase();
  return state.pages.filter((page, index) => {
    if (filterSource && page.sourceId !== filterSource) return false;
    if (!text) return true;
    const name = nameFor(page.sourceId).toLowerCase();
    const position = `#${index + 1}`;
    return name.includes(text) || position.includes(text);
  });
}

function sourceSummaries() {
  const sources = [];
  const seen = new Map();
  for (const page of state.pages) {
    let summary = seen.get(page.sourceId);
    if (!summary) {
      summary = { sourceId: page.sourceId, name: nameFor(page.sourceId), pages: 0 };
      seen.set(page.sourceId, summary);
      sources.push(summary);
    }
    summary.pages += 1;
  }
  return sources;
}

function selectedPages() {
  return state.pages.filter((page) => selection.has(page.id));
}

function selectedIndex() {
  if (!previewId) return -1;
  return state.pages.findIndex((page) => page.id === previewId);
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

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// --- rendering ---------------------------------------------------------------

function render() {
  renderBoard();
  void renderPreview();
  sync();
}

function renderBoard() {
  const has = state.pages.length > 0;
  emptyEl.hidden = has;
  grid.hidden = !has;
  grid.dataset.zoom = zoom;
  if (!has) {
    grid.replaceChildren();
    return;
  }

  const pages = visiblePages();
  const positionOf = new Map(state.pages.map((page, index) => [page.id, index]));
  const frag = document.createDocumentFragment();
  pages.forEach((page, index) => {
    const position = (positionOf.get(page.id) ?? 0) + 1;
    const card = document.createElement("div");
    card.className = "c-card";
    card.draggable = true;
    card.tabIndex = 0;
    card.dataset.index = String(index);
    card.dataset.id = page.id;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", String(selection.has(page.id)));
    card.setAttribute("aria-label", `Page ${position}, ${nameFor(page.sourceId)} page ${page.sourcePage + 1}`);
    if (page.id === previewId) card.classList.add("is-previewed");

    const thumbwrap = document.createElement("div");
    thumbwrap.className = "c-card__thumbwrap";
    const img = new Image();
    img.className = "c-card__thumb";
    img.alt = "";
    const no = document.createElement("span");
    no.className = "c-card__no";
    no.textContent = `#${position} · p${page.sourcePage + 1}`;
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
    pos.textContent = `#${position}`;
    meta.append(name, pos);

    card.append(thumbwrap, meta);
    frag.appendChild(card);
  });
  grid.replaceChildren(frag);
}

// --- panels (documents · find · properties) ----------------------------------

function panelHead(title, count) {
  const head = document.createElement("div");
  head.className = "c-panelhead";
  const label = document.createElement("span");
  label.textContent = title;
  head.appendChild(label);
  if (count !== undefined) {
    const chip = document.createElement("span");
    chip.className = "c-chip";
    chip.textContent = String(count);
    head.appendChild(chip);
  }
  return head;
}

function docRow(sourceId, title, meta, selected) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "c-row";
  row.dataset.source = sourceId;
  row.setAttribute("aria-selected", String(selected));
  row.title = sourceId ? "Show only this file" : "Show every page";
  const name = document.createElement("span");
  name.className = "c-row__title";
  name.textContent = title;
  const metaEl = document.createElement("span");
  metaEl.className = "c-row__meta";
  const snippet = document.createElement("span");
  snippet.className = "c-row__snippet";
  snippet.textContent = meta;
  metaEl.appendChild(snippet);
  row.append(name, metaEl);
  return row;
}

function documentsPanel(ctx) {
  if (ctx.panel === "history") return null; // the shell renders History itself
  if (ctx.panel === "find") return findPanel();

  const wrap = document.createElement("div");
  wrap.className = "w-panel";
  const sources = sourceSummaries();
  wrap.appendChild(panelHead("Documents", sources.length));

  const body = document.createElement("div");
  body.className = "c-rail__body";
  const all = docRow("", "All pages", plural(state.pages.length, "page"), filterSource === null);
  all.addEventListener("click", () => {
    filterSource = null;
    selection.clear();
    anchor = null;
    render();
  });
  body.appendChild(all);
  for (const summary of sources) {
    const row = docRow(summary.sourceId, summary.name, plural(summary.pages, "page"), filterSource === summary.sourceId);
    row.addEventListener("click", () => {
      filterSource = filterSource === summary.sourceId ? null : summary.sourceId;
      selection.clear();
      anchor = null;
      render();
    });
    body.appendChild(row);
  }
  if (sources.length === 0) {
    const note = document.createElement("p");
    note.className = "c-help";
    note.textContent = "No files yet.";
    body.appendChild(note);
  }
  wrap.appendChild(body);
  return wrap;
}

function findPanel() {
  const wrap = document.createElement("div");
  wrap.className = "w-panel";
  wrap.appendChild(panelHead("Find"));

  const body = document.createElement("div");
  body.className = "c-rail__body w-find";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "w-input";
  input.placeholder = "File name or #position";
  input.value = query;
  input.setAttribute("aria-label", "Filter pages");
  input.spellcheck = false;

  const count = document.createElement("p");
  count.className = "c-help";
  const report = () => {
    const shown = visiblePages().length;
    count.textContent = query.trim()
      ? `${shown} of ${plural(state.pages.length, "page")} match`
      : `${plural(state.pages.length, "page")} in the document`;
  };
  report();

  input.addEventListener("input", () => {
    query = input.value;
    report();
    renderBoard();
    sync({ panels: false });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    query = "";
    input.value = "";
    report();
    renderBoard();
    sync({ panels: false });
  });

  body.append(input, count);
  wrap.appendChild(body);
  return wrap;
}

function propRow(label, value) {
  const row = document.createElement("div");
  row.className = "c-prop";
  const key = document.createElement("span");
  key.className = "c-prop__label";
  key.textContent = label;
  const val = document.createElement("span");
  val.className = "c-prop__value";
  val.textContent = value;
  row.append(key, val);
  return row;
}

function section(title) {
  const node = document.createElement("div");
  node.className = "c-section";
  node.textContent = title;
  return node;
}

/** Properties is information, never a second set of buttons (brief #3 §3.2). */
function propertiesPanel() {
  const wrap = document.createElement("div");
  wrap.className = "w-panel";
  wrap.appendChild(panelHead("Properties"));

  const body = document.createElement("div");
  body.className = "c-inspector__body w-props";
  const selected = selectedPages();

  if (selected.length === 1) {
    const page = selected[0];
    const index = state.pages.indexOf(page);
    body.appendChild(section("Page"));
    body.appendChild(propRow("Position", `#${index + 1} of ${state.pages.length}`));
    body.appendChild(propRow("File page", `p${page.sourcePage + 1}`));
    body.appendChild(propRow("File", nameFor(page.sourceId)));
    body.appendChild(propRow("Rotation", `${page.rotation}°`));
    body.appendChild(propRow("Size", dimensionsOf(page.sourceId, page.sourcePage)));
    body.appendChild(propRow("Orientation", orientationOf(page.sourceId, page.sourcePage) || "—"));

    const dev = document.createElement("div");
    dev.setAttribute("data-dev", "");
    dev.appendChild(section("Developer details"));
    dev.appendChild(propRow("Node", page.id));
    dev.appendChild(propRow("Last command", lastCommand || "—"));
    body.appendChild(dev);
  } else if (selected.length > 1) {
    const rotated = selected.filter((page) => (page.rotation ?? 0) !== 0).length;
    const positions = selected
      .map((page) => `#${state.pages.findIndex((candidate) => candidate.id === page.id) + 1}`)
      .join(", ");
    body.appendChild(section("Selection"));
    body.appendChild(propRow("Pages", String(selected.length)));
    body.appendChild(propRow("Rotated", `${rotated} of ${selected.length}`));
    body.appendChild(propRow("Files", String(new Set(selected.map((page) => page.sourceId)).size)));
    body.appendChild(propRow("Positions", positions));

    const dev = document.createElement("div");
    dev.setAttribute("data-dev", "");
    dev.appendChild(section("Developer details"));
    dev.appendChild(propRow("Last command", lastCommand || "—"));
    body.appendChild(dev);
  } else {
    const summary = summarise();
    body.appendChild(section("Document"));
    body.appendChild(propRow("Pages", String(summary.pages)));
    body.appendChild(propRow("Files", String(summary.sources)));
    body.appendChild(propRow("Rotated", String(summary.rotated)));
    body.appendChild(propRow("Rotation mix", summary.mix || "—"));
    if (filterSource || query.trim()) {
      body.appendChild(propRow("Showing", `${visiblePages().length} of ${summary.pages}`));
    }

    const hint = document.createElement("p");
    hint.className = "c-help";
    if (summary.pages === 0) hint.textContent = "Add a PDF, then select pages to work on them.";
    if (hint.textContent) body.appendChild(hint);

    const dev = document.createElement("div");
    dev.setAttribute("data-dev", "");
    dev.appendChild(section("Developer details"));
    dev.appendChild(propRow("Last command", lastCommand || "—"));
    dev.appendChild(propRow("Can undo", state.canUndo ? "yes" : "no"));
    body.appendChild(dev);
  }

  wrap.appendChild(body);
  return wrap;
}

// --- actions -----------------------------------------------------------------

async function rotateSelection(degrees) {
  const ids = [...selection];
  if (ids.length === 0) return;
  await op("pdf.rotatePages", { ids, degrees }, `Rotate ${plural(ids.length, "page")}`);
}

async function duplicateSelection() {
  const ids = [...selection];
  if (ids.length === 0) return;
  const result = await op("pdf.duplicatePages", { ids }, `Duplicate ${plural(ids.length, "page")}`);
  const created = result?.ids ?? [];
  if (created.length > 0) {
    selection = new Set(created);
    render();
  }
}

async function removeSelection() {
  const ids = [...selection];
  if (ids.length === 0) return;
  await op("pdf.removePages", { ids }, `Remove ${plural(ids.length, "page")}`);
  selection.clear();
  anchor = null;
  render();
}

async function reverseDocument() {
  await op("pdf.reverse", {}, "Reverse document");
}

function selectAll() {
  selection = new Set(visiblePages().map((page) => page.id));
  anchor = null;
  render();
}

function clearSelection() {
  if (previewId) {
    closePreview();
    return;
  }
  selection.clear();
  anchor = null;
  render();
}

function setZoom(value) {
  if (zoom === value) return;
  zoom = value;
  grid.dataset.zoom = value;
  renderBoard();
  void window.NucleusShell.setSetting("thumbnailSize", value);
  sync();
}

function cycleZoom(delta) {
  const order = ["s", "m", "l"];
  const index = order.indexOf(zoom);
  const next = order[Math.max(0, Math.min(order.length - 1, index + delta))];
  if (next !== zoom) setZoom(next);
}

function zoomSeg() {  const seg = document.createElement("div");
  seg.className = "c-seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Page size");
  for (const [value, label, title] of [
    ["s", "S", "Small pages"],
    ["m", "M", "Medium pages"],
    ["l", "L", "Large pages"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", String(zoom === value));
    button.addEventListener("click", () => setZoom(value));
    seg.appendChild(button);
  }
  return seg;
}

function previewAction() {
  if (previewId) {
    if (selectedIndex() < state.pages.length - 1) previewStep(1);
    else closePreview();
    return;
  }
  if (state.pages.length === 0) return;
  openPreview([...selection][0]);
}

// --- preview -----------------------------------------------------------------

function openPreview(id) {
  previewId = id ?? state.pages[0]?.id ?? null;
  if (!previewId) return;
  previewEl.hidden = false;
  sync();
  void renderPreview();
}

function closePreview() {
  previewId = null;
  previewEl.hidden = true;
  renderBoard();
  sync();
}

async function renderPreview() {
  if (previewEl.hidden) return;
  const page = state.pages.find((entry) => entry.id === previewId);
  if (!page) {
    closePreview();
    return;
  }
  const index = state.pages.indexOf(page);
  $("#preview-label").textContent = `Page ${index + 1} of ${state.pages.length}`;
  $("#preview-foot").textContent =
    `${nameFor(page.sourceId)} · file page ${page.sourcePage + 1} · ` +
    `${page.rotation}° · ${dimensionsOf(page.sourceId, page.sourcePage)}`;

  const body = $("#preview-body");
  if (!pdfjsLib) {
    body.textContent = "pdf.js is unavailable — the preview needs the bundled renderer.";
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
    body.textContent = `Preview failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function previewStep(delta) {
  const index = selectedIndex();
  if (index === -1) return;
  const next = state.pages[index + delta];
  if (!next) return;
  previewId = next.id;
  sync();
  void renderPreview();
}

// --- board interactions ------------------------------------------------------

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
  sync();
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

// Native file drops, anywhere on the board.
workspace.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  workspace.classList.add("--dragover");
});
workspace.addEventListener("dragleave", () => workspace.classList.remove("--dragover"));
workspace.addEventListener("drop", (event) => {
  workspace.classList.remove("--dragover");
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  void loadFiles(event.dataTransfer.files);
});

// --- preview overlay ---------------------------------------------------------

$("#preview-close").addEventListener("click", closePreview);
$("#preview-prev").addEventListener("click", () => previewStep(-1));
$("#preview-next").addEventListener("click", () => previewStep(1));
$("#preview-rot").addEventListener("click", async () => {
  if (!previewId) return;
  await op("pdf.rotatePages", { ids: [previewId], degrees: 90 }, "Rotate page");
  void renderPreview();
});
previewEl.addEventListener("click", (event) => {
  if (event.target === previewEl) closePreview();
});
// Arrows are contextual to the overlay, so they stay local (no global binding).
previewEl.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    previewStep(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    previewStep(1);
  }
});

// --- files -------------------------------------------------------------------

fileInput.addEventListener("change", (event) => void loadFiles(event.target.files));
projectInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  void openProject(file);
  event.target.value = "";
});

// --- the shell ---------------------------------------------------------------

emptyEl.appendChild(
  window.NucleusShell.emptyState({
    kick: "PDF Workbench",
    title: "Your pages, assembled.",
    body: "Drop PDFs anywhere — reorder, rotate, duplicate and export. Every step is one undo away.",
    cta: "Add PDFs",
    onCta: () => fileInput.click(),
    hint: "or drop a PDF here · Ctrl K for every command · files never leave this machine",
  }),
);

window.NucleusShell.mount({
  app: { name: "PDF Workbench", accent: "#e85a6c" },
  main: workspace,
  menus: [
    {
      label: "File",
      items: [
        { id: "file.add", label: "Add PDFs…", shortcut: "Ctrl+O", run: () => fileInput.click() },
        { id: "file.open", label: "Open project…", run: () => projectInput.click() },
        { id: "file.save", label: "Save project", shortcut: "Ctrl+S", run: saveProject },
        { sep: true },
        { id: "file.export", label: "Export PDF", shortcut: "Ctrl+E", run: () => void doExport() },
        {
          id: "file.exportSelection",
          label: "Export selected pages",
          shortcut: "Ctrl+Shift+E",
          run: () => void doExport([...selection]),
        },
        { sep: true },
        {
          id: "file.startOver",
          label: "Start over…",
          danger: true,
          confirm: "Remove every page and every loaded file? This starts a new, empty document.",
          run: () => void startOver(),
        },
      ],
    },
    {
      label: "Edit",
      items: [
        { id: "edit.undo", label: "Undo", shortcut: "Ctrl+Z", command: "tape.undo", run: () => void undo() },
        {
          id: "edit.redo",
          label: "Redo",
          shortcut: ["Ctrl+Shift+Z", "Ctrl+Y"],
          command: "tape.redo",
          run: () => void redo(),
        },
        { sep: true },
        { id: "edit.selectAll", label: "Select all pages", shortcut: "Ctrl+A", run: selectAll },
        { id: "edit.clearSelection", label: "Clear selection", shortcut: "Esc", run: clearSelection },
        { sep: true },
        { id: "edit.preview", label: "Preview page", shortcut: "Space", run: previewAction },
        { id: "edit.rotateLeft", label: "Rotate left", shortcut: "Ctrl+Shift+R", run: () => void rotateSelection(-90) },
        { id: "edit.rotateRight", label: "Rotate right", shortcut: "Ctrl+R", run: () => void rotateSelection(90) },
        { id: "edit.duplicate", label: "Duplicate", shortcut: "Ctrl+D", run: () => void duplicateSelection() },
        { sep: true },
        {
          id: "edit.remove",
          label: "Remove pages…",
          shortcut: "Del",
          danger: true,
          confirm: "Remove the selected pages? You can undo it with Ctrl+Z.",
          run: () => void removeSelection(),
        },
        { id: "edit.reverse", label: "Reverse order", run: () => void reverseDocument() },
      ],
    },
    {
      label: "View",
      items: [
        {
          id: "view.sizeSmall",
          label: "Small pages",
          checked: () => zoom === "s",
          run: () => setZoom("s"),
        },
        {
          id: "view.sizeMedium",
          label: "Medium pages",
          checked: () => zoom === "m",
          run: () => setZoom("m"),
        },
        {
          id: "view.sizeLarge",
          label: "Large pages",
          checked: () => zoom === "l",
          run: () => setZoom("l"),
        },
        { sep: true },
        { id: "view.smaller", label: "Smaller pages", shortcut: "Ctrl+-", run: () => cycleZoom(-1) },
        { id: "view.larger", label: "Larger pages", shortcut: "Ctrl+=", run: () => cycleZoom(1) },
        { sep: true },
        ...window.NucleusShell.standardViewMenu(),
      ],
    },
    { label: "Help", items: window.NucleusShell.standardHelpMenu() },
  ],
  primary: { id: "file.export" },
  noun: (ids) => plural(ids.length, "page"),
  options: (ctx) => {
    if (ctx.preview) {
      return { hint: "Space shows the next page · Esc closes the preview", right: zoomSeg() };
    }
    const count = (ctx.selection || []).length;
    const sizes = state.pages.length > 0 ? zoomSeg() : null;
    if (count === 0) {
      return {
        hint: state.pages.length
          ? "Click a page to select it, shift-click for a range."
          : "Add a PDF to begin.",
        right: sizes,
      };
    }
    const ids = ["edit.rotateLeft", "edit.rotateRight", "edit.duplicate", "file.exportSelection"];
    if (count === 1) ids.unshift("edit.preview");
    return { label: plural(count, "page") + " selected", ids, right: sizes };
  },
  rail: [
    { id: "documents", icon: "pages", label: "Documents" },
    { id: "find", icon: "search", label: "Find" },
    { id: "history", icon: "history", label: "History" },
  ],
  panels: { left: documentsPanel, right: propertiesPanel },
  status: {
    left: () => {
      const node = document.createElement("span");
      node.className = "w-status";
      const dot = document.createElement("span");
      dot.className = "c-dot";
      if (status.kind === "busy") dot.classList.add("c-dot--busy");
      if (status.kind === "error") dot.classList.add("c-dot--err");
      node.append(dot, document.createTextNode(status.text));
      return node;
    },
    right: () => {
      const summary = summarise();
      const parts = [`${plural(summary.pages, "page")}`, `${selection.size} selected`];
      if (summary.sources > 0) parts.push(plural(summary.sources, "file"));
      if (filterSource) parts.push("filtered");
      return parts.join(" · ");
    },
  },
  enabled: {
    "file.export": () => state.pages.length > 0 && !busy,
    "file.exportSelection": () => selection.size > 0 && !busy,
    "file.save": () => state.pages.length > 0,
    "file.startOver": () => state.pages.length > 0 && !busy,
    "edit.undo": () => state.canUndo && !busy,
    "edit.redo": () => state.canRedo && !busy,
    "edit.selectAll": () => visiblePages().length > 0 && !busy,
    "edit.clearSelection": () => selection.size > 0 || Boolean(previewId),
    "edit.preview": () => state.pages.length > 0,
    "edit.rotateLeft": () => selection.size > 0 && !busy,
    "edit.rotateRight": () => selection.size > 0 && !busy,
    "edit.duplicate": () => selection.size > 0 && !busy,
    "edit.remove": () => selection.size > 0 && !busy,
    "edit.reverse": () => state.pages.length > 1 && !busy,
  },
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

void refresh();
