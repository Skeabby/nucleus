/**
 * Minimal MCP server: JSON-RPC 2.0 over stdio, no dependencies.
 *
 * The client's `initialize` names itself; that name becomes the actor id on
 * every invoke, so the apps' review policy and the tape can tell an agent from
 * a human (§4.4).
 */
import type { Actor, AppClient } from "./client.js";
import { callTool, describeError, listTools, type ToolContext } from "./tools.js";

/** Protocol revision this server speaks. */
export const PROTOCOL_VERSION = "2025-06-18";

interface Request {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ServerOptions {
  /** Fresh clients per request: the launcher may have started/stopped apps. */
  clients: () => AppClient[];
  /** Where JSON-RPC lines go (stdout in production, a buffer in tests). */
  write?: (line: string) => void;
}

export interface Server {
  /** Feed one decoded JSON-RPC message. */
  handle(message: Request): Promise<void>;
  /** The actor derived from `initialize` (defaults to a generic agent). */
  actor(): Actor;
}

export function createServer(options: ServerOptions): Server {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  let actor: Actor = { kind: "agent", id: "nucleus-mcp" };

  const send = (message: unknown) => write(JSON.stringify(message));
  const reply = (id: unknown, result: unknown) =>
    send({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, message: string) =>
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: message }], isError: true },
    });

  const context = (): ToolContext => ({ clients: options.clients(), actor });

  return {
    actor: () => actor,
    async handle(message: Request): Promise<void> {
      const { id, method, params } = message;

      if (method === "initialize") {
        const info = (params?.clientInfo ?? {}) as { name?: unknown; version?: unknown };
        const name = typeof info.name === "string" && info.name !== "" ? info.name : "mcp";
        actor = { kind: "agent", id: name };
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "nucleus-mcp", version: "1.0.0" },
        });
        return;
      }

      if (method === "notifications/initialized" || method === "notifications/cancelled") {
        return;
      }

      if (method === "ping") {
        reply(id, {});
        return;
      }

      if (method === "tools/list") {
        const tools = await listTools(context());
        reply(id, { tools });
        return;
      }

      if (method === "tools/call") {
        const name = String(params?.name ?? "");
        const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
        try {
          const result = await callTool(name, args, context());
          reply(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (error) {
          fail(id, describeError(error));
        }
        return;
      }

      if (id !== undefined && id !== null) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    },
  };
}
