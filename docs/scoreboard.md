# Scoreboard — measured claims

Every number below is produced by a command in this repository. None is typed by
hand: that is the difference between a claim and a measurement.

- **Regenerate**: `npm run scoreboard` (TypeScript + cross-app + Rust when cargo is available).
- **CI fails when this file is stale**: `npm run scoreboard -- --check ts` in `.github/workflows/ci.yml`,
  `node tools/scoreboard.mjs --check rust` in `.github/workflows/launcher-rs.yml`.
- Claimed elsewhere (README, ARCHITECTURE) numbers must match this file.

<!-- section:ts -->

### TypeScript

| Claim | Measured | Reproduce |
|---|---|---|
| Build, typecheck and test tasks pass | **42 / 42** | `npm run verify` |
| TypeScript unit tests | **312** (app-kit 111 · control 14 · control-federation 10 · control-mcp 27 · core 68 · image 19 · launcher 16 · notes 25 · pdf 22) | `npm run test` |
| UI guards: plain vocabulary, WCAG AA contrast, accent = launcher category | **13 tests** | `npx vitest run --root packages/app-kit test/jargon.test.ts test/contrast.test.ts test/accent.test.ts` |
| Apps joined into one session → unified commands | **33 commands from 2 apps** (nucleus.pdf (pdf) · nucleus.notes (notes)) | `npm run demo:cross-app` |
| One undo path across those apps: 4 edits in 2 apps, unwound then replayed | **9 / 9 checks passed** | `npm run demo:cross-app` |
| Export from the edited state is a readable PDF | **3 pages read back** | `npm run demo:cross-app -- --export` |
| MCP tools on the federation server | **12** (apps_list, cmd_list, cmd_describe, cmd_invoke, state_get, undo_status, undo, redo, pdf.load, pdf.loadFile, pdf.export, notes.export) | `npm run mcp:federation` then `tools/list` |
| Workspace packages / apps | **10 / 4** | `npm run scoreboard` |

**Not claimed yet** (honesty rule — no number, no claim): PNG export of a PDF page, PDF text
extraction, assistant permissions enforced from the manifest, a scripted demo video under 60 s.
Those land with v0.4; today's proof stops where the checks stop.

<!-- /section:ts -->

<!-- section:rust -->

### Rust (`launcher-rs/`)

| Claim | Measured | Reproduce |
|---|---|---|
| Rust unit tests | **145** (nucleus_launcher 81 · nucleus_launcher_core 64) | `cargo test --workspace` |

The `Launcher (Rust)` workflow runs fmt, clippy (`-D warnings`), tests and a release build on
every change under `launcher-rs/`; this section is diffed against it there.

<!-- /section:rust -->
