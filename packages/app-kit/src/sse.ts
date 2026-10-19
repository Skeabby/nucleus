/**
 * Server-Sent Events hub — zero dependency (F14). Every connected browser tab
 * gets `command`, `proposal` and `state` frames, plus a 15 s heartbeat so
 * proxies keep the connection open.
 */
import type { ServerResponse } from "node:http";

export const SSE_HEARTBEAT_MS = 15_000;

export class SseHub {
  readonly #clients = new Set<ServerResponse>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  /** Attach a response as an SSE stream. Returns a cleanup closure. */
  connect(res: ServerResponse): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`retry: 2000\n:${new Date().toISOString()} connected\n\n`);
    this.#clients.add(res);
    this.#startHeartbeat();
    return () => {
      this.#clients.delete(res);
      if (this.#clients.size === 0) this.#stopHeartbeat();
    };
  }

  broadcast(type: string, payload: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...this.#clients]) {
      client.write(frame);
    }
  }

  clientCount(): number {
    return this.#clients.size;
  }

  close(): void {
    for (const client of [...this.#clients]) {
      client.end();
    }
    this.#clients.clear();
    this.#stopHeartbeat();
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) return;
    const beat = `event: heartbeat\ndata: {}\n\n`;
    this.#heartbeat = setInterval(() => {
      for (const client of [...this.#clients]) {
        client.write(beat);
      }
    }, SSE_HEARTBEAT_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }
}
