#!/usr/bin/env node
/**
 * Notes — Markdown note-taking app on the Nucleus command bus.
 * Everything generic (bind 127.0.0.1, guard, standard API, SSE, persistence,
 * single-instance lock, legacy projects, static files, web kit) lives in
 * `@nucleus/app-kit`.
 */
import { fileURLToPath } from "node:url";
import { createAppServer } from "@nucleus/app-kit";
import {
  createNotesSession,
  exportNotesMarkdown,
  notebookViews,
  noteViews,
  notesStats,
  NOTES_PROJECT_FORMAT,
  tagViews,
  type NotesSession,
} from "@nucleus/notes";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

function session(): NotesSession {
  return createNotesSession();
}

try {
  const app = await createAppServer({
    id: "nucleus.notes",
    name: "Notes",
    publicDir: PUBLIC_DIR,
    projectFormat: NOTES_PROJECT_FORMAT,
    createSession: () => {
      const s = session();
      return {
        ...s,
        // One snapshot for the whole library: the UI filters locally, so a
        // keystroke in the search box never costs a round-trip. Trashed notes
        // ride along and are hidden by the view instead of by the payload.
        snapshot: () => ({
          notes: noteViews(s.doc, { trashed: true }),
          notebooks: notebookViews(s.doc),
          tags: tagViews(s.doc),
          stats: notesStats(s.doc),
        }),
      };
    },
    // App-specific: export the whole notebook as one Markdown file.
    routes: async (req, res, url, s) => {
      if (url.pathname === "/api/export" && req.method === "GET") {
        const views = noteViews(s.doc);
        if (views.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { kind: "validation", message: "no notes to export" } }));
          return true;
        }
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="notes.md"',
        });
        res.end(exportNotesMarkdown(s.doc));
        return true;
      }
      return false;
    },
  });

  process.stdout.write(`Notes running at http://localhost:${app.port()}/?t=${process.env.NUCLEUS_TOKEN ?? ""}\n`);
} catch (error) {
  // Exit code 3 = the launcher's pre-ready launch-failure semantics (Update
  // #13): double-open is a user mistake, not a crash — say so and die fast.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(3);
}
