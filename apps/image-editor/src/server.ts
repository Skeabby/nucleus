#!/usr/bin/env node
/**
 * Image Editor — non-destructive edits on the Nucleus command bus.
 * Everything generic (bind 127.0.0.1, guard, standard API, SSE, persistence,
 * single-instance lock, projects, static files, web kit) lives in
 * `@nucleus/app-kit`.
 */
import { fileURLToPath } from "node:url";
import { ControlServer } from "@nucleus/control";
import { createAppServer, readJson } from "@nucleus/app-kit";
import { createImageSession, imageView, type MemoryAssetStore } from "@nucleus/image";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

/** Magic-byte sniffing: a project reopened later still serves the right type. */
function sniffMime(bytes: Uint8Array): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return "application/octet-stream";
}

function session() {
  const base = createImageSession();
  return {
    ...base,
    control: new ControlServer(base.bus, base.doc),
    snapshot: () => ({
      image: imageView(base.doc),
    }),
  };
}

try {
  const app = await createAppServer({
    id: "nucleus.image",
    name: "Image Editor",
    publicDir: PUBLIC_DIR,
    projectFormat: "nucleus.project",
    createSession: session,
    // App-specific: raw uploads into the asset store + serving the source back
    // to the canvas (the editor renders the edit stack client-side).
    routes: async (req, res, url, s) => {
      if (url.pathname === "/api/upload" && req.method === "POST") {
        const body = await readJson(req);
        const raw = Buffer.from(String(body.dataBase64 ?? ""), "base64");
        if (raw.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { kind: "validation", message: "empty upload" } }));
          return true;
        }
        if (raw.length > 40 * 1024 * 1024) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { kind: "validation", message: "image larger than 40 MB" } }));
          return true;
        }
        const sourceId = `src-${Date.now().toString(36)}-${raw.length}`;
        s.assets?.put(sourceId, new Uint8Array(raw));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            sourceId,
            bytes: raw.length,
            mime: sniffMime(new Uint8Array(raw)),
          }),
        );
        return true;
      }

      const sourceMatch = /^\/api\/source\/([^/]+)$/.exec(url.pathname);
      if (sourceMatch && req.method === "GET") {
        const sourceId = decodeURIComponent(sourceMatch[1] ?? "");
        const assets = s.assets as MemoryAssetStore | undefined;
        const bytes = assets?.get(sourceId);
        if (!bytes) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { kind: "not_found", message: "source not found" } }));
          return true;
        }
        res.writeHead(200, {
          "content-type": sniffMime(bytes),
          "content-length": String(bytes.length),
          "cache-control": "private, max-age=3600",
        });
        res.end(Buffer.from(bytes));
        return true;
      }

      return false;
    },
  });

  process.stdout.write(
    `Image Editor running at http://localhost:${app.port()}/?t=${process.env.NUCLEUS_TOKEN ?? ""}\n`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(3);
}
