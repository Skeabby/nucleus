/**
 * @nucleus/notes — the Notes command pack.
 *
 * A notebook is an unordered list of `notebook` and `note` nodes. A note carries
 * a title, markdown content, an optional notebook, tags and two flags (pinned,
 * favorite); deleting moves it to the trash, restoring brings it back and
 * purging is the only irreversible step (and even it is one undo away).
 *
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
  type Node,
  type Patch,
} from "@nucleus/core";
import { ControlServer } from "@nucleus/control";

export const NOTES_APP_ID = "nucleus.notes";
export const NOTES_PROJECT_FORMAT = "nucleus.notes.project";
export const NOTE_TYPE = "note";
export const NOTEBOOK_TYPE = "notebook";

const noteIdParam: JsonSchema = { type: "string", description: "Note node id." };
const notebookIdParam: JsonSchema = { type: "string", description: "Notebook node id." };
const textProp = (description: string): JsonSchema => ({ type: "string", description });

const now = () => new Date().toISOString();

/** Read a string prop with a fallback (props are `Record<string, unknown>`). */
function str(node: Node, key: string, fallback = ""): string {
  const value = node.props[key];
  return typeof value === "string" ? value : fallback;
}

/** Read a boolean prop with a fallback. */
function bool(node: Node, key: string, fallback = false): boolean {
  const value = node.props[key];
  return typeof value === "boolean" ? value : fallback;
}

/** Read a string[] prop, dropping anything that is not a string. */
function strings(node: Node, key: string): string[] {
  const value = node.props[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function notes(state: DocumentState): Node[] {
  return listNodes(state).filter((node) => node.type === NOTE_TYPE);
}

function notebooks(state: DocumentState): Node[] {
  return listNodes(state).filter((node) => node.type === NOTEBOOK_TYPE);
}

/** Throws the structured error the control layer expects. */
function requireNode(state: DocumentState, id: string, kind: "note" | "notebook"): Node {
  const node = state.nodes[id];
  if (!node || node.type !== kind) {
    throw new NucleusError("not_found", `${kind} not found: ${id}`);
  }
  return node;
}

/** Normalise tags: trimmed, lowercase, deduplicated, order preserved. */
export function normaliseTags(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().toLowerCase();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Words in a markdown body (code fences and link targets included once). */
export function countWords(content: string): number {
  const text = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~-]/g, " ");
  const words = text.split(/\s+/).filter((word) => word !== "");
  return words.length;
}

/** Minutes of reading at ~200 wpm, minimum 1 for a non-empty note. */
export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / 200));
}

