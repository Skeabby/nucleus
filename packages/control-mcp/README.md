# @nucleus/control-mcp

The suite's **single MCP server** (§4.4). It is a *proxy*, not a command bus of
its own:

```
launcher ──writes──▶ %APPDATA%\Nucleus\run\apps.json
                              │  (id, name, port, token, pid, startedAt)
                              ▼
agent ──stdio MCP──▶ control-mcp ──HTTP + Bearer──▶ app /api/describe|op|…
```

Nothing is linked in-process, so **any app the launcher starts is drivable** —
no rebuild, no tool list to maintain. Apps that are not running simply do not
appear; an app that is up but unreachable is reported, never fatal.

## Tools (progressive disclosure)

| Tool | Purpose |
| --- | --- |
| `nucleus_apps` | Running apps + capability summary (commands, writes, shortcuts) |
| `nucleus_describe(app, command?)` | Commands **with their params JSON Schema** |
| `nucleus_invoke(app, command, params, label?)` | Result, or `{ status: "proposed", proposalId }` |
| `nucleus_proposals(app)` | Pending and decided proposals |
| `nucleus_wait(proposalId, timeoutMs?, app?)` | Block until a proposal is decided |
| `nucleus_tape(app, since?)` | Applied changes (provenance + patches) |
| `nucleus_undo(app)` | Undo one step; says whether anything was undone |

On top of those, **curated shortcuts** are generated from the descriptors that
opt in with `mcp: { expose: true, name: "pdf_remove_page" }` on the app side:

- `note_create`, `note_update`
- `pdf_import_pages`, `pdf_remove_page`, `pdf_stats`

A shortcut's `inputSchema` *is* the command's params schema — no translation
layer to keep in sync. Shortcuts appear and disappear with the apps.

> **Recipes are not implemented.** `recipe_list` / `recipe_run` from §4.4 have
> no engine behind them, so they are intentionally absent rather than faked. An
> agent composes the same behaviour from `nucleus_describe` +
> `nucleus_invoke`.

## Identity

`initialize.params.clientInfo.name` becomes the actor on every invoke:
`{ kind: "agent", id: "<client name>" }`. The apps' review policy (`ask` →
proposal, `autopilot` → apply) and the tape therefore distinguish an agent from
a human, and two agents from each other.

## Run it

```bash
npm run build                      # or: npm --workspace @nucleus/control-mcp run build
node packages/control-mcp/dist/index.js
```

```jsonc
// .opencode/mcp.json
{
  "mcpServers": {
    "nucleus": { "type": "local", "command": ["node", "packages/control-mcp/dist/index.js"] }
  }
}
```

`NUCLEUS_RUN_DIR` overrides the registry location (tests, portable installs).

## Testing

`test/mcp.test.ts` runs the proxy against a fake app over real HTTP: registry
parsing and self-healing, bearer handling, actor propagation, proposals,
timeouts, tape filtering, undo, shortcuts, and the JSON-RPC framing (including
`-32601` and `isError` results).
