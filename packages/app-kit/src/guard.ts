/**
 * Request guard for every Nucleus app HTTP surface (lifted from the two apps,
 * fixing F5/F6 once instead of twice).
 *
 * The server binds 127.0.0.1 only, but a localhost port is still reachable by
 * any page in the user's browser (and by DNS-rebinding tricks). This guard
 * enforces the minimum: correct Host, same-origin (or no Origin), a safe
 * content-type on writes, and a per-launch bearer token or `nt` cookie.
 *
 * Pure over `IncomingMessage`-shaped data so it stays unit-testable without
 * sockets.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface GuardOptions {
  /** Port the server is bound to (used to build the allowed Host values). */
  port: number;
  /** Per-launch secret. Empty string disables the token check. */
  token: string;
}

export interface GuardRejection {
  status: number;
  error: string;
}

export const OK_METHODS = ["GET", "HEAD"] as const;

/** Bodies may be JSON, raw PDF (binary upload) or generic bytes (SSE is read-only anyway). */
export const OK_CONTENT_TYPES = /^application\/(json|pdf|octet-stream)(;|$)/;

/**
 * Decide whether a request may proceed. Returns a rejection (status + message)
 * or `null` when the request is allowed.
 */
export function checkRequest(
  req: Pick<IncomingMessage, "headers" | "method">,
  { port, token }: GuardOptions,
): GuardRejection | null {
  const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = String(req.headers.host ?? "");
  if (!okHosts.includes(host)) return { status: 403, error: "bad host" };

  const origin = req.headers.origin;
  if (origin && !okHosts.some((h) => origin === `http://${h}`)) {
    return { status: 403, error: "bad origin" };
  }

  const method = req.method ?? "GET";
  if (!OK_METHODS.includes(method as "GET" | "HEAD")) {
    const ct = String(req.headers["content-type"] ?? "");
    if (!OK_CONTENT_TYPES.test(ct)) {
      return { status: 415, error: "bad content-type" };
    }
  }

  if (token !== "") {
    const auth = String(req.headers.authorization ?? "");
    const bearer = auth.startsWith("Bearer ") && auth.slice(7) === token;
    const cookie = String(req.headers.cookie ?? "");
    const match = /(?:^|;\s*)nt=([^;]+)/.exec(cookie);
    const cookieOk = match !== null && decodeURIComponent(match[1] ?? "") === token;
    if (!bearer && !cookieOk) return { status: 401, error: "missing token" };
  }

  return null;
}

/** True when the request passes; otherwise writes a JSON error and returns false. */
export function guard(
  req: IncomingMessage,
  res: ServerResponse,
  options: GuardOptions,
): boolean {
  const rejection = checkRequest(req, options);
  if (rejection) {
    res.writeHead(rejection.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: rejection.error }));
    return false;
  }
  return true;
}

/** The cookie we adopt `?t=<token>` into (HttpOnly, so scripts can't read it). */
export function tokenCookie(token: string): string {
  return `nt=${token}; HttpOnly; SameSite=Strict; Path=/`;
}
