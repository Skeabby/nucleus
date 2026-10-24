#!/usr/bin/env node
/**
 * Marketing assets, generated from the real product (§5 docs + repo polish).
 *
 * Every screenshot is the actual app served by the actual command pack, with a
 * throwaway `APPDATA` so the demo data never touches your notebook. Rendering
 * is Microsoft Edge in headless mode (present on every Windows 10/11 box), so
 * there is no Playwright dependency to install or keep alive.
 *
 *   node tools/media.mjs                 # every screenshot + the social card
 *   node tools/media.mjs --only notes
 *   node tools/media.mjs --only pdf
 *   node tools/media.mjs --only image
 *   node tools/media.mjs --only social
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { encodePng } from "./png.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "docs", "media");

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
];

function findEdge() {
  const found = EDGE_CANDIDATES.find((candidate) => candidate !== "" && existsSync(candidate));
  if (!found) throw new Error("Microsoft Edge not found — install Edge or pass --edge <path>");
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Start an app exactly like the launcher does (PORT + NUCLEUS_TOKEN). */
async function startApp(dir, appData) {
  // `public/_kit` is generated at bundle time; refresh it so a local run shows
  // the same chrome as the shipped payload.
  cpSync(path.join(ROOT, "packages", "app-kit", "kit"), path.join(ROOT, dir, "public", "_kit"), {
    recursive: true,
  });
  const port = await freePort();
  const token = randomUUID().replace(/-/g, "");
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: path.join(ROOT, dir),
    env: { ...process.env, PORT: String(port), NUCLEUS_TOKEN: token, APPDATA: appData },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    20_000,
    `${dir}${errors.length > 0 ? ` (stderr: ${errors.join("").trim()})` : ""}`,
  );
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/?t=${token}`,
    stop: () => child.kill(),
  };
}

function client(app) {
  const headers = { authorization: `Bearer ${app.token}`, "content-type": "application/json" };
  return {
    async post(urlPath, body) {
      const response = await fetch(`http://127.0.0.1:${app.port}${urlPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
      });
      const payload = await response.json();
      if (!payload.ok) throw new Error(`${urlPath}: ${JSON.stringify(payload.error)}`);
      return payload;
    },
    async op(name, params = {}) {
      const body = await this.post("/api/op", { name, params });
      return body.result?.result ?? body.result;
    },
  };
}

/**
 * Edge headless screenshot through the DevTools protocol.
 *
 * `--screenshot` waits for the page to finish loading, and our apps keep an SSE
 * stream open forever — the capture would never happen. CDP lets us navigate,
 * wait a beat, then grab the frame (and close the target) deterministically.
 */
async function shoot(edge, url, outFile, { width = 1600, height = 1000, settle = 1500, evaluate = null } = {}) {
  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), "nucleus-media-profile-"));
  const browser = spawn(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--disable-features=Translate,MediaRouter",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  const json = async (path, method = "GET") => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return response.json();
  };

  try {
    await waitFor(
      async () => {
        try {
          await json("/json/version");
          return true;
        } catch {
          return false;
        }
      },
      20_000,
      "Edge DevTools",
    );

    const target = await json(`/json/new?${encodeURIComponent(url)}`, "PUT");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });

    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url });
    await sleep(settle);
    if (evaluate) {
      await send("Runtime.enable");
      const outcome = await send("Runtime.evaluate", {
        expression: evaluate,
        awaitPromise: true,
        returnByValue: true,
      });
      if (outcome.result?.exceptionDetails) {
        throw new Error(`page script failed: ${JSON.stringify(outcome.result.exceptionDetails)}`);
      }
      await sleep(700);
    }
    const frame = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!frame.result?.data) throw new Error(`no screenshot data (${JSON.stringify(frame.error ?? {})})`);
    writeFileSync(outFile, Buffer.from(frame.result.data, "base64"));
    socket.close();
    await json(`/json/close/${target.id}`).catch(() => {});
  } finally {
    browser.kill();
    await sleep(100);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Edge may still hold the profile; the OS cleans temp eventually */
    }
  }
}

