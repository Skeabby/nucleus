// Image Editor — Craft front-end. Every edit goes through /api/op, so the tape,
// undo and agent proposals see exactly what the human sees.
//
// The pixels are never rewritten: the command pack stores a crop, a quarter-turn
// rotation, two flips, a named filter, seven adjustments and an optional output
// size. This file renders that stack on a canvas — the same function paints the
// preview and the exported PNG, so what you see is what you get.

const $ = (selector) => document.querySelector(selector);
const canvas = $("#view");
const stage = $("#stage");
const emptyEl = $("#empty");
const workEl = $("#work");
const statusEl = $("#status");
const dotEl = $("#dot");
const counterEl = $("#counter");
const inspectorEl = $("#inspector");
const toolsEl = $("#tools");

const state = { image: null, canUndo: false, canRedo: false };
const TOOLS = [
  { id: "adjust", glyph: "◐", label: "Adjust", hint: "Light and colour" },
  { id: "filter", glyph: "▦", label: "Filter", hint: "Named looks" },
  { id: "crop", glyph: "⌗", label: "Crop", hint: "Keep a rectangle" },
  { id: "resize", glyph: "⤢", label: "Resize", hint: "Output size" },
  { id: "info", glyph: "i", label: "Info", hint: "Source and edits" },
];

let sourceImg = null; // HTMLImageElement of the stored source
let sourceKey = null; // which sourceId sourceImg holds
let activeTool = "adjust";
let zoom = "fit"; // "fit" or a numeric scale
let lastFit = 1;
let showBefore = false;
let busy = false;
let cropDraft = null; // { x, y, width, height } in source pixels
let cropAspect = "free";
let drag = null; // pointer gesture for the crop overlay
let sliderTimer = null;

// ── plumbing ────────────────────────────────────────────────────────────────

function setBusy(value) {
  busy = value;
  dotEl.classList.toggle("c-dot--busy", value);
  if (value) statusEl.textContent = "Working…";
}

function markReady(message = "Ready") {
  dotEl.classList.remove("c-dot--err", "c-dot--busy");
  statusEl.textContent = message;
}

function markError(message) {
  dotEl.classList.add("c-dot--err");
  statusEl.textContent = message;
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
  dotEl.classList.remove("c-dot--err");
  state.image = payload.image ?? null;
  state.canUndo = Boolean(payload.canUndo);
  state.canRedo = Boolean(payload.canRedo);
  return true;
}

/** Run one command, fold the new snapshot in, repaint.
 *  Commands are serialised: a slider's last value must always land, even if the
 *  previous fetch is still in flight. */
let commandChain = Promise.resolve();

function op(name, params, label) {
  commandChain = commandChain.then(() => runCommand(name, params, label)).catch(() => null);
  return commandChain;
}

