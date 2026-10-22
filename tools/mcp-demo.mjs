#!/usr/bin/env node
/**
 * End-to-end demo of the M4 proxy (§4.4): a real Notes app, the launcher's run
 * registry, the MCP server over stdio, and an agent that proposes a change, has
 * it approved, reads the tape and undoes it.
 *
 * The app is started exactly like the launcher starts it (`node dist/server.js`
 * with `PORT` + `NUCLEUS_TOKEN`); the registry entry is written the same shape
 * the Rust `Runtime` writes. Everything after that is the production path: MCP
 * JSON-RPC on stdin/stdout, bearer-authenticated HTTP into the app.
 *
 *   node tools/mcp-demo.mjs                 # print the transcript
 *   node tools/mcp-demo.mjs --out examples/mcp/transcript.md
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex === -1 ? null : process.argv[outIndex + 1];

const lines = [];
/** Append one markdown block to the transcript. */
function say(text) {
  lines.push(text);
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Start an app server the way the launcher does. */
async function startApp({ dir, args, token, dataDir }) {
  const port = await freePort();
  const child = spawn(process.execPath, args, {
    cwd: path.join(ROOT, dir),
    env: { ...process.env, PORT: String(port), NUCLEUS_TOKEN: token, APPDATA: dataDir },
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
    `${dir} to answer /api/state${errors.length ? ` (stderr: ${errors.join("").trim()})` : ""}`,
  );
  return { child, port };
}

/** A tiny stdio MCP client: line-delimited JSON-RPC, one pending map. */
class McpClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #buffer = "";

  constructor({ runDir }) {
    this.#child = spawn(process.execPath, [path.join(ROOT, "packages/control-mcp/dist/index.js")], {
      cwd: ROOT,
      env: { ...process.env, NUCLEUS_RUN_DIR: runDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => {
      this.#buffer += chunk;
      let index;
      while ((index = this.#buffer.indexOf("\n")) !== -1) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line === "") continue;
        const message = JSON.parse(line);
        const resolve = this.#pending.get(message.id);
        if (resolve) {
          this.#pending.delete(message.id);
          resolve(message);
        }
      }
    });
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, resolve);
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20_000).unref();
    });
  }

  /** Call a tool and parse its JSON text payload. */
  async tool(name, args = {}) {
    const response = await this.request("tools/call", { name, arguments: args });
    const text = response.result?.content?.[0]?.text ?? "";
    if (response.result?.isError) throw new Error(text);
    return JSON.parse(text);
  }

  close() {
    this.#child.stdin.end();
    this.#child.kill();
  }
}

async function main() {
  const notesToken = randomUUID().replace(/-/g, "");
  const runDir = mkdtempSync(path.join(tmpdir(), "nucleus-mcp-demo-"));
  // The app persists its document + tape under APPDATA: give it a throwaway one
  // so the demo never touches the real notebook.
  const appData = mkdtempSync(path.join(tmpdir(), "nucleus-mcp-appdata-"));
  const notes = await startApp({ dir: "apps/notes", args: ["dist/server.js"], token: notesToken, dataDir: appData });

  writeFileSync(
    path.join(runDir, "apps.json"),
    `${JSON.stringify(
      [
        {
          id: "nucleus.notes",
          name: "Notes",
          port: notes.port,
          token: notesToken,
          pid: notes.child.pid ?? null,
          startedAt: new Date().toISOString(),
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );

  const mcp = new McpClient({ runDir });
  try {
    say("# M4 — an agent drives a running Nucleus app\n");
    say("Generated by `node tools/mcp-demo.mjs`. The app is a real Notes server;");
    say("the MCP server is `packages/control-mcp`, talking to it over HTTP with the");
    say("bearer token from `run/apps.json`.\n");

    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "opencode", version: "demo" },
    });
    say("## 1. Handshake\n");
    say("```json\n" + JSON.stringify(init.result, null, 2) + "\n```\n");

    const list = await mcp.request("tools/list", {});
    say("## 2. Tools\n");
    say("```\n" + list.result.tools.map((tool) => tool.name).join("\n") + "\n```\n");

    const apps = await mcp.tool("nucleus_apps");
    say("## 3. What is running\n");
    say("`nucleus_apps` →\n");
    say("```json\n" + JSON.stringify(apps, null, 2) + "\n```\n");

    const described = await mcp.tool("nucleus_describe", { app: "nucleus.notes", command: "note.create" });
    say("## 4. The command's schema\n");
    say("`nucleus_describe({ app: \"nucleus.notes\", command: \"note.create\" })` →\n");
    say("```json\n" + JSON.stringify(described.command, null, 2) + "\n```\n");

    const invoked = await mcp.tool("nucleus_invoke", {
      app: "nucleus.notes",
      command: "note.create",
      params: { title: "M4 demo", content: "- an agent wrote this\n- a human approved it" },
      label: "draft the demo note",
    });
    say("## 5. The agent proposes a write\n");
    say("Agents land in the review queue, not in the document:\n");
    say("```json\n" + JSON.stringify(invoked, null, 2) + "\n```\n");

    const proposalId = invoked.proposalId;
    if (!proposalId) throw new Error("expected a proposal — is the app running in autopilot?");

    // The human approves in the app's review drawer (keyboard: A). Same HTTP call.
    const accepted = await fetch(
      `http://127.0.0.1:${notes.port}/api/proposals/${encodeURIComponent(proposalId)}/accept`,
      { method: "POST", headers: { authorization: `Bearer ${notesToken}`, "content-type": "application/json" } },
    );
    if (!accepted.ok) throw new Error(`accept failed: HTTP ${accepted.status}`);

    const waited = await mcp.tool("nucleus_wait", { proposalId, timeoutMs: 5_000 });
    say("## 6. The human accepts; the agent waits\n");
    say("`nucleus_wait` →\n");
    say("```json\n" + JSON.stringify(waited, null, 2) + "\n```\n");

    const tape = await mcp.tool("nucleus_tape", { app: "nucleus.notes" });
    say("## 7. The tape remembers who did it\n");
    say("```json\n" + JSON.stringify(tape.records, null, 2) + "\n```\n");

    const undone = await mcp.tool("nucleus_undo", { app: "nucleus.notes" });
    say("## 8. …and it can be undone\n");
    say("```json\n" + JSON.stringify(undone, null, 2) + "\n```\n");

    const after = await mcp.tool("nucleus_tape", { app: "nucleus.notes", since: 1 });
    say("Records after the undo (seq > 1):\n");
    say("```json\n" + JSON.stringify(after.records, null, 2) + "\n```\n");

    say("---\n");
    say("Every mutation above went through the app's own `/api/op`: the proxy has no");
    say("private back door, and the actor on the tape is the MCP client, not the tool.");
  } finally {
    mcp.close();
    notes.child.kill();
    // Let the pipes drain so Windows does not trip on a half-closed handle.
    await sleep(150);
    for (const dir of [runDir, appData]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A file still held by the dying app: the OS cleans temp eventually.
      }
    }
  }

  const transcript = `${lines.join("\n")}\n`;
  process.stdout.write(transcript);
  if (outFile) {
    mkdirSync(path.dirname(path.resolve(ROOT, outFile)), { recursive: true });
    writeFileSync(path.resolve(ROOT, outFile), transcript, "utf8");
    process.stderr.write(`\nwrote ${outFile}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`mcp demo failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