// ---------------------------------------------------------------------------
// Seed data — a library that shows the app off without lying about features
// ---------------------------------------------------------------------------

async function seedNotes(app) {
  const api = client(app);
  const work = await api.op("notebook.create", { title: "Work" });
  const personal = await api.op("notebook.create", { title: "Personal" });
  const reading = await api.op("notebook.create", { title: "Reading" });

  const launch = await api.op("note.create", {
    title: "Launch checklist",
    notebookId: work.id,
    tags: ["release", "q4"],
    pinned: true,
    favorite: true,
    content: [
      "## Before the tag",
      "",
      "- [x] Rotate the signing key",
      "- [x] Refresh the rolling `latest` release",
      "- [ ] Smoke-test the updater on a clean profile",
      "- [ ] Ask Mitch to re-record the demo",
      "",
      "> The launcher stays alive so closing it shuts down the apps it owns.",
      "",
      "### Numbers",
      "",
      "| Step | Owner | Status |",
      "| --- | --- | --- |",
      "| Bundle apps | CI | done |",
      "| Pack + catalog | CI | done |",
      "| Inno setup | CI | done |",
    ].join("\n"),
  });

  await api.op("note.create", {
    title: "MCP proxy: design notes",
    notebookId: work.id,
    tags: ["mcp", "agents"],
    content: [
      "The proxy reads `%APPDATA%\\Nucleus\\run\\apps.json` and calls each app's `/api/*` with its bearer.",
      "",
      "1. `nucleus_apps` — what is running",
      "2. `nucleus_describe` — command schemas",
      "3. `nucleus_invoke` — propose or apply",
      "",
      "Agents land in the review drawer, so a human still says yes.",
    ].join("\n"),
  });

  await api.op("note.create", {
    title: "Groceries",
    notebookId: personal.id,
    tags: ["errands"],
    content: "- [ ] oat milk\n- [ ] coffee beans\n- [ ] lemons\n- [x] sourdough",
  });

  await api.op("note.create", {
    title: "Weekend plans",
    notebookId: personal.id,
    tags: ["family"],
    content: "Sat: market, then the park.\n\nSun: nothing. Deliberately.",
  });

  await api.op("note.create", {
    title: "Designing Data-Intensive Applications — ch. 5",
    notebookId: reading.id,
    tags: ["books", "distributed"],
    content: [
      "Replication, then partitioning.",
      "",
      "- Leaders, followers, and the lag budget",
      "- Read-your-writes needs a token, not a prayer",
      "> 'Eventual' is a duration, not a promise.",
    ].join("\n"),
  });

  const old = await api.op("note.create", {
    title: "Old scratchpad",
    notebookId: work.id,
    tags: ["archive"],
    content: "Superseded by the launch checklist.",
  });
  await api.op("note.trash", { id: old.id });

  // Open a rich note so the editor pane is the one on screen.
  void launch;
}

async function captureNotes(edge) {
  const appData = mkdtempSync(path.join(tmpdir(), "nucleus-media-notes-"));
  const app = await startApp("apps/notes", appData);
  try {
    await seedNotes(app);
    const out = path.join(OUT_DIR, "notes.png");
    await shoot(edge, app.url, out);
    console.log(`wrote docs/media/notes.png`);
  } finally {
    app.stop();
    await sleep(150);
    try {
      rmSync(appData, { recursive: true, force: true });
    } catch {
      /* the dying app may still hold a lock; temp gets cleaned by the OS */
    }
  }
}

// ---------------------------------------------------------------------------
// PDF Workbench
// ---------------------------------------------------------------------------

