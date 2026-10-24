// Image Editor — Craft front-end on the shared shell (brief #3 §4.3).
//
// Every edit goes through /api/op, so the tape, undo and agent proposals see
// exactly what the human sees. The pixels are never rewritten: the command pack
// stores a crop, a quarter-turn rotation, two flips, a named filter, seven
// adjustments and an optional output size. This file renders that stack on a
// canvas — the same function paints the preview and the exported PNG, so what
// you see is what you get.
//
// The chrome (menubar, tool rail, options bar, panels, status bar, shortcuts,
// palette, dialogs) belongs to /_kit/shell.js. This file only says *what* the
// app can do and paints the stage.

const $ = (selector) => document.querySelector(selector);

const canvas = $("#view");
const stage = $("#stage");
const emptyEl = $("#empty");
const workEl = $("#work");
const overlay = $("#crop-overlay");
const cropBox = $("#crop-box");
const cropSizeEl = $("#crop-size");

const TOOL_IDS = ["adjust", "filter", "crop", "resize"];
const TOOL_META = {
  adjust: { label: "Adjust", chip: "Light and colour" },
  filter: { label: "Filter", chip: "Named looks" },
  crop: { label: "Crop", chip: "Keep a rectangle" },
  resize: { label: "Resize", chip: "Output size" },
};
const FILTERS = ["none", "grayscale", "sepia", "invert", "warm", "cool"];
// key, label, min, max, step — one row per slider, one command per gesture.
const ADJUSTMENTS = [
  ["brightness", "Brightness", -100, 100, 1],
  ["contrast", "Contrast", -100, 100, 1],
  ["saturation", "Saturation", -100, 100, 1],
  ["hue", "Hue", -180, 180, 1],
  ["temperature", "Temperature", -100, 100, 1],
  ["blur", "Blur", 0, 50, 0.5],
  ["vignette", "Vignette", 0, 100, 1],
];

const state = { image: null, canUndo: false, canRedo: false, status: { text: "Ready", kind: "" } };
let sourceImg = null; // HTMLImageElement of the stored source
let sourceKey = null; // which sourceId sourceImg holds
let lastTool = "adjust"; // the right panel keeps this while History is open
let zoom = "fit"; // "fit" or a numeric scale
let lastScale = 1;
let showBefore = false;
let busy = false;
let cropDraft = null; // { x, y, width, height } in source pixels
let cropAspect = "free";
let drag = null; // pointer gesture for the crop overlay
let sliderTimer = null;
let resizeLink = true;

// ── plumbing ────────────────────────────────────────────────────────────────

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function ready() {
  return Boolean(state.image) && !busy;
}

function setStatus(text, kind = "") {
  state.status = { text, kind };
  sync({ panels: false });
}

function setBusy(value) {
  busy = value;
  if (value) state.status = { text: "Working…", kind: "busy" };
  sync({ panels: false });
}

function markReady(message = "Ready") {
  state.status = { text: message, kind: "" };
  sync({ panels: false });
}

function markError(message) {
  state.status = { text: message, kind: "error" };
  sync({ panels: false });
  if (window.NucleusKit?.toast) window.NucleusKit.toast(message, "error");
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return response.json();
}

function settle(payload) {
  if (!payload.ok) {
    markError(`Error: ${payload.error?.message ?? "unknown"}`);
    return false;
  }
  state.image = payload.image ?? null;
  state.canUndo = Boolean(payload.canUndo);
  state.canRedo = Boolean(payload.canRedo);
  return true;
}

/** Run one command, fold the new snapshot in, repaint.
 *  Commands are serialised: a slider's last value must always land, even if the
 *  previous fetch is still in flight. `options.panels === false` keeps the right
 *  panel alive while a slider is being dragged (rebuilding it would drop the
 *  pointer capture mid-gesture). */
let commandChain = Promise.resolve();

function op(name, params, label, options) {
  commandChain = commandChain.then(() => runCommand(name, params, label, options)).catch(() => null);
  return commandChain;
}

async function runCommand(name, params, label, options) {
  setBusy(true);
  try {
    const payload = await post("/api/op", { name, params, label });
    const ok = settle(payload);
    if (ok) markReady(`${label ?? name} — done`);
    return ok ? (payload.result?.result ?? payload.result ?? {}) : null;
  } finally {
    setBusy(false);
    await ensureSource();
    render(options);
  }
}

async function undo() {
  if (!state.canUndo) return;
  setBusy(true);
  try {
    const payload = await post("/api/undo", {});
    if (settle(payload)) markReady("Undone");
  } finally {
    setBusy(false);
    await ensureSource();
    render();
  }
}

async function redo() {
  if (!state.canRedo) return;
  setBusy(true);
  try {
    const payload = await post("/api/redo", {});
    if (settle(payload)) markReady("Redone");
  } finally {
    setBusy(false);
    await ensureSource();
    render();
  }
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the browser could not decode this image"));
    img.src = url;
  });
}