async function runCommand(name, params, label) {
  setBusy(true);
  try {
    const payload = await post("/api/op", { name, params, label });
    const ok = settle(payload);
    if (ok) {
      const chip = $("#bus-chip");
      if (chip) chip.textContent = label ?? name;
      markReady(`${label ?? name} — done`);
    }
    return ok ? (payload.result?.result ?? payload.result ?? {}) : null;
  } finally {
    setBusy(false);
    await ensureSource();
    render();
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
    activeTool = "adjust";
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

function currentScale(view) {
  const space = stageSpace();
  if (zoom === "fit") return Math.min(space.width / view.width, space.height / view.height, 4);
  return zoom;
}

function render() {
  renderToolbar();
  renderTools();
  renderInspector();
  renderStage();
  renderStatus();
}

function renderToolbar() {
  const has = Boolean(state.image);
  $("#undo").disabled = !state.canUndo || busy;
  $("#redo").disabled = !state.canRedo || busy;
  for (const id of ["#rot-left", "#rot-right", "#flip-h", "#flip-v", "#reset", "#export", "#rail-reset"]) {
    $(id).disabled = !has || busy;
  }
}

function renderTools() {
  const view = state.image;
  const counts = {
    adjust: Object.values(view?.adjustments ?? {}).filter((value) => value !== 0).length,
    filter: view && view.filter !== "none" ? 1 : 0,
    crop: view?.crop ? 1 : 0,
    resize: view?.resize ? 1 : 0,
    info: view?.edits.length ?? 0,
  };
  toolsEl.innerHTML = TOOLS.map((tool) => {
    const badge = counts[tool.id] ?? 0;
    return (
      `<button class="i-tool" data-tool="${tool.id}" aria-current="${activeTool === tool.id}" ${view ? "" : "disabled"}>` +
      `<span class="i-tool__glyph">${tool.glyph}</span>` +
      `<span class="i-tool__label">${tool.label}</span>` +
      (badge > 0 ? `<span class="i-tool__badge">${badge}</span>` : "") +
      `</button>`
    );
  }).join("");
  $("#edits-count").textContent = String(view?.edits.length ?? 0);
  $("#rail-meta").textContent = view
    ? `${view.naturalWidth}×${view.naturalHeight} source\n${view.width}×${view.height} output\n${view.mime}`
    : "No image";
  $("#rail-meta").style.whiteSpace = "pre-line";
}

function renderStage() {
  const view = state.image;
  const has = Boolean(view);
  emptyEl.style.display = has ? "none" : "";
  workEl.hidden = !has;
  $("#cropbar").hidden = !has || activeTool !== "crop";
  $("#crop-overlay").hidden = !has || activeTool !== "crop";
  if (!has) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }

  // Cropping shows the unturned source so the rectangle maps 1:1 to pixels.
  const cropMode = activeTool === "crop";
  if (cropMode && !cropDraft) {
    cropDraft = view.crop ?? { x: 0, y: 0, width: view.naturalWidth, height: view.naturalHeight };
  }
  const baseWidth = cropMode ? view.naturalWidth : view.width;
  const baseHeight = cropMode ? view.naturalHeight : view.height;
  const space = stageSpace();
  const scale =
    zoom === "fit"
      ? Math.min(space.width / baseWidth, space.height / baseHeight, 4)
      : zoom;
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
      { ...view, crop: null, rotation: 0, resize: null, width: cropMode ? view.naturalWidth : view.width, height: cropMode ? view.naturalHeight : view.height },
      sourceImg,
      displayWidth,
      displayHeight,
      scale,
      false,
    );
  } else {
    paint(ctx, view, sourceImg, displayWidth, displayHeight, scale, showBefore);
  }

  if (cropMode) positionCropBox(scale);
  lastFit = scale;
  $("#zoom-chip").textContent = `${Math.round(scale * 100)}%`;
}

function positionCropBox(scale) {
  const view = state.image;
  if (!view) return;
  const rect = canvas.getBoundingClientRect();
  const host = $("#work").getBoundingClientRect();
  const offsetX = rect.left - host.left;
  const offsetY = rect.top - host.top;
  const draft = cropDraft ?? { x: 0, y: 0, width: view.naturalWidth, height: view.naturalHeight };
  const box = $("#crop-box");
  box.style.left = `${offsetX + draft.x * scale}px`;
  box.style.top = `${offsetY + draft.y * scale}px`;
  box.style.width = `${draft.width * scale}px`;
  box.style.height = `${draft.height * scale}px`;
  $("#crop-size").textContent = `${Math.round(draft.width)} × ${Math.round(draft.height)} px`;
}

function renderStatus() {
  const view = state.image;
  if (!view) {
    counterEl.textContent = "no image";
    return;
  }
  const edits = view.edits.length;
  counterEl.textContent =
    `${view.width}×${view.height} · ${edits} edit${edits === 1 ? "" : "s"} · ` +
    `${zoom === "fit" ? "fit" : `${Math.round(currentScale(view) * 100)}%`}`;
}

// ── inspector ───────────────────────────────────────────────────────────────

