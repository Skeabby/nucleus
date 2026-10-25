//! # nucleus-launcher
//!
//! The Nucleus desktop launcher: discover the local suite, open/stop app
//! servers, and show them in a light egui window. Windows-first (M1).

#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(not(windows))]
compile_error!("nucleus-launcher currently supports Windows only (M1)");

mod app;
mod catalogue;
mod discovery;
mod install;
mod jobs;
mod launcher_lock;
mod net;
mod pack;
mod paths;
mod ports;
mod probe;
mod process;
mod runtime;
mod sse_events;
mod ui;
mod verify;
mod window;

use std::path::PathBuf;

use discovery::Discovery;
use serde_json::json;

use crate::ui::{Facts, NodeFact};

fn main() {
    // --- CLI: --smoke | --list | --repo <path> -------------------------------
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut smoke = false;
    let mut list = false;
    let mut repo: Option<PathBuf> = None;
    let mut install: Option<PathBuf> = None;
    let mut allow_commands = false;
    let mut sha256: Option<String> = None;
    let mut install_app: Option<String> = None;
    let mut uninstall_app: Option<String> = None;
    let mut pack_dir: Option<PathBuf> = None;
    let mut gen_catalog_dir: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut base_url: Option<String> = None;
    let mut setup_path: Option<PathBuf> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--smoke" => smoke = true,
            // A local `launch.kind: command` bundle is refused unless the user
            // says so explicitly (N1): the installer cannot tell a bundle they
            // wrote from one they downloaded from a forum.
            "--allow-commands" => allow_commands = true,
            "--list" => list = true,
            "--repo" => {
                index += 1;
                match args.get(index) {
                    Some(path) => repo = Some(PathBuf::from(path)),
                    None => {
                        eprintln!("error: --repo requires a path");
                        std::process::exit(2);
                    }
                }
            }
            "--install" => {
                index += 1;
                match args.get(index) {
                    Some(path) => install = Some(PathBuf::from(path)),
                    None => {
                        eprintln!("error: --install requires a path to a .nucleusapp");
                        std::process::exit(2);
                    }
                }
            }
            "--sha256" => {
                index += 1;
                match args.get(index) {
                    Some(hash) => sha256 = Some(hash.clone()),
                    None => {
                        eprintln!("error: --sha256 requires a hex digest");
                        std::process::exit(2);
                    }
                }
            }
            "--install-app" => {
                index += 1;
                match args.get(index) {
                    Some(id) => install_app = Some(id.clone()),
                    None => {
                        eprintln!("error: --install-app requires a catalogue app id");
                        std::process::exit(2);
                    }
                }
            }
            "--uninstall-app" => {
                index += 1;
                match args.get(index) {
                    Some(id) => uninstall_app = Some(id.clone()),
                    None => {
                        eprintln!("error: --uninstall-app requires an app id");
                        std::process::exit(2);
                    }
                }
            }
            "--pack" => {
                index += 1;
                match args.get(index) {
                    Some(path) => pack_dir = Some(PathBuf::from(path)),
                    None => {
                        eprintln!("error: --pack requires an app directory");
                        std::process::exit(2);
                    }
                }
            }
            "--gen-catalog" => {
                index += 1;
                match args.get(index) {
                    Some(path) => gen_catalog_dir = Some(PathBuf::from(path)),
                    None => {
                        eprintln!("error: --gen-catalog requires a directory of .nucleusapp files");
                        std::process::exit(2);
                    }
                }
            }
            "--out" => {
                index += 1;
                match args.get(index) {
                    Some(path) => out = Some(PathBuf::from(path)),
                    None => {
                        eprintln!("error: --out requires a file path");
                        std::process::exit(2);
                    }
                }
            }
            "--base-url" => {
                index += 1;
                match args.get(index) {
                    Some(url) => base_url = Some(url.clone()),
                    None => {
                        eprintln!("error: --base-url requires a URL or folder prefix");
                        std::process::exit(2);
                    }
                }
            }
            "--setup" => {
                index += 1;
                match args.get(index) {
                    Some(path) => setup_path = Some(PathBuf::from(path)),
                    None => {
                        eprintln!("error: --setup requires the installer path");
                        std::process::exit(2);
                    }
                }
            }
            other => {
                eprintln!("error: unknown argument `{other}`");
                eprintln!(
                    "usage: nucleus-launcher [--smoke] [--list] [--repo <path>] \
                     [--install <.nucleusapp>] [--sha256 <hex>] [--allow-commands] \
                     [--install-app <id>] [--uninstall-app <id>] \
                     [--pack <dir> --out <file>] [--gen-catalog <dir> --out <file> \
                     [--base-url <prefix>]]"
                );
                std::process::exit(2);
            }
        }
        index += 1;
    }
    if sha256.is_some() && install.is_none() {
        eprintln!("error: --sha256 only applies to --install");
        std::process::exit(2);
    }

    // --- CLI: pack a `.nucleusapp` / generate a catalogue (no repo needed) ---
    if let Some(dir) = pack_dir {
        let Some(out) = out else {
            eprintln!("error: --pack requires --out <file>");
            std::process::exit(2);
        };
        match pack::pack_app_dir(&dir, &out) {
            Ok(outcome) => {
                let summary = json!({
                    "packed": true,
                    "id": outcome.id,
                    "version": outcome.version,
                    "out": outcome.out,
                    "files": outcome.files,
                    "bytes": outcome.bytes,
                });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "{}".into())
                );
                return;
            }
            Err(err) => {
                eprintln!("error: {err}");
                std::process::exit(1);
            }
        }
    }
    if let Some(dir) = gen_catalog_dir {
        let Some(out) = out else {
            eprintln!("error: --gen-catalog requires --out <file>");
            std::process::exit(2);
        };
        match pack::gen_catalog(
            &dir,
            base_url.as_deref(),
            "Skeabby/nucleus",
            &out,
            setup_path.as_deref(),
        ) {
            Ok(count) => {
                println!("wrote {count} app(s) to {}", out.display());
                return;
            }
            Err(err) => {
                eprintln!("error: {err}");
                std::process::exit(1);
            }
        }
    }

    // --- Resolve the repository + data locations ----------------------------
    let paths = match paths::Paths::resolve(repo.as_deref()) {
        Ok(paths) => paths,
        Err(message) => {
            eprintln!("error: {message}");
            std::process::exit(1);
        }
    };

    // --- CLI: install a `.nucleusapp` into the user apps root ---------------
    if let Some(archive) = install {
        let apps_root = paths::nucleus_data_dir().join("apps"); // %APPDATA%\Nucleus\apps
        match install::install_checked(
            &archive,
            &apps_root,
            sha256.as_deref(),
            install::InstallOrigin::Local,
            allow_commands,
        ) {
            Ok(outcome) => {
                let summary = json!({
                    "installed": true,
                    "id": outcome.id,
                    "version": outcome.version,
                    "dir": outcome.dir,
                    "files": outcome.files,
                });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "{}".into())
                );
                return;
            }
            Err(err) => {
                eprintln!("error: {err}");
                std::process::exit(1);
            }
        }
    }

    // --- Load the catalogue (embedded mirror + optional overrides) ----------
    let data_dir = paths::nucleus_data_dir();
    let (catalog, catalog_warnings) = catalogue::load(&data_dir);

    // --- CLI: install a catalogue app by id (download → verify → install) ---
    if let Some(id) = install_app {
        let Some(entry) = catalog.apps.iter().find(|entry| entry.id == id).cloned() else {
            eprintln!("error: `{id}` is not in the catalogue");
            std::process::exit(1);
        };
        let url = entry.url.clone().unwrap_or_else(|| {
            format!(
                "https://github.com/{}/releases/latest/download/{}",
                entry.repo, entry.release_asset
            )
        });
        let cache = data_dir.join("cache");
        let dest = cache.join(&entry.release_asset);
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut last = 0u64;
        let mut progress = |done: u64, total: Option<u64>| {
            // One line at the start and at the end; never spam the console.
            if done == 0 || total.is_some_and(|t| done >= t) || done >= last + 8 * 1024 * 1024 {
                last = done;
                match total {
                    Some(total) => eprintln!("downloading {id}: {done}/{total} bytes"),
                    None => eprintln!("downloading {id}: {done} bytes"),
                }
            }
        };
        if let Err(err) = net::download_archive(&url, &dest, &mut progress, &cancel) {
            eprintln!("error: {err}");
            std::process::exit(1);
        }
        let apps_root = data_dir.join("apps");
        match install::install_checked(
            &dest,
            &apps_root,
            entry.sha256.as_deref(),
            install::InstallOrigin::Catalog,
            false,
        ) {
            Ok(outcome) => {
                let summary = json!({
                    "installed": true,
                    "id": outcome.id,
                    "version": outcome.version,
                    "dir": outcome.dir,
                    "files": outcome.files,
                    "source": url,
                });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "{}".into())
                );
                return;
            }
            Err(err) => {
                eprintln!("error: {err}");
                std::process::exit(1);
            }
        }
    }

    // --- CLI: remove a catalogue-installed app -----------------------------
    if let Some(id) = uninstall_app {
        let apps_root = data_dir.join("apps");
        match install::uninstall_app(&id, &apps_root) {
            Ok(()) => {
                let summary = json!({
                    "uninstalled": true,
                    "id": id,
                    "dir": apps_root.join(&id),
                });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "{}".into())
                );
                return;
            }
            Err(err) => {
                eprintln!("error: {err}");
                std::process::exit(1);
            }
        }
    }

    let discovery = discovery::discover(&paths, &catalog);
    let node = process::known_node();

    if smoke {
        print_smoke(&discovery, node.as_deref());
        return;
    }
    if list {
        print_list(&discovery);
        return;
    }

    // --- Engine + window ----------------------------------------------------
    // Single-instance (§4.5): a second launcher window must not happen. The
    // lock is held for as long as main() lives; process death releases it.
    // CLI helpers (--smoke/--list) above are read-only and stay multi-call.
    let _lock = match launcher_lock::acquire(&crate::paths::nucleus_data_dir()) {
        Ok(lock) => lock,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(0);
        }
    };

    let (runtime, events) = runtime::Runtime::new(runtime::RuntimeConfig {
        node_path: node.clone(),
        shell_exe: paths.shell_exe.clone(),
        icon_ico: paths.icon_ico.clone(),
        window_profiles_dir: paths.window_profiles_dir.clone(),
        run_registry_dir: crate::paths::nucleus_data_dir().join("run"),
        window_size: window::APP_WINDOW_SIZE,
    });
    let facts = Facts {
        node: match node {
            Some(path) => NodeFact::Found(path),
            None => NodeFact::Missing,
        },
        errors: {
            let mut errors = catalog_warnings;
            errors.extend(discovery.errors.clone());
            errors
        },
    };

    let mut viewport = egui::ViewportBuilder::default()
        .with_title("Nucleus")
        .with_inner_size([1200.0, 760.0])
        .with_min_inner_size([900.0, 600.0]);
    // Our own mark on the taskbar/title bar: rasterised from the embedded SVG.
    if let Some(icon) = window_icon() {
        viewport = viewport.with_icon(icon);
    }
    let native_options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    let result = eframe::run_native(
        "Nucleus",
        native_options,
        Box::new(move |cc| {
            Ok(Box::new(app::LauncherApp::new(
                cc, discovery, runtime, events, facts, paths, catalog,
            )))
        }),
    );
    if let Err(err) = result {
        eprintln!("error: {err}");
    }
}

