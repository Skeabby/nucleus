# M4 — agent-drivable apps, end to end

`transcript.md` is a real run, not a mock:

```
node tools/mcp-demo.mjs --out examples/mcp/transcript.md
```

What the script does:

1. starts `apps/notes` exactly like the launcher (`node dist/server.js` with `PORT` and
   `NUCLEUS_TOKEN`, throwaway `APPDATA` so your notebook is untouched);
2. writes the same `run/apps.json` entry the Rust `Runtime` writes;
3. spawns `packages/control-mcp/dist/index.js` and speaks MCP JSON-RPC over stdio
   (`initialize` with `clientInfo.name = "opencode"`);
4. discovers the app (`nucleus_apps`), reads the command schema (`nucleus_describe`),
   proposes a write (`nucleus_invoke`), has the human side approve it over HTTP —
   the same call the review drawer's `A` key makes — waits (`nucleus_wait`), reads
   the tape (`nucleus_tape`) and undoes (`nucleus_undo`).

The actor on the tape is `{ kind: "agent", id: "opencode" }`: the apps' review
policy and provenance never mistake an agent for a human.

Screenshots are deliberately absent: the demo runs headless (no WebView2 window),
so a PNG would show a terminal, and the transcript already contains every byte
that crossed the wire.
