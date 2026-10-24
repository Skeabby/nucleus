# Nucleus — Architecture & Phased Build Plan

> Status: **Phase 1 built** (2026-10-10). Keep the checkout on local disk so `node_modules/`
> and `.turbo/` never land in a cloud-synced folder.
> Scope: the *nucleus itself* — launcher + shared core + unified control layer + MCP — plus **one** proof app.

> **Update (2026-10-10):** Phase 0 scaffolded and verified green — npm workspaces + Turborepo,
> `@nucleus/core` command bus with 7 passing tests, and a working `CLI → ControlServer → CommandBus`
> spine. Build caches must live outside any cloud-synced folder: npm deletes a `node_modules`
> junction on install, so redirecting caches via a junction is not viable — keeping the checkout on
> local disk resolves risk #1 outright. Risk #2 (rustup) is deferred until Tauri lands (Phase 4).

> **Update #2 (2026-10-10) — naming + launcher pulled earlier.** The deliverable is **"Nucleus"**:
> a personal suite of creative apps in the spirit of ArtCraft Launcher (commercial,
> trademarked — own branding, own app set, no catalog cloning). The launcher (Phase 5 in the table
> below) was **implemented now**, in Node, rather than waiting for Tauri: `apps/launcher` is a
> windowed app (Edge/Chrome `--app=`) listing apps from `nucleus.app.json` manifests, with
> Open/Stop, grid + table views, search and themes. `packages/launcher` owns discovery, manifests,
> process runtime (free port + readiness probe + process-tree kill), window management and the
> `nucleus` CLI. A desktop shortcut makes it launch like a native app. Tauri remains the
> Phase 4 upgrade path for a real always-on shell.
>
> Apps now: **PDF Workbench** (real: `packages/pdf` + `apps/pdf-workbench`) and **Notes**
> (`apps/notes`) plus the launcher itself; **Image Editor** is the one further app declared as a
> *planned* entry in `apps/launcher/roadmap.json`.

> **Update #3 (2026-10-10) — native windows, no browser.** The launcher (and every app window)
> no longer opens in Edge/Chrome. `shell/nucleus-shell.cs` is a ~150-line WinForms + **WebView2**
> host compiled with the .NET Framework `csc.exe` (present on every Windows box — no Visual
> Studio, no Rust needed) into `assets/nucleus-shell.exe`. Each app still runs as a local Node
> HTTP server; `packages/launcher` opens it inside a real native window (taskbar identity,
> brand icon, no browser chrome), with Chrome/Edge `--app=` as a fallback. WebView2 runtime is
> preinstalled on Win10/11. Rebuild: `powershell -File scripts\build-shell.ps1` (refetch
> assemblies with `scripts\fetch-webview2.ps1`). Tauri (Phase 4) remains the path to a packaged
> installer + tray; the shell already gives us the native-window behaviour today.

> **Update #4 (2026-10-10) — renamed to "Nucleus" + launcher redesign.** The project was renamed
> from "Creative Studio" to **Nucleus** everywhere: the GitHub repo (`Skeabby/nucleus`), npm scope
> (`@nucleus/*`), CLI (`nucleus`), app ids (`nucleus.*`), manifest file (`nucleus.app.json`), the
> per-user data dir (`%APPDATA%\Nucleus`) and the native shell (`nucleus-shell.exe`). The launcher
> UI was redesigned into a premium app-store look: big icon tiles, status + version, sectioned grid
> (Apps / Coming soon), a prominent Open button, a running dot, and a refined light/dark palette.

> **Update #5 (2026-10-10) — launcher UX, tier 1.** The launcher grew the features that make it feel
> like a real app store: cards are grouped **by category** (Image & Design / Documents / System),
> the table is **sortable** on every column (7 columns incl. inspired-by and source),
> **arrow keys** move a selection and Enter opens, **Ctrl+K** opens a **command palette** that also
> lists each app's command-bus capabilities, and clicking a card opens a **detail drawer** showing
> description, capabilities/permissions chips and the exact `npm run nucleus -- open <id>` command.
> `/api/apps` now also returns `author`, `capabilities`, `permissions`, `source` and `dir`.
> `tools/screenshot.mjs`'s DOM self-check was updated and a second hero (`docs/screenshot-table.png`)
> is captured. Assets (logo, wordmark, app icons) are still pending.