export function registerNoteCommands(bus: CommandBus): void {
  // ── notebooks ──────────────────────────────────────────────────────────

  bus.register<{ title?: string }, { id: string }>({
    name: "notebook.create",
    title: "Create notebook",
    description: "Create a notebook (a folder for notes).",
    sideEffects: "write",
    reversible: true,
    params: { type: "object", properties: { title: textProp('Notebook name; defaults to "Notebook".') } },
    result: { type: "object", required: ["id"], properties: { id: notebookIdParam } },
    examples: [{ params: { title: "Work" } }],
    run(params, ctx) {
      const id = `nb-${randomUUID().slice(0, 8)}`;
      const stamp = now();
      return {
        patches: [{
          op: "add",
          nodeId: id,
          after: {
            id,
            type: NOTEBOOK_TYPE,
            parentId: null,
            order: notebooks(ctx.state).length,
            enabled: true,
            opacity: 1,
            props: { title: params.title ?? "Notebook", createdAt: stamp, updatedAt: stamp },
          },
        }],
        result: { id },
      };
    },
  });

  bus.register<{ id: string; title: string }, { id: string }>({
    name: "notebook.rename",
    title: "Rename notebook",
    description: "Rename a notebook. Notes keep their membership.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id", "title"],
      properties: { id: notebookIdParam, title: textProp("New name.") },
    },
    result: { type: "object", required: ["id"], properties: { id: notebookIdParam } },
    run(params, ctx) {
      const node = requireNode(ctx.state, params.id, "notebook");
      return {
        patches: [{
          op: "update",
          nodeId: params.id,
          after: { ...node, props: { ...node.props, title: params.title, updatedAt: now() } },
        }],
        result: { id: params.id },
      };
    },
  });

  bus.register<{ id: string }, { id: string; moved: number }>({
    name: "notebook.delete",
    title: "Delete notebook",
    description: "Delete a notebook; its notes move back to Unfiled (never deleted).",
    sideEffects: "destructive",
    reversible: true,
    params: { type: "object", required: ["id"], properties: { id: notebookIdParam } },
    result: {
      type: "object",
      required: ["id", "moved"],
      properties: { id: notebookIdParam, moved: { type: "integer", minimum: 0 } },
    },
    run(params, ctx) {
      requireNode(ctx.state, params.id, "notebook");
      const patches: Patch[] = notes(ctx.state)
        .filter((node) => str(node, "notebookId") === params.id)
        .map((node) => ({
          op: "update" as const,
          nodeId: node.id,
          after: { ...node, props: { ...node.props, notebookId: null, updatedAt: now() } },
        }));
      patches.push({ op: "remove", nodeId: params.id });
      return { patches, result: { id: params.id, moved: patches.length - 1 } };
    },
  });

  // ── notes ──────────────────────────────────────────────────────────────

  bus.register<
    { title?: string; content?: string; notebookId?: string | null; tags?: string[]; pinned?: boolean; favorite?: boolean },
    { id: string }
  >({
    name: "note.create",
    title: "Create note",
    description: "Create a new note and return its id.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      properties: {
        title: textProp('Note title; defaults to "Untitled".'),
        content: textProp("Markdown body; defaults to empty."),
        notebookId: { type: ["string", "null"], description: "Notebook to file it in (optional)." },
        tags: { type: "array", items: { type: "string" }, description: "Tags, normalised to lowercase." },
        pinned: { type: "boolean", description: "Pin the note to the top of lists." },
        favorite: { type: "boolean", description: "Mark it as a favorite." },
      },
    },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    examples: [{ params: { title: "Shopping", content: "- [ ] oat milk" } }],
    // Curated MCP shortcut (§4.4): the common case, one tool call, no describe.
    mcp: { expose: true, name: "note_create" },
    run(params, ctx) {
      const id = `note-${randomUUID().slice(0, 8)}`;
      const stamp = now();
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
              createdAt: stamp,
              updatedAt: stamp,
              notebookId: params.notebookId ?? null,
              tags: normaliseTags(params.tags ?? []),
              pinned: params.pinned ?? false,
              favorite: params.favorite ?? false,
              trashedAt: null,
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
      const node = requireNode(ctx.state, params.id, "note");
      const after = {
        ...node,
        props: {
          ...node.props,
          ...(params.title !== undefined ? { title: params.title } : {}),
          ...(params.content !== undefined ? { content: params.content } : {}),
          updatedAt: now(),
        },
      };
      return {
        patches: [{ op: "update", nodeId: params.id, after }],
        result: { id: params.id },
      };
    },
  });

  bus.register<{ id: string; content: string; separator?: string }, { id: string }>({
    name: "note.append",
    title: "Append to note",
    description: "Append markdown to the end of a note (journaling, agent logs).",
    sideEffects: "write",
    reversible: true,
    coalesce: { key: (params) => params.id, windowMs: 2000 },
    params: {
      type: "object",
      required: ["id", "content"],
      properties: {
        id: noteIdParam,
        content: textProp("Markdown to append."),
        separator: textProp('Joiner; defaults to "\\n\\n".'),
      },
    },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    mcp: { expose: true, name: "note_append" },
    run(params, ctx) {
      const node = requireNode(ctx.state, params.id, "note");
      const existing = str(node, "content");
      const separator = params.separator ?? "\n\n";
      const content = existing === "" ? params.content : `${existing}${separator}${params.content}`;
      return {
        patches: [{
          op: "update",
          nodeId: params.id,
          after: { ...node, props: { ...node.props, content, updatedAt: now() } },
        }],
        result: { id: params.id },
      };
    },
  });

  bus.register<{ id: string; title?: string }, { id: string }>({
    name: "note.duplicate",
    title: "Duplicate note",
    description: "Copy a note (title, content, notebook, tags) into a new note.",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id"],
      properties: { id: noteIdParam, title: textProp('New title; defaults to "<title> (copy)".') },
    },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    run(params, ctx) {
      const node = requireNode(ctx.state, params.id, "note");
      if (str(node, "trashedAt") !== "") {
        throw new NucleusError("validation", `note is in the trash: ${params.id}`);
      }
      const id = `note-${randomUUID().slice(0, 8)}`;
      const stamp = now();
      return {
        patches: [{
          op: "add",
          nodeId: id,
          after: {
            id,
            type: NOTE_TYPE,
            parentId: null,
            order: Object.keys(ctx.state.nodes).length,
            enabled: true,
            opacity: 1,
            props: {
              ...node.props,
              title: params.title ?? `${str(node, "title", "Untitled")} (copy)`,
              createdAt: stamp,
              updatedAt: stamp,
              trashedAt: null,
            },
          },
        }],
        result: { id },
      };
    },
  });

  bus.register<{ id: string; notebookId: string | null }, { id: string }>({
    name: "note.move",
    title: "Move note",
    description: "File a note into a notebook (null = Unfiled).",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id", "notebookId"],
      properties: {
        id: noteIdParam,
        notebookId: { type: ["string", "null"], description: "Target notebook, or null for Unfiled." },
      },
    },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    run(params, ctx) {
      const node = requireNode(ctx.state, params.id, "note");
      if (params.notebookId !== null) requireNode(ctx.state, params.notebookId, "notebook");
      return {
        patches: [{
          op: "update",
          nodeId: params.id,
          after: { ...node, props: { ...node.props, notebookId: params.notebookId, updatedAt: now() } },
        }],
        result: { id: params.id },
      };
    },
  });

  bus.register<{ id: string; pinned?: boolean; favorite?: boolean }, { id: string }>({
    name: "note.setFlags",
    title: "Pin / favorite a note",
    description: "Toggle the pinned and favorite flags (only provided flags change).",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id"],
      properties: {
        id: noteIdParam,
        pinned: { type: "boolean" },
        favorite: { type: "boolean" },
      },
    },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    run(params, ctx) {
      const node = requireNode(ctx.state, params.id, "note");
      return {
        patches: [{
          op: "update",
          nodeId: params.id,
          after: {
            ...node,
            props: {
              ...node.props,
              ...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
              ...(params.favorite !== undefined ? { favorite: params.favorite } : {}),
              updatedAt: now(),
            },
          },
        }],
        result: { id: params.id },
      };
    },
  });

  bus.register<{ id: string; tags: string[] }, { id: string; tags: string[] }>({
    name: "note.setTags",
    title: "Set note tags",
    description: "Replace a note's tags (trimmed, lowercase, deduplicated).",
    sideEffects: "write",
    reversible: true,
    params: {
      type: "object",
      required: ["id", "tags"],
      properties: {
        id: noteIdParam,
        tags: { type: "array", items: { type: "string" }, description: "Full tag list." },
      },
    },
    result: {
      type: "object",
      required: ["id", "tags"],
      properties: { id: noteIdParam, tags: { type: "array", items: { type: "string" } } },
    },
    run(params, ctx) {
      const node = requireNode(ctx.state, params.id, "note");
      const tags = normaliseTags(params.tags);
      return {
        patches: [{
          op: "update",
          nodeId: params.id,
          after: { ...node, props: { ...node.props, tags, updatedAt: now() } },
        }],
        result: { id: params.id, tags },
      };
    },
  });

  bus.register<{ id: string }, { id: string }>({
    name: "note.trash",
    title: "Move note to trash",
    description: "Soft-delete a note: it leaves the lists but stays recoverable.",
    sideEffects: "write",
    reversible: true,
    params: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    run(params, ctx) {
      const node = requireNode(ctx.state, params.id, "note");
      return {
        patches: [{
          op: "update",
          nodeId: params.id,
          after: { ...node, props: { ...node.props, trashedAt: now(), pinned: false } },
        }],
        result: { id: params.id },
      };
    },
  });

  bus.register<{ id: string }, { id: string }>({
    name: "note.restore",
    title: "Restore note",
    description: "Bring a note back from the trash.",
    sideEffects: "write",
    reversible: true,
    params: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    run(params, ctx) {
      const node = requireNode(ctx.state, params.id, "note");
      return {
        patches: [{
          op: "update",
          nodeId: params.id,
          after: { ...node, props: { ...node.props, trashedAt: null, updatedAt: now() } },
        }],
        result: { id: params.id },
      };
    },
  });

  bus.register<{ id: string }, { id: string }>({
    name: "note.purge",
    title: "Delete note permanently",
    description: "Remove a note for good. (Still one undo step away in this session.)",
    sideEffects: "destructive",
    reversible: true,
    params: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    result: { type: "object", required: ["id"], properties: { id: noteIdParam } },
    run(params, ctx) {
      requireNode(ctx.state, params.id, "note");
      return {
        patches: [{ op: "remove", nodeId: params.id }],
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
      requireNode(ctx.state, params.id, "note");
      return {
        patches: [{ op: "remove", nodeId: params.id }],
        result: { id: params.id },
      };
    },
  });

  // ── read-only ──────────────────────────────────────────────────────────

  bus.register<{ query: string; limit?: number }, { hits: NoteHit[] }>({
    name: "note.search",
    title: "Search notes",
    description: "Full-text search over titles and bodies, best matches first.",
    sideEffects: "read",
    reversible: false,
    params: {
      type: "object",
      required: ["query"],
      properties: {
        query: textProp("What to look for (case-insensitive, all terms must match)."),
        limit: { type: "integer", minimum: 1, description: "Maximum hits; defaults to 50." },
      },
    },
    result: { type: "object", required: ["hits"], properties: { hits: { type: "array" } } },
    run(params, ctx) {
      return { result: { hits: searchNotes(ctx.state, params.query, params.limit ?? 50) } };
    },
  });

  bus.register<Record<string, never>, NotesStats>({
    name: "notes.stats",
    title: "Notes statistics",
    description: "Counts and word totals for the whole notebook.",
    sideEffects: "read",
    reversible: false,
    params: { type: "object", properties: {} },
    result: { type: "object" },
    run(_params, ctx) {
      return { result: notesStats(ctx.state) };
    },
  });
}

