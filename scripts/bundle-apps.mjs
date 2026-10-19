#!/usr/bin/env node
// Bundle every app's dist/server.js into a single self-contained file.
//
//   node scripts/bundle-apps.mjs            # bundle apps/notes + apps/pdf-workbench
//   node scripts/bundle-apps.mjs <app ...>  # bundle only the named apps
//
// Why: `.nucleusapp` archives exclude `node_modules` (pack.rs SKIP_DIRS), so a
// plain `tsc` dist that still imports `@nucleus/*` workspace packages cannot
// run on a machine without the monorepo checkout — node dies instantly with
// ERR_MODULE_NOT_FOUND and the launcher's only visible symptom is a failed
// readiness probe 20 s later. Bundling bakes the workspace packages into the
// single server file so the packed payload runs anywhere node runs.
//
// The bundle replaces `<app>/dist/server.js` in the working tree — dist/ is a
// build output (`npm run build` regenerates the unbundled version), and the
// pack step archives it as-is. Build → bundle → pack.

import { build } from "esbuild";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:"));
const appsDir = path.join(repoRoot, "apps");

// node built-ins must stay external: the bundle runs on real node, and leaving
// them as imports keeps the output readable. esbuild with platform=node marks
// every `node:*` import external automatically; the explicit list below is a
// belt-and-braces for bare forms (`http`, `fs`) some tools emit.
const nodeBuiltins = new Set([
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "http",
  "https", "module", "net", "os", "path", "perf_hooks", "readline", "stream",
  "string_decoder", "timers", "tls", "url", "util", "zlib",
]);

const wanted = process.argv.slice(2);

async function serverApps() {
  const dirs = await readdir(appsDir, { withFileTypes: true });
  const found = [];
  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const appDir = path.join(appsDir, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(appDir, "nucleus.app.json"), "utf8"));
    } catch {
      // A folder without a manifest is not an app (e.g. a placeholder).
      continue;
    }
    if (manifest?.launch?.kind !== "server") continue;
    found.push({ name: entry.name, appDir, entry: path.join(appDir, "dist", "server.js") });
  }
  return found;
}

const apps = (await serverApps()).filter(
  (app) => wanted.length === 0 || wanted.includes(app.name) || wanted.includes(path.basename(app.appDir)),
);
if (apps.length === 0) {
  console.error("bundle-apps: no server app matched the request");
  process.exit(1);
}

for (const app of apps) {
  const result = await build({
    entryPoints: [app.entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: app.entry,
    allowOverwrite: true,
    external: [...nodeBuiltins],
    sourcemap: false,
    logLevel: "warning",
  });
  console.log(`bundle-apps: ${path.relative(repoRoot, app.appDir)} → dist/server.js (${((await stat(app.entry)).size / 1024).toFixed(0)} KiB${result.warnings.length ? `, ${result.warnings.length} warning(s)` : ""})`);
}

async function stat(file) {
  const { stat } = await import("node:fs/promises");
  return stat(file);
}