/** A believable report: title block, a bar chart, a footer per page. */
async function makeReportPdf() {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const accent = rgb(0.13, 0.83, 0.93);

  const cover = doc.addPage([595, 842]);
  cover.drawRectangle({ x: 0, y: 640, width: 595, height: 202, color: rgb(0.09, 0.08, 0.13) });
  cover.drawText("NUCLEUS", { x: 54, y: 760, size: 12, font: bold, color: accent });
  cover.drawText("Annual", { x: 54, y: 700, size: 46, font: bold, color: rgb(1, 1, 1) });
  cover.drawText("report 2026", { x: 54, y: 660, size: 46, font: bold, color: rgb(1, 1, 1) });
  cover.drawText("Figures, decisions and the year ahead.", { x: 54, y: 120, size: 13, font: body, color: rgb(0.35, 0.35, 0.4) });

  for (let i = 2; i <= 6; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`0${i}`, { x: 54, y: 770, size: 10, font: bold, color: accent });
    page.drawText(["Revenue", "Retention", "Shipping", "Costs", "Outlook"][i - 2] ?? "Notes", {
      x: 54,
      y: 726,
      size: 26,
      font: bold,
      color: rgb(0.12, 0.12, 0.16),
    });
    page.drawLine({ start: { x: 54, y: 706 }, end: { x: 541, y: 706 }, thickness: 1, color: rgb(0.85, 0.85, 0.88) });

    // A small chart so every thumbnail has visual structure.
    const bars = 5 + (i % 3);
    for (let b = 0; b < bars; b += 1) {
      const height = 40 + ((b * 37 + i * 29) % 150);
      page.drawRectangle({
        x: 70 + b * 62,
        y: 420,
        width: 34,
        height,
        color: b % 3 === 0 ? accent : rgb(0.36, 0.33, 0.95),
      });
    }
    for (let line = 0; line < 9; line += 1) {
      page.drawRectangle({
        x: 54,
        y: 250 - line * 18,
        width: 380 - ((line * 53) % 140),
        height: 7,
        color: rgb(0.88, 0.88, 0.91),
      });
    }
    page.drawText(`Page ${i} of 6 — nucleus`, { x: 54, y: 40, size: 8, font: body, color: rgb(0.6, 0.6, 0.65) });
  }
  return doc.save();
}

async function makeContractPdf() {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i += 1) {
    const page = doc.addPage([842, 595]);
    page.drawText("SERVICE AGREEMENT", { x: 54, y: 520, size: 18, font: body, color: rgb(0.12, 0.12, 0.16) });
    for (let line = 0; line < 14; line += 1) {
      page.drawRectangle({
        x: 54,
        y: 470 - line * 22,
        width: 640 - ((line * 71) % 260),
        height: 6,
        color: rgb(0.86, 0.86, 0.9),
      });
    }
    page.drawText(`Exhibit ${String.fromCharCode(64 + i)}`, { x: 54, y: 40, size: 9, font: body, color: rgb(0.55, 0.55, 0.6) });
  }
  return doc.save();
}

async function seedPdf(app) {
  const api = client(app);
  const uploads = [
    { name: "Annual report.pdf", bytes: await makeReportPdf(), rotate: [2] },
    { name: "Contract.pdf", bytes: await makeContractPdf(), rotate: [] },
  ];

  for (const upload of uploads) {
    const loaded = await api.post("/api/load", {
      dataBase64: Buffer.from(upload.bytes).toString("base64"),
      name: upload.name,
    });
    const pages = Array.from({ length: loaded.pageCount }, (_, index) => index);
    const imported = await api.op("pdf.importPages", {
      sourceId: loaded.sourceId,
      pages,
      name: upload.name,
    });
    if (upload.rotate.length > 0) {
      const ids = upload.rotate.map((index) => imported.ids[index]).filter(Boolean);
      await api.op("pdf.rotatePages", { ids, degrees: 90 });
    }
  }
}

async function capturePdf(edge) {
  const appData = mkdtempSync(path.join(tmpdir(), "nucleus-media-pdf-"));
  const app = await startApp("apps/pdf-workbench", appData);
  try {
    await seedPdf(app);
    const out = path.join(OUT_DIR, "pdf-workbench.png");
    // Select one page so the screenshot shows the contextual options bar and
    // Properties in use.
    await shoot(edge, app.url, out, {
      settle: 2600,
      evaluate:
        "document.querySelectorAll('.c-card')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })); 'ok'",
    });
    console.log("wrote docs/media/pdf-workbench.png");
  } finally {
    app.stop();
    await sleep(150);
    try {
      rmSync(appData, { recursive: true, force: true });
    } catch {
      /* the dying app may still hold a lock; temp gets cleaned by the OS */
    }
  }
}

