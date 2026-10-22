/**
 * The agent-facing tool surface (§4.4): progressive disclosure, never the full
 * command set. Seven generic tools find, describe and drive any running app;
 * descriptors that opt in with `mcp.expose` also get a curated shortcut.
 */
import { AppError, type Actor, type AppClient, type CommandDescription } from "./client.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  clients: AppClient[];
  actor: Actor;
}

/** A curated shortcut: one exposed descriptor, bound to its app. */
interface Shortcut {
  tool: ToolDef;
  client: AppClient;
  command: CommandDescription;
}

const APP_ARG = {
  type: "string",
  description: "App id from nucleus_apps (e.g. nucleus.notes). The app name works too.",
} as const;

function appList(ctx: ToolContext): string {
  const ids = ctx.clients.map((client) => client.id);
  return ids.length === 0 ? "no app is running" : ids.join(", ");
}

/** Resolve the `app` argument against ids first, then display names. */
export function findClient(ctx: ToolContext, app: unknown): AppClient {
  const wanted = String(app ?? "").trim().toLowerCase();
  if (wanted === "") {
    throw new Error(`missing "app" (running: ${appList(ctx)})`);
  }
  const byId = ctx.clients.find((client) => client.id.toLowerCase() === wanted);
  if (byId) return byId;
  const byName = ctx.clients.find((client) => client.app.name.toLowerCase() === wanted);
  if (byName) return byName;
  throw new Error(`app "${String(app)}" is not running (running: ${appList(ctx)})`);
}

