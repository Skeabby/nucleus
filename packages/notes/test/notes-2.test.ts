import { describe, expect, it } from "vitest";

import { NucleusError } from "@nucleus/core";
import {
  countWords,
  createNotesSession,
  exportNotesMarkdown,
  noteViews,
  notebookViews,
  normaliseTags,
  notesStats,
  searchNotes,
  tagViews,
  type NotesSession,
} from "../src/index.js";

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { kind: string; message: string };
}

/** Invoke a command and unwrap the control envelope (throws on failure). */
function run<T = any>(session: NotesSession, name: string, params: unknown = {}): T {
  const response = session.control.handle({
    method: "command.invoke",
    params: { name, params },
  }) as Envelope;
  if (!response.ok) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
  return (response.result as { result: T }).result;
}

describe("@nucleus/notes 2.0: notebooks", () => {
  it("creates, renames and counts notebooks", () => {
    const session = createNotesSession();
    const work = run<{ id: string }>(session, "notebook.create", { title: "Work" });
    run(session, "notebook.create", { title: "Archive" });
    expect(notebookViews(session.doc).map((book) => book.title)).toEqual(["Archive", "Work"]);

    run(session, "notebook.rename", { id: work.id, title: "Day job" });
    expect(notebookViews(session.doc).map((book) => book.title)).toEqual(["Archive", "Day job"]);

    run(session, "note.create", { title: "Standup", notebookId: work.id });
    expect(notebookViews(session.doc).find((book) => book.id === work.id)?.noteCount).toBe(1);
  });

  it("deleting a notebook unfiles its notes instead of deleting them", () => {
    const session = createNotesSession();
    const book = run<{ id: string }>(session, "notebook.create", { title: "Temp" });
    const note = run<{ id: string }>(session, "note.create", { title: "Keep me", notebookId: book.id });

    const deleted = run<{ moved: number }>(session, "notebook.delete", { id: book.id });
    expect(deleted.moved).toBe(1);
    expect(notebookViews(session.doc)).toHaveLength(0);
    const view = noteViews(session.doc).find((entry) => entry.id === note.id);
    expect(view?.notebookId).toBeNull();

    // and it is one undo step: the notebook and its membership are back
    session.control.handle({ method: "history.undo" });
    expect(notebookViews(session.doc)).toHaveLength(1);
    expect(noteViews(session.doc)[0]?.notebookId).toBe(book.id);
  });

  it("refuses a note in a notebook that does not exist", () => {
    const session = createNotesSession();
    const note = run<{ id: string }>(session, "note.create", {});
    const response = session.control.handle({
      method: "command.invoke",
      params: { name: "note.move", params: { id: note.id, notebookId: "nb-nope" } },
    }) as Envelope;
    expect(response.error?.kind).toBe("not_found");
    expect(NucleusError.name).toBe("NucleusError");
  });
});

describe("@nucleus/notes 2.0: tags and flags", () => {
  it("normalises tags on create and on setTags", () => {
    const session = createNotesSession();
    const note = run<{ id: string }>(session, "note.create", { tags: ["  Work ", "work", "Idées"] });
    expect(noteViews(session.doc)[0]?.tags).toEqual(["work", "idées"]);

    const updated = run<{ tags: string[] }>(session, "note.setTags", {
      id: note.id,
      tags: ["Urgent", "", "urgent", "  "],
    });
    expect(updated.tags).toEqual(["urgent"]);
    expect(normaliseTags(["A", "a", " b "])).toEqual(["a", "b"]);
  });

  it("pins first, then newest first", async () => {
    const session = createNotesSession();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const old = run<{ id: string }>(session, "note.create", { title: "OLD" });
    await tick();
    const fresh = run<{ id: string }>(session, "note.create", { title: "NEW" });
    expect(noteViews(session.doc).map((note) => note.title)).toEqual(["NEW", "OLD"]);

    await tick();
    run(session, "note.setFlags", { id: old.id, pinned: true, favorite: true });
    expect(noteViews(session.doc).map((note) => note.title)).toEqual(["OLD", "NEW"]);
    expect(notesStats(session.doc).pinned).toBe(1);
    expect(notesStats(session.doc).favorites).toBe(1);

    // Unpinning does not move it back: the most recent edit wins (it was OLD).
    await tick();
    run(session, "note.setFlags", { id: old.id, pinned: false });
    expect(noteViews(session.doc).map((note) => note.title)).toEqual(["OLD", "NEW"]);
    // ...so touch NEW and it takes the front seat.
    await tick();
    run(session, "note.update", { id: fresh.id, content: "newer" });
    expect(noteViews(session.doc).map((note) => note.title)).toEqual(["NEW", "OLD"]);
  });

  it("counts tags across live notes only", () => {
    const session = createNotesSession();
    run(session, "note.create", { title: "A", tags: ["work", "spec"] });
    const b = run<{ id: string }>(session, "note.create", { title: "B", tags: ["work"] });
    run(session, "note.trash", { id: b.id });
    expect(tagViews(session.doc)).toEqual([{ tag: "spec", count: 1 }, { tag: "work", count: 1 }]);
  });
});