// ── views ────────────────────────────────────────────────────────────────

export interface NoteView {
  id: string;
  title: string;
  content: string;
  snippet: string;
  createdAt: string;
  updatedAt: string;
  notebookId: string | null;
  tags: string[];
  pinned: boolean;
  favorite: boolean;
  trashedAt: string | null;
  words: number;
  readingMinutes: number;
}

export interface NotebookView {
  id: string;
  title: string;
  noteCount: number;
  updatedAt: string;
}

export interface NoteHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  notebookId: string | null;
}

export interface NotesStats {
  notes: number;
  notebooks: number;
  favorites: number;
  pinned: number;
  trashed: number;
  tags: number;
  words: number;
}

export interface NoteViewOptions {
  /** Include notes sitting in the trash (default false). */
  trashed?: boolean;
}

function snippetOf(content: string, limit = 140): string {
  return content
    .slice(0, limit)
    .replace(/[#*`>\-_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Notes ready for a UI or an agent: pinned first, then newest first. Trashed
 * notes are hidden unless asked for — they belong to the Trash view.
 */
export function noteViews(state: DocumentState, options: NoteViewOptions = {}): NoteView[] {
  return notes(state)
    .filter((node) => (options.trashed ? true : str(node, "trashedAt") === ""))
    .sort((a, b) => {
      const pinned = Number(bool(b, "pinned")) - Number(bool(a, "pinned"));
      if (pinned !== 0) return pinned;
      const aUpdated = str(a, "updatedAt");
      const bUpdated = str(b, "updatedAt");
      // newest first; tie-break on creation order (same-millisecond bursts)
      return bUpdated.localeCompare(aUpdated) || b.order - a.order;
    })
    .map((node) => {
      const content = str(node, "content");
      const words = countWords(content);
      const trashedAt = str(node, "trashedAt");
      return {
        id: node.id,
        title: str(node, "title", "Untitled"),
        content,
        snippet: snippetOf(content),
        createdAt: str(node, "createdAt"),
        updatedAt: str(node, "updatedAt"),
        notebookId: str(node, "notebookId") || null,
        tags: strings(node, "tags"),
        pinned: bool(node, "pinned"),
        favorite: bool(node, "favorite"),
        trashedAt: trashedAt === "" ? null : trashedAt,
        words,
        readingMinutes: readingMinutes(words),
      };
    });
}

/** Notebooks with their live note count (trashed notes excluded). */
export function notebookViews(state: DocumentState): NotebookView[] {
  const live = notes(state).filter((node) => str(node, "trashedAt") === "");
  return notebooks(state)
    .sort((a, b) => str(a, "title").localeCompare(str(b, "title")))
    .map((node) => ({
      id: node.id,
      title: str(node, "title", "Notebook"),
      noteCount: live.filter((note) => str(note, "notebookId") === node.id).length,
      updatedAt: str(node, "updatedAt"),
    }));
}

/** Every tag in use, with how many live notes carry it. */
export function tagViews(state: DocumentState): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const note of noteViews(state)) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * All terms must appear somewhere (title or body). Title hits score higher so
 * a note called "invoice" beats one that mentions invoices in passing.
 */
export function searchNotes(state: DocumentState, query: string, limit = 50): NoteHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return [];
  const hits: NoteHit[] = [];
  for (const note of noteViews(state)) {
    const title = note.title.toLowerCase();
    const body = note.content.toLowerCase();
    let score = 0;
    let matched = true;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inBody = body.includes(term);
      if (!inTitle && !inBody) {
        matched = false;
        break;
      }
      score += (inTitle ? 3 : 0) + (inBody ? 1 : 0);
      if (title.startsWith(term)) score += 2;
    }
    if (!matched) continue;
    hits.push({
      id: note.id,
      title: note.title,
      snippet: hitSnippet(note.content, terms[0] ?? ""),
      score,
      notebookId: note.notebookId,
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

/** A window of text around the first match, so the hit reads in context. */
function hitSnippet(content: string, term: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(term);
  if (at === -1) return snippetOf(flat);
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, at + term.length + 100);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function notesStats(state: DocumentState): NotesStats {
  const live = noteViews(state);
  const all = noteViews(state, { trashed: true });
  return {
    notes: live.length,
    notebooks: notebookViews(state).length,
    favorites: live.filter((note) => note.favorite).length,
    pinned: live.filter((note) => note.pinned).length,
    trashed: all.length - live.length,
    tags: tagViews(state).length,
    words: live.reduce((total, note) => total + note.words, 0),
  };
}

/** All live notes as one Markdown document, grouped by notebook. */
export function exportNotesMarkdown(state: DocumentState): string {
  const books = new Map(notebookViews(state).map((book) => [book.id, book.title]));
  const groups = new Map<string, NoteView[]>();
  for (const note of noteViews(state)) {
    const key = note.notebookId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  const sections: string[] = [];
  for (const [key, group] of groups) {
    const heading = key === "" ? "Unfiled" : (books.get(key) ?? "Notebook");
    sections.push(`# ${heading}\n`);
    for (const note of group) {
      const tags = note.tags.length > 0 ? `\n\n_Tags: ${note.tags.join(", ")}_` : "";
      sections.push(`## ${note.title}\n\n${note.content}${tags}`);
    }
  }
  return sections.join("\n\n---\n\n");
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