/** Make sure the canvas has the HTMLImageElement for the current source. */
async function ensureSource() {
  const view = state.image;
  if (!view) {
    sourceImg = null;
    sourceKey = null;
    return;
  }
  if (sourceKey === view.sourceId && sourceImg) return;
  try {
    sourceImg = await loadImageElement(`/api/source/${encodeURIComponent(view.sourceId)}`);
    sourceKey = view.sourceId;
  } catch (error) {
    sourceImg = null;
    sourceKey = null;
    markError(`Could not load the source image: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── files ───────────────────────────────────────────────────────────────────

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function openFile(file) {
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) {
    markError("That image is larger than 40 MB.");
    return;
  }
  setBusy(true);
  try {
    markReady(`Reading ${file.name}…`);
    const dataBase64 = await fileToBase64(file);
    const uploaded = await post("/api/upload", { dataBase64, name: file.name });
    if (!uploaded.ok) {
      markError(`Upload failed: ${uploaded.error?.message ?? "unknown"}`);
      return;
    }
    const img = await loadImageElement(`/api/source/${encodeURIComponent(uploaded.sourceId)}`);
    setBusy(false);
    await op(
      "image.load",
      {
        sourceId: uploaded.sourceId,
        name: file.name,
        mime: uploaded.mime ?? file.type ?? "image/png",
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      },
      `Open ${file.name}`,
    );
    sourceImg = img;
    sourceKey = uploaded.sourceId;
    setTool("adjust");
    zoom = "fit";
    cropDraft = null;
    markReady(`${file.name} — ${img.naturalWidth}×${img.naturalHeight}`);
  } catch (error) {
    markError(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
    render();
  }
}

async function exportPng() {
  const view = state.image;
  if (!view) return;
  await ensureSource();
  if (!sourceImg) return markError("The source image is still loading.");

  setBusy(true);
  markReady("Exporting PNG…");
  try {
    const out = document.createElement("canvas");
    out.width = view.width;
    out.height = view.height;
    const ctx = out.getContext("2d");
    paint(ctx, view, sourceImg, view.width, view.height, 1, false);
    const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("the browser refused to encode the canvas");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(view.name || "image").replace(/\.[^.]+$/, "")}-edited.png`;
    link.click();
    URL.revokeObjectURL(url);
    markReady(`Exported ${view.width}×${view.height} PNG.`);
  } catch (error) {
    markError(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

function saveProject() {
  if (!state.image) return markError("Nothing to save yet.");
  const link = document.createElement("a");
  link.href = "/api/project";
  link.download = "image.nucleus.json";
  link.click();
  markReady("Project downloaded.");
}

async function openProject(file) {
  if (!file) return;
  setBusy(true);
  try {
    const payload = JSON.parse(await file.text());
    const restored = await post("/api/project", payload);
    if (settle(restored)) markReady(`Opened ${file.name}.`);
    sourceImg = null;
    sourceKey = null;
    await ensureSource();
    setTool("adjust");
  } catch (error) {
    markError(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
    render();
  }
}

// ── painting ────────────────────────────────────────────────────────────────

function activeTemperature(view) {
  const base = view.adjustments.temperature ?? 0;
  const transfer = view.filter === "warm" ? 30 : view.filter === "cool" ? -30 : 0;
  return Math.max(-100, Math.min(100, base + transfer));
}

function cssFilter(view, scale) {
  const a = view.adjustments;
  const parts = [];
  if (a.brightness) parts.push(`brightness(${1 + a.brightness / 100})`);
  if (a.contrast) parts.push(`contrast(${1 + a.contrast / 100})`);
  if (a.saturation) parts.push(`saturate(${Math.max(0, 1 + a.saturation / 100)})`);
  if (a.hue) parts.push(`hue-rotate(${a.hue}deg)`);
  if (a.blur) parts.push(`blur(${(a.blur * scale).toFixed(2)}px)`);
  if (view.filter === "grayscale") parts.push("grayscale(1)");
  if (view.filter === "sepia") parts.push("sepia(0.85)");
  if (view.filter === "invert") parts.push("invert(1)");
  return parts.length > 0 ? parts.join(" ") : "none";
}

/**
 * Paint the edit stack into `ctx`. `width`/`height` are the output box in CSS
 * pixels; `scale` is output-pixels per source-pixel (used for blur radii).
 */
function paint(ctx, view, img, width, height, scale, original) {
  ctx.clearRect(0, 0, width, height);
  if (original) {
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, width, height);
    return;
  }

  const crop = view.crop ?? { x: 0, y: 0, width: view.naturalWidth, height: view.naturalHeight };
  const swapped = view.rotation % 180 !== 0;
  // Content box before the quarter turn: swapped relative to the output box.
  const baseW = swapped ? height : width;
  const baseH = swapped ? width : height;

  ctx.save();
  ctx.filter = cssFilter(view, scale);
  ctx.translate(width / 2, height / 2);
  ctx.rotate((view.rotation * Math.PI) / 180);
  ctx.scale(view.flipX ? -1 : 1, view.flipY ? -1 : 1);
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, -baseW / 2, -baseH / 2, baseW, baseH);
  ctx.restore();

  // Warm/cool tint: an overlay so highlights keep their detail.
  const temperature = activeTemperature(view);
  if (temperature !== 0) {
    const strength = Math.abs(temperature) / 100;
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = strength * 0.45;
    ctx.fillStyle = temperature > 0 ? "rgb(255, 150, 40)" : "rgb(40, 130, 255)";
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // Vignette: transparent centre, dark corners.
  const vignette = view.adjustments.vignette ?? 0;
  if (vignette > 0) {
    const radius = Math.hypot(width, height) / 2;
    const gradient = ctx.createRadialGradient(
      width / 2,
      height / 2,
      radius * 0.35,
      width / 2,
      height / 2,
      radius,
    );
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(1, `rgba(0,0,0,${(vignette / 100) * 0.85})`);
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}

function stageSpace() {
  const style = getComputedStyle(stage);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return {
    width: Math.max(120, stage.clientWidth - padX - 40),
    height: Math.max(120, stage.clientHeight - padY - 40),
  };
}

function draftOf(view) {
  return view.crop
    ? { x: view.crop.x, y: view.crop.y, width: view.crop.width, height: view.crop.height }
    : { x: 0, y: 0, width: view.naturalWidth, height: view.naturalHeight };
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Repaint the stage, then let the shell re-read the options bar and panels. */
function render(options) {
  renderStage();
  sync(options);
}

function sync(options) {
  if (window.NucleusShell) window.NucleusShell.setContext({}, options);
}

function renderStage() {
  const view = state.image;
  const has = Boolean(view);
  emptyEl.hidden = has;
  workEl.hidden = !has;
  overlay.hidden = !has || lastTool !== "crop";
  if (!has) {
    canvas.width = 0;
    canvas.height = 0;
    lastScale = 1;
    return;
  }

  // Cropping shows the unturned source so the rectangle maps 1:1 to pixels.
  const cropMode = lastTool === "crop";
  if (cropMode && !cropDraft) cropDraft = draftOf(view);
  const baseWidth = cropMode ? view.naturalWidth : view.width;
  const baseHeight = cropMode ? view.naturalHeight : view.height;
  const space = stageSpace();
  const scale =
    zoom === "fit" ? Math.min(space.width / baseWidth, space.height / baseHeight, 4) : zoom;
  const displayWidth = Math.max(1, Math.round(baseWidth * scale));
  const displayHeight = Math.max(1, Math.round(baseHeight * scale));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.round(displayWidth * dpr);
  canvas.height = Math.round(displayHeight * dpr);
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!sourceImg) {
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(0, 0, displayWidth, displayHeight);
  } else if (cropMode) {
    // The crop tool previews the source with the flips/filter, which never move
    // a pixel, but without the crop or the turn — the rectangle is in source space.
    paint(
      ctx,
      {
        ...view,
        crop: null,
        rotation: 0,
        resize: null,
        width: view.naturalWidth,
        height: view.naturalHeight,
      },
      sourceImg,
      displayWidth,
      displayHeight,
      scale,
      false,
    );
  } else {
    paint(ctx, view, sourceImg, displayWidth, displayHeight, scale, showBefore);
  }

  lastScale = scale;
  if (cropMode) positionCropBox(scale);
}

function positionCropBox(scale) {
  const view = state.image;
  if (!view || !cropBox) return;
  const rect = canvas.getBoundingClientRect();
  const host = workEl.getBoundingClientRect();
  const offsetX = rect.left - host.left;
  const offsetY = rect.top - host.top;
  const draft = cropDraft ?? draftOf(view);
  cropBox.style.left = `${offsetX + draft.x * scale}px`;
  cropBox.style.top = `${offsetY + draft.y * scale}px`;
  cropBox.style.width = `${draft.width * scale}px`;
  cropBox.style.height = `${draft.height * scale}px`;
  if (cropSizeEl) cropSizeEl.textContent = `${Math.round(draft.width)} × ${Math.round(draft.height)} px`;
}

function setZoom(value) {
  zoom = Math.max(0.05, Math.min(8, value));
  render();
}

function zoomFit() {
  zoom = "fit";
  render();
}

// ── panels ──────────────────────────────────────────────────────────────────

/** The tool lives in ctx.panel (the rail). History is the one panel that is
 *  not a tool, so the right column keeps painting the last tool. */
function toolOf(ctx) {
  const panel = ctx && typeof ctx.panel === "string" ? ctx.panel : "";
  const tool = TOOL_IDS.includes(panel) ? panel : lastTool;
  if (tool !== lastTool) {
    lastTool = tool;
    if (tool === "crop" && state.image) cropDraft = draftOf(state.image);
    // The rail switches tools through the shell, so the stage catches up here.
    queueMicrotask(() => renderStage());
  }
  return tool;
}

function setTool(id) {
  lastTool = id;
  if (id === "crop" && state.image) cropDraft = draftOf(state.image);
  if (window.NucleusShell) window.NucleusShell.openPanel(id);
  render();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function panelHead(title, chip) {
  const head = el("div", "c-panelhead");
  head.appendChild(el("span", null, title));
  if (chip) head.appendChild(el("span", "c-chip", chip));
  return head;
}

function section(text) {
  return el("div", "c-section", text);
}

function hint(text) {
  return el("div", "i-hint", text);
}

function propRow(label, value) {
  const row = el("div", "c-prop");
  row.appendChild(el("span", "c-prop__label", label));
  row.appendChild(el("span", "c-prop__value", value));
  return row;
}

function inspectorPanel(ctx) {
  const tool = toolOf(ctx);
  const view = state.image;
  const meta = TOOL_META[tool] ?? TOOL_META.adjust;

  const wrap = el("div", "i-panel");
  wrap.appendChild(panelHead(meta.label, meta.chip));

  const body = el("div", "c-inspector__body i-panel__body");
  wrap.appendChild(body);

  if (!view) {
    body.appendChild(
      hint("Open an image to see its controls. Drop one on the canvas, paste with Ctrl V, or use File → Open image."),
    );
    return wrap;
  }

  if (tool === "adjust") {
    body.appendChild(adjustBody(view));
  } else if (tool === "filter") {
    body.appendChild(filterBody(view));
  } else if (tool === "crop") {
    body.appendChild(cropBody(view));
  } else {
    body.appendChild(resizeBody(view));
  }

  wirePanel(body);
  return wrap;
}

function sliderRow(key, label, min, max, step, value) {
  const row = el("div", "i-row");
  row.dataset.slider = key;
  row.appendChild(el("span", "i-row__label", label));
  const input = el("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.dataset.key = key;
  const out = el("output", null, String(value));
  out.dataset.out = key;
  row.append(input, out);
  return row;
}

function numberRow(label, dataset, key, value, min, max) {
  const row = el("div", "i-row");
  row.appendChild(el("span", "i-row__label", label));
  const input = el("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(Math.round(value));
  input.dataset[dataset] = key;
  row.appendChild(input);
  return row;
}

function adjustBody(view) {
  const frag = document.createDocumentFragment();
  const hist = el("canvas", "i-histogram");
  hist.width = 256;
  hist.height = 54;
  frag.appendChild(hist);
  const a = view.adjustments;
  for (const [key, label, min, max, step] of ADJUSTMENTS) {
    frag.appendChild(sliderRow(key, label, min, max, step, a[key] ?? 0));
  }
  frag.appendChild(hint("One gesture is one undo step. Double-click a slider to reset just that value."));
  drawHistogram(hist);
  return frag;
}

function filterBody(view) {
  const frag = document.createDocumentFragment();
  const grid = el("div", "i-swatches");
  for (const name of FILTERS) {
    const button = el("button", "i-swatch");
    button.type = "button";
    button.dataset.filter = name;
    button.setAttribute("aria-pressed", String(view.filter === name));
    button.appendChild(el("span", "i-swatch__chip"));
    button.appendChild(document.createTextNode(name));
    grid.appendChild(button);
  }
  frag.appendChild(grid);
  frag.appendChild(
    hint("Warm and cool also move the temperature slider — the two add up. Filters are independent of the adjustments, so they compose."),
  );
  return frag;
}

function cropBody(view) {
  const frag = document.createDocumentFragment();
  const draft = cropDraft ?? draftOf(view);
  frag.appendChild(numberRow("X", "crop", "x", draft.x, 0, view.naturalWidth - 1));
  frag.appendChild(numberRow("Y", "crop", "y", draft.y, 0, view.naturalHeight - 1));
  frag.appendChild(numberRow("Width", "crop", "width", draft.width, 1, view.naturalWidth));
  frag.appendChild(numberRow("Height", "crop", "height", draft.height, 1, view.naturalHeight));
  frag.appendChild(hint("Drag on the picture to draw a rectangle, drag inside to move it, grab a corner to resize. Cropping works on the unturned source, so a crop and a rotation never fight."));
  return frag;
}

function resizeBody(view) {
  const frag = document.createDocumentFragment();
  frag.appendChild(section("Output"));
  frag.appendChild(propRow("Source", `${view.naturalWidth} × ${view.naturalHeight}`));
  frag.appendChild(propRow("Exported", `${view.width} × ${view.height}`));
  frag.appendChild(propRow("Scale", `${Math.round((view.width / view.naturalWidth) * 100)}%`));
  frag.appendChild(
    hint("Width and height live in the options bar. Resizing only changes the exported pixels — the preview scales to fit."),
  );
  return frag;
}

/** One listener set per panel build: the panel is replaced, never mutated. */
function wirePanel(body) {
  body.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.dataset.key) {
      const key = target.dataset.key;
      const out = body.querySelector(`[data-out="${key}"]`);
      if (out) out.textContent = target.value;
      // The pack coalesces a burst on the same key into one undo step, so we can
      // stream while the slider moves without flooding the tape.
      clearTimeout(sliderTimer);
      sliderTimer = setTimeout(() => {
        void op("image.adjust", { [key]: Number(target.value) }, `Adjust ${key}`, { panels: false });
      }, 45);
    } else if (target.dataset.crop && state.image) {
      cropDraft = { ...(cropDraft ?? draftOf(state.image)), [target.dataset.crop]: Math.max(0, Number(target.value)) };
      renderStage();
    }
  });

  body.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.key) {
      clearTimeout(sliderTimer);
      void op("image.adjust", { [target.dataset.key]: Number(target.value) }, `Adjust ${target.dataset.key}`);
    }
  });

  body.addEventListener("dblclick", (event) => {
    const row = event.target instanceof HTMLElement ? event.target.closest("[data-slider]") : null;
    if (!row) return;
    void op("image.adjust", { [row.dataset.slider]: 0 }, `Reset ${row.dataset.slider}`);
  });

  body.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("[data-filter]") : null;
    if (!target) return;
    void op("image.setFilter", { filter: target.dataset.filter }, `Filter ${target.dataset.filter}`);
  });
}

