#!/usr/bin/env node
/**
 * @nucleus/control-mcp — the suite's single MCP server (§4.4).
 *
 * It is a *proxy*: it reads the launcher's run registry
 * (`%APPDATA%\Nucleus\run\apps.json`), and drives each running app over its own
 * authenticated `/api/*` surface. No app package is linked here, so a new app
 * becomes agent-drivable the day it starts — no rebuild, no tool list to edit.
 */
import { createInterface } from "node:readline";
import { AppClient } from "./client.js";
import { Registry } from "./registry.js";
import { createServer } from "./server.js";

const registry = new Registry();

const server = createServer({
  clients: () =>
    registry
      .apps()
      .filter((app) => typeof app.port === "number" && app.port > 0)
      .map((app) => new AppClient(app)),
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

/** Serialise requests so a burst cannot interleave two `tools/call`s. */
let queue: Promise<void> = Promise.resolve();

lines.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
    );
    return;
  }
  queue = queue
    .then(() => server.handle(message as Parameters<typeof server.handle>[0]))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message } })}\n`);
    });
});

lines.on("close", () => {
  // Let the in-flight request finish before the process goes away.
  void queue.then(() => process.exit(0));
});
