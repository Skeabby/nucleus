/**
 * @nucleus/notes — the Notes command pack.
 *
 * A notebook is an unordered list of `note` nodes (title + markdown content).
 * Extracted from `apps/notes/src/server.ts` so the same commands can be driven
 * by the app server, the CLI, the MCP frontend and the federated agent — one
 * registry, many transports.
 */
import { randomUUID } from "node:crypto";
import {
  CommandBus,
  createDocument,
  listNodes,
  registerCoreCommands,
  NucleusError,
  type DocumentState,
  type JsonSchema,
} from "@nucleus/core";
import { ControlServer } from "@nucleus/control";

export const NOTES_APP_ID = "nucleus.notes";
export const NOTES_PROJECT_FORMAT = "nucleus.notes.project";
export const NOTE_TYPE = "note";

const noteIdParam: JsonSchema = { type: "string", description: "Note node id." };
const textProp = (description: string): JsonSchema => ({ type: "string", description });

export function registerNoteCommands(bus: CommandBus): void {
  bus.register<{ title?: string; content?: string }, { id: string }>({
    name: "note.create",
    title: "Create note",
    description: "Create a new note and return its id.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      properties: {
        title: textProp("Note title; defaults to \"Untitled\"."),
        content: textProp("Markdown body; defaults to empty."),
      },
    },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    examples: [{ params: { title: "Shopping", content: "- [ ] oat milk" } }],
    // Curated MCP shortcut (§4.4): the common case, one tool call, no describe.
    mcp: { expose: true, name: "note_create" },
    run(params, ctx) {
      const id = `note-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const order = Object.keys(ctx.state.nodes).length;
      return {
        patches: [{
          op: "add",
          nodeId: id,
          after: {
            id,
            type: NOTE_TYPE,
            parentId: null,
            order,
            enabled: true,
            opacity: 1,
            props: {
              title: params.title ?? "Untitled",
              content: params.content ?? "",
              createdAt: now,
              updatedAt: now,
            },
          },
        }],
        result: { id },
      };
    },
  });

  bus.register<{ id: string; title?: string; content?: string }, { id: string }>({
    name: "note.update",
    title: "Update note",
    description: "Update title and/or content of a note.",
    sideEffects: "write",
    reversible: true,
    // A typing/autosave burst on the same note collapses into one undo step (F2).
    coalesce: { key: (params) => params.id, windowMs: 2000 },
    params: {
      type: "object",
      required: ["id"],
      properties: {
        id: noteIdParam,
        title: textProp("New title (optional — only provided fields change)."),
        content: textProp("New markdown body (optional)."),
      },
    },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    mcp: { expose: true, name: "note_update" },
    run(params, ctx) {
      const node = ctx.state.nodes[params.id];
      if (!node) throw new NucleusError("not_found", `note not found: ${params.id}`);
      const after = {
        ...node,
        props: {
          ...node.props,
          ...(params.title !== undefined ? { title: params.title } : {}),
          ...(params.content !== undefined ? { content: params.content } : {}),
          updatedAt: new Date().toISOString(),
        },
      };
      return {
        patches: [{ op: "update", nodeId: params.id, after }],
        result: { id: params.id },
      };
    },
  });

  bus.register<{ id: string }, { id: string }>({
    name: "note.delete",
    title: "Delete note",
    description: "Permanently remove a note.",
    sideEffects: "destructive",
    reversible: true,
    params: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    run(params, ctx) {
      if (!ctx.state.nodes[params.id]) {
        throw new NucleusError("not_found", `note not found: ${params.id}`);
      }
      return {
        patches: [{ op: "remove", nodeId: params.id }],
        result: { id: params.id },
      };
    },
  });
}

export interface NoteView {
  id: string;
  title: string;
  content: string;
  snippet: string;
  createdAt: string;
  updatedAt: string;
}

/** Newest-first note list, ready for a UI or an agent. */
export function noteViews(state: DocumentState): NoteView[] {
  return listNodes(state)
    .filter((n) => n.type === NOTE_TYPE)
    .sort((a, b) => {
      const aUpdated = String(a.props["updatedAt"] ?? "");
      const bUpdated = String(b.props["updatedAt"] ?? "");
      // newest first; tie-break on creation order (same-millisecond bursts)
      return bUpdated.localeCompare(aUpdated) || b.order - a.order;
    })
    .map((n) => ({
      id: n.id,
      title: String(n.props["title"] ?? "Untitled"),
      content: String(n.props["content"] ?? ""),
      snippet: String(n.props["content"] ?? "")
        .slice(0, 140)
        .replace(/[#*`>\-_]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
      createdAt: String(n.props["createdAt"] ?? ""),
      updatedAt: String(n.props["updatedAt"] ?? ""),
    }));
}

/** All notes as one Markdown document. Empty string when there is no note. */
export function exportNotesMarkdown(state: DocumentState): string {
  return noteViews(state)
    .map((n) => `# ${n.title}\n\n${n.content}`)
    .join("\n\n---\n\n");
}

export interface NotesSession {
  doc: DocumentState;
  bus: CommandBus;
  control: ControlServer;
}

/** Create a ready-to-use Notes session (document + bus + control surface). */
export function createNotesSession(): NotesSession {
  const doc = createDocument(NOTES_APP_ID);
  const bus = new CommandBus();
  registerCoreCommands(bus);
  registerNoteCommands(bus);
  return { doc, bus, control: new ControlServer(bus, doc) };
}
