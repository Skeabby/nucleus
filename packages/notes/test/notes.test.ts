import { describe, expect, it } from "vitest";

import {
  CommandBus,
  createDocument,
  registerCoreCommands,
  NucleusError,
} from "@nucleus/core";
import { ControlServer } from "@nucleus/control";
import {
  createNotesSession,
  noteViews,
  registerNoteCommands,
  NOTES_APP_ID,
} from "../src/index.js";

describe("@nucleus/notes (M1): commands with schemas", () => {
  it("every registered command exposes a params schema (F11 acceptance)", () => {
    const session = createNotesSession();
    for (const name of ["note.create", "note.update", "note.delete"]) {
      const descriptor = session.bus.describe(name);
      expect(descriptor.params, `${name} has a params schema`).toBeDefined();
      expect(descriptor.result, `${name} has a result schema`).toBeDefined();
    }
    // and the core pack does too
    expect(session.bus.describe("doc.addNode").params?.required).toEqual(["type"]);
  });

  it("create → update → delete roundtrip with undo", () => {
    const session = createNotesSession();
    const created = session.control.handle({
      method: "command.invoke",
      params: { name: "note.create", params: { title: "First", content: "hello" } },
    });
    expect(created.ok).toBe(true);
    const id = (created.result as { result: { id: string } }).result.id;
    expect(noteViews(session.doc)).toHaveLength(1);

    const updated = session.control.handle({
      method: "command.invoke",
      params: { name: "note.update", params: { id, content: "hello world" } },
    });
    expect(updated.ok).toBe(true);
    expect(noteViews(session.doc)[0]?.content).toBe("hello world");

    // validation comes from the schema (F11), not from lucky params
    const bad = session.control.handle({
      method: "command.invoke",
      params: { name: "note.update", params: { content: "no id" } },
    });
    expect(bad.error?.kind).toBe("validation");

    session.control.handle({
      method: "command.invoke",
      params: { name: "note.delete", params: { id } },
    });
    expect(noteViews(session.doc)).toHaveLength(0);
    // everything is undoable, delete included
    expect(session.control.handle({ method: "history.undo" }).result.undone).toBe(true);
    expect(noteViews(session.doc)).toHaveLength(1);
  });

  it("agent writes are proposed under trust=ask, accepted on demand", () => {
    const session = createNotesSession();
    const proposed = session.control.handle({
      method: "command.invoke",
      params: {
        name: "note.create",
        params: { title: "From agent" },
        actor: { kind: "agent", id: "opencode" },
      },
    });
    expect((proposed.result as { status?: string }).status).toBe("proposed");
    const id = (proposed.result as { proposalId: string }).proposalId;
    expect(noteViews(session.doc)).toHaveLength(0);
    expect(session.control.handle({ method: "proposal.accept", params: { id } }).ok).toBe(true);
    expect(noteViews(session.doc)).toHaveLength(1);
  });

  it("the coalesce burst of note.update is ONE undo step (F2)", () => {
    const doc = createDocument(NOTES_APP_ID);
    const bus = new CommandBus();
    registerCoreCommands(bus);
    registerNoteCommands(bus);
    const control = new ControlServer(bus, doc);
    const id = (
      control.handle({ method: "command.invoke", params: { name: "note.create", params: {} } })
        .result as { result: { id: string } }
    ).result.id;
    for (let i = 0; i < 5; i++) {
      control.handle({
        method: "command.invoke",
        params: { name: "note.update", params: { id, content: "v".repeat(i + 1) } },
      });
    }
    let undoSteps = 0;
    while ((control.handle({ method: "history.undo" }).result as { undone: boolean }).undone) {
      undoSteps++;
    }
    // create + the whole typing burst = 2 steps, not 7 (F2 fixed for good)
    expect(undoSteps).toBe(2);
    expect(doc.nodes[id]).toBeUndefined(); // fully undone: the burst rewound too
  });

  it("newest-first list (F1 stays fixed)", () => {
    const session = createNotesSession();
    const first = session.control.handle({
      method: "command.invoke",
      params: { name: "note.create", params: { title: "OLD" } },
    });
    const second = session.control.handle({
      method: "command.invoke",
      params: { name: "note.create", params: { title: "NEW" } },
    });
    expect(first.ok && second.ok).toBe(true);
    expect(noteViews(session.doc).map((n) => n.title)).toEqual(["NEW", "OLD"]);
  });

  it("deleting an unknown note is a structured not_found", () => {
    const session = createNotesSession();
    const response = session.control.handle({
      method: "command.invoke",
      params: { name: "note.delete", params: { id: "nope" } },
    });
    expect(response.error?.kind).toBe("not_found");
    expect(NucleusError.name).toBe("NucleusError");
  });
});