function sliderRow(key, label, min, max, step, value) {
  return (
    `<div class="i-row" data-slider="${key}">` +
    `<span class="i-row__label">${label}</span>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-key="${key}" />` +
    `<output data-out="${key}">${value}</output>` +
    `</div>`
  );
}

function renderInspector() {
  const view = state.image;
  const title = $("#inspector-title");
  const chip = $("#inspector-chip");
  const tool = TOOLS.find((entry) => entry.id === activeTool) ?? TOOLS[0];

  if (!view) {
    title.textContent = "Inspector";
    chip.textContent = "—";
    inspectorEl.innerHTML =
      '<div class="i-hint" style="padding-top:14px">Open an image to start. Drop a file on the canvas, paste one with Ctrl+V, or press "+ Open image".</div>';
    return;
  }

  title.textContent = tool.label;
  chip.textContent = tool.hint;

  if (activeTool === "adjust") {
    const a = view.adjustments;
    inspectorEl.innerHTML =
      `<canvas class="i-histogram" id="histogram" width="256" height="54"></canvas>` +
      sliderRow("brightness", "Brightness", -100, 100, 1, a.brightness) +
      sliderRow("contrast", "Contrast", -100, 100, 1, a.contrast) +
      sliderRow("saturation", "Saturation", -100, 100, 1, a.saturation) +
      sliderRow("hue", "Hue", -180, 180, 1, a.hue) +
      sliderRow("temperature", "Temperature", -100, 100, 1, a.temperature) +
      sliderRow("blur", "Blur", 0, 50, 0.5, a.blur) +
      sliderRow("vignette", "Vignette", 0, 100, 1, a.vignette) +
      '<div class="i-actions"><button class="c-btn" data-act="reset-adjust">Neutral</button></div>' +
      '<div class="i-hint">A slider drag collapses into one undo step. Double-click a slider to reset just that value.</div>';
    drawHistogram();
  } else if (activeTool === "filter") {
    inspectorEl.innerHTML =
      '<div class="i-swatches">' +
      ["none", "grayscale", "sepia", "invert", "warm", "cool"]
        .map(
          (filter) =>
            `<button class="i-swatch" data-filter="${filter}" aria-pressed="${view.filter === filter}">` +
            `<span class="i-swatch__chip"></span>${filter}</button>`,
        )
        .join("") +
      "</div>" +
      `<div class="i-hint">Warm and cool also move the temperature slider — the two add up. Filters are independent of adjustments, so they compose.</div>`;
  } else if (activeTool === "crop") {
    const draft = cropDraft ?? view.crop ?? { x: 0, y: 0, width: view.naturalWidth, height: view.naturalHeight };
    inspectorEl.innerHTML =
      `<div class="i-row"><span class="i-row__label">X</span><input type="number" data-crop="x" value="${Math.round(draft.x)}" min="0" max="${view.naturalWidth - 1}" /></div>` +
      `<div class="i-row"><span class="i-row__label">Y</span><input type="number" data-crop="y" value="${Math.round(draft.y)}" min="0" max="${view.naturalHeight - 1}" /></div>` +
      `<div class="i-row"><span class="i-row__label">Width</span><input type="number" data-crop="width" value="${Math.round(draft.width)}" min="1" max="${view.naturalWidth}" /></div>` +
      `<div class="i-row"><span class="i-row__label">Height</span><input type="number" data-crop="height" value="${Math.round(draft.height)}" min="1" max="${view.naturalHeight}" /></div>` +
      '<div class="c-section">Aspect</div>' +
      '<div class="i-swatches" style="grid-template-columns: repeat(3, 1fr)">' +
      ["free", "1:1", "4:3", "3:2", "16:9", "9:16"]
        .map(
          (aspect) =>
            `<button class="i-swatch" data-crop-aspect="${aspect}" aria-pressed="${cropAspect === aspect}">` +
            `<span class="i-swatch__chip" style="height:14px"></span>${aspect}</button>`,
        )
        .join("") +
      "</div>" +
      '<div class="i-actions"><button class="c-btn" data-act="crop-reset">Whole image</button><button class="c-btn c-btn--accent" data-act="crop-apply">Apply crop</button></div>' +
      '<div class="i-hint">Drag on the picture to draw a rectangle, drag inside to move it, grab a corner to resize. Cropping works on the unturned source, so a crop and a rotation never fight.</div>';
  } else if (activeTool === "resize") {
    inspectorEl.innerHTML =
      `<div class="i-row"><span class="i-row__label">Width</span><input type="number" data-size="width" value="${view.width}" min="1" /></div>` +
      `<div class="i-row"><span class="i-row__label">Height</span><input type="number" data-size="height" value="${view.height}" min="1" /></div>` +
      '<div class="i-actions"><button class="c-btn" data-act="size-half">50%</button><button class="c-btn" data-act="size-double">2×</button><button class="c-btn" data-act="size-reset">Natural</button></div>' +
      '<div class="i-actions"><button class="c-btn c-btn--accent" data-act="size-apply">Apply size</button></div>' +
      `<div class="i-hint">The current output is ${view.width}×${view.height}. Leaving one side empty keeps the aspect ratio. Resizing only changes the exported pixels — the preview scales to fit.</div>`;
  } else {
    inspectorEl.innerHTML =
      '<div class="c-section">Source</div>' +
      propRow("File", escapeHtml(view.name)) +
      propRow("Type", escapeHtml(view.mime)) +
      propRow("Source size", `${view.naturalWidth} × ${view.naturalHeight}`) +
      propRow("Output", `${view.width} × ${view.height}`) +
      propRow("Rotation", `${view.rotation}°`) +
      propRow("Flips", `${view.flipX ? "H " : ""}${view.flipY ? "V" : ""}`.trim() || "none") +
      propRow("Filter", escapeHtml(view.filter)) +
      propRow("Node", `<code>${escapeHtml(view.id)}</code>`) +
      '<div class="c-section">Applied edits</div>' +
      (view.edits.length === 0
        ? '<div class="i-hint">Nothing yet — the source is untouched.</div>'
        : `<div class="i-edits">${view.edits.map((edit) => `<span class="i-edit">${escapeHtml(edit)}</span>`).join("")}</div>`) +
      '<div class="i-hint">Every line above is a command on the bus: an agent can add or remove any of them and the canvas follows.</div>';
  }
}