/** `note.create` → `note_create` when a descriptor does not name its shortcut. */
export function derivedToolName(command: string): string {
  return command.replace(/\./g, "_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Every exposed descriptor across the running apps (unreachable ones skipped). */
export async function shortcuts(ctx: ToolContext): Promise<Shortcut[]> {
  const found: Shortcut[] = [];
  const seen = new Set<string>();
  const descriptions = await Promise.all(
    ctx.clients.map(async (client) => {
      try {
        return { client, describe: await client.describe() };
      } catch {
        return null; // an unreachable app must not hide the others
      }
    }),
  );
  for (const entry of descriptions) {
    if (!entry) continue;
    for (const command of entry.describe.commands ?? []) {
      if (!command.mcp?.expose) continue;
      const name = command.mcp.name ?? derivedToolName(command.name);
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({
        client: entry.client,
        command,
        tool: {
          name,
          description:
            `${entry.client.app.name}: ${command.description ?? command.title ?? command.name}` +
            ` (shortcut for ${command.name})`,
          inputSchema: (command.params as Record<string, unknown> | undefined) ?? {
            type: "object",
            properties: {},
          },
        },
      });
    }
  }
  return found.sort((a, b) => a.tool.name.localeCompare(b.tool.name));
}

const GENERIC_TOOLS: ToolDef[] = [
  {
    name: "nucleus_apps",
    description:
      "List the Nucleus apps that are running right now, with a capability summary " +
      "(command count and exposed shortcuts). Start here.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nucleus_describe",
    description:
      "Describe an app's commands, each with its params JSON Schema. Pass `command` for one.",
    inputSchema: {
      type: "object",
      required: ["app"],
      properties: {
        app: APP_ARG,
        command: { type: "string", description: "Optional: a single command name." },
      },
    },
  },
  {
    name: "nucleus_invoke",
    description:
      "Run one command. The app's review policy applies: the answer is the result, " +
      'or { status: "proposed", proposalId } when a human must approve it first.',
    inputSchema: {
      type: "object",
      required: ["app", "command"],
      properties: {
        app: APP_ARG,
        command: { type: "string" },
        params: { type: "object", description: "Command params (see nucleus_describe)." },
        label: { type: "string", description: "Short human-readable label for the tape." },
      },
    },
  },
  {
    name: "nucleus_proposals",
    description: "List an app's proposals (pending and decided).",
    inputSchema: {
      type: "object",
      required: ["app"],
      properties: { app: APP_ARG },
    },
  },
  {
    name: "nucleus_wait",
    description:
      "Wait until a proposal is decided (accepted/rejected) or the timeout expires. " +
      "Omit `app` to search every running app.",
    inputSchema: {
      type: "object",
      required: ["proposalId"],
      properties: {
        proposalId: { type: "string" },
        app: APP_ARG,
        timeoutMs: { type: "integer", minimum: 0, description: "Default 30000." },
      },
    },
  },
  {
    name: "nucleus_tape",
    description: "Read the tape (the append-only log of applied changes), optionally from a seq.",
    inputSchema: {
      type: "object",
      required: ["app"],
      properties: {
        app: APP_ARG,
        since: { type: "integer", minimum: 0, description: "Only records with seq > since." },
      },
    },
  },
  {
    name: "nucleus_undo",
    description: "Undo the last change in an app. Returns whether anything was undone.",
    inputSchema: {
      type: "object",
      required: ["app"],
      properties: { app: APP_ARG },
    },
  },
];

/** Generic tools plus the shortcuts currently available. */
export async function listTools(ctx: ToolContext): Promise<ToolDef[]> {
  const curated = (await shortcuts(ctx)).map((entry) => entry.tool);
  return [...GENERIC_TOOLS, ...curated];
}

/** Capability summary for `nucleus_apps`. */
async function appSummary(client: AppClient): Promise<Record<string, unknown>> {
  try {
    const describe = await client.describe();
    const commands = describe.commands ?? [];
    return {
      id: client.id,
      name: client.app.name,
      port: client.app.port,
      startedAt: client.app.startedAt,
      reachable: true,
      commands: commands.length,
      writes: commands.filter((command) => command.sideEffects === "write").length,
      shortcuts: commands.filter((command) => command.mcp?.expose).length,
    };
  } catch (error) {
    return {
      id: client.id,
      name: client.app.name,
      port: client.app.port,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Execute one tool call. Every branch returns a JSON-serialisable value. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case "nucleus_apps": {
      const summaries = await Promise.all(ctx.clients.map(appSummary));
      return { apps: summaries };
    }

    case "nucleus_describe": {
      const client = findClient(ctx, args.app);
      const describe = await client.describe();
      const commands = describe.commands ?? [];
      if (args.command === undefined) {
        return { app: client.id, name: describe.app?.name ?? client.app.name, commands };
      }
      const wanted = String(args.command);
      const command = commands.find((entry) => entry.name === wanted);
      if (!command) throw new Error(`app ${client.id} has no command "${wanted}"`);
      return { app: client.id, command };
    }

    case "nucleus_invoke": {
      const client = findClient(ctx, args.app);
      const command = String(args.command ?? "");
      if (command === "") throw new Error('missing "command"');
      const params = (args.params as Record<string, unknown> | undefined) ?? {};
      const label = typeof args.label === "string" ? args.label : undefined;
      return client.invoke(command, params, ctx.actor, label);
    }

    case "nucleus_proposals": {
      const client = findClient(ctx, args.app);
      return { app: client.id, proposals: await client.proposals() };
    }

    case "nucleus_wait": {
      const proposalId = String(args.proposalId ?? "");
      if (proposalId === "") throw new Error('missing "proposalId"');
      const timeoutMs = Number(args.timeoutMs ?? 30_000);
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const clients =
        args.app === undefined || args.app === null
          ? ctx.clients
          : [findClient(ctx, args.app)];
      for (;;) {
        for (const client of clients) {
          let proposals;
          try {
            proposals = await client.proposals();
          } catch {
            continue; // an app that went away cannot own the proposal
          }
          const found = proposals.find((proposal) => proposal.id === proposalId);
          if (found && found.status !== "pending") {
            return { app: client.id, proposal: found };
          }
        }
        if (Date.now() >= deadline) {
          return { proposalId, status: "timeout", waitedMs: Math.max(0, timeoutMs) };
        }
        await sleep(250);
      }
    }

    case "nucleus_tape": {
      const client = findClient(ctx, args.app);
      const since = args.since === undefined ? 0 : Number(args.since);
      const records = await client.tape();
      return { app: client.id, records: records.filter((record) => record.seq > since) };
    }

    case "nucleus_undo": {
      const client = findClient(ctx, args.app);
      return { app: client.id, undone: await client.undo() };
    }

    default: {
      const shortcut = (await shortcuts(ctx)).find((entry) => entry.tool.name === name);
      if (!shortcut) throw new Error(`unknown tool: ${name}`);
      const label =
        typeof args.label === "string"
          ? args.label
          : `agent: ${shortcut.command.name}`;
      return shortcut.client.invoke(shortcut.command.name, args, ctx.actor, label);
    }
  }
}

/** Name the app that failed, for the MCP error text. */
export function describeError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