> **Update #6 (2026-10-13) — Notes ships + brand assets.** App #2 is real: **Notes**
> (`apps/notes`, `nucleus.notes`, category `text`, alpha, inspired by OneNote) — a Markdown
> notebook with notebooks/folders, undo/redo and full-text search, running as a local server app
> with `readyPath /api/state`. It was delivered as a full design→build handoff (code + assets),
> then re-verified line-by-line against `@nucleus/core`'s actual API, recompiled under the repo's
> strict TS config and smoke-tested over HTTP before merge. The roadmap now dedupes discovered
> apps via `mergeRoadmap` (`packages/launcher/src/roadmap.ts`), so a real app hides its planned
> card instead of listing twice. Brand assets landed in `docs/brand/` (logo PNG + `nucleus.svg`)
> and `docs/brand/icons/` (7 recolored SVG icons on the token palette: INK `#0B0E14`, SURFACE
> `#151B26`, TEXT `#E7ECF5`, ACCENT `#6D5EF8`, CYAN `#22D3EE`, RUN `#34D399`, AMBER `#F59E0B`);
> every app icon is token-native. *(The palette in this sentence is superseded by Update #11.)* **Provenance strip:** the handoff packed C2PA metadata
> (81-89 % of SVG weight + a `caBX` chunk in the PNG) — `tools/strip-c2pa.mjs` removes it from
> SVGs (`<metadata>` + `xmlns:c2pa`) and PNGs (text/`eXIf`/`caBX` chunks, CRCs re-verified) for
> anything committed to the repo. The short TikTok promo clips keep their provenance labels on
> purpose (platform AI-labeling rules) and live outside the public checkout.

> **Update #7 (2026-10-13) — the launcher goes native in Rust (M1).** Inspired by the open-source
> ArtCraft Launcher (craft-launcher 0.3.2, MIT/Apache-2.0 code, trademarked brand), the launcher is
> being rebuilt as a standalone native app in **`launcher-rs/`** — own branding, own app set, own
> architecture (two crates, egui/eframe 0.32 glow backend), so nothing is copied from ArtCraft. M1
> (discovery + Open/Stop) is **built, green and verified locally**: `cargo check` and
> `clippy --all-targets -- -D warnings` clean, **47 unit tests passing** (incl. a real node
> spawn/kill-tree), `--smoke` reports 3 real apps + 1 planned (4 cards) and locates node, and the
> release binary is ~6.8 MB. To link it, MSVC Build Tools + rustup were installed (rustup 1.29.1,
> rustc/cargo 1.99.0 stable-msvc); CI runs on `windows-latest` via
> `.github/workflows/launcher-rs.yml` (fmt + clippy + tests + release build, path-filtered on
> `launcher-rs/**`). The Node launcher remains the daily driver until **M2** (catalogue +
> `.nucleusapp` install/update) lands; the full spec, data model and M1/M2 semantics live in
> `launcher-rs/SPEC.md`.

> **Update #8 (2026-10-13) — launcher UI rebuilt to the reference design language.** The M1 UI was
> functional but did not look like the launcher it takes its cues from, so it was rewritten around a
> flat, hairline-based system: **square corners everywhere** (`CornerRadius::ZERO`), **1 px rules**
> instead of fills or shadows, a single **accent blue `#2D81FF`**, and **mono uppercase HUD labels**
> (11 px, ~0.15 em tracking). Two embedded token sets (`Tokens::dark()` / `Tokens::light()`) drive a
> light/dark toggle from the header; three OFL typefaces ship inside the binary —
> **Archivo** (display), **Inter** (body), **Geist Mono** (HUD) — with their `OFL-*.txt` licence
> files next to them. The window is now three panels: a 48 px header (brand mark + wordmark, view
> switch, theme toggle), a 34 px control row (filter cells with counts, search, sort), a central
> grid (gapless 320 x 280 cards sharing their borders, hover-only lift with an app-coloured top
> rule) or a **6-column table**, and a 34 px footer (counts, node facts, runtime log + live URLs).
> `views.rs` owns the layout, `widgets.rs` the primitives, `theme.rs` the tokens and fonts.
> Still green: `clippy --all-targets -- -D warnings` clean, **56 tests** (24 launcher + 32 core),
> release binary ~12.2 MB (fonts are embedded). M2 (catalogue, `.nucleusapp`, install/update) is
> next; the details drawer and motion hooks from the reference are deliberately not replicated yet.

> **Update #9 (2026-10-13) - own brand mark, legible icon tiles, calmer header.** Pixel-level
> inspection of a live capture (the agent cannot read images, so the window is captured with
> `PrintWindow` and classified against the token palette) found two real defects. **(1)** The control
> row used a bare `with_layout(right_to_left)` which claimed the whole remaining height and
> vertically centred itself, leaving the central panel empty; the header and toolbar now allocate an
> explicit `CONTROL_H` strip and lay their contents out inside `scope_builder`. **(2)** App icons are
> 512 px SVGs painted on their own dark plate (`#0B0E14`), so they read as dark slabs on a dark page:
> `widgets::icon_tile` now frames every icon in a tinted well (`blend(sunken, app_colour, ~0.2)`) with
> a `line_strong` hairline and an 8 % inset. The header is now a brand lockup - a 26 px orbit mark
> (`assets/brand/mark.svg`, transparent plate, tuned for small sizes), the wordmark, an outlined
> `v0.2.0` chip and a faint subtitle - with only the view switch and the theme toggle on the right,
> so a single inverted block remains. `assets/brand/nucleus.svg` (plated) still supplies the window
> icon via `ViewportBuilder::with_icon`. **61 tests** (29 launcher + 32 core); the toolbar height and
> grid geometry are now covered by unit tests so the empty-page regression cannot come back.

> **Update #10 (2026-10-13) — our own signature: brand violet, orbits, reticles.** Update #8 borrowed
> the reference's visual language closely enough that the result read as a clone, so the chrome now
> carries a mark of its own. The accent is the **brand violet `#6D5EF8`** — the nucleus colour of the
> logo — in both themes, and it is *reserved for the launcher's own chrome*: the active view cell, the
> active filter cell, primary actions and hovered glyph buttons are solid violet instead of white
> blocks, while the app palette keeps the violet out (the Image category, and its roadmap entry, move
> to pink `#F472B6`). The `invert_bg`/`invert_fg` token pair collapsed into **`accent` /
> `on_accent`**. Two motifs carry the identity: every icon tile wears an **orbit** — a hairline ring
> circumscribing the icon with a satellite dot, faint at rest and bright under the pointer
> (`widgets::icon_tile`) — and the hovered card plus the four corners of the window frame wear
> **corner brackets** (`widgets::brackets`: the card's fade in with the existing hover animation, the
> frame's are painted in a `Foreground` layer). The card's top-edge hover rule is gone. Version bumped
> to **0.3.0** for the release; 62 tests green at the tag, clippy clean.

> **Update #11 (2026-10-13) — the designer icon set, and a publishable binary.** The brand assets now
> come from the designer's handoff instead of our own token recolouring, which supersedes the palette
> sentence of #6. The handoff's plates were re-tinted to the *category* colours the launcher already
> uses (`widgets::category_color`) so an icon, its card and its roadmap entry finally agree: System
> violet `#6D5EF8` (white nucleus), Text `#8AB4F8`, Pdf `#E85A6C`, Audio `#34D399`, Image `#F472B6`,
> Layout `#C084FC`, Vector `#22D3EE`, Video `#F59E0B`. Every glyph is ink `#0B0E14` except on the
> violet plate, where it is white — measured, not guessed (4.56:1 white vs 4.24:1 ink). The plate
> geometry, and the header mark, are untouched: `mark.svg` must stay unplated to read at 26 px on both
> themes. `docs/brand/logo.png` carries the violet plate, `docs/brand/icons/` gained the Notes and PDF
> Workbench icons (7 app icons beside the launcher's `nucleus.svg`), and C2PA metadata is stripped
> exactly as in #6.
> **Release hygiene.** A plain `cargo build --release` bakes the build machine's absolute paths into
> the artifact through `file!()` and panic locations; the published v0.3.0 binary contained 722
> occurrences of the maintainer's profile path. Releases are now built by `scripts/build-release.ps1`,
> which passes `--remap-path-prefix` (the prefix is read from `$env:USERPROFILE`, so it is never
> committed either), and the release profile sets `strip = true`. The script verifies the result and
> fails if the account name survives in the binary, so this cannot ship again unnoticed.

> **Update #12 (2026-10-17) — M0 truth & safety.** An external audit re-verified against the code
> found a set of gaps that had been described as done. Corrections land in this update:
> **Notes was overclaimed** in #6 and in the README — it is a single Markdown note list with
> undo/redo, preview and export; there are no notebooks/folders and no full-text search. The README
> row now says what the code does (finding F9). The two apps **bound every interface** rather than
> loopback (F5): `server.listen(PORT)` became `server.listen(PORT, "127.0.0.1", …)`. Both apps gained
> a shared **request guard** (`src/guard.ts`) that enforces a Host allowlist, a same-origin check,
> `application/json` on writes and a per-launch bearer token (or `nt` cookie) — closing the
> localhost-reachable, page-driven command bus (F6). The launcher (Rust and TS) mints the token,
> passes it as `NUCLEUS_TOKEN` plus `?t=` in the window URL, and sends it on the readiness probe;
> the app swaps `?t=` for an `HttpOnly` cookie and redirects. Notes' newest-first sort was inverted
> (F1), its Markdown preview escaped *after* inserting markup (F3, XSS via notes an agent wrote),
> and its editor could clobber unsent typing when a save round-trip landed mid-keystroke (F4, now
> guarded by `localRev`/`sentRev`). Autosave flooded undo — one step per keystroke (F2) — so
> `CommandBus` history entries now carry a coalescing key and window; `note.update` declares
> `coalesce: { key: (p) => p.id, windowMs: 2000 }` and a burst collapses into one undo step. The
> remaining audit findings (F7 persistence, F8 accent drift, F10 anonymous history, F11 no param
> schemas, F12 non-deterministic ids, F13 PDF-only MCP, F14 duplicated HTTP boilerplate, F15 PDF
> gaps) are tracked for their milestones, not silently dropped.

> **Update #13 (2026-10-19) — the Open bug: bundles that run anywhere, failures that speak up.**
> Three user-facing fixes landed together. **(1)** Published `.nucleusapp` archives shipped an
> unbundled `dist/server.js` importing workspace packages with no `node_modules`, so on any machine
> without the checkout the server died instantly with `ERR_MODULE_NOT_FOUND` and **Open looked
> broken**; apps are now bundled self-contained at pack time (`npm run bundle:apps`, esbuild, node
> built-ins external), and `pack.rs` **refuses** a server payload that still imports `@nucleus/*`
> — the guard has tests. Bundles republished as **`apps-v0.1.1`** from audited source
> (loopback-only + token guard; the v0.1.0 ones predated the audit).
> **(2)** A node process that dies before readiness used to surf as a silent 20 s timeout and one
> faint footer line: `spawn_node` pipes stderr, a tail-reader thread keeps the last bytes without
> ever blocking the child, and `reconcile()` now reports `Event::Failed` **immediately** with exit
> code + stderr tail; `Running.ready` splits "died during launch" from "stopped", and a test spawns
> a server that exits with code 3 and asserts the fast failure.
> **(3)** `nucleus-shell.exe` + `nucleus.ico` resolve **next to the launcher exe** too
> (`paths.rs`), and both ship in the installer and the portable ZIP (`nucleus.iss`, `make-setup.ps1`)
> — catalogue-only machines get native WebView2 app windows instead of a browser fallback.
> Also this day: the installer creates the desktop shortcut by default; GitHub releases cleaned to
> one launcher release (`v0.4.0-alpha`, now *Latest*, no pre-release flag) + one bundle release;
> `README.md` rewritten, `CONTRIBUTING.md`, issue/PR templates and repo description/topics added.
> Verification: `cargo fmt --check`, `clippy -D warnings` clean, **109 tests**  green; `npm run build && npm run bundle:apps && npm run check:apps` PASS for all three server apps; shipped
> payload re-verified from extracted archive.

> **Update #14 (2026-10-19) — Core v2 (M1): the bus gains evidence, trust and a rewind button.**
> This closes the core half of the audit on one sweep (`packages/core`, `packages/control`, `+@nucleus/notes`'s
> first test suite). **Schemas (F11):** every command descriptor now carries `params`/`result` JSON-Schema
> (a ~90-line validator in `@nucleus/core`, *no new dependency*, errors list *all* offending fields) plus
> `examples` — `command.describe` is now a machine-readable contract for the 12 existing commands across
> core, notes and PDF. **CAS + provenance (F10, D-protocol):** `invoke` accepts `expectedDocVersion`
> (mismatch → `kind: "conflict"`, details carry `{expected, actual}`), an explicit `actor` and a `label`;
> every applied change appends an attributable **tape record** `{seq, ts, actor, label, command, params,
> docVersionAfter, redo, undo}` — replay applies the recorded *patches*, never re-runs commands (F12 held
> harmless). **Transactions (F14):** `bus.transaction(label, actor, fn)` wraps N invokes into ONE undo
> step and ONE tape record; failure rolls patches *and* docVersion back entirely. **Coalescing hardened:**
> bursts only merge when the actor is the same. **Proposals (§3.2):** agent commands run dry into a
> `Proposal` (patches + touched-node snapshots + `baseVersion`); a human `accept` applies it as a normal
> undoable entry, `reject` discards; accepting after anyone touched the same nodes marks it **stale** and
> returns `kind: "conflict"` — never silently overwritten. Trust policy via `needsReview` (`ask`/`writes`/
> `autopilot`; destructive is *always* reviewed). **Time travel:** `tapeStateAt`/`replayTape` rebuild the
> document from an empty start (patches carry full node content), a `tape.restore` *command* diffs the
> live doc against any past seq and appends — history is never rewritten — plus a property test:
> **replay == live state** over 60 randomized operations. The `ControlServer` surface grows accordingly
> (`command.describe` with schemas, `command.invoke` with actor/dryRun/label/CAS, `tape.list|seek|fork|
> restore`, `proposal.list|accept|reject|acceptAll`, `doc.snapshot`) behind the same transport-agnostic
> `handle()`.

> **Update #15 (2026-10-19) — App-Kit (M2): one HTTP skeleton for every app, persistence and a rewindable web kit.**
> The audit's **F14** (both apps duplicated ~200 lines of HTTP boilerplate) and **F7** ("nothing persists")
> are closed by a new workspace package, **`@nucleus/app-kit`**, and both apps rewritten on top of it
> (each `server.ts` now ~90–115 lines). `createAppServer({id, name, publicDir, createSession, routes, …})`
> provides: 127.0.0.1-only binding; the request guard **lifted out of the apps** (Host allowlist, same-origin,
> token; content-type rule extended to `application/pdf|octet-stream` for the day §5.1 switches uploads to
> raw binary); the `?t=`→HttpOnly-cookie handshake; and the **standard API surface** — `GET /api/state`,
> `POST /api/op` (CAS, dryRun, actor/labels via the M1 `ControlServer`), `/api/undo|redo|reset`,
> `GET /api/tape` + `tape/seek|restore|fork`, `GET /api/proposals` + `proposals/:id/accept|reject`,
> `GET /api/describe` (full schema'd catalogue), `GET /api/events` — **zero-dependency SSE** with 15 s
> heartbeats streaming `command`/`proposal`/`state` frames. **Persistence (F7):** documents autosave to
> `%APPDATA%\Nucleus\docs\<appId>\` as `document.json` (atomic temp+rename) plus append-only `tape.jsonl`
> (appends serialized in order; a torn last line never corrupts the good prefix); relaunch restores both
> — undo stays session-scoped, the tape timeline survives via the new `bus.importTape` — and `/api/reset`
> starts clean. **Legacy opens (migration):** `POST /api/project` still accepts `nucleus.project` and
> `nucleus.notes.project` v1 files, so nothing written before this update is stranded; the same endpoint
> keeps roundtripping those formats wholesale (base64 assets included). **`.nucleus` export:** one ZIP
> (`document.json` manifest `nucleus.doc` v2, `tape.jsonl`, content-addressed `assets/<sha256-hex>.<pdf|bin>`)
> built with the pre-approved `fflate`, deduped by hash. **Shared web kit:** `/_kit/kit.js|css` (vanilla,
> launcher palette tokens) adds a **tape scrubber** (seek preview → restore/fork), a **review drawer** for
> pending agent proposals (A/R keyboard), SSE-driven refresh and toasts; apps mount it with one script tag,
> `createAppServer` serves `/_kit/*` from the app's `public/_kit` (bundler copies it into payloads) falling
> back to the package copy. App-specific routes (notes' Markdown export, PDF's base64 load/export) stay in
> the apps. Verification: `npm run verify` PASS (36 tasks incl. cross-app demo); TS suites now **156** —
> core **68** (incl. `importTape`), control 14, notes 6, pdf 9, federation 10, launcher 16,
> **app-kit 33** (guard lifted with its tests, e2e route/SSE/persistence/migration/ZIP suites) — Rust side
> untouched (110 tests).

> **Update #16 (2026-10-19) — Bus in the launcher, single-instance (M3-lite; satellite dé-scopé).**
> The §4.4/§4.5 contract lands in three layers. **Pure (core):** a new I/O-free `bus` module in
> `nucleus-launcher-core` — an incremental **SSE line parser** (event/data/multi-data/comments/CR),
> frame **classification** (`command` tape records → actor/command/label; `proposal` → status; heartbeats
> noise), `pending_delta` for the open-review counter, the **run-registry record**
> `{id, name, port, token, pid, startedAt}` (camelCase wire) with self-healing parse, and a chrono-free
> RFC 3339 writer (days-from-civil, leap-day tested). **Engine (launcher):** `Running` gains
> `name/token/startedAt`; every start/stop/exit **rewrites `%APPDATA%\Nucleus\run\apps.json` atomically**
> (tmp+rename, full replace — corrupt files heal on the next change) per §4.4, which is exactly what
> the M4 MCP proxy will read; after a server app's readiness probe answers, `Runtime::start_bus`
> spawns **one subscriber thread per app** (ureq `into_reader()` streaming) that pushes classified
> frames into the existing `Event` channel as `Event::Command` / `Event::Proposal`. **UI:** a third
> view, **Bus** (nav link shows the pending-review badge when > 0) — a live feed, newest first, of
> time · actor badge (`AGENT · user` in accent cyan for `agent`, neutral ink for `human`) ·
> command+label · app · status pill (`APPLIED` good / `PENDING` warn / accepted info / rejected faint),
> with a summary strip (running count + per-app pending review). The **living satellite** (§4.5 tile
> animation) is deliberately **de-scoped from M3-lite** per decision — activity classification stays
> in the feed. **Single-instance:** app-kit refusal (two processes writing one persisted document is
> the one silent-corruption path M2 opened): `createAppServer` takes an O_EXCL lock
> `<dataDir>/locks/<appId>/owner.json` ({pid, startedAt}) — dead-owner takeover via `process.kill(pid, 0)`,
> corrupt owner = stale, corrupt-but-alive keeps the original file — and the launcher fails fast:
> second same-app launch **exits 3** (Update #13 pre-ready failure semantics); tests prove cross-process
> refusal, takeover, per-id keying and the e2e double-instance case. On the launcher side
> (§4.5 "Single-instance lock"): an advisory lock on `%APPDATA%\Nucleus\launcher.lock`
> (`std::fs::try_lock`, auto-released on process death, no native mutex dep). **Testing:** core lift 110 → 126 Rust tests (bus 16 + SSE e2e against a local fake app-kit stream + launcher-lock unit);
> TS 156 → 163 (app-kit 33 → 40: lock suite + double-instance). `apps/launcher` + `packages/launcher` (TS)
> are now formally legacy surfaces and marked deprecated in their READMEs.

> **Update #17 (2026-10-19) — Craft UI (interlude milestone): the apps get the launcher's chrome.**
> Both app frontends were rewritten to the reference design language (distilled from the ArtCraft
> conventions — organize-page cards, docked panels, command palette, mono status bars — re-implemented
> from scratch, no code copied): a shared **`craft.css` design system** ships in `@nucleus/app-kit/kit`
> (tokens `--c-*` mirroring the launcher palette, light/dark via `data-theme` with system-preference
> fallback, app shell = toolstrip + rail/canvas/inspector + status bar, hard edges, hairlines, one
> accent per app via `--nk-app-accent`). A **⌘K command palette** joins the web kit (`kit.js`):
> it reads `GET /api/describe` once, filters every bus command as you type, and builds an inline
> params form straight from the command's JSON Schema (strings/numbers/booleans; arrays via JSON or
> comma lists) — so *every keyboard-driven action goes through `/api/op` exactly like an agent's*
> (§3 philosophy: human and agent drive the same bus). **PDF Workbench** becomes an "Organize pages"
> workbench: sources rail (import + per-source filtering), page cards with thumbnails (pdf.js,
> lazy via IntersectionObserver), click/ctrl/shift selection, batch rotate/remove as labelled
> one-step-each command sequences, drag-to-reorder (drop computes the post-removal insert index),
> a sticky selection bar, an inspector (page props / selection / document), zoom S/M/L,
> file drop-import, and a mono status bar. **Notes** becomes a three-pane editor: rich note rows
> (title + snippet + relative date, newest first), search strip, Write/Split/Read modes (Ctrl+E
> cycles) with a live debounced markdown preview, a writer's insert toolbar (H2/B/I/code/lists/
> quote/link/snippet, Ctrl+B/I), an inspector (created/updated/words/chars/lines/node id) and the
> F4 save-generations logic kept verbatim. Kit components (scrubber, review drawer, toasts, SSE
> refresh) are untouched and co-exist with the new chrome; all bus/server/core code and schemas
> are untouched (no new commands, no state changes). Gates: `npm run verify` PASS; TS suites
> unchanged at **163** (frontends remain unmeshed vanilla JS); app smoke checks PASS for all three
> servers; Rust untouched (126).
>
> *Superseded in part by Update #18: the toolstrip + inspector chrome described here is replaced by
> the shared shell (menu bar, contextual options bar, Properties panel, icon rail, History panel).*

> **Update #18 (2026-10-24) — UI pass, part 1 (U1): one shell for every app, and a vocabulary that
> stops leaking.** The maintainer's verdict on the craft chrome ("the apps' UI is horrible, hard to
> understand") traced to structure, not to colour: **25** `c-btn`s in PDF Workbench's toolstrip, four
> ways to add a file, every action implemented up to three times (toolstrip, selection bar,
> inspector), and internal words (`TAPE · Restore here · Fork · Live`, "every action is a bus
> command", "N node(s) touched") sitting in the UI. `@nucleus/app-kit` now ships **`kit/shell.js`**, a
> declarative shell (`NucleusShell.mount({ app, menus, primary, options, rail, panels, status,
> enabled, noun, highlight, main })` + `setContext`) that owns the whole frame: WAI-ARIA **menu bar**
> (roles, arrow keys, Esc, typeahead, roving tabindex), a **contextual options bar** that can only
> reference menu ids, one **shortcut registry** (duplicate shortcuts throw at mount; `Ctrl+K` is
> reserved for the palette), **confirmation dialogs** for `danger` items (never in the options bar),
> a right-click menu reusing the same registry, an **icon rail** (inline stroke SVG set, no emoji),
> **Properties = information, never actions**, and a status bar. Internals move behind *View →
> Developer details* (`[data-dev]`, `body.nk-dev`). The kit's fixed bottom scrubber is gone: **History
> is a panel** (actor badge — cyan `--nk-ai` when an agent did it —, plain label, relative time,
> *Go back to this point*, *Start a copy from here*, *Back to now*), and a pending proposal is an
> inline **card** (`<actor.id>’s proposal`, the app's noun, Accept/Reject on `A`/`R`), not a drawer.
> `Ctrl+K` now lists **menu items + bus commands de-duplicated by id** (a menu item declares the
> `command` it wraps). Tokens: `--c-sans` with **Inter embedded locally** (`kit/fonts/Inter-Variable.ttf`
> + OFL, `@font-face`, no remote asset, `font/ttf` MIME), mono demoted to numbers/shortcuts/code,
> every text token re-tuned to clear **WCAG AA on every surface in both themes** (`--c-faint`
> `#5f5a74` → `#9490aa` was 2.5:1), and `--c-on-accent` switched to dark ink — white on `#F472B6`
> is 2.2:1, ink is 6.9:1. App accents are now their launcher category colours (PDF `#E85A6C`, Text
> `#8AB4F8`, Image `#F472B6`; violet stays launcher-only, cyan is agent-only). New **`GET/POST
> /api/settings`** (`src/settings.ts`) persists `developerDetails`, `theme`, `thumbnailSize`,
> `viewMode`, `collapsedSections`, `panelWidths` to `%APPDATA%\Nucleus\settings\<appId>.json` with an
> allowlist (unknown key → `400 validation`), atomic writes, and no reliance on `localStorage` (the
> launcher picks a new port per launch, so the origin — and every origin-scoped store — changes).
> Gates: app-kit **80** tests (5 new suites: `shell` in jsdom, `settings` over HTTP, `kit` for the
> review card, and the three guards `contrast`, `accent` — parsed from the Rust category table —,
> `jargon`), `npm run verify`
> PASS. The three app frontends migrate in U2–U4; until then the `jargon`/`accent` guards cover the
> kit, with each app added to `MIGRATED` as it lands.
>
> **Update #19 (2026-10-24) — UI pass, part 2 (U2): PDF Workbench moves onto the shell.** The first
> app actually *consumes* `NucleusShell`, and the shrinking is the point: `public/index.html` goes
> **145 → 46 lines** and loses its whole hand-written chrome (toolstrip, second canvas bar, sources
> rail, inspector, status bar), while `app.js` keeps the document model and delegates every frame
> concern to the shell. Chrome buttons: **35 (25 in HTML + 10 built in JS) → 5**, and 4 of those 5 are
> the page-preview overlay's own controls (prev/next/rotate/close); the fifth is the empty state's
> single call to action. The app now has **one** way to add files (File → Add PDFs…, `Ctrl+O`, or a
> drop), one filled **Export PDF** in the menubar, and no duplicated action. The frame is File (Add PDFs… `Ctrl+O`, Open project…, Save
> project `Ctrl+S`, Export PDF `Ctrl+E`, Export selected pages `Ctrl+Shift+E`, Start over… →
> destructive, confirmed, starts a *new* session so it is not undoable) · Edit (Undo/Redo
> `Ctrl+Z` / `Ctrl+Shift+Z`·`Ctrl+Y`, Select all `Ctrl+A`, Clear selection `Esc`, Preview `Space`,
> Rotate left/right `Ctrl+Shift+R`/`Ctrl+R`, Duplicate `Ctrl+D`, Remove pages… `Del` → destructive,
> Reverse order) · View (page size S/M/L with checkmarks, Smaller/Larger `Ctrl+-`/`Ctrl+=`, then the
> standard History `Ctrl+H` / Developer details / Theme) · Help. The **options bar is contextual and
> derived**: no selection → a one-line hint + the S/M/L segment; one page → *Preview page* joins the
> batch actions; two or more → no preview. **`Remove` can never appear there** (danger), and the
> dock/Properties split is gone: *Documents* lists files with page counts (click = filter the board),
> *Find* filters by file name or `#position` without rebuilding its panel (the caret survives because
> the panel is only re-rendered when structure changes), and *Properties* is read-only — position,
> file page, rotation, size, orientation, with the node id and last command behind *Developer
> details*. History is the standard panel; a proposed batch from an agent lands in the review card at
> the top of Properties. Two shell fixes came out of the migration: one action may now answer to
> **several shortcuts** (`Ctrl+Shift+Z` *and* `Ctrl+Y`, validated for clashes across the whole array),
> and the shell no longer steals **Space/Enter** from a focused control (`button`, `a[href]`,
> `role=button|menuitem|tab`, `summary`) — pressing Space on a focused toolbar button must activate
> it, not open the preview. The kit's palette also stopped printing raw ids: a menu item shows its
> **menu name** ("File") instead of `file.add`, and the palette takes the keyboard while it is open so
> `Esc` closes it instead of clearing the selection underneath. Evidence: `npm run verify` PASS
> (**42/42** tasks, **285** TS tests), `node tools/media.mjs --only pdf` regenerated
> `docs/media/pdf-workbench.png` from the real app, and a CDP smoke on the real server (8 pages, two
> files) reports 4 menus, 5 contextual actions on selection, the rail, the History text, a filtered
> board (2 of 8), a rotate → `90°` → `Ctrl+Z` → `0°` round-trip, **zero console logs, zero
> exceptions**. Notes and Image Editor keep the old frame until U3/U4.
>
> **Update #20 (2026-10-24) — UI pass, part 3 (U3): Notes moves onto the shell, and the library
> becomes one dropdown.** The second app, and the one with the most furniture: `public/index.html`
> goes **208 → 70 lines** (`<button>`: **37 → 1**) and `style.css` **453 → 378**, while `app.js`
> stays in the same range (**1350 → 1570**) because the app now *declares* five menus and its panel
> instead of painting a toolbar by hand — every removed control is code the app no longer owns. The
> notebook rail, the 15-button Markdown toolbar, the sort select, the scope segment and the whole
> right-hand inspector are gone: the **filter is one dropdown** above the list (All notes ·
> Favorites · Trash · each notebook · each tag) and the list is a plain `c-row` list with
> multi-select (Ctrl/Shift) and a bulk bar that appears only when something is selected. The frame
> is File (New note `Ctrl+N`, New notebook…, Rename notebook…, Delete notebook…, Save a copy…
> `Ctrl+S`, Open a copy…, Export note…, Export all as Markdown…) · Edit (Undo/Redo, Quick open…
> `Ctrl+P`, Duplicate `Ctrl+D`, Pin, Favorite, Move to trash `Del`, Restore, Delete forever… →
> destructive and confirmed, Clear selection `Esc`) · Format (Bold `Ctrl+B`, Italic `Ctrl+I`, H1–H3,
> lists, task, quote, link, inline code, code block, table, divider) · View (Edit/Split/Preview
> `Ctrl+1..3`, Next layout `Ctrl+E`, sort by updated/created/title, then History `Ctrl+H` /
> Developer details / Theme) · Help. The **options bar** carries the one control a search needs — a
> filter that is not an action — plus the save state, the layout segment and History; its formatting
> row appears only in Edit/Split and only above **1200 px** (below that the Format menu keeps every
> action and the bar stays readable). Autosave speaks plainly — "Saved just now" / "Saving…" /
> "Unsaved changes" — with created/updated/notebook/tags behind a **Details popover** in the editor
> header, words · characters · reading time · notebook in the status bar, and a **640 px measure**
> for both the editor and the preview. Shell changes this round, each earned by the brief: the
> options bar accepts a **`left` node** (a control, never an action; Notes hands it the *same* DOM
> node on every render, so the query and its caret survive), `reviewHost` **docks the proposal card
> inline** above the title instead of in a right panel Notes no longer has, `ask()` gives apps the
> shell's one-field dialog (New/Rename notebook) with values read at click time, the options bar
> **re-reads itself on resize** (debounced), and `setSetting` was missing from the public export —
> PDF's zoom had been throwing silently since U2. A test now pins the public API. Notes joins
> `MIGRATED` in the jargon guard. Evidence: `npm run verify` PASS (**42/42** tasks, **289** TS tests,
> app-kit **88**), `node tools/media.mjs --only notes` regenerated `docs/media/notes.png`, and a CDP
> smoke on the real server (3 notes, 1 trashed) reports 5 menus, 8 contextual actions, the rail, a
> search that filters 3 → 1 and keeps the caret, Preview hiding the textarea and showing the
> breadcrumb, the Details popover with both tags, `Delete forever…` disabled outside the trash, and
> the narrow window (1100 px) dropping to `History` alone with **no overflow** — zero console logs,
> zero exceptions, zero server stderr.

> **Update #21 (2026-10-24) — UI pass, part 4 (U4): Image Editor moves onto the shell, and the
> canvas gets the width it deserves.** The third app, and the first with **no library**: its rail
> picks a *tool*, not a panel, so `public/index.html` drops **146 → 44 lines** (`<button>`:
> **1 → 0** — only two hidden file inputs remain), `style.css` stays flat at **263 → 265** (the
> toolstrip, the floating stage bar and the crop bar leave; the tool panel and the zoom cluster
> arrive) and `app.js` goes **1047 → 1349** because the app now *declares* five menus, the rail and
> its panels instead of painting 1047 lines of chrome by hand. Gone: the brand strip (Open image,
> undo/redo, rotate/flip/reset, palette, save, export), the text tool list with numeric badges, the
> Info panel, the zoom chip / −/+/Fit/Before bar over the picture, the six-button crop bar and the
> global `keydown` handler. The frame is File (Open image… `Ctrl+O`, Open project…, Save project…
> `Ctrl+S`, Export PNG `Ctrl+E` — the one filled action) · Edit (Undo `Ctrl+Z`, Redo
> `Ctrl+Shift+Z` / `Ctrl+Y`, Reset all edits, Image details… `Ctrl+I`) · Image (Rotate left `Shift+R`,
> Rotate right `R`, Flip horizontal `H`, Flip vertical `V`, Crop… `C`, Resize… `S`, Apply crop,
> Cancel crop `Esc`, Whole image, Apply size, Half / Double / Natural size, Neutral adjustments) ·
> View (Zoom in `Ctrl+=`, Zoom out `Ctrl+-`, Fit `Ctrl+0`, **Compare with original** `\` as a checked
> toggle, then History `Ctrl+H` / Developer details / Theme) · Help. The **options bar follows the
> active tool**: Adjust → Neutral adjustments, Filter → the composition note, Crop → the aspect
> segment plus Apply crop / Cancel crop / Whole image, Resize → width × height, a **Linked** toggle
> and a live "→ 900 × 1400 px" preview next to Apply size. **Zoom moved to the status bar**
> (`1400×900 · 5 edits  − 85% + Fit`), which is also where the old numeric badges landed; the Info
> panel became **Image details…** (File, Type, source and output size, rotation, flips, filter, the
> applied edits, and the document id only behind Developer details). One deviation, stated: History
> is the rail's fifth entry (the shell's own panel) rather than a list under the sliders — one
> implementation instead of two, and the right column keeps the active tool while it is open.
> Slider drags now survive the repaint (`op(..., { panels: false })` while the pointer is down, a
> full render on release). Shell changes this round, each earned by the brief: **`.nk-body` places
> its four columns explicitly** — a `display:none` left panel used to slide the canvas into its 0 px
> column, which is exactly what an app without a library does (test pins the four `grid-column`
> rules), `dialog()` joins the public API so an app never invents its own read-only modal, and menu
> toggles expose **`role="menuitemcheckbox"` + `aria-checked`** instead of a glyph hidden from
> assistive tech. `image-editor` joins `MIGRATED` in the jargon guard (and the empty-state copy lost
> its "command on the bus"). Evidence: `npm run verify` PASS (**42/42** tasks, **291** TS tests,
> app-kit **90**), `node tools/media.mjs --only image` regenerated `docs/media/image-editor.png`,
> and a CDP smoke on the real server (one 1400×900 image, 5 edits) reports 5 menus, 5 rail entries,
> 14 Image items with their keys, the crop options bar (6 aspects + 3 actions) with the overlay on,
> the Resize bar reading 900 × 1400, History opening on the left while the right column keeps
> Resize, the palette listing "Rotate right", the details dialog, Neutral → seven zeros → Undo
> restoring 8/16/10/0/18/0/22, `Esc` leaving the crop tool, and the empty state at 0 edits — zero
> console logs, zero exceptions, zero server stderr.

**Codename:** `nucleus` · monorepo root `nucleus` · packages `@nucleus/*`

---

## 0. Executive decision

> Build the MVP as a **TypeScript monorepo** (pnpm + Turborepo) with a **Tauri v2** desktop shell,
> the core in TypeScript behind a hard "replaceable native module" seam, and a **single command
> bus** exposed via **CLI + JSON-RPC + MCP**. Target end-state is a Rust-core hybrid; do not start there.

Why:
- No Rust installed + speed-to-MVP dominates → authoring in TS is far faster to first working command.
- Agent-driven development (opencode) iterates on TS/JSON far faster (no slow `cargo build` loop).
- A TS core runs in the browser for free; heavy modules migrate to Rust→WASM later behind the same seam.
- ArtCraft parity is the finish line, not the on-ramp.

---

## 1. Stack recommendation

| | A. Pure Rust (wgpu/egui/iced) | **B. TS monorepo + Tauri v2** | C. Hybrid Rust-core + TS/Web UI |
|---|---|---|---|
| MVP speed | very slow | **fastest** | moderate |
| Native, no Electron | full | WebView2 (not Electron) | full |
| Perf ceiling | best | WebView/WebGPU ceiling | best |
| Toolchain now | needs rustup+cargo | needs rustup (shell only) | needs rustup + napi/wasm |
| Agent iteration | slow compile loop | **hot reload, fast tests** | core loop slow |
| WASM/browser | possible | heavy ops not browser-ready | by construction |
| Risk | high for MVP | **low** | medium (two toolchains + FFI) |

**Verdict:** **B now, C as target, A never as a rewrite.** Tauri still needs the Rust toolchain to
*build* (one-time `rustup`, ~15 min); author zero Rust initially.

**WASM note:** orchestrator, document model, command bus, serialization and most UI logic are
browser-native already (TS). Heavy modules (RAW, video, GPU compositing) go behind the
`Renderer`/`Codec` abstraction so a WASM backend is additive, never an assumption.

---

## 2. Repo structure

> **Target layout.** Anything marked `(future)`, plus the packages that are not in the checkout yet
> (`control-rpc`, `control-federation` was added in 2026-10, `renderer`, `manifests`, `ui-kit`,
> `sdk`, `testkit`), is a plan — not code. For what exists today see the monorepo layout in
> [`README.md`](./README.md) and the measured numbers in [`docs/scoreboard.md`](./docs/scoreboard.md).

```
nucleus/
├─ package.json / pnpm-workspace.yaml / turbo.json / tsconfig.base.json
├─ .github/workflows/ci.yml          # windows-latest primary
├─ .opencode/mcp.json                # register MCP server with opencode
├─ schemas/                          # SINGLE SOURCE OF TRUTH (JSON Schema)
│  ├─ command-descriptor.schema.json
│  ├─ app-manifest.schema.json
│  ├─ document.schema.json
│  ├─ control-protocol.schema.json
│  └─ error.schema.json
├─ packages/
│  ├─ core/          # document model, graph, command bus, undo, serialize
│  ├─ core-native/   # (future) Rust napi/wasm seam — Phase 7
│  ├─ renderer/      # rendering abstraction + backends (cpu/canvas/webgpu)
│  ├─ control/       # ControlServer: transport-agnostic session/invoke/subscribe
│  ├─ control-cli/   # frontend #1: CLI
│  ├─ control-mcp/   # frontend #2: MCP server (stdio; shipped 2026-10) + per-app tools
│  ├─ control-federation/ # frontend #3: MCP server across apps, one undo journal (shipped 2026-10)
│  ├─ control-rpc/   # (planned) JSON-RPC 2.0 over pipe + WS — README only today
│  ├─ launcher/      # discovery/install/update/sign
│  ├─ manifests/     # manifest types, validation, registry client
│  ├─ ui-kit/        # shared UI + design tokens
│  ├─ sdk/           # public SDK for 3rd-party app authors
│  └─ testkit/       # fixtures, golden images, protocol conformance
├─ apps/
│  ├─ pdf-workbench/ # PROOF APP #1 (headless-testable)
│  └─ image-editor/  # PROOF APP #2 (Phase 6, de-risks rendering)
├─ rust/             # cargo workspace — created only in Phase 7
├─ tools/            # codegen, validators, release scripts
├─ examples/         # sample docs, agent scripts, MCP transcripts
└─ docs/             # architecture, protocol, app-authoring guide
```

**Rules:** `schemas/` is the source of truth (codegen TS types, CLI help, MCP tools, docs).
`core` never imports UI/transport. `control-*` never imports app code. Apps depend on `core` + `sdk` only.

---

## 3. Shared core modules (`@nucleus/core`)

Everything flows through commands; **no direct document mutation anywhere else.**

| Module | Responsibility | Key decision |
|---|---|---|
| `document` | root aggregate: metadata, nodes, assets, selection, `docVersion` (CAS) | runtime = flat `Map<NodeId,Node>` + child index |
| `model/graph` | node/layer tree; invariants (acyclic, parent exists, dense order) | tree now, DAG refs later |
| `command` | registry, descriptor lookup, validation, middleware, execution, events | pure handlers `(state, params, ctx) → {patches, events}` |
| `history` | undo/redo | inverse-patch + snapshot checkpoints; entries tagged `{actor, label, requestId}` |
| `serialize` | persistence + versioning | `.nucleus` = ZIP(manifest.json + canonical document.json + content-addressed assets + oplog.jsonl) |
| `render` | rendering abstraction | backends `cpu-headless` (mandatory), `canvas2d`, `webgpu`, later `wgpu` |
| `events` | typed event bus | drives UI, RPC subscriptions, MCP notifications |
| `assets` | content-addressed store | hash-addressed, dedup, integrity |
| `log` | append-only command log (JSONL) | **base doc + command log = deterministic replay** — backbone of undo/MCP/co-editing |

**CPU-first renderer is the most important testability decision** — lets CI and opencode verify
output headlessly (`render --to png --headless`) with zero GUI.

---

## 4. Unified control layer

**One bus, one `ControlServer`, three thin frontends. No business logic in frontends.**

```
CLI ─┐
RPC ─┼─► ControlServer (invoke / describe / list / subscribe / cancel / handshake)
MCP ─┘        │
              ▼
          CommandBus ─► handlers ─► document + history + events
```

- **CLI:** `nucleus serve`, `nucleus cmd <name> --json '<params>'`, `nucleus list|describe`, `nucleus run <script.oplog>`, `nucleus render`.
- **JSON-RPC 2.0 IPC:** Windows named pipe `\\.\pipe\nucleus-<appId>-<pid>` (Node `net`), Unix socket elsewhere, plus loopback WS for browser/debug. Token file (user-only ACL), loopback-only.
- **MCP:** see §5.

**Command descriptor schema** (`schemas/command-descriptor.schema.json`):
`name` (dotted, namespaced), `title`, `description`, `params` (JSON Schema), `result`,
`examples`, `sideEffects` (`read|write|destructive`), `reversible`, `requires` (capabilities),
`since`/`deprecatedIn`/`removedIn` (semver), `mcp` mapping hints, `authorization`.
Registry is self-describing → CLI help + MCP tools + docs are **generated**, zero drift.

**Versioning:** two independent versions — app semver and **control protocol semver** (negotiated at
handshake). Within a major: additive only; renames = add new + deprecate + alias for one major.
Document format versioned separately with explicit migrations.

**Error format** (JSON-RPC envelope, stable machine contract in `data`):
`{ code, message, data: { kind, command, params, details[], retryable,
expectedDocVersion, actualDocVersion }, id }`. Codes `-32000..-32099` reserved for nucleus.
Concurrency conflict → `kind:"conflict"` + versions → agent re-reads and retries (CAS).

**Provenance:** every command carries `actor: { kind: human|agent|system, id, session }` →
audit, per-actor undo, isolated agent sessions.

---

## 5. MCP server (`@nucleus/control-mcp`)

- **Transport:** stdio (primary — opencode launches it) + **Streamable HTTP** (secondary, loopback by default).
- **SDK:** official TypeScript MCP SDK now; Rust `rmcp` later only if the core goes native. Keep the adapter thin (tools → `bus.invoke`).
- **Tool naming:** MCP forbids dots → deterministic mapping `doc.addNode` → `doc_add_node`; `mcp.toolName` can override.
- **Critical decision — do NOT expose every command as a tool.** Expose a curated ~15–30 primary
  tools + a generic escape hatch + discovery tools (progressive disclosure):
  - Primary: `doc_open`, `doc_query`, `doc_apply` (batch), `render_export`, `session_undo`, `session_info`
  - Generic: `cmd_invoke(name, params)`
  - Discovery: `cmd_list`, `cmd_describe(name)`
  - Lifecycle: `app_list`, `app_open`, `app_close`
- **Resources:** current document JSON, selection, command catalog, rendered preview images.
- **Event handling:** stdio is request/response — prefer `session_wait_for_idle` + `doc_query` polling over server push for correctness.

**opencode loop:** register stdio server → list tools → `doc_query` → `doc_open` → `cmd_describe`/`doc_apply` → `render_export` → agent reads returned image → iterate. Human UI talks to the **same core** via RPC → live co-editing, `actor`-tagged, fully auditable via oplog.

---

## 6. Launcher

- **Discovery (priority):** dev `apps/*` (`NUCLEUS_DEV=1`) → bundled → `%APPDATA%\Nucleus\apps\<id>\<version>\` → signed remote catalog.
- **Manifest `nucleus.app.json`:** `id`, `name`, `version`, `icon`, entrypoints, **`coreApiVersion`** (ABI major), `protocolRange`, `permissions`, `capabilities`, `minShell`, `updateChannel`, `integrity` (sha256), `signature` (ed25519).
- **Install/update:** `.nucleusapp` bundle (ZIP) verified (hash + signature) **before** install; **atomic** stage→verify→move→repoint `current` junction; keep prior version for rollback.
- **Core sharing:** launcher ships **one core host**; apps are plugins declaring `coreApiVersion` (major must match). Loader refuses mismatched majors with a clear error.

---

## 7. Proof app: **PDF Workbench**

Chosen because it is **headless-testable** (no GPU), exercises **every** core subsystem
(document model, ordering, command bus, undo, serialize+migrate, oplog replay, RPC, MCP,
error/CAS), is deterministic for golden tests, has real utility, and a permissive license path
(`pdf-lib` MIT, `pdfium` BSD, `pdf.js` Apache — avoid AGPL).

Command surface: `pdf.open`, `pdf.split`, `pdf.merge`, `pdf.rotate`, `pdf.reorder`, `pdf.extract`,
`pdf.redact`, `pdf.metadata`, `pdf.export`, `render.pageToPng`.

**Why not start with the image editor?** It front-loads GPU/rendering risk — exactly what we deferred. Prove control first, then rendering. Image editor is proof #2.

---

## 8. Phased roadmap (person-days, 1 dev + opencode)

| Phase | Name | Deliverables | Exit criteria | Effort |
|---|---|---|---|---|
| **0** | Foundations | repo, pnpm+Turbo, tsconfig, `schemas/` skeleton, CI, `.opencode/mcp.json`, install `rustup` | empty workspace builds+green in CI | 3–5 d |
| **1** | Core MVP | document, graph, command bus, history, serialize (+oplog), CPU render stub, testkit | headless deterministic replayable core; round-trip/migrate tests pass | 10–15 d |
| **2** | Control layer | `control`, `control-rpc` (pipe+WS+token), `control-cli` | drive every core command from CLI end-to-end | 5–8 d |
| **3** | MCP | `control-mcp` (TS SDK, stdio+HTTP), curated tools + `cmd_*`, resources; wire into opencode | **opencode builds a PDF via tools**; transcript committed | 4–6 d |
| **4** | Proof app UI | `apps/pdf-workbench` Tauri v2 shell + minimal UI | native PDF app; **human + agent drive same doc** | 10–15 d |
| **5** | Launcher | manifest, discovery, `.nucleusapp` install/update/rollback, signing, multiplexed MCP | launcher installs/runs PDF Workbench + a stub 2nd app | 7–10 d |
| **6** | Harden + app #2 | image editor proof, WebGPU backend, ABI versioning, perf, public `sdk` | two apps on one core | 15–20 d |
| **7** | Native core (opt.) | Rust napi/wasm hot modules, `wgpu`, `rmcp`, WASM/browser | measurable hot-path win | 20+ d |

**Phases 0–4 → genuinely usable nucleus with one solid proof app: ~6–8 weeks.**

**Milestone gates:** M1 (end P1) core deterministic/replayable · M2 (end P3) agent authors a doc
*without a GUI* · M3 (end P4) human+agent co-edit a native app · M4 (end P5) nucleus becomes a platform.

---

## 9. Key risks

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| 1 | **OneDrive vs build caches** (node_modules/target/.turbo/OneDrive sync storms, locks, corrupt builds) | High | move caches to local disk (junction / env dirs) **or** exclude repo from OneDrive sync — decide in Phase 0 |
| 2 | Tauri needs Rust despite "no Rust" | Med | install `rustup` in Phase 0; minimal `src-tauri`; author zero Rust; fallback Node+WebView2 host |
| 3 | WebView perf ceiling for RAW/video/VFX | Med | heavy ops behind `Renderer`/`Codec` backends; WebGPU; benchmark before committing |
| 4 | headless vs GPU render divergence | Med | CPU renderer for tests only; golden images with tolerance; parity suite in CI |
| 5 | descriptor/protocol/doc drift | High | **generate** TS types, CLI help, MCP tools, docs from `schemas/`; conformance tests |
| 6 | agent tool explosion / context bloat | High | curated tools + `cmd_invoke` + `cmd_describe`; never auto-expose full command set |
| 7 | human/agent concurrent edits clobber | Med | `docVersion` CAS + `kind:"conflict"`; `actor` tagging; isolated sessions; log merge |
| 8 | serialization instability across versions | Med | canonical form + explicit migration chain + fuzz round-trip; never mutate old formats |
| 9 | local IPC security | Med | token file (user-only ACL), loopback-only WS, per-app permissions, destructive confirm, oplog audit |
| 10 | **scope creep (the seven-app temptation)** | High | hard freeze: no app #3+ until M3 |
| 11 | licensing drift (AGPL) | Low | allowlist MIT/BSD/Apache; block AGPL/GPL at dependency review in CI |
| 12 | undo of non-invertible ops | Med | inverse-patch + snapshot checkpoints; `reversible:false` forces checkpoint |
| 13 | named-pipe/WS flakiness on Windows | Low | plain Node `net`; integration tests; token + reconnect |

---

## 10. Decision log

- **D1** TS monorepo + Tauri v2 for MVP (Option B); hybrid (C) as target; pure Rust (A) rejected for MVP.
- **D2** pnpm (Corepack) + Turborepo; npm workspaces fallback; no bun.
- **D3** one command bus; CLI / JSON-RPC (pipe+WS) / MCP as thin frontends.
- **D4** `schemas/` single source of truth → codegen CLI + MCP + docs.
- **D5** curated MCP tools + `cmd_invoke` + discovery; no full command exposure.
- **D6** official TS MCP SDK now; `rmcp` only if core goes native.
- **D7** PDF Workbench = proof #1; image editor = proof #2.
- **D8** flat node table + child index; canonical JSON in ZIP; command `oplog` as replay backbone.
- **D9** launcher ships one core; apps depend on `coreApiVersion` ABI major.
- **D10** resolve OneDrive cache hazard in Phase 0.
- **D11** the launcher wears its own signature (violet chrome, orbit tiles, brackets) rather than
  reproducing the reference UI; the accent is never reused as an app colour.
- **D12** releases (updated 2026-10-19): **one launcher release** — `v0.4.0-alpha` (cross-app
  federation + `.nucleusapp` install engine) is the *Latest* release and is no longer flagged as a
  pre-release; `v0.3.0` and `v0.1.0` were deleted (the TypeScript launcher line lives on in the
  repo + git history, not as a download); the separate `apps-v0.1.0` release keeps the published
  `.nucleusapp` bundles the committed catalogue points at. Superseded launcher releases are deleted
  rather than accumulated.

---

## 11. Immediate next actions (Phase 0)

1. **Confirm OneDrive cache strategy (junction vs exclude) — blocks everything else.**
2. `corepack enable`; scaffold pnpm + Turborepo.
3. Install `rustup` (Tauri build dependency only).
4. Draft `schemas/command-descriptor.schema.json` + `document.schema.json`.
5. Stand up CI (windows-latest) + an empty core test.

---

**Bottom line:** ship the **control layer first**, in **TypeScript**, with **one bus and three
frontends**, prove it on a **headless PDF Workbench**, and keep a clean seam to migrate hot paths
to Rust later. The differentiator is not the GUI — it is that **an agent and a human drive the same
document through the same command bus**, deterministically and audibly. Build that spine and the
seven apps become plug-ins, not rewrites.