function drawHistogram(target) {
  const view = state.image;
  if (!target || !view || !sourceImg) return;
  const sample = document.createElement("canvas");
  const ratio = Math.min(1, 160 / Math.max(view.width, view.height));
  sample.width = Math.max(1, Math.round(view.width * ratio));
  sample.height = Math.max(1, Math.round(view.height * ratio));
  const sctx = sample.getContext("2d");
  paint(sctx, view, sourceImg, sample.width, sample.height, ratio, false);
  let data;
  try {
    data = sctx.getImageData(0, 0, sample.width, sample.height).data;
  } catch {
    return;
  }
  const bins = 64;
  const hist = [new Float32Array(bins), new Float32Array(bins), new Float32Array(bins)];
  let max = 1;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    hist[0][Math.min(bins - 1, (r / 256) * bins) | 0] += 1;
    hist[1][Math.min(bins - 1, (g / 256) * bins) | 0] += 1;
    hist[2][Math.min(bins - 1, (b / 256) * bins) | 0] += 1;
  }
  for (const channel of hist) for (const value of channel) max = Math.max(max, value);

  const ctx = target.getContext("2d");
  const { width, height } = target;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(124, 92, 255, 0.06)";
  ctx.fillRect(0, 0, width, height);
  const colors = ["rgba(255, 105, 120, 0.75)", "rgba(120, 230, 160, 0.75)", "rgba(110, 170, 255, 0.75)"];
  hist.forEach((channel, index) => {
    ctx.beginPath();
    ctx.strokeStyle = colors[index];
    ctx.lineWidth = 1;
    for (let x = 0; x < bins; x += 1) {
      const value = channel[x] / max;
      const px = (x / (bins - 1)) * width;
      const py = height - value * (height - 4) - 1;
      if (x === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  });
}

// ── options bar controls (stable nodes: the bar re-renders often) ───────────

const aspectBar = el("div", "c-seg");
aspectBar.setAttribute("role", "group");
aspectBar.setAttribute("aria-label", "Aspect ratio");
for (const aspect of ["free", "1:1", "4:3", "3:2", "16:9", "9:16"]) {
  const button = el("button", null, aspect);
  button.type = "button";
  button.dataset.aspect = aspect;
  button.setAttribute("aria-pressed", String(cropAspect === aspect));
  button.addEventListener("click", () => {
    cropAspect = aspect;
    for (const other of aspectBar.children) {
      other.setAttribute("aria-pressed", String(other.dataset.aspect === aspect));
    }
  });
  aspectBar.appendChild(button);
}

const sizeBar = el("div", "i-sizebar");
const sizeWidth = el("input", "i-sizebar__num");
sizeWidth.type = "number";
sizeWidth.min = "1";
sizeWidth.setAttribute("aria-label", "Output width");
const sizeHeight = el("input", "i-sizebar__num");
sizeHeight.type = "number";
sizeHeight.min = "1";
sizeHeight.setAttribute("aria-label", "Output height");
const sizeLink = el("button", "c-btn", "Link");
sizeLink.type = "button";
sizeLink.dataset.link = "1";
sizeLink.title = "Keep the aspect ratio";
sizeLink.addEventListener("click", () => {
  resizeLink = !resizeLink;
  syncSizeBar();
});
const sizePreview = el("span", "i-sizebar__preview");
sizeBar.append(sizeWidth, el("span", "i-sizebar__x", "×"), sizeHeight, sizeLink, sizePreview);

sizeWidth.addEventListener("input", () => {
  const view = state.image;
  if (resizeLink && view && view.width > 0 && view.height > 0) {
    const ratio = view.width / view.height;
    const width = Number(sizeWidth.value);
    if (width >= 1) sizeHeight.value = String(Math.max(1, Math.round(width / ratio)));
  }
  updateSizePreview();
});
sizeHeight.addEventListener("input", () => {
  const view = state.image;
  if (resizeLink && view && view.width > 0 && view.height > 0) {
    const ratio = view.width / view.height;
    const height = Number(sizeHeight.value);
    if (height >= 1) sizeWidth.value = String(Math.max(1, Math.round(height * ratio)));
  }
  updateSizePreview();
});

function sizeValues() {
  return { width: Number(sizeWidth.value) || 0, height: Number(sizeHeight.value) || 0 };
}

function updateSizePreview() {
  const { width, height } = sizeValues();
  sizePreview.textContent = width >= 1 || height >= 1 ? `→ ${width || "auto"} × ${height || "auto"} px` : "Type a side";
}

function syncSizeBar() {
  const view = state.image;
  const active = document.activeElement;
  if (view) {
    if (active !== sizeWidth) sizeWidth.value = String(view.width);
    if (active !== sizeHeight) sizeHeight.value = String(view.height);
  } else {
    sizeWidth.value = "";
    sizeHeight.value = "";
  }
  sizeLink.setAttribute("aria-pressed", String(resizeLink));
  sizeLink.textContent = resizeLink ? "Linked" : "Free";
  updateSizePreview();
}

function cropHint() {
  const view = state.image;
  if (!view) return "";
  const draft = cropDraft ?? draftOf(view);
  const whole =
    draft.x === 0 && draft.y === 0 && draft.width >= view.naturalWidth && draft.height >= view.naturalHeight;
  return whole
    ? "Drag on the picture to keep a rectangle."
    : `${Math.round(draft.width)} × ${Math.round(draft.height)} px — Apply crop keeps it.`;
}

function optionsBar(ctx) {
  const view = state.image;
  const tool = toolOf(ctx);
  if (!view) return { hint: "File → Open image… · or drop an image anywhere", ids: [] };
  if (tool === "crop") {
    return { left: aspectBar, hint: cropHint(), ids: ["image.applyCrop", "image.cancelCrop", "image.clearCrop"] };
  }
  if (tool === "resize") {
    syncSizeBar();
    return { left: sizeBar, hint: "Clear a side to keep the ratio.", ids: ["image.applyResize"] };
  }
  if (tool === "adjust") {
    return { hint: "Double-click a slider to reset it.", ids: ["image.neutral"] };
  }
  return { hint: "Warm and cool also move Temperature — the two add up.", ids: [] };
}

// ── actions ─────────────────────────────────────────────────────────────────

function applyCrop() {
  const draft = cropDraft;
  if (!draft) return markError("Draw a crop rectangle first.");
  const view = state.image;
  const x = Math.max(0, Math.round(draft.x));
  const y = Math.max(0, Math.round(draft.y));
  const width = Math.max(1, Math.round(draft.width));
  const height = Math.max(1, Math.round(draft.height));
  const whole = view && x === 0 && y === 0 && width >= view.naturalWidth && height >= view.naturalHeight;
  cropDraft = null;
  return op(
    whole ? "image.clearCrop" : "image.crop",
    whole ? {} : { x, y, width, height },
    whole ? "No crop" : `Crop ${width}×${height}`,
  );
}

function cancelCrop() {
  cropDraft = state.image?.crop ? draftOf(state.image) : null;
  setTool("adjust");
}

function applyResize() {
  const { width, height } = sizeValues();
  if (width < 1 && height < 1) return markError("Type a width or a height.");
  const params = {};
  if (width >= 1) params.width = width;
  if (height >= 1) params.height = height;
  return op("image.resize", params, `Resize ${params.width ?? "auto"}×${params.height ?? "auto"}`);
}

function showDetails() {
  const view = state.image;
  if (!view) return;
  const body = el("div", "i-details");
  body.appendChild(section("Image"));
  body.appendChild(propRow("File", view.name));
  body.appendChild(propRow("Type", view.mime));
  body.appendChild(propRow("Source size", `${view.naturalWidth} × ${view.naturalHeight}`));
  body.appendChild(propRow("Output", `${view.width} × ${view.height}`));
  body.appendChild(propRow("Rotation", `${view.rotation}°`));
  body.appendChild(propRow("Flips", [view.flipX ? "horizontal" : "", view.flipY ? "vertical" : ""].filter(Boolean).join(", ") || "none"));
  body.appendChild(propRow("Filter", view.filter));

  body.appendChild(section("Applied edits"));
  if (view.edits.length === 0) {
    body.appendChild(hint("Nothing yet — the source is untouched."));
  } else {
    const list = el("div", "i-edits");
    for (const edit of view.edits) list.appendChild(el("span", "i-edit", edit));
    body.appendChild(list);
  }

  const dev = el("div");
  dev.setAttribute("data-dev", "");
  dev.appendChild(section("Developer details"));
  dev.appendChild(propRow("Document id", view.id));
  body.appendChild(dev);

  if (window.NucleusShell?.dialog) {
    void window.NucleusShell.dialog({
      title: "Image details",
      content: body,
      actions: [{ label: "Close", value: true, primary: true }],
    });
  }
}

// ── crop overlay gestures ───────────────────────────────────────────────────

function pointToSource(event) {
  const view = state.image;
  const rect = canvas.getBoundingClientRect();
  const baseWidth = lastTool === "crop" ? view.naturalWidth : view.width;
  const scale = rect.width / baseWidth;
  const x = (event.clientX - rect.left) / scale;
  const y = (event.clientY - rect.top) / scale;
  return {
    x: Math.max(0, Math.min(view.naturalWidth, x)),
    y: Math.max(0, Math.min(view.naturalHeight, y)),
    scale,
  };
}

function ratioOf(aspect) {
  if (aspect === "free") return null;
  const [w, h] = aspect.split(":").map(Number);
  return w / h;
}

overlay.addEventListener("pointerdown", (event) => {
  if (!state.image) return;
  const view = state.image;
  const point = pointToSource(event);
  const draft = cropDraft ?? { x: 0, y: 0, width: 0, height: 0 };
  const handle = event.target instanceof HTMLElement ? event.target.dataset.handle : null;

  if (handle) {
    drag = { mode: "resize", handle, origin: draft };
    overlay.setPointerCapture(event.pointerId);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / view.width;
  const inX = draft.x * scale + rect.left;
  const inY = draft.y * scale + rect.top;
  const inW = draft.width * scale;
  const inH = draft.height * scale;
  const inside =
    event.clientX >= inX && event.clientX <= inX + inW && event.clientY >= inY && event.clientY <= inY + inH;

  if (inside) {
    drag = { mode: "move", start: point, origin: draft };
  } else {
    cropDraft = { x: point.x, y: point.y, width: 1, height: 1 };
    drag = { mode: "new", start: point, origin: cropDraft };
    renderStage();
  }
  overlay.setPointerCapture(event.pointerId);
});

overlay.addEventListener("pointermove", (event) => {
  if (!drag || !state.image) return;
  const view = state.image;
  const point = pointToSource(event);
  const ratio = ratioOf(cropAspect);

  if (drag.mode === "new") {
    const x = Math.min(drag.start.x, point.x);
    const y = Math.min(drag.start.y, point.y);
    let width = Math.abs(point.x - drag.start.x);
    let height = Math.abs(point.y - drag.start.y);
    if (ratio) {
      if (width / height > ratio) width = height * ratio;
      else height = width / ratio;
    }
    cropDraft = {
      x: Math.max(0, Math.min(view.naturalWidth - width, x)),
      y: Math.max(0, Math.min(view.naturalHeight - height, y)),
      width: Math.max(1, Math.min(width, view.naturalWidth)),
      height: Math.max(1, Math.min(height, view.naturalHeight)),
    };
  } else if (drag.mode === "move") {
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    cropDraft = {
      x: Math.max(0, Math.min(view.naturalWidth - drag.origin.width, drag.origin.x + dx)),
      y: Math.max(0, Math.min(view.naturalHeight - drag.origin.height, drag.origin.y + dy)),
      width: drag.origin.width,
      height: drag.origin.height,
    };
  } else {
    const origin = drag.origin;
    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;
    if (drag.handle.includes("w")) left = Math.min(point.x, right - 2);
    if (drag.handle.includes("e")) right = Math.max(point.x, left + 2);
    if (drag.handle.includes("n")) top = Math.min(point.y, bottom - 2);
    if (drag.handle.includes("s")) bottom = Math.max(point.y, top + 2);
    cropDraft = {
      x: Math.max(0, left),
      y: Math.max(0, top),
      width: Math.min(view.naturalWidth - Math.max(0, left), right - Math.max(0, left)),
      height: Math.min(view.naturalHeight - Math.max(0, top), bottom - Math.max(0, top)),
    };
  }
  renderStage();
});

function endDrag() {
  drag = null;
  if (cropDraft) {
    cropDraft = {
      x: Math.max(0, Math.round(cropDraft.x)),
      y: Math.max(0, Math.round(cropDraft.y)),
      width: Math.max(1, Math.round(cropDraft.width)),
      height: Math.max(1, Math.round(cropDraft.height)),
    };
  }
  render();
}
overlay.addEventListener("pointerup", endDrag);
overlay.addEventListener("pointercancel", endDrag);

// ── files: drag & drop, paste ───────────────────────────────────────────────

stage.addEventListener("dragover", (event) => {
  event.preventDefault();
  stage.classList.add("--dragover");
});
stage.addEventListener("dragleave", () => stage.classList.remove("--dragover"));
stage.addEventListener("drop", (event) => {
  event.preventDefault();
  stage.classList.remove("--dragover");
  const file = [...(event.dataTransfer?.files ?? [])].find((entry) => entry.type.startsWith("image/"));
  if (file) void openFile(file);
});

document.addEventListener("paste", (event) => {
  const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (file) {
    event.preventDefault();
    void openFile(file);
  }
});

// Full-window drag & drop
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  if (event.target === stage || stage.contains(event.target)) return;
  event.preventDefault();
  const file = [...(event.dataTransfer?.files ?? [])].find((entry) => entry.type.startsWith("image/"));
  if (file) void openFile(file);
});