function propRow(label, value) {
  return `<div class="c-prop"><span class="c-prop__label">${escapeHtml(label)}</span><span class="c-prop__value">${value}</span></div>`;
}

function drawHistogram() {
  const target = $("#histogram");
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

// ── interactions ────────────────────────────────────────────────────────────

toolsEl.addEventListener("click", (event) => {
  const button = event.target instanceof HTMLElement ? event.target.closest("[data-tool]") : null;
  if (!button || !state.image) return;
  activeTool = button.dataset.tool;
  if (activeTool === "crop") cropDraft = state.image.crop ?? null;
  render();
});

inspectorEl.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  if (target.dataset.key) {
    const key = target.dataset.key;
    const value = Number(target.value);
    const out = inspectorEl.querySelector(`[data-out="${key}"]`);
    if (out) out.textContent = String(value);
    // The pack coalesces a burst on the same key into one undo step, so we can
    // stream while the slider moves without flooding the tape.
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => {
      void op("image.adjust", { [key]: value }, `Adjust ${key}`);
    }, 45);
  } else if (target.dataset.crop && cropDraft) {
    cropDraft = { ...cropDraft, [target.dataset.crop]: Math.max(0, Number(target.value)) };
    renderStage();
  }
});

inspectorEl.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.dataset.key) {
    clearTimeout(sliderTimer);
    void op("image.adjust", { [target.dataset.key]: Number(target.value) }, `Adjust ${target.dataset.key}`);
  }
});

