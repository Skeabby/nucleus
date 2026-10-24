# Nucleus Launcher (Rust) — Build Spec

Design produced 2026-10-13 (architect) before M1 implementation. Original, lighter design —
no code copied from third-party launchers.

## Locked decisions
- Native Rust desktop launcher akin in *spirit* to ArtCraft Launcher but lighter and visually original.
- Scope: M1 = discover + Open/Stop. M2 = catalogue + install/update (`.nucleusapp` bundles).
- Windows-first. Toolchain: rustup stable-msvc (1.99). `target/` gitignored.
- GUI: **egui / eframe, glow backend** (no wgpu). Design tokens: INK #0B0E14, SURFACE #151B26,
  TEXT #E7ECF5, ACCENT #6D5EF8, CYAN #22D3EE, RUN #34D399, AMBER #F59E0B.
- Apps remain Node local HTTP servers with `nucleus.app.json` manifests.
  App roots: `<repo>/apps/*` + `%APPDATA%\Nucleus\apps`. TS launcher + `assets/nucleus-shell.exe` stay.

## Crate layout
```
launcher-rs/
├─ Cargo.toml                  # workspace, resolver 3, edition 2024
├─ .gitignore                  # target/, *.nucleusapp
├─ mirror/catalog.json         # offline catalog
└─ crates/
   ├─ nucleus-launcher-core/   # PURE (no I/O, no egui): serde types + parsers + pure fns
   │   src/{lib.rs, error.rs, manifest.rs, model.rs, roadmap.rs, catalog.rs,
   │        installed.rs, version.rs, status.rs}
   └─ nucleus-launcher/        # BIN: egui UI + native engine (fs/proc/net/window)
       src/{main.rs, app.rs, paths.rs, discovery.rs, ports.rs, probe.rs,
            process.rs, window.rs, runtime.rs, jobs.rs, net.rs, install.rs,
            ui/{mod.rs, theme.rs, views.rs, widgets.rs}}
```

## Data model (core)
- `Manifest` mirrors `schemas/app-manifest.schema.json` (serde camelCase renames). Enums: `Category`
  (image/vector/video/audio/pdf/text/layout/data/cad/system/other), `ReleaseStatus`
  (stable/beta/alpha/planned), `LaunchKind` (server/url/command), `Permission`, `Channel`.
- `LaunchSpec { kind, command?, args, url?, port?, window?, readyPath? }` +
  `parse_manifest(json)`, `validate(m)`.
- `AppMeta { manifest, dir, manifest_path, source: AppSource(Repo|UserData|Roadmap), installed?, catalog? }`.
- `AppStatus` (UI state, distinct from manifest status): NotInstalled / Installed / UpdateAvailable /
  Unavailable / Running; `is_installed()`.
- `RoadmapEntry` mirrors `apps/launcher/roadmap.json`; `Card::{App,Planned}`; `merge_roadmap(dedup by id)`.
- Catalog/Installed (M2): `Catalog { suiteVersion, generatedAt?, apps: Vec<CatalogEntry{id, repo,
  releaseAsset, sha256, version?, url?, name?, channel?}> }`, `InstalledIndex` (BTreeMap id →
  `InstalledRecord{version, installedAt, source, channel?}`), `parse_catalog` (lenient, drop bad),
  `is_update(latest, installed)` semver (strip leading `v`), `derive_status(installed, catalog, running)`.

## M1 semantics
- **Discovery** `discover(roots)`: roots `[<repo>/apps, %APPDATA%\Nucleus\apps]`, first root wins on id;
  for each root, candidate = root itself + child dirs; load `<dir>/nucleus.app.json` AND
  `<dir>/current/nucleus.app.json`. `load_roadmap(<repo>/apps/launcher/roadmap.json)` +
  `merge_roadmap`. `known_node()`: `where node` → `NUCLEUS_NODE` env → "node".
- **Ports** `free_port(preferred)`: default 4300-ish pool optional; bind 127.0.0.1:preferred else :0.
- **Spawn** `spawn_node(app, port)`: `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`, cwd=app.dir,
  env PORT, cmd = spec.command.unwrap_or(node), args = spec.args.
- **Probe** `wait_ready(port, ready_path, 20s)`: GET http://127.0.0.1:{port}{path}, 1.5s per-request, 250ms loop.
- **Window** `open_app_window(url, title, icon, profile)`: `assets/nucleus-shell.exe` with
  `--user-data-dir %APPDATA%\Nucleus\window-profiles\<id> --size 1440x900`; fallback `cmd /c start "" <url>`.