// ---------------------------------------------------------------------------
// Image Editor
// ---------------------------------------------------------------------------

/** A dusk landscape: gradient sky, low sun, layered hills, vignette already there. */
function makeLandscapePng(width = 1400, height = 900) {
  return encodePng(width, height, (x, y) => {
    const t = y / height;
    const sky = Math.pow(t, 0.9);
    let r = 22 + 210 * sky;
    let g = 26 + 120 * sky;
    let b = 62 + 60 * (1 - sky);
    // low sun, left of centre
    const dx = x - width * 0.34;
    const dy = y - height * 0.56;
    const distance = Math.hypot(dx, dy);
    if (distance < 190) {
      const k = 1 - distance / 190;
      r += 200 * k * k;
      g += 150 * k * k;
      b += 60 * k * k;
    }
    // two hill ridges, back and front
    const ridgeBack = height * 0.62 + Math.sin(x / 210) * 40 + Math.sin(x / 71) * 12;
    const ridgeFront = height * 0.74 + Math.sin(x / 150 + 1.6) * 55;
    if (y > ridgeBack) {
      const k = Math.min(1, (y - ridgeBack) / 120);
      r = r * (1 - 0.72 * k) + 18 * k;
      g = g * (1 - 0.66 * k) + 16 * k;
      b = b * (1 - 0.5 * k) + 34 * k;
    }
    if (y > ridgeFront) {
      const k = Math.min(1, (y - ridgeFront) / 90);
      r = r * (1 - 0.8 * k) + 8 * k;
      g = g * (1 - 0.78 * k) + 8 * k;
      b = b * (1 - 0.6 * k) + 16 * k;
    }
    // a soft grain so the histogram is not a single spike
    const grain = ((x * 7 + y * 13) % 9) - 4;
    return [
      Math.max(0, Math.min(255, Math.round(r + grain))),
      Math.max(0, Math.min(255, Math.round(g + grain))),
      Math.max(0, Math.min(255, Math.round(b + grain))),
    ];
  });
}

async function seedImage(app) {
  const api = client(app);
  const png = makeLandscapePng();
  const uploaded = await api.post("/api/upload", {
    dataBase64: png.toString("base64"),
    name: "dusk-ridges.png",
  });
  await api.op("image.load", {
    sourceId: uploaded.sourceId,
    name: "dusk-ridges.png",
    mime: uploaded.mime,
    naturalWidth: 1400,
    naturalHeight: 900,
  });
  // A visible grade, so the sliders in the screenshot are not all at zero.
  await api.op("image.adjust", {
    brightness: 8,
    contrast: 16,
    saturation: 10,
    temperature: 18,
    vignette: 22,
  });
}

async function captureImage(edge) {
  const appData = mkdtempSync(path.join(tmpdir(), "nucleus-media-image-"));
  const app = await startApp("apps/image-editor", appData);
  try {
    await seedImage(app);
    const out = path.join(OUT_DIR, "image-editor.png");
    await shoot(edge, app.url, out, { settle: 2200 });
    console.log("wrote docs/media/image-editor.png");
  } finally {
    app.stop();
    await sleep(150);
    try {
      rmSync(appData, { recursive: true, force: true });
    } catch {
      /* the dying app may still hold a lock; temp gets cleaned by the OS */
    }
  }
}

// ---------------------------------------------------------------------------
// Social preview card (1280×640, GitHub's og:image size)
// ---------------------------------------------------------------------------