inspectorEl.addEventListener("dblclick", (event) => {
  const row = event.target instanceof HTMLElement ? event.target.closest("[data-slider]") : null;
  if (!row) return;
  const key = row.dataset.slider;
  void op("image.adjust", { [key]: 0 }, `Reset ${key}`);
});

inspectorEl.addEventListener("click", (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return;

  const filter = target.closest("[data-filter]");
  if (filter) {
    void op("image.setFilter", { filter: filter.dataset.filter }, `Filter ${filter.dataset.filter}`);
    return;
  }

  const aspect = target.closest("[data-crop-aspect]");
  if (aspect) {
    cropAspect = aspect.dataset.cropAspect;
    renderInspector();
    return;
  }

  const action = target.closest("[data-act]")?.dataset.act;
  if (!action) return;
  const view = state.image;
  if (!view) return;

  switch (action) {
    case "reset-adjust":
      void op(
        "image.adjust",
        { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, blur: 0, vignette: 0 },
        "Neutral adjustments",
      );
      break;
    case "crop-apply":
      void applyCrop();
      break;
    case "crop-reset":
      cropDraft = null;
      void op("image.clearCrop", {}, "Reset crop");
      break;
    case "size-apply": {
      const width = Number(inspectorEl.querySelector('[data-size="width"]')?.value ?? 0);
      const height = Number(inspectorEl.querySelector('[data-size="height"]')?.value ?? 0);
      if (width < 1 || height < 1) return markError("Width and height must be positive.");
      void op("image.resize", { width, height }, `Resize ${width}×${height}`);
      break;
    }
    case "size-half":
      void op("image.resize", { width: Math.max(1, Math.round(view.width / 2)) }, "Resize 50%");
      break;
    case "size-double":
      void op("image.resize", { width: Math.round(view.width * 2) }, "Resize 2×");
      break;
    case "size-reset":
      void op("image.clearResize", {}, "Reset size");
      break;
    default:
      break;
  }
});

async function applyCrop() {
  const draft = cropDraft;
  if (!draft) return markError("Draw a crop rectangle first.");
  const view = state.image;
  const x = Math.max(0, Math.round(draft.x));
  const y = Math.max(0, Math.round(draft.y));
  const width = Math.max(1, Math.round(draft.width));
  const height = Math.max(1, Math.round(draft.height));
  const whole =
    view &&
    x === 0 &&
    y === 0 &&
    width >= view.naturalWidth &&
    height >= view.naturalHeight;
  await op(
    whole ? "image.clearCrop" : "image.crop",
    whole ? {} : { x, y, width, height },
    whole ? "No crop" : `Crop ${width}×${height}`,
  );
  cropDraft = null;
}

// Toolstrip
$("#rot-left").addEventListener("click", () => void op("image.rotate", { degrees: -90 }, "Rotate left"));
$("#rot-right").addEventListener("click", () => void op("image.rotate", { degrees: 90 }, "Rotate right"));
$("#flip-h").addEventListener("click", () => void op("image.flip", { axis: "x" }, "Flip horizontal"));
$("#flip-v").addEventListener("click", () => void op("image.flip", { axis: "y" }, "Flip vertical"));
$("#reset").addEventListener("click", () => void op("image.reset", {}, "Reset edits"));
$("#rail-reset").addEventListener("click", () => void op("image.reset", {}, "Reset edits"));
$("#export").addEventListener("click", () => void exportPng());
$("#undo").addEventListener("click", () => void undo());
$("#redo").addEventListener("click", () => void redo());
$("#palette").addEventListener("click", () => window.NucleusKit?.openPalette());
$("#file-input").addEventListener("change", (event) => void openFile(event.target.files?.[0]));

$("#save").addEventListener("click", () => {
  if (!state.image) return markError("Nothing to save yet.");
  const link = document.createElement("a");
  link.href = "/api/project";
  link.download = "image.nucleus.json";
  link.click();
});

