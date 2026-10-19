#!/usr/bin/env node
/**
 * PDF Workbench — page surgery on the Nucleus command bus.
 * Everything generic (bind 127.0.0.1, guard, standard API, SSE, persistence,
 * single-instance lock, legacy projects, static files, web kit) lives in
 * `@nucleus/app-kit`.
 */
import { fileURLToPath } from "node:url";
import { ControlServer } from "@nucleus/control";
import { createAppServer, readJson } from "@nucleus/app-kit";
import { countPages, createPdfSession, exportPdf, MemoryAssetStore, pageViews } from "@nucleus/pdf";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

function session() {
  const base = createPdfSession();
  return {
    ...base,
    control: new ControlServer(base.bus, base.doc),
    snapshot: () => ({
      pages: pageViews(base.doc),
    }),
  };
}

try {
  const app = await createAppServer({
    id: "nucleus.pdf",
    name: "PDF Workbench",
    publicDir: PUBLIC_DIR,
    projectFormat: "nucleus.project",
    createSession: session,
    // App-specific: raw uploads into the asset store + PDF export.
    routes: async (req, res, url, s) => {
      if (url.pathname === "/api/load" && req.method === "POST") {
        // M0-era upload shape (base64 JSON); raw binary lands with §5.1.
        const body = await readJson(req);
        const raw = Buffer.from(String(body.dataBase64 ?? ""), "base64");
        if (raw.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { kind: "validation", message: "empty upload" } }));
          return true;
        }
        const sourceId = `src-${Date.now().toString(36)}-${raw.length}`;
        s.assets?.put(sourceId, new Uint8Array(raw));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sourceId, pageCount: await countPages(raw) }));
        return true;
      }

      if (url.pathname === "/api/export" && req.method === "GET") {
        const bytes = await exportPdf(s.doc, s.assets as MemoryAssetStore);
        if (bytes.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { kind: "validation", message: "document is empty" } }));
          return true;
        }
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="workbench.pdf"',
        });
        res.end(Buffer.from(bytes));
        return true;
      }
      return false;
    },
  });

  process.stdout.write(`PDF Workbench running at http://localhost:${app.port()}/?t=${process.env.NUCLEUS_TOKEN ?? ""}\n`);
} catch (error) {
  // Exit code 3 = the launcher's pre-ready launch-failure semantics: a second
  // instance of the same app is a user mistake — report and die fast.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(3);
}
