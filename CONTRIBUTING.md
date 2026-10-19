# Contributing to Nucleus

PRs and issues are welcome — this is a young project, and the plugin/manifest
model is the most interesting thing to poke at. This page gets you from a bare
machine to a green gate.

## Requirements

| Tool | Needed for | Notes |
|---|---|---|
| **Windows 10/11 x64** | everything | the launcher is Windows-native (egui + WebView2 apps) |
| **Node.js ≥ 22** | the TypeScript side + the apps themselves | [nodejs.org](https://nodejs.org), on `PATH` |
| **Rust (stable, MSVC)** | `launcher-rs/` | `rustup` with the MSVC toolchain; MSVC Build Tools are required |
| **Inno Setup 6** (optional) | building `NucleusSetup-*.exe` | without it, `make-setup.ps1` falls back to the portable ZIP |

## Setup

```powershell
git clone https://github.com/Skeabby/nucleus.git
cd nucleus
npm install
npm run build        # TypeScript side
cargo build          # launcher-rs/ (fast check; use --release for real runs)
```

Run the launcher from the repo root (that is where it looks for `apps\`):

```powershell
.\launcher-rs\target\release\nucleus-launcher.exe
```

> Keep the checkout on local disk. `node_modules`, `target` and `.turbo`
> caches inside a cloud-synced folder are a known hazard .

## The rules of the codebase

- **`schemas/` is the single source of truth.** TypeScript types, CLI help and
  MCP tools are generated from it; when you change a schema, regenerate the
  clients.
- **`packages/core` never imports UI or transport code.** Frontends are thin
  adapters over the command bus; features land once and exist everywhere.
- **Apps depend on `@nucleus/core` (+ `sdk`) only.** Everything an app wants
  flows through commands; there is no direct document mutation anywhere else.
- **`nucleus-launcher-core` does no I/O and pulls no UI dependencies.**
  Discovery, catalogue and status types live there; network spawns, jobs and
  windows live in the `nucleus-launcher` crate.
- **No unmeasured claims.** `docs/scoreboard.md` is generated from real
  command output and CI fails if it drifts from the code — if your change
  affects a number the README or the scoreboard states, regenerate it with
  `npm run scoreboard`.

## Verification gates

Run all of them before opening a PR — CI runs exactly these:

```powershell
npm run verify                                  # build + typecheck + turbo tests + cross-app demo
cargo test --workspace                          # Rust core + launcher
cargo clippy --workspace --all-targets -- -D warnings   # lints are part of the contract
cargo fmt --all -- --check
node tools/scoreboard.mjs --check ts            # claim drift guards
node tools/scoreboard.mjs --check rust
```

From `launcher-rs/`, a smoke test exercises discovery and Node detection
headlessly:

```powershell
cargo run --release -p nucleus-launcher -- --smoke
```

## App idea?

An app is a folder with a `nucleus.app.json` manifest dropped into `apps/` —
no registry, no rebuild, no plugin SDK to learn. Look at `apps/notes` (the
smallest real example: local HTTP server + web UI on the command bus) and at
`packages/notes` (its command pack). Copy the structure, validate your
manifest against `schemas/app-manifest.schema.json`, and open an issue first
if you want a second pair of eyes on the command surface.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`,
`schemas:`, `ci:`). Keep the subject short and let the body explain the why.

## Releases

Releases are cut for the launcher as a single, current release (old ones are
deleted rather than accumulated):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1   # hardened binary (paths remapped, strip on)
powershell -ExecutionPolicy Bypass -File scripts\make-setup.ps1      # installer (Inno) or portable ZIP
```

`build-release.ps1` bakes nothing of the maintainer's machine into the
artifact and refuses a binary that still contains profile paths — do not
publish a plain `cargo build --release` output instead.