const SOCIAL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1280px; height: 640px; background: #17141f; color: #ece9f5;
    font-family: "Segoe UI", system-ui, sans-serif; overflow: hidden;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 64px 72px; position: relative;
  }
  .grid {
    position: absolute; inset: 0;
    background-image: linear-gradient(rgba(236,233,245,.05) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(236,233,245,.05) 1px, transparent 1px);
    background-size: 64px 64px; mask-image: radial-gradient(circle at 70% 20%, #000, transparent 75%);
  }
  .top { display: flex; align-items: center; gap: 16px; position: relative; }
  .mark { width: 34px; height: 34px; border: 2px solid #6d5ef8; position: relative; }
  .mark::after { content: ""; position: absolute; inset: 8px; background: #6d5ef8; }
  .wordmark { font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
  .wordmark span { color: #8f85ff; font-weight: 500; margin-left: 10px; font-size: 13px;
    font-family: "Cascadia Code", Consolas, monospace; letter-spacing: .16em; text-transform: uppercase; }
  h1 { position: relative; font-size: 68px; line-height: 1.04; letter-spacing: -.035em; max-width: 900px; font-weight: 700; }
  h1 em { font-style: normal; color: #8f85ff; }
  p.sub { position: relative; margin-top: 22px; font-size: 22px; color: #9b96ad; max-width: 780px; line-height: 1.45; }
  .bottom { display: flex; align-items: flex-end; justify-content: space-between; position: relative; gap: 32px; }
  .chips { display: flex; gap: 10px; flex-wrap: wrap; }
  .chip { border: 1px solid rgba(236,233,245,.18); padding: 7px 12px; font-size: 14px; color: #9b96ad; }
  .chip b { color: #ece9f5; font-weight: 600; }
  .accent { height: 3px; width: 180px; background: #6d5ef8; }
  .repo { font-family: "Cascadia Code", Consolas, monospace; font-size: 15px; color: #5f5a74; }
</style></head>
<body>
  <div class="grid"></div>
  <div class="top">
    <div class="mark"></div>
    <div class="wordmark">Nucleus<span>creative suite</span></div>
  </div>
  <div>
    <h1>The creative suite<br />that <em>runs itself</em>.</h1>
    <p class="sub">Drop-in apps in native WebView2 windows, one command bus for the GUI, the CLI and your agent. No Electron.</p>
  </div>
  <div class="bottom">
    <div class="chips">
      <span class="chip"><b>One</b> command bus</span>
      <span class="chip"><b>Agent-first</b> MCP</span>
      <span class="chip"><b>SHA-256</b> app installs</span>
      <span class="chip"><b>Zero</b> Electron</span>
    </div>
    <div class="repo">github.com/Skeabby/nucleus</div>
  </div>
  <div class="accent"></div>
</body></html>`;

async function captureSocial(edge) {
  const htmlFile = path.join(tmpdir(), `nucleus-social-${process.pid}.html`);
  writeFileSync(htmlFile, SOCIAL_HTML, "utf8");
  const out = path.join(OUT_DIR, "social-preview.png");
  await shoot(edge, `file:///${htmlFile.replace(/\\/g, "/")}`, out, { width: 1280, height: 640, budget: 1200 });
  mkdirSync(path.join(ROOT, ".github"), { recursive: true });
  writeFileSync(path.join(ROOT, ".github", "social-preview.png"), readFileSync(out));
  rmSync(htmlFile, { force: true });
  console.log("wrote docs/media/social-preview.png + .github/social-preview.png");
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
  const edgeIndex = process.argv.indexOf("--edge");
  const edge = edgeIndex === -1 ? findEdge() : process.argv[edgeIndex + 1];

  const jobs = [
    ["notes", () => captureNotes(edge)],
    ["pdf", () => capturePdf(edge)],
    ["image", () => captureImage(edge)],
    ["social", () => captureSocial(edge)],
  ].filter(([name]) => only === null || name === only);

  if (jobs.length === 0) throw new Error(`unknown --only ${only} (notes, pdf, image, social)`);
  for (const [name, job] of jobs) {
    process.stdout.write(`· ${name}\n`);
    await job();
  }
}

main().catch((error) => {
  process.stderr.write(`media failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
