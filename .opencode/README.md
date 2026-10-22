# opencode integration

`mcp.json` registers two MCP servers so opencode (and any MCP-capable agent) can
drive the same command bus as the CLI and the web apps.

```json
{
  "mcpServers": {
    "nucleus": {
      "type": "local",
      "command": ["node", "packages/control-mcp/dist/index.js"],
      "enabled": true
    },
    "nucleus-federation": {
      "type": "local",
      "command": ["node", "packages/control-federation/dist/mcp.js"],
      "enabled": true
    }
  }
}
```

Build the servers first:

```powershell
npm run build
```

## `nucleus` — the launcher's running apps (proxy)

Reads `%APPDATA%\Nucleus\run\apps.json` and calls each app's `/api/*` with the
bearer token the launcher minted. Nothing is linked in-process: start an app in
the launcher and it becomes drivable, no rebuild.

| Tool | Purpose |
|------|---------|
| `nucleus_apps` | Running apps + capability summary (commands, writes, shortcuts) |
| `nucleus_describe(app, command?)` | Commands **with their params JSON Schema** |
| `nucleus_invoke(app, command, params, label?)` | Result, or `{ status: "proposed", proposalId }` |
| `nucleus_proposals(app)` | Pending and decided proposals |
| `nucleus_wait(proposalId, timeoutMs?, app?)` | Block until a proposal is decided |
| `nucleus_tape(app, since?)` | Applied changes, with the actor |
| `nucleus_undo(app)` | Undo one step |

Curated shortcuts come from descriptors that opt in with `mcp: { expose: true }`:
`note_create`, `note_update`, `pdf_import_pages`, `pdf_remove_page`, `pdf_stats`.

An agent that writes lands in the app's **review drawer** (`ask` trust): approve
with `A`, reject with `R`. The transcript of a full proposal → approve → tape →
undo run is in [`../examples/mcp/transcript.md`](../examples/mcp/transcript.md),
regenerate it with `npm run demo:mcp`.

`recipe_list` / `recipe_run` from the M4 spec are **not** implemented (no engine
behind them); compose behaviour from `nucleus_describe` + `nucleus_invoke`.

## `nucleus-federation` — every app in one session

Joins the PDF and Notes apps behind one surface and keeps **one undo stack** for
the whole session. See [`../docs/cross-app.md`](../docs/cross-app.md).

| Tool | Purpose |
|------|---------|
| `apps_list` | Joined apps, with their command and tool counts |
| `cmd_list` | Every command of every app (canonical `app/command` names) |
| `cmd_describe` | Owning app, side effects and reversibility of one command |
| `cmd_invoke` | Invoke any command; it joins the unified undo journal |
| `state_get` | Read every app's state (or one, via `prefix`) |
| `undo_status` | Cross-app undo journal and redo stack |
| `undo` / `redo` | Move through edits whichever app made them |
| `pdf.load`, `pdf.loadFile`, `pdf.export`, `notes.export` | Member tools: byte I/O, not journaled |

Both servers are dependency-free JSON-RPC 2.0 implementations over stdio
(`initialize`, `notifications/initialized`, `tools/list`, `tools/call`).
