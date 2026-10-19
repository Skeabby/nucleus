#!/usr/bin/env node
// Self-contained check for a bundled app server.
//
//   node scripts/check-bundled-app.mjs <appDir> [timeoutMs]
//
// Spawns `node dist/server.js` from <appDir> exactly the way the launcher does
// (PORT + NUCLEUS_TOKEN env, cwd = app dir), waits for the manifest's
// readyPath to answer with the token attached, then reports PASS/FAIL and
// makes sure the child is gone. A bundled server that cannot import its own
// code exits within milliseconds — exactly the failure that shipped as a
// silent "Open does nothing" in v0.4.0-alpha; this check is what gates it.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const appDir = path.resolve(process.argv[2] ?? "");
const timeoutMs = Number(process.argv[3] ?? 10_000);
const manifestDir = path.basename(appDir) === "dist" ? path.dirname(appDir) : appDir;
const manifest = JSON.parse(await readFile(path.join(manifestDir, "nucleus.app.json"), "utf8"));
const readyPath = manifest?.launch?.readyPath ?? "/";
const server = path.join(appDir.endsWith("dist") ? appDir : path.join(appDir, "dist"), "server.js");

if (!manifest || manifest.launch?.kind !== "server") {
  console.error(`check-bundled-app: ${manifestDir} is not a kind=server app`);
  process.exit(1);
}

const port = 4300 + Math.floor(Math.random() * 400);
const token = "selfcheck-" + Math.random().toString(36).slice(2);
const child = spawn(process.execPath, [server], {
  cwd: appDir.endsWith("dist") ? path.dirname(appDir) : appDir,
  env: { ...process.env, PORT: String(port), NUCLEUS_TOKEN: token },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderrTail = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-2000);
  if (!child.exited && stderrTail.length <= 4000) {
    process.stderr.write(`[server] ${chunk}`);
  }
});

const deadline = Date.now() + timeoutMs;
let lastError = "";
let ok = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break; // died early: report instead of burning the timeout
  try {
    const response = await fetch(`http://127.0.0.1:${port}${readyPath}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      ok = true;
      break;
    }
    lastError = `HTTP ${response.status}`;
  } catch (err) {
    lastError = err.message;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (child.exitCode === null) child.kill("SIGKILL");
const exited = await new Promise((resolve) => {
  if (child.exitCode !== null) return resolve(true);
  child.on("close", () => resolve(true));
  setTimeout(() => resolve(false), 3_000);
});

console.log(`${manifestDir} → ${ok ? "PASS" : "FAIL"} (${port}${readyPath})${centered(lastError)}${exited ? "" : " (child still running!)"}`);
if (!ok || !exited) {
  if (stderrTail) console.error("server stderr tail:\n" + stderrTail);
  process.exit(1);
}

function centered(extra) {
  return extra ? ` — last error: ${extra}` : "";
}
