<div align="center">

# Nucleus

### The creative suite that runs itself.

**One command bus. Every app speaks GUI, CLI and MCP.**
**A native Rust launcher, drop-in plugins in WebView2 windows — no Electron, no bundled runtime.**

[![CI](https://github.com/Skeabby/nucleus/actions/workflows/ci.yml/badge.svg)](https://github.com/Skeabby/nucleus/actions/workflows/ci.yml)
[![Launcher (Rust)](https://github.com/Skeabby/nucleus/actions/workflows/launcher-rs.yml/badge.svg)](https://github.com/Skeabby/nucleus/actions/workflows/launcher-rs.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4.svg)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D22-43853D.svg)](https://nodejs.org)
[![Stars](https://img.shields.io/github/stars/Skeabby/nucleus?style=social)](https://github.com/Skeabby/nucleus/stargazers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Skeabby/nucleus/pulls)

<img src="docs/screenshot-launcher.png" alt="The Nucleus launcher, grid view grouped by category" width="820" />
<br />
<img src="docs/screenshot-table.png" alt="The Nucleus launcher, sortable table view" width="820" />

</div>

---

> **The GUI, the terminal, and your AI agent all run the exact same commands.**
> Nucleus hosts small creative apps as plugins, and every app exposes one command bus through a web
> UI, a CLI and an MCP server. Drive it by clicking, scripting, or prompting — the results are
> identical. A federated MCP server can drive several apps in one session with a single undo stack.

<!-- TODO: record a 20-40s demo GIF, drop it in docs/, and replace this note. -->
<p align="center"><em>Demo GIF coming soon (<code>docs/demo.gif</code>)</em></p>

---

## Why it's different

Most creative suites are either a heavy Electron shell or a pile of disconnected tools. Nucleus takes a
different route:

- **Agent-first, not agent-bolted-on.** MCP is a first-class frontend, not an afterthought. An AI
  agent can do everything a human can, because it talks to the *same* command bus.
- **Apps are just folders.** Drop a directory with a `nucleus.app.json` manifest into `apps/` and it
  appears in the launcher. No registry, no rebuild, no plugin SDK to learn.
- **Native windows in ~11 KB.** A tiny WinForms + WebView2 host renders each app in a real desktop
  window with taskbar identity and its own icon — compiled with the `csc.exe` already on Windows.
- **One core to rule the suite.** `@nucleus/core` owns the document model, a command bus and
  undo/redo. Frontends are thin adapters, so features land once and become available everywhere.
- **Every app, one session, one undo.** A federated MCP frontend joins the PDF and Notes apps
  behind a single surface: 12 unified commands and **one** undo stack across both, so an agent can
  reorder a PDF and edit a note, then undo both in order (`npm run demo:cross-app`).
- **Apps install themselves, verified.** A `.nucleusapp` archive is SHA-256 checked, unpacked to a
  temp directory, verified **file by file** against a digest ledger, then swapped in atomically with
  rollback — zip-slip, decompression bombs and case-collisions are all refused. The launcher does the
  whole loop itself: it builds bundles (`--pack`), writes a `catalog.json` (`--gen-catalog`), and
  installs / updates / removes through the catalogue (`--install-app`, `--uninstall-app`, and the
  Install / Update / Remove buttons in the UI).
- **A native launcher, no Electron.** `launcher-rs/` is a single Rust binary (egui/eframe, ~12 MB,
  no runtime installed): manifest discovery, Open / Stop, grid and table views, category filter,
  search, dark/light themes, a `--smoke`/`--list` CLI — and a flat hairline design of its own:
  brand violet reserved for the chrome, orbit icon tiles, corner brackets.
- **A launcher that looks the part.** Big app icons with status and version, grouped by category, a
  sortable table, an app detail panel that lists each app's commands, and light/dark themes.
- **Two launchers, one manifest.** The native one above is the default entry point; the TypeScript
  launcher (`apps/launcher`, `packages/launcher`) shipped in `v0.1.0` and stays in the repo as the
  reference implementation over the same `nucleus.app.json` files.

## Apps

| App | Status | What it does |
|-----|--------|--------------|
| **Nucleus launcher** | alpha | The **native Rust launcher** (`launcher-rs/`): every app in one window — grid and table views, category filter, search, Open / Stop, live log, dark + light themes, its own flat hairline design. |
| **PDF Workbench** | beta | Merge, reorder, rotate, delete pages, undo/redo, save/open projects, export. |
| **Notes** | alpha | Markdown notes with undo/redo, live preview and Markdown export. |
| Image Editor | planned | Layers, masks, non-destructive adjustments and export. |

## Quickstart (Windows)

Nucleus installs like any other Windows app: download `NucleusSetup-0.4.0-alpha-win64.exe` from the
[v0.4.0-alpha release](https://github.com/Skeabby/nucleus/releases/tag/v0.4.0-alpha), double-click it,
and you are done. No Node build, no checkout, no admin prompt — it is a per-user install. Prefer not
to install? Grab the portable `nucleus-launcher-v0.4.0-alpha-win64.zip` from the same release and run
`nucleus-launcher.exe` from wherever you unzip it.

> The installer ships with the `v0.4.0-alpha` **pre-release**; the stable `v0.3.0` (the "Latest"
> release) predates it and has no installer.

1. **Run the installer** (`NucleusSetup-<version>-win64.exe`). It needs no administrator rights.
2. **Launch Nucleus** from the Start Menu or the desktop shortcut — both are
   created by default (untick the desktop-shortcut box during setup if you do
   not want it), pick an app and click **Open** — it starts on a free port in
   its own window.
3. **To remove it**: **Settings → Apps → Nucleus → Uninstall**, or run
   `powershell -ExecutionPolicy Bypass -File scripts\uninstall-nucleus.ps1`.

> **Node.js note:** the *launcher* is a native binary and needs nothing else. The *apps* it hosts are
> Node servers, so Node.js must be on your `PATH` for them to run — install it once from
> [nodejs.org](https://nodejs.org). The installer only *warns* if it is missing; it never blocks.

A released launcher runs **catalogue-only** with no checkout: it discovers installed apps under
`%APPDATA%\Nucleus\apps` and installs published app bundles from the catalogue, so it works on a
machine that has never seen this repository. Close the launcher window to shut the whole nucleus down.

<details>
<summary><strong>Run from a checkout (developers)</strong></summary>

Contributors run everything from the repository instead. The launcher is the native Rust binary; the
apps it hosts are Node/TypeScript, so build the apps once:

```powershell
npm install
npm run build
```

Run the launcher **from the repo root** — that is where it looks for `apps\`:

```powershell
.\launcher-rs\target\release\nucleus-launcher.exe
```

Build the launcher from source (needs a Rust toolchain):

```powershell
cargo build --release --manifest-path launcher-rs\Cargo.toml
```

Published binaries are built with `scripts\build-release.ps1` instead: a plain release build bakes the
build machine's paths into the artifact through `file!()`/panic locations, and that script remaps them
away (and refuses to hand you a binary that still contains them).

Build the installer yourself (Inno Setup 6 is optional — without it the same command writes the
portable ZIP):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-setup.ps1
```

Make a checkout act like a desktop app:

```powershell
npm run shell                       # (one-time) build the native window shell -> assets\nucleus-shell.exe
powershell -File scripts\install-shortcut.ps1   # "Nucleus.lnk" on the desktop, with an icon
```

The shortcut points straight at `launcher-rs\target\release\nucleus-launcher.exe`, with the repo
root as its working directory; it falls back to the TypeScript entry if that binary is missing.

</details>

## How it works

```
  frontends
    launcher UI          click it
    control-cli          script it
    control-mcp          prompt one app
    control-federation   prompt every app in one session, one undo stack
                                │
                                ▼
                    ControlServer (transport-agnostic)
                                ▼
        CommandBus · document model · undo/redo · serialization
                                ▲
                app command packs (e.g. @nucleus/pdf)
```

The **launcher** scans `apps/*/nucleus.app.json` and `%APPDATA%\Nucleus\apps`, picks a free port
per app, spawns `node <app>` detached with a `PORT` env var, waits for a readiness probe, and opens
a native window at the app root. It stays alive so closing the launcher shuts down the apps it owns.

## Monorepo layout

```
packages/core              # document model, command bus, undo/redo, serialization
packages/control           # ControlServer: invoke / describe / list / history
packages/control-cli       # CLI frontend
packages/control-mcp       # MCP frontend (dependency-free JSON-RPC 2.0 over stdio)
packages/control-federation # MCP frontend across apps: one session, one undo stack
packages/control-rpc       # planned JSON-RPC frontend — README only, no code yet
packages/pdf               # @nucleus/pdf command pack (import / rotate / move / remove / export)
packages/notes             # @nucleus/notes command pack (commands, views, markdown export)
packages/launcher          # app discovery, manifests, process runtime, windows, CLI
apps/launcher              # the launcher window (grid/table UI + /api/apps)
apps/pdf-workbench         # app #1: local HTTP server + web UI
apps/notes                 # app #2: Markdown notes on the command bus
schemas/                   # JSON Schema - the source of truth for codegen
tools/                     # codegen, schema validators, scoreboard
shell/                     # native window host (WinForms + WebView2)
scripts/                   # shell build, release build, screenshots, shortcut installer
launcher-rs/               # native Rust launcher: core crate + egui/eframe UI crate
```

Every app is just a folder with a `nucleus.app.json` manifest describing what it is and how to
launch it — that is all the launcher needs to discover and run it.

## Commands

```bash
npm run verify            # build + typecheck + test (via turbo) + cross-app demo
npm run build
npm run test
npm run scoreboard        # regenerate docs/scoreboard.md from real command output
npm start                 # open the Nucleus launcher
npm run nucleus -- list   # list discovered apps
npm run nucleus -- open nucleus.pdf-workbench
npm run nucleus -- serve  # launcher server only, no window
npm run start:pdf         # run PDF Workbench directly
npm run mcp               # run the per-app MCP server over stdio
npm run mcp:federation    # run the cross-app MCP server over stdio
npm run demo:cross-app    # replay the two-app session and its unified undo
```

The native launcher is a cargo workspace (`launcher-rs/`). From that directory:

```bash
cargo test                                           # 107 unit tests (core + launcher)
cargo clippy --all-targets -- -D warnings            # lints are part of the contract
cargo run --release -p nucleus-launcher -- --smoke   # headless smoke test (apps + planned + node)
cargo run --release -p nucleus-launcher -- --list     # discovered vs planned apps
cargo run --release -p nucleus-launcher -- --install <app.nucleusapp>  # install a local archive
cargo run --release -p nucleus-launcher -- --install-app <id>          # catalogue install (download → verify → install)
cargo run --release -p nucleus-launcher -- --uninstall-app <id>        # remove a catalogue-installed app
cargo run --release -p nucleus-launcher -- --pack apps/notes --out notes.nucleusapp  # build a .nucleusapp
cargo run --release -p nucleus-launcher -- --gen-catalog mirror/apps --out mirror/catalog.json  # write a catalogue
cargo run --release -p nucleus-launcher              # open the native window
```

Setting `NUCLEUS_CATALOG` to a `catalog.json` (or any folder paired with its `apps/`) makes an
install run entirely offline: relative asset URLs resolve against the catalogue's own directory.

## Agent-ready (MCP)

Two MCP servers are registered in [`.opencode/mcp.json`](./.opencode/mcp.json) — see
[`.opencode/README.md`](./.opencode/README.md):

- `nucleus` — `control-mcp`: curated PDF tools plus a generic `cmd_invoke` escape hatch for one app.
- `nucleus-federation` — `control-federation`: every joined app in one session, with a **single undo
  stack** across them (`apps_list`, `cmd_list`, `cmd_describe`, `cmd_invoke`, `state_get`,
  `undo_status`, `undo`, `redo` + each app's tools). Details in
  [`docs/cross-app.md`](./docs/cross-app.md).

Any MCP-capable agent can drive the same command bus as the GUI, so the whole suite is scriptable
*and* promptable.

## Measured claims

[`docs/scoreboard.md`](./docs/scoreboard.md) is generated from real command output — test counts,
the cross-app demo checks, the MCP tool list. CI fails if it drifts from the code, so every number
in this README has a command behind it.

## Roadmap

The phased plan, design decisions and risks live in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
Where we are: the native Rust launcher + first three apps (**done**), cross-app federation, and the
full `.nucleusapp` catalogue loop — bundle builder, catalogue generator, verified install / update /
remove in both the CLI and the UI, with an offline (no-network) test — **shipped as `v0.4.0-alpha`**.
The committed catalogue already points at two published app bundles
([`apps-v0.1.0`](https://github.com/Skeabby/nucleus/releases/tag/apps-v0.1.0)), so a released
launcher installs them on a machine with no checkout. Next: build the **Image Editor** (the second
proof app), the JSON-RPC frontend and packaging for cross-platform native bundles.

## Contributing

PRs and issues are welcome — this is a young project and the plugin/manifest model is the most
interesting thing to poke at. Run `npm run verify` before opening a PR.

If Nucleus is useful or just neat, a **star** helps other people find it.

## License

[MIT](./LICENSE) © Nucleus contributors.

### Bundled third-party assets

The native launcher (`launcher-rs/`) embeds three typefaces, all under the SIL Open Font License
1.1. The full licence texts ship alongside the font files in
[`launcher-rs/crates/nucleus-launcher/assets/fonts/`](./launcher-rs/crates/nucleus-launcher/assets/fonts):

| Font | Licence | Copyright |
| --- | --- | --- |
| Archivo | OFL 1.1 (`OFL-Archivo.txt`) | 2020 The Archivo Project Authors (Omnibus-Type) |
| Inter | OFL 1.1 (`OFL-Inter.txt`) | 2016 The Inter Project Authors |
| Geist Mono | OFL 1.1 (`OFL-GeistMono.txt`) | 2024 The Geist Project Authors (Vercel) |

No other third-party code or design assets are used: the launcher UI is an original implementation.