/// The Nucleus mark as an `IconData`, rasterised from the embedded brand SVG.
fn window_icon() -> Option<egui::IconData> {
    let (width, height, rgba) = ui::icons::render_svg(ui::icons::BRAND_SVG, 256.0)?;
    Some(egui::IconData {
        rgba,
        width: width as u32,
        height: height as u32,
    })
}

/// `--smoke`: a short JSON summary, exit 0 (exit 1 already handled above on a
/// serious error like an unresolvable repository).
fn print_smoke(discovery: &Discovery, node: Option<&str>) {
    let discovered_ids: Vec<&str> = discovery.apps.iter().map(|app| app.id()).collect();
    let planned_ids: Vec<&str> = discovery
        .roadmap
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    let summary = json!({
        "discovered": discovery.app_count(),
        "packed": discovered_ids.len(),
        "apps": discovered_ids,
        "roadmap": discovery.roadmap.len(),
        "planned": planned_ids,
        "cards": discovery.cards.len(),
        "node": node,
        "errors": discovery.errors,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "{}".into())
    );
}

/// `--list`: a human-readable listing.
fn print_list(discovery: &Discovery) {
    println!(
        "{} app{} discovered, {} planned",
        discovery.app_count(),
        plural(discovery.app_count()),
        discovery.planned_count()
    );
    for app in &discovery.apps {
        println!(
            "{:<28} {:<20} {:<8} {:<6} {}",
            app.id(),
            app.name(),
            app.manifest
                .category
                .map(|c| c.as_str().to_string())
                .unwrap_or_else(|| "-".into()),
            app.manifest
                .status
                .map(|s| s.as_str().to_string())
                .unwrap_or_else(|| "-".into()),
            app.manifest.version
        );
    }
    println!();
    println!("Coming soon:");
    for entry in &discovery.roadmap {
        println!("  {:<28} {}", entry.id, entry.name);
    }
    if !discovery.errors.is_empty() {
        println!();
        println!("warnings:");
        for error in &discovery.errors {
            println!("  - {error}");
        }
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}