$("#file-input").addEventListener("change", (event) => {
  const input = event.target;
  void openFile(input.files?.[0]);
  input.value = "";
});
$("#project-input").addEventListener("change", (event) => {
  const input = event.target;
  void openProject(input.files?.[0]);
  input.value = "";
});

window.addEventListener("resize", () => {
  if (state.image) renderStage();
});

// ── shell ───────────────────────────────────────────────────────────────────

emptyEl.appendChild(
  window.NucleusShell.emptyState({
    title: "Open a picture, change it, keep the original.",
    body: "Rotate, crop, resize, grade and filter. Nothing is baked in: the original stays untouched and every step can be undone.",
    cta: "Open image",
    onCta: () => $("#file-input").click(),
    hint: "Drop or paste an image anywhere · Ctrl K lists every command · nothing leaves this machine",
  }),
);

function statusLeft() {
  const node = el("span", "i-status");
  const dot = el("span", "c-dot");
  if (state.status.kind === "busy") dot.classList.add("c-dot--busy");
  if (state.status.kind === "error") dot.classList.add("c-dot--err");
  node.append(dot, document.createTextNode(state.status.text));
  return node;
}

function zoomCluster() {
  const wrap = el("span", "i-zoom");
  const out = el("button", "i-zoom__btn", "−");
  out.type = "button";
  out.setAttribute("aria-label", "Zoom out");
  out.title = "Zoom out (Ctrl -)";
  out.addEventListener("click", () => setZoom(lastScale / 1.25));

  const pct = el("span", "i-zoom__pct", `${Math.round(lastScale * 100)}%`);
  pct.title = "Current zoom";

  const inBtn = el("button", "i-zoom__btn", "+");
  inBtn.type = "button";
  inBtn.setAttribute("aria-label", "Zoom in");
  inBtn.title = "Zoom in (Ctrl =)";
  inBtn.addEventListener("click", () => setZoom(lastScale * 1.25));

  const fit = el("button", "i-zoom__btn", "Fit");
  fit.type = "button";
  fit.setAttribute("aria-pressed", String(zoom === "fit"));
  fit.title = "Fit the window (Ctrl 0)";
  fit.addEventListener("click", zoomFit);

  wrap.append(out, pct, inBtn, fit);
  return wrap;
}

