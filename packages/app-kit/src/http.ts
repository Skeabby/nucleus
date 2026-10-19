/**
 * Small HTTP helpers every app duplicated (F14). No framework — after years
 * of node:http, this file is shorter than an express tutorial.
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Serve static files from `baseDir`. Path traversal is impossible by
 * construction: the resolved target must stay inside the base directory.
 */
export async function serveStatic(
  res: ServerResponse,
  pathname: string,
  baseDir: string,
): Promise<{ served: boolean; file: string }> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(baseDir, rel));
  if (!target.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return { served: false, file: "" };
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
    return { served: true, file: target };
  } catch {
    return { served: false, file: target };
  }
}
