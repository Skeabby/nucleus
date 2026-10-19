/**
 * Proposals: agents ask, humans decide (brief §3.2).
 *
 * An agent command is *not* applied silently: the bus runs it dry, stores the
 * patches plus a snapshot of every touched node, and hands back an id. A human
 * accepts (applying it as a normal, undoable entry) or rejects it. Accepting
 * re-checks staleness — if anyone touched the same nodes since, the proposal
 * is `stale` and the agent gets `kind: "conflict"` so it can re-plan.
 */
import type { Actor, Patch, CommandDescriptor, SideEffects } from "./command.js";
import type { Node } from "./document.js";

export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale";

/** A dry-run agent command awaiting a human decision. */
export interface Proposal {
  id: string;
  ts: string;
  actor: Actor;
  label?: string;
  command: string;
  params?: unknown;
  /** Forward patches to apply on accept. */
  patches: Patch[];
  /** The dry-run result (info for the review UI). */
  result?: unknown;
  /** docVersion at proposal time. */
  baseVersion: number;
  /**
   * Node content snapshot per touched id, taken when the proposal was made.
   * `null` = the node did not exist yet (pure adds must stay impossible to
   * satisfy some other way).
   */
  touched: Record<string, Node | null>;
  status: ProposalStatus;
}

/** Per-document trust policy for agent actors (settings land with app-kit). */
export type TrustLevel = "ask" | "writes" | "autopilot";

/**
 * Does this invocation need human review before it may apply? Read commands
 * never do; destructive commands always do — even in autopilot ("never
 * silently destroy"); everything else follows the document trust level.
 */
export function needsReview(
  actor: Actor,
  descriptor: Pick<CommandDescriptor, "sideEffects">,
  trust: TrustLevel,
): boolean {
  if (actor.kind !== "agent") return false;
  const kind: SideEffects = descriptor.sideEffects;
  if (kind === "read") return false;
  if (kind === "destructive") return true;
  return trust === "ask";
}
