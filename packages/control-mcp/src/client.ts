/**
 * One HTTP client per running app: the proxy never links the app packages, it
 * talks to the app's own `/api/*` surface with the per-launch bearer token the
 * launcher put in the registry (§4.4). Everything an app accepts is therefore
 * exactly what a human clicking in the UI would send.
 */
import type { RunningApp } from "./registry.js";

/** Who did it. The review policy keys off `kind` (§3.2). */
export interface Actor {
  kind: "human" | "agent";
  id: string;
}

/** One command as `/api/describe` reports it. */
export interface CommandDescription {
  name: string;
  title?: string;
  description?: string;
  sideEffects?: string;
  reversible?: boolean;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  examples?: unknown[];
  mcp?: { expose?: boolean; name?: string };
}

/** `/api/describe` payload. */
export interface DescribeResponse {
  app?: { id?: string; name?: string };
  commands: CommandDescription[];
}

/** One tape record (provenance + patches). */
export interface TapeRecord {
  seq: number;
  ts?: string;
  actor?: Actor;
  label?: string;
  command?: string;
  docVersionAfter?: number;
}

/** One proposal as `/api/proposals` reports it. */
export interface Proposal {
  id: string;
  status: string;
  command: string;
  actor?: Actor;
  label?: string;
  baseVersion?: number;
  touchedNodeIds?: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** A launch-readiness probe for `nucleus_apps` must stay snappy. */
const SUMMARY_TIMEOUT_MS = 2_500;

/** Raised for any non-2xx answer; the message names the app and the status. */
export class AppError extends Error {
  constructor(
    readonly appId: string,
    message: string,
  ) {
    super(`app ${appId}: ${message}`);
    this.name = "AppError";
  }
}

export class AppClient {
  readonly app: RunningApp;

  constructor(app: RunningApp) {
    this.app = app;
  }

  get id(): string {
    return this.app.id;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.app.port ?? 0}`;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.app.token) headers.authorization = `Bearer ${this.app.token}`;
    return headers;
  }

  async #json<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.#headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AppError(this.id, `unreachable (${reason})`);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new AppError(this.id, `invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error?: unknown }).error)
          : `HTTP ${response.status}`;
      throw new AppError(this.id, message);
    }
    return body as T;
  }

  /** Every command the app registers, with its param schema. */
  async describe(): Promise<DescribeResponse> {
    return this.#json<DescribeResponse>("/api/describe");
  }

  /** Cheapest readiness check: the app answers with its snapshot. */
  async state(): Promise<Record<string, unknown>> {
    const body = await this.#json<Record<string, unknown>>("/api/state", {}, SUMMARY_TIMEOUT_MS);
    return body;
  }

  /**
   * Invoke one command as an agent. The app applies its own review policy, so
   * the answer is either the command result or `{ status: "proposed" }`.
   */
  async invoke(
    command: string,
    params: unknown,
    actor: Actor,
    label?: string,
  ): Promise<unknown> {
    const body = await this.#json<{ result?: unknown }>("/api/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: command,
        params: params ?? {},
        actor,
        ...(label !== undefined ? { label } : {}),
      }),
    });
    return body.result ?? body;
  }

  /** Pending (and recently decided) proposals. */
  async proposals(): Promise<Proposal[]> {
    const body = await this.#json<{ proposals?: Proposal[] }>("/api/proposals");
    return body.proposals ?? [];
  }

  /** The append-only tape, newest last. */
  async tape(): Promise<TapeRecord[]> {
    const body = await this.#json<{ records?: TapeRecord[] }>("/api/tape");
    return body.records ?? [];
  }

  /** Undo one step; `undone: false` means there was nothing to undo. */
  async undo(): Promise<boolean> {
    const body = await this.#json<{ undone?: boolean }>("/api/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return body.undone === true;
  }
}