describe("@nucleus/notes 2.0: trash", () => {
  it("trash hides, restore brings back, purge removes", () => {
    const session = createNotesSession();
    const note = run<{ id: string }>(session, "note.create", { title: "Doomed" });

    run(session, "note.trash", { id: note.id });
    expect(noteViews(session.doc)).toHaveLength(0);
    expect(noteViews(session.doc, { trashed: true })).toHaveLength(1);
    expect(noteViews(session.doc, { trashed: true })[0]?.trashedAt).toBeTruthy();
    expect(notesStats(session.doc).trashed).toBe(1);

    run(session, "note.restore", { id: note.id });
    expect(noteViews(session.doc)).toHaveLength(1);
    expect(notesStats(session.doc).trashed).toBe(0);

    run(session, "note.purge", { id: note.id });
    expect(noteViews(session.doc, { trashed: true })).toHaveLength(0);
    // even a purge is one undo step in-session
    session.control.handle({ method: "history.undo" });
    expect(noteViews(session.doc)).toHaveLength(1);
  });

  it("refuses to duplicate a trashed note", () => {
    const session = createNotesSession();
    const note = run<{ id: string }>(session, "note.create", { title: "Gone" });
    run(session, "note.trash", { id: note.id });
    const response = session.control.handle({
      method: "command.invoke",
      params: { name: "note.duplicate", params: { id: note.id } },
    }) as Envelope;
    expect(response.error?.kind).toBe("validation");
    expect(response.error?.message).toContain("trash");
  });
});

describe("@nucleus/notes 2.0: composing", () => {
  it("appends with a separator and coalesces with update", () => {
    const session = createNotesSession();
    const note = run<{ id: string }>(session, "note.create", { title: "Log", content: "day one" });
    run(session, "note.append", { id: note.id, content: "day two" });
    expect(noteViews(session.doc)[0]?.content).toBe("day one\n\nday two");
    run(session, "note.append", { id: note.id, content: "day three", separator: " | " });
    expect(noteViews(session.doc)[0]?.content).toBe("day one\n\nday two | day three");
  });

  it("appends to an empty note without a leading separator", () => {
    const session = createNotesSession();
    const note = run<{ id: string }>(session, "note.create", {});
    run(session, "note.append", { id: note.id, content: "first" });
    expect(noteViews(session.doc)[0]?.content).toBe("first");
  });

  it("duplicates content, notebook and tags with a (copy) title", () => {
    const session = createNotesSession();
    const book = run<{ id: string }>(session, "notebook.create", { title: "Inbox" });
    const note = run<{ id: string }>(session, "note.create", {
      title: "Ideas",
      content: "- ship",
      notebookId: book.id,
      tags: ["m4"],
    });
    const copy = run<{ id: string }>(session, "note.duplicate", { id: note.id });
    const view = noteViews(session.doc).find((entry) => entry.id === copy.id);
    expect(view?.title).toBe("Ideas (copy)");
    expect(view?.content).toBe("- ship");
    expect(view?.notebookId).toBe(book.id);
    expect(view?.tags).toEqual(["m4"]);
    expect(view?.pinned).toBe(false);
  });

  it("moves a note between notebooks and back to Unfiled", () => {
    const session = createNotesSession();
    const book = run<{ id: string }>(session, "notebook.create", { title: "Work" });
    const note = run<{ id: string }>(session, "note.create", {});
    run(session, "note.move", { id: note.id, notebookId: book.id });
    expect(noteViews(session.doc)[0]?.notebookId).toBe(book.id);
    run(session, "note.move", { id: note.id, notebookId: null });
    expect(noteViews(session.doc)[0]?.notebookId).toBeNull();
  });
});

