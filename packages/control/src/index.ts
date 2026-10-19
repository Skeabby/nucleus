import {
  CommandBus,
  NucleusError,
  needsReview,
  tapeStateAt,
  replayTape,
  type Actor,
  type DocumentState,
  type ErrorKind,
  type InvokeOptions,
  type TapeRecord,
  type TrustLevel,
} from "@nucleus/core";

/**
 * Transport-agnostic control surface. CLI, JSON-RPC and MCP frontends are all
 * thin adapters over `handle()`. No business logic lives in a frontend.
 */
export interface ControlRequest {
  method: string;
  params?: unknown;
}

export interface ControlFailure {
  kind: ErrorKind;
  message: string;
}

export interface ControlResponse {
  ok: boolean;
  result?: unknown;
  error?: ControlFailure;
}

export interface ControlServerOptions {
  /** Agent trust policy for this document (default "ask": writes are reviewed). */
  trust?: TrustLevel;
}

/** An actor arriving over JSON: `{ kind, id, session? }` — validated. */
function toActor(value: unknown): Actor | undefined {
  if (value === undefined) return undefined;
  const candidate = value as { kind?: unknown; id?: unknown; session?: unknown };
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new NucleusError("validation", "actor requires a non-empty string id");
  }
  if (candidate.kind !== "human" && candidate.kind !== "agent" && candidate.kind !== "system") {
    throw new NucleusError("validation", 'actor.kind must be "human", "agent" or "system"');
  }
  return {
    kind: candidate.kind,
    id: candidate.id,
    ...(typeof candidate.session === "string" ? { session: candidate.session } : {}),
  };
}

export class ControlServer {
  readonly #bus: CommandBus;
  readonly #state: DocumentState;
  readonly #trust: TrustLevel;

  constructor(bus: CommandBus, state: DocumentState, options: ControlServerOptions = {}) {
    this.#bus = bus;
    this.#state = state;
    this.#trust = options.trust ?? "ask";
  }

  get bus(): CommandBus {
    return this.#bus;
  }

  get state(): DocumentState {
    return this.#state;
  }