function statusRight() {
  const view = state.image;
  if (!view) return "No image";
  const wrap = el("span", "i-statusbar");
  wrap.appendChild(el("span", "c-mono", `${view.width}×${view.height} · ${plural(view.edits.length, "edit")}`));
  wrap.appendChild(zoomCluster());
  return wrap;
}

window.NucleusShell.mount({
  app: { name: "Image Editor", accent: "#f472b6" },
  main: stage,
  menus: [
    {
      label: "File",
      items: [
        { id: "file.open", label: "Open image…", shortcut: "Ctrl+O", run: () => $("#file-input").click() },
        { id: "file.openProject", label: "Open project…", run: () => $("#project-input").click() },
        { id: "file.saveProject", label: "Save project…", shortcut: "Ctrl+S", run: saveProject },
        { sep: true },
        { id: "file.exportPng", label: "Export PNG", shortcut: "Ctrl+E", run: () => void exportPng() },
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
        {
          id: "edit.resetAll",
          label: "Reset all edits",
          run: () => void op("image.reset", {}, "Reset edits"),
        },
        { sep: true },
        { id: "edit.details", label: "Image details…", shortcut: "Ctrl+I", run: showDetails },
      ],
    },
    {
      label: "Image",
      items: [
        {
          id: "image.rotateLeft",
          label: "Rotate left",
          shortcut: "Shift+R",
          run: () => void op("image.rotate", { degrees: -90 }, "Rotate left"),
        },
        {
          id: "image.rotateRight",
          label: "Rotate right",
          shortcut: "R",
          run: () => void op("image.rotate", { degrees: 90 }, "Rotate right"),
        },
        { sep: true },
        {
          id: "image.flipH",
          label: "Flip horizontal",
          shortcut: "H",
          run: () => void op("image.flip", { axis: "x" }, "Flip horizontal"),
        },
        {
          id: "image.flipV",
          label: "Flip vertical",
          shortcut: "V",
          run: () => void op("image.flip", { axis: "y" }, "Flip vertical"),
        },
        { sep: true },
        { id: "image.cropTool", label: "Crop…", shortcut: "C", run: () => setTool("crop") },
        { id: "image.resizeTool", label: "Resize…", shortcut: "S", run: () => setTool("resize") },
        { sep: true },
        { id: "image.applyCrop", label: "Apply crop", run: () => void applyCrop() },
        { id: "image.cancelCrop", label: "Cancel crop", shortcut: "Esc", run: cancelCrop },
        {
          id: "image.clearCrop",
          label: "Whole image",
          run: () => {
            cropDraft = null;
            return op("image.clearCrop", {}, "No crop");
          },
        },
        { id: "image.applyResize", label: "Apply size", run: () => void applyResize() },
        { sep: true },
        {
          id: "image.sizeHalf",
          label: "Half size",
          run: () => op("image.resize", { width: Math.max(1, Math.round(state.image.width / 2)) }, "Resize 50%"),
        },
        {
          id: "image.sizeDouble",
          label: "Double size",
          run: () => op("image.resize", { width: Math.round(state.image.width * 2) }, "Resize 2×"),
        },
        { id: "image.sizeNatural", label: "Natural size", run: () => op("image.clearResize", {}, "Reset size") },
        { sep: true },
        {
          id: "image.neutral",
          label: "Neutral adjustments",
          run: () =>
            op(
              "image.adjust",
              Object.fromEntries(ADJUSTMENTS.map(([key]) => [key, 0])),
              "Neutral adjustments",
            ),
        },
      ],
    },
    {
      label: "View",
      items: [
        { id: "view.zoomIn", label: "Zoom in", shortcut: ["Ctrl+=", "Ctrl++"], run: () => setZoom(lastScale * 1.25) },
        { id: "view.zoomOut", label: "Zoom out", shortcut: "Ctrl+-", run: () => setZoom(lastScale / 1.25) },
        { id: "view.fit", label: "Fit", shortcut: "Ctrl+0", run: zoomFit },
        { sep: true },
        {
          id: "view.compare",
          label: "Compare with original",
          shortcut: "\\",
          checked: () => showBefore,
          run: () => {
            showBefore = !showBefore;
            render();
          },
        },
        { sep: true },
        ...window.NucleusShell.standardViewMenu(),
      ],
    },
    { label: "Help", items: window.NucleusShell.standardHelpMenu() },
  ],
  primary: { id: "file.exportPng" },
  noun: (ids) => plural(ids.length, "edit"),
  options: optionsBar,
  rail: [
    { id: "adjust", icon: "adjust", label: "Adjust" },
    { id: "filter", icon: "filter", label: "Filter" },
    { id: "crop", icon: "crop", label: "Crop" },
    { id: "resize", icon: "resize", label: "Resize" },
    { id: "history", icon: "history", label: "History" },
  ],
  // The rail picks the tool; the controls live in the right column, so the left
  // panel is only ever History (the shell paints it).
  panels: { left: () => null, right: inspectorPanel },
  status: { left: statusLeft, right: statusRight },
  enabled: {
    "file.open": () => !busy,
    "file.openProject": () => !busy,
    "file.saveProject": () => Boolean(state.image),
    "file.exportPng": () => ready(),
    "edit.undo": () => Boolean(state.canUndo) && !busy,
    "edit.redo": () => Boolean(state.canRedo) && !busy,
    "edit.resetAll": () => ready() && state.image.edits.length > 0,
    "edit.details": () => Boolean(state.image),
    "image.rotateLeft": ready,
    "image.rotateRight": ready,
    "image.flipH": ready,
    "image.flipV": ready,
    "image.cropTool": () => Boolean(state.image),
    "image.resizeTool": () => Boolean(state.image),
    "image.applyCrop": () => ready() && lastTool === "crop",
    "image.cancelCrop": () => Boolean(state.image) && lastTool === "crop",
    "image.clearCrop": () => ready() && Boolean(state.image.crop),
    "image.applyResize": () => ready() && lastTool === "resize",
    "image.sizeHalf": ready,
    "image.sizeDouble": ready,
    "image.sizeNatural": () => ready() && Boolean(state.image.resize),
    "image.neutral": () => ready() && Object.values(state.image.adjustments).some((value) => value !== 0),
    "view.zoomIn": () => Boolean(state.image),
    "view.zoomOut": () => Boolean(state.image),
    "view.fit": () => Boolean(state.image),
    "view.compare": () => Boolean(state.image),
  },
});

// ── boot ────────────────────────────────────────────────────────────────────

async function refresh() {
  const payload = await (await fetch("/api/state")).json();
  settle(payload);
  await ensureSource();
  render();
  markReady();
}

if (typeof EventSource !== "undefined") {
  let timer = null;
  const events = new EventSource("/api/events");
  events.addEventListener("state", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 250);
  });
}

void refresh();