describe("@nucleus/notes 2.0: search and stats", () => {
  it("ranks title hits above body hits and requires every term", () => {
    const session = createNotesSession();
    run(session, "note.create", { title: "Invoice March", content: "paid" });
    run(session, "note.create", { title: "Random", content: "an invoice was mentioned here" });
    run(session, "note.create", { title: "Unrelated", content: "nothing to see" });

    const hits = searchNotes(session.doc, "invoice");
    expect(hits.map((hit) => hit.title)).toEqual(["Invoice March", "Random"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);

    const both = searchNotes(session.doc, "invoice march");
    expect(both.map((hit) => hit.title)).toEqual(["Invoice March"]);
    expect(searchNotes(session.doc, "")).toEqual([]);
  });

  it("snippets read in context around the match", () => {
    const session = createNotesSession();
    run(session, "note.create", {
      title: "Long",
      content: `${"filler ".repeat(30)}needle${" more".repeat(30)}`,
    });
    const [hit] = searchNotes(session.doc, "needle");
    expect(hit?.snippet).toContain("needle");
    expect(hit?.snippet.startsWith("…")).toBe(true);
    expect(hit?.snippet.endsWith("…")).toBe(true);
  });

  it("stats cover every counter the UI shows", () => {
    const session = createNotesSession();
    const book = run<{ id: string }>(session, "notebook.create", { title: "B" });
    run(session, "note.create", { title: "One", content: "alpha beta gamma", notebookId: book.id, tags: ["x"] });
    const two = run<{ id: string }>(session, "note.create", { title: "Two", content: "delta" });
    run(session, "note.setFlags", { id: two.id, pinned: true });
    run(session, "note.create", { title: "Three" });
    run(session, "note.trash", { id: two.id });

    expect(notesStats(session.doc)).toEqual({
      notes: 2,
      notebooks: 1,
      favorites: 0,
      pinned: 0,
      trashed: 1,
      tags: 1,
      words: 3,
    });
  });

  it("counts words without markdown noise", () => {
    expect(countWords("# Title\n\n- one\n- two")).toBe(3);
    expect(countWords("```js\nconst x = 1;\n```\nreal words here")).toBe(3);
    expect(countWords("[link](https://example.com) tail")).toBe(2);
    expect(countWords("")).toBe(0);
  });
});

describe("@nucleus/notes 2.0: export and schemas", () => {
  it("exports grouped by notebook, trashed notes excluded", () => {
    const session = createNotesSession();
    const book = run<{ id: string }>(session, "notebook.create", { title: "Work" });
    run(session, "note.create", { title: "Filed", content: "body", notebookId: book.id, tags: ["spec"] });
    run(session, "note.create", { title: "Loose", content: "other" });
    const gone = run<{ id: string }>(session, "note.create", { title: "Gone", content: "nope" });
    run(session, "note.trash", { id: gone.id });

    const markdown = exportNotesMarkdown(session.doc);
    expect(markdown).toContain("# Unfiled");
    expect(markdown).toContain("# Work");
    expect(markdown).toContain("## Filed");
    expect(markdown).toContain("_Tags: spec_");
    expect(markdown).not.toContain("Gone");
  });

  it("every command ships params and result schemas (F11)", () => {
    const session = createNotesSession();
    const names = [
      "notebook.create",
      "notebook.rename",
      "notebook.delete",
      "note.create",
      "note.update",
      "note.append",
      "note.duplicate",
      "note.move",
      "note.setFlags",
      "note.setTags",
      "note.trash",
      "note.restore",
      "note.purge",
      "note.delete",
      "note.search",
      "notes.stats",
    ];
    for (const name of names) {
      const descriptor = session.bus.describe(name);
      expect(descriptor.params, `${name} params schema`).toBeDefined();
      expect(descriptor.result, `${name} result schema`).toBeDefined();
    }
  });

  it("read-only commands are never journaled", () => {
    const session = createNotesSession();
    run(session, "note.create", { title: "One" });
    const before = session.bus.tapeRecords().length;
    run(session, "notes.stats");
    run(session, "note.search", { query: "one" });
    expect(session.bus.tapeRecords().length).toBe(before);
  });
});