$("#project-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy(true);
  try {
    const payload = JSON.parse(await file.text());
    const restored = await post("/api/project", payload);
    if (settle(restored)) markReady(`Opened ${file.name}.`);
    sourceImg = null;
    sourceKey = null;
    await ensureSource();
  } catch (error) {
    markError(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
    render();
    event.target.value = "";
  }
});

// Zoom
$("#zoom-in").addEventListener("click", () => setZoom(lastFit * 1.25));
$("#zoom-out").addEventListener("click", () => setZoom(lastFit / 1.25));
$("#zoom-fit").addEventListener("click", () => {
  zoom = "fit";
  render();
});
$("#hold-before").addEventListener("pointerdown", () => {
  showBefore = true;
  renderStage();
});
$("#hold-before").addEventListener("pointerup", () => {
  showBefore = false;
  renderStage();
});
$("#hold-before").addEventListener("pointerleave", () => {
  showBefore = false;
  renderStage();
});

function setZoom(value) {
  zoom = Math.max(0.05, Math.min(8, value));
  render();
}

// Crop overlay gestures
const overlay = $("#crop-overlay");
const cropBox = $("#crop-box");

function pointToSource(event) {
  const view = state.image;
  const rect = canvas.getBoundingClientRect();
  const baseWidth = activeTool === "crop" ? view.naturalWidth : view.width;
  const scale = rect.width / baseWidth;
  const x = (event.clientX - rect.left) / scale;
  const y = (event.clientY - rect.top) / scale;
  return { x: Math.max(0, Math.min(view.naturalWidth, x)), y: Math.max(0, Math.min(view.naturalHeight, y)), scale };
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
  const inX = (draft.x) * scale + rect.left;
  const inY = (draft.y) * scale + rect.top;
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
  renderInspector();
}
overlay.addEventListener("pointerup", endDrag);
overlay.addEventListener("pointercancel", endDrag);

$("#crop-apply").addEventListener("click", () => void applyCrop());
$("#crop-cancel").addEventListener("click", () => {
  cropDraft = state.image?.crop ?? null;
  activeTool = "adjust";
  render();
});

for (const button of document.querySelectorAll("[data-aspect]")) {
  button.addEventListener("click", () => {
    cropAspect = button.dataset.aspect;
    for (const other of document.querySelectorAll("[data-aspect]")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });
}

// Files: drag & drop, paste
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

// Keyboard
document.addEventListener("keydown", (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && key === "z" && !event.shiftKey) { event.preventDefault(); void undo(); return; }
  if (mod && ((key === "z" && event.shiftKey) || key === "y")) { event.preventDefault(); void redo(); return; }
  if (mod && key === "e") { event.preventDefault(); void exportPng(); return; }
  if (mod && key === "0") { event.preventDefault(); zoom = "fit"; render(); return; }
  if (mod && (key === "=" || key === "+")) { event.preventDefault(); setZoom(lastFit * 1.25); return; }
  if (mod && key === "-") { event.preventDefault(); setZoom(lastFit / 1.25); return; }
  if (typing || mod) return;

  if (event.key === "\\") { showBefore = true; renderStage(); return; }
  if (!state.image) return;
  switch (key) {
    case "r": void op("image.rotate", { degrees: event.shiftKey ? -90 : 90 }, "Rotate"); break;
    case "h": void op("image.flip", { axis: "x" }, "Flip horizontal"); break;
    case "v": void op("image.flip", { axis: "y" }, "Flip vertical"); break;
    case "escape":
      if (activeTool === "crop") {
        cropDraft = state.image?.crop ?? null;
        activeTool = "adjust";
        render();
      }
      break;
    default: break;
  }
});

document.addEventListener("keyup", (event) => {
  if (event.key === "\\") {
    showBefore = false;
    renderStage();
  }
});

window.addEventListener("resize", () => {
  if (state.image) renderStage();
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

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

void refresh();