  handle(request: ControlRequest): ControlResponse {
    try {
      switch (request.method) {
        case "command.list":
          return { ok: true, result: this.#bus.list() };

        case "command.describe": {
          const name = (request.params as { name?: string } | undefined)?.name;
          if (!name) throw new NucleusError("validation", "command.describe requires params.name");
          const d = this.#bus.describe(name);
          return {
            ok: true,
            result: {
              name: d.name,
              title: d.title,
              description: d.description,
              sideEffects: d.sideEffects,
              reversible: d.reversible ?? true,
              params: d.params,
              result: d.result,
              examples: d.examples,
              mcp: d.mcp,
            },
          };
        }

        case "command.invoke": {
          const body = (request.params ?? {}) as {
            name?: string;
            params?: unknown;
            coalesceKey?: string;
            dryRun?: boolean;
            label?: string;
            expectedDocVersion?: number;
            actor?: unknown;
          };
          if (!body.name) throw new NucleusError("validation", "command.invoke requires params.name");
          const actor = toActor(body.actor);
          const options: InvokeOptions = {
            ...(actor ? { actor } : {}),
            ...(body.dryRun ? { dryRun: true } : {}),
            ...(body.label !== undefined ? { label: body.label } : {}),
            ...(body.expectedDocVersion !== undefined
              ? { expectedDocVersion: body.expectedDocVersion }
              : {}),
            ...(body.coalesceKey !== undefined ? { coalesceKey: body.coalesceKey } : {}),
          };
          // Agent + review policy → the command becomes a Proposal (§3.2).
          if (actor && needsReview(actor, this.#bus.describe(body.name), this.#trust)) {
            const proposal = this.#bus.propose(body.name, this.#state, body.params, actor, body.label);
            return {
              ok: true,
              result: {
                status: "proposed",
                proposalId: proposal.id,
                command: proposal.command,
                touchedNodeIds: Object.keys(proposal.touched),
              },
            };
          }
          return { ok: true, result: this.#bus.invoke(body.name, this.#state, body.params, options) };
        }

        case "proposal.list":
          return {
            ok: true,
            result: {
              proposals: this.#bus.proposals().map((proposal) => ({
                id: proposal.id,
                status: proposal.status,
                command: proposal.command,
                actor: proposal.actor,
                label: proposal.label,
                baseVersion: proposal.baseVersion,
                touchedNodeIds: Object.keys(proposal.touched),
              })),
            },
          };

        case "proposal.accept": {
          const id = (request.params as { id?: string } | undefined)?.id;
          if (!id) throw new NucleusError("validation", "proposal.accept requires params.id");
          return { ok: true, result: this.#bus.acceptProposal(id, this.#state) };
        }

        case "proposal.reject": {
          const id = (request.params as { id?: string } | undefined)?.id;
          if (!id) throw new NucleusError("validation", "proposal.reject requires params.id");
          this.#bus.rejectProposal(id);
          return { ok: true, result: { rejected: id } };
        }

        case "proposal.acceptAll": {
          const pending = this.#bus.proposals().filter((proposal) => proposal.status === "pending");
          const accepted: string[] = [];
          for (const proposal of pending) {
            this.#bus.acceptProposal(proposal.id, this.#state);
            accepted.push(proposal.id);
          }
          return { ok: true, result: { accepted } };
        }

        case "tape.list":
          return { ok: true, result: { records: this.#bus.tapeRecords() } };

        case "tape.seek": {
          const seq = (request.params as { seq?: number } | undefined)?.seq;
          if (typeof seq !== "number") {
            throw new NucleusError("validation", "tape.seek requires params.seq");
          }
          const preview = tapeStateAt(this.#state.appId, this.#bus.tapeRecords(), seq);
          return { ok: true, result: { seq, preview } };
        }

        case "tape.fork": {
          const seq = (request.params as { seq?: number } | undefined)?.seq;
          if (typeof seq !== "number") {
            throw new NucleusError("validation", "tape.fork requires params.seq");
          }
          const records = this.#bus.tapeRecords().filter((r: TapeRecord) => r.seq <= seq);
          return { ok: true, result: { appId: this.#state.appId, state: replayTape(this.#state.appId, records) } };
        }

        case "tape.restore": {
          const seq = (request.params as { seq?: number } | undefined)?.seq;
          if (typeof seq !== "number") {
            throw new NucleusError("validation", "tape.restore requires params.seq");
          }
          const caller = toActor((request.params as { actor?: unknown } | undefined)?.actor);
          return {
            ok: true,
            result: this.#bus.invoke(
              "tape.restore",
              this.#state,
              { seq },
              { ...(caller ? { actor: caller } : {}), label: "Restore here" },
            ),
          };
        }

        case "doc.get":
          return { ok: true, result: this.#state };

        case "doc.snapshot":
          return {
            ok: true,
            result: {
              state: this.#state,
              tape: {
                length: this.#bus.tapeRecords().length,
                lastSeq: this.#bus.tapeRecords().at(-1)?.seq ?? 0,
              },
            },
          };

        case "history.status":
          return { ok: true, result: { canUndo: this.#bus.canUndo(), canRedo: this.#bus.canRedo() } };

        case "history.undo":
          return { ok: true, result: { undone: this.#bus.undo(this.#state), docVersion: this.#state.docVersion } };

        case "history.redo":
          return { ok: true, result: { redone: this.#bus.redo(this.#state), docVersion: this.#state.docVersion } };

        default:
          throw new NucleusError("not_found", `unknown method: ${request.method}`);
      }
    } catch (error) {
      const nucleusError =
        error instanceof NucleusError
          ? error
          : new NucleusError("internal", error instanceof Error ? error.message : String(error));
      return { ok: false, error: { kind: nucleusError.kind, message: nucleusError.message } };
    }
  }
}