- **Runtime** owns `Vec<Running>`; mpsc `Event { Starting, Ready(url), Failed, Stopped }` drained per
  frame in `app.rs`; `Drop` + on-exit → `stop_all()` (taskkill /T /F). No orphan node after exit.
- **UI**: three panes (sidebar 240 SURFACE, main list, optional inspector 320). Rows with 44px tile,
  name/desc, category chip, version, status dot (RUN/AMBER/CYAN), primary Open|Stop. Footer: counts +
  honest source line. "Coming soon" section from roadmap.
- Acceptance: `cargo build --release` green; 3 apps + 5 upcoming; Open spawns + shell window; Stop
  kills tree; closing leaves no node.

## M2 semantics
- Catalog URL precedence: `NUCLEUS_CATALOG` (dev override, unsigned, `https` only unless
  `NUCLEUS_ALLOW_FILE_CATALOG=1`) → verified `%APPDATA%\Nucleus\catalog.json` (+`catalog.json.sig`) →
  embedded `mirror/catalog.json`. `NUCLEUS_OFFLINE=1` simply skips the network survey.
- **Trust (N1)**: the fetched catalogue is verified **before parsing** against
  `catalog.json.sig` — a detached JSON envelope `{algorithm, keyId, signature}` over the exact bytes —
  with the Ed25519 keys compiled into the binary (`TRUSTED_KEYS`, key ids for rotation). Unsigned,
  unknown key, bad signature, past `expiresAt` (90 days) or a downgrade versus `trust.json` ⇒ refused,
  last good catalogue kept, notice shown. Plain `http://` is refused before the socket and again on the
  final URL after redirects.
- Asset URL default `https://github.com/{repo}/releases/latest/download/{releaseAsset}`; sha256 must be
  64 hex else entry dropped.
- **Launch policy**: a bundle that came from the catalogue may only start a relative `node` server —
  no `kind: command`, no shell, no absolute/`..` argument; a refusal rolls the install back out.
- **Consent**: `updates` defaults to `ask` (banner with *Install now* / *Always install*), persisted in
  `trust.json`. The self-update uses the signed `launcher {version, url, sha256}` block and refuses a
  version mismatch, a missing checksum, or a mismatched download.
- Install pipeline (worker, one per id): download `.part` streaming-hash → verify → unzip via
  `enclosed_name()` into `<id>\.staging-<ver>` → atomic swap to `<id>\current` → update
  `installed.json` (temp+rename). Emit `Phase { Queued, Downloading{done,total}, Verifying, Installing,
  Done, Failed }`. Update = same function. Uninstall = stop + remove dir + drop index key (never for repo apps).
- Status from `derive_status`; UI filters All/Installed/Updates; row button by status
  (Install/Open/Update/Stop/disabled); inline progress bar + phase; honest footer
  ("via catalog.json (Skeabby/nucleus) · verified 4 min ago" / "offline" / "no catalog").

## Anti-plagiarism guardrails
- Keep our lexicon (Apps / Coming soon / Open / Stop / Install / Update / Uninstall), tokens
  (INK/SURFACE/TEXT/ACCENT/CYAN/RUN/AMBER), three-pane layout, `nucleus.app.json`, `.nucleusapp`,
  `installed.json`, `catalog.json`, `nucleus open <id>`.
- Never copy ArtCraft crate split core/native/ui-egui, Command/Event trait ceremony, identifiers
  (CraftApp/SUITE/Feed/AppGroup/InstallSource), i18n catalogs, fonts (Archivo/Inter/Geist), header grid
  or table layout, WASM build, asset pipeline, trademark notice phrasing.

## CI (when M1 code lands)
Separate `launcher-rs.yml`: windows-latest, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`
(workspaces: launcher-rs), `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test --workspace`. Paths filter `launcher-rs/**`.

## Known risks
- node resolution: `where node` at startup + NUCLEUS_NODE env + clear missing-node error.
- SVG icons: emoji/letter tiles in M1 (egui can't rasterize SVG cheaply); M2 optional icon.png.
- Unsigned binary → SmartScreen on first run (out of scope).
- Zip traversal mitigated by `enclosed_name()`; atomic swap relies on same-volume rename.
- `target/` must never sync to OneDrive (repo already on local disk).