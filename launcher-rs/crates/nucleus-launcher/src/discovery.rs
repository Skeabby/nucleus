//! Filesystem discovery: apps from every app root plus the roadmap.

use std::fs;
use std::path::{Path, PathBuf};

use nucleus_launcher_core::{
    AppMeta, AppSource, Card, Catalog, CatalogEntry, Channel, InstalledRecord, Manifest,
    RoadmapEntry, merge_roadmap, parse_manifest,
};

use crate::paths::Paths;

/// The launcher's own app manifest — the TS launcher UI kept in
/// `apps/launcher/` (it also hosts `roadmap.json`). It must never surface as a
/// card: you cannot open the launcher from the launcher, and "uninstalling"
/// it would be nonsense. The folder stays in the repo; the grid just skips it.
pub const LAUNCHER_SELF_ID: &str = "nucleus.launcher";

/// The result of discovery: app cards, roadmap cards and any non-fatal errors
/// encountered along the way (an unreadable manifest is skipped, never fatal).
#[derive(Debug, Clone)]
pub struct Discovery {
    /// Discovered apps, in discovery order (repo first, then user data).
    pub apps: Vec<AppMeta>,
    /// Merged `apps + upcoming` cards, in display order.
    pub cards: Vec<Card>,
    /// Raw roadmap entries loaded from `apps/launcher/roadmap.json`.
    pub roadmap: Vec<RoadmapEntry>,
    /// Reasons some manifests were skipped (e.g. invalid JSON).
    pub errors: Vec<String>,
}

impl Discovery {
    pub fn app(&self, id: &str) -> Option<&AppMeta> {
        self.apps.iter().find(|app| app.id() == id)
    }

    /// Look up any card (app or planned entry). Used by tests now; the
    /// M2 inspector will read it when the detail panel lands.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn card(&self, id: &str) -> Option<&Card> {
        self.cards.iter().find(|card| card.id() == id)
    }

    pub fn app_count(&self) -> usize {
        self.apps.len()
    }

    pub fn planned_count(&self) -> usize {
        self.cards.iter().filter(|c| c.as_app().is_none()).count()
    }
}

/// Discover the whole suite: for each app root (in order) take the root itself
/// plus its immediate child directories, and for every candidate load
/// `<dir>/nucleus.app.json` **and** `<dir>/current/nucleus.app.json`
/// (first one wins per id). Then attach catalogue entries, surface apps that
/// are in the catalogue but not yet on disk (so they can be installed), and
/// merge the roadmap.
pub fn discover(paths: &Paths, catalog: &Catalog) -> Discovery {
    let mut apps: Vec<AppMeta> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for root in &paths.app_roots {
        // The user data root is the one catalogue installs land in; everything
        // before it is the (optional) repository checkout.
        let source = if root == &paths.user_apps {
            AppSource::UserData
        } else {
            AppSource::Repo
        };
        if !root.is_dir() {
            continue;
        }
        // The root itself is a candidate (harmless when it has no manifest).
        add_candidate(root, source, &mut apps, &mut errors);
        // Then each immediate child directory, sorted for deterministic order.
        let mut children = match fs::read_dir(root) {
            Ok(entries) => entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_dir() && !is_hidden(path))
                .collect::<Vec<PathBuf>>(),
            Err(err) => {
                errors.push(format!("cannot read {}: {err}", root.display()));
                continue;
            }
        };
        children.sort();
        for child in &children {
            add_candidate(child, source, &mut apps, &mut errors);
        }
    }

    // M2: attach catalogue entries to installed apps (drives `UpdateAvailable`)
    // and add a card for every catalogue app that is not on disk yet, so it can
    // be installed from the UI on a machine without the repository.
    for app in &mut apps {
        if let Some(entry) = catalog.apps.iter().find(|entry| entry.id == app.id()) {
            app.catalog = Some(entry.clone());
        }
    }
    let user_apps_root = &paths.user_apps;
    for entry in &catalog.apps {
        if apps.iter().any(|app| app.id() == entry.id) {
            continue;
        }
        apps.push(catalogue_meta(entry, user_apps_root.join(&entry.id)));
    }

    // Never list the launcher itself (see [`LAUNCHER_SELF_ID`]) — after the
    // catalogue merge, so a future catalogue entry cannot resurrect it either.
    apps.retain(|app| app.id() != LAUNCHER_SELF_ID);

    // The roadmap lives in the checkout; without one there is simply nothing
    // planned to merge, which is not an error.
    let roadmap = match &paths.repo_root {
        Some(repo_root) => load_roadmap(repo_root).unwrap_or_else(|err| {
            errors.push(err);
            Vec::new()
        }),
        None => Vec::new(),
    };
    let cards = merge_roadmap(&apps, &roadmap);

    Discovery {
        apps,
        cards,
        roadmap,
        errors,
    }
}

/// A placeholder [`AppMeta`] for an app that is in the catalogue but not yet on
/// disk: enough to render a card with an enabled "Install" button. The real
/// manifest replaces it once the archive is installed and rediscovered.
fn catalogue_meta(entry: &CatalogEntry, dir: PathBuf) -> AppMeta {
    let manifest = Manifest {
        id: entry.id.clone(),
        name: entry.name.clone().unwrap_or_else(|| entry.id.clone()),
        version: entry.version.clone().unwrap_or_default(),
        core_api_version: "1".to_string(),
        description: None,
        author: None,
        category: None,
        status: None,
        inspired_by: None,
        icon: None,
        entry: None,
        protocol_entry: None,
        mcp_entry: None,
        launch: None,
        protocol_range: None,
        permissions: Vec::new(),
        capabilities: Vec::new(),
        min_shell: None,
        update_channel: entry.channel.as_deref().and_then(channel_from_str),
        integrity: None,
        signature: None,
    };
    AppMeta {
        manifest,
        manifest_path: dir.join("nucleus.app.json"),
        dir,
        source: AppSource::UserData,
        installed: None,
        catalog: Some(entry.clone()),
    }
}

fn channel_from_str(value: &str) -> Option<Channel> {
    match value {
        "stable" => Some(Channel::Stable),
        "beta" => Some(Channel::Beta),
        _ => None,
    }
}

/// Add `<dir>/nucleus.app.json` and `<dir>/current/nucleus.app.json` if both
/// exist and the id is new (first source wins).
fn add_candidate(dir: &Path, source: AppSource, apps: &mut Vec<AppMeta>, errors: &mut Vec<String>) {
    for manifest_name in ["nucleus.app.json", "current/nucleus.app.json"] {
        let manifest_path = dir.join(manifest_name);
        if !manifest_path.is_file() {
            continue;
        }
        let raw = match fs::read_to_string(&manifest_path) {
            Ok(raw) => raw,
            Err(err) => {
                errors.push(format!("cannot read {}: {err}", manifest_path.display()));
                continue;
            }
        };
        let manifest = match parse_manifest(&raw) {
            Ok(manifest) => manifest,
            Err(err) => {
                errors.push(format!("{}: {err}", manifest_path.display()));
                continue;
            }
        };
        let id = manifest.id.clone();
        if apps.iter().any(|app| app.id() == id) {
            continue; // first wins on id
        }
        // M1: synthesize an install record so locally-found apps are treated
        // as installed (Open is enabled). `Repo` records must never be
        // uninstalled; M2 reads real records from installed.json instead.
        let installed = Some(InstalledRecord {
            version: manifest.version.clone(),
            installed_at: String::new(),
            source,
            channel: manifest.update_channel.map(|c| c.as_str().to_string()),
            bundle_sha256: read_install_marker(manifest_path.parent()),
        });
        apps.push(AppMeta {
            manifest,
            dir: manifest_path
                .parent()
                .expect("join keeps a parent")
                .to_path_buf(),
            manifest_path,
            source,
            installed,
            catalog: None,
        });
    }
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with('.') || name.starts_with('_'))
        .unwrap_or(false)
}

/// Read `<app dir>/nucleus.install.json` and pull out `bundleSha256`.
///
/// Absent or unreadable is normal: apps installed before this marker existed,
/// and apps discovered from a checkout, have no archive to point at. In both
/// cases "unknown" must not be mistaken for "different" (that would light up
/// every card with a permanent phantom update).
fn read_install_marker(app_dir: Option<&Path>) -> Option<String> {
    let dir = app_dir?;
    let raw = fs::read_to_string(dir.join(crate::install::INSTALL_MARKER)).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let hash = parsed.get("bundleSha256")?.as_str()?.trim();
    if hash.is_empty() {
        None
    } else {
        Some(hash.to_ascii_lowercase())
    }
}

/// Load `<repo>/apps/launcher/roadmap.json`. Missing/unreadable → error string.
fn load_roadmap(repo_root: &Path) -> Result<Vec<RoadmapEntry>, String> {
    let path = repo_root.join("apps").join("launcher").join("roadmap.json");
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("cannot read roadmap {}: {err}", path.display()))?;
    serde_json::from_str(&raw).map_err(|err| format!("invalid roadmap {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_launcher_core::{AppMeta, AppSource};

    fn app(id: &str) -> AppMeta {
        AppMeta {
            manifest: nucleus_launcher_core::parse_manifest(&format!(
                r#"{{"id":"{id}","name":"{id}","version":"0.1.0","coreApiVersion":"1","launch":{{"kind":"server","args":["server.js"]}}}}"#
            ))
            .unwrap(),
            dir: PathBuf::from("."),
            manifest_path: PathBuf::from("."),
            source: AppSource::Repo,
            installed: None,
            catalog: None,
        }
    }

    #[test]
    fn hidden_dir_is_hidden() {
        assert!(is_hidden(Path::new(".git")));
        assert!(is_hidden(Path::new("_wip")));
        assert!(!is_hidden(Path::new("notes")));
    }

    /// The launcher never appears in its own grid, whether found on disk or
    /// (hypothetically) via the catalogue — the card would be circular.
    #[test]
    fn the_launcher_never_lists_itself() {
        let base = std::env::temp_dir().join(format!("nucleus-self-{}", std::process::id()));
        let repo_apps = base.join("apps");
        std::fs::create_dir_all(repo_apps.join("launcher")).unwrap();
        std::fs::create_dir_all(repo_apps.join("notes")).unwrap();
        std::fs::write(
            repo_apps.join("launcher/nucleus.app.json"),
            r#"{"id":"nucleus.launcher","name":"Nucleus","version":"0.1.0","coreApiVersion":"1","launch":{"kind":"server","args":["dist/server.js"]}}"#,
        )
        .unwrap();
        std::fs::write(
            repo_apps.join("notes/nucleus.app.json"),
            r#"{"id":"nucleus.notes","name":"Notes","version":"0.1.0","coreApiVersion":"1","launch":{"kind":"server","args":["dist/server.js"]}}"#,
        )
        .unwrap();
        let paths = Paths {
            repo_root: Some(base.clone()),
            user_apps: repo_apps.clone(),
            app_roots: vec![repo_apps.clone()],
            window_profiles_dir: base.join("profiles"),
            shell_exe: None,
            icon_ico: None,
        };
        // Even a catalogue entry for the launcher must not resurrect the card.
        let catalog = nucleus_launcher_core::Catalog {
            suite_version: "0.4.0-alpha".into(),
            generated_at: None,
            issued_at: None,
            expires_at: None,
            launcher: None,
            apps: vec![CatalogEntry {
                id: LAUNCHER_SELF_ID.into(),
                repo: "Skeabby/nucleus".into(),
                release_asset: "nucleus.launcher.nucleusapp".into(),
                sha256: Some("0".repeat(64)),
                version: Some("0.1.0".into()),
                url: None,
                name: Some("Nucleus".into()),
                channel: None,
            }],
        };

        let discovery = discover(&paths, &catalog);
        assert!(
            discovery.app(LAUNCHER_SELF_ID).is_none(),
            "the launcher must not list itself"
        );
        assert!(discovery.card(LAUNCHER_SELF_ID).is_none());
        assert!(discovery.app("nucleus.notes").is_some(), "real apps stay");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn card_and_app_lookup() {
        let apps = vec![app("nucleus.launcher")];
        let discovery = Discovery {
            apps: apps.clone(),
            cards: merge_roadmap(&apps, &[]),
            roadmap: vec![],
            errors: vec![],
        };
        assert!(discovery.app("nucleus.launcher").is_some());
        assert!(discovery.app("nope").is_none());
        assert_eq!(
            discovery.card("nucleus.launcher").unwrap().id(),
            "nucleus.launcher"
        );
        assert_eq!(discovery.app_count(), 1);
        assert_eq!(discovery.planned_count(), 0);
    }

    #[test]
    fn catalogue_only_app_becomes_an_installable_card() {
        let entry = CatalogEntry {
            id: "nucleus.notes".into(),
            repo: "Skeabby/nucleus".into(),
            release_asset: "nucleus.notes.nucleusapp".into(),
            sha256: Some("0".repeat(64)),
            version: Some("1.2.0".into()),
            url: None,
            name: Some("Notes".into()),
            channel: Some("stable".into()),
        };
        let meta = catalogue_meta(&entry, PathBuf::from("C:/Nucleus/apps/nucleus.notes"));
        assert_eq!(meta.id(), "nucleus.notes");
        assert_eq!(meta.name(), "Notes");
        assert_eq!(meta.source, AppSource::UserData);
        assert!(meta.installed.is_none(), "not installed yet");
        assert!(meta.catalog.is_some(), "catalogue entry attached");
        assert_eq!(meta.manifest.update_channel, Some(Channel::Stable));
        // Status must be NotInstalled so the card offers "Install".
        assert_eq!(
            nucleus_launcher_core::derive_status(
                meta.installed.as_ref(),
                meta.catalog.as_ref(),
                false
            ),
            nucleus_launcher_core::AppStatus::NotInstalled
        );
    }

    /// A released binary on a machine with no checkout: no `repo_root`, no repo
    /// app root, no roadmap — only the user data root and the catalogue. The
    /// catalogue apps must still show up as installable, and the missing
    /// roadmap must not be reported as an error.
    #[test]
    fn a_machine_without_a_repository_still_lists_catalogue_apps() {
        let base = std::env::temp_dir().join(format!("nucleus-norepo-{}", std::process::id()));
        let user_apps = base.join("apps");
        std::fs::create_dir_all(&user_apps).unwrap();
        let paths = Paths {
            repo_root: None,
            user_apps: user_apps.clone(),
            app_roots: vec![user_apps.clone()],
            window_profiles_dir: base.join("profiles"),
            shell_exe: None,
            icon_ico: None,
        };
        let catalog = nucleus_launcher_core::Catalog {
            suite_version: "0.4.0-alpha".into(),
            generated_at: None,
            issued_at: None,
            expires_at: None,
            launcher: None,
            apps: vec![CatalogEntry {
                id: "nucleus.notes".into(),
                repo: "Skeabby/nucleus".into(),
                release_asset: "nucleus.notes.nucleusapp".into(),
                sha256: Some("0".repeat(64)),
                version: Some("0.1.0".into()),
                url: None,
                name: Some("Notes".into()),
                channel: Some("stable".into()),
            }],
        };

        let discovery = discover(&paths, &catalog);
        let card = discovery
            .card("nucleus.notes")
            .expect("catalogue app listed");
        assert!(card.as_app().unwrap().installed.is_none(), "not installed");
        assert!(discovery.errors.is_empty(), "{:?}", discovery.errors);
        assert_eq!(discovery.planned_count(), 0, "no roadmap without a repo");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn planned_count_only_counts_planned_cards() {
        let roadmap = vec![nucleus_launcher_core::RoadmapEntry {
            id: "nucleus.image-editor".into(),
            name: "Image Editor".into(),
            description: None,
            category: None,
            inspired_by: None,
            emoji: None,
            color: None,
        }];
        let apps = vec![app("nucleus.launcher")];
        let discovery = Discovery {
            apps: apps.clone(),
            cards: merge_roadmap(&apps, &roadmap),
            roadmap,
            errors: vec![],
        };
        assert_eq!(discovery.app_count(), 1);
        assert_eq!(discovery.planned_count(), 1);
    }
}
