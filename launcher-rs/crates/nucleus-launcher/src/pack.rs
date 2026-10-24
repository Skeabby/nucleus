//! Producing a `.nucleusapp` archive from an app directory, and generating a
//! `catalog.json` from a directory of archives — the "pack-app" toolchain that
//! feeds the M2 install engine.
//!
//! An archive is a zip with, at its root, `nucleus.app.json`, a `payload/`
//! directory holding the app's files, and a `DIGESTS.json` ledger of every
//! payload file's SHA-256. This is exactly the shape [`crate::install`] expects.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use nucleus_launcher_core::verify::{DIGESTS_FILE, sha256_hex};
use nucleus_launcher_core::{LaunchKind, ManifestError, parse_manifest};
use thiserror::Error;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::install::{MANIFEST_FILE, PAYLOAD_DIR};
use crate::verify::sha256_reader;

/// Directory names never packed into a payload (build/dev debris).
pub const SKIP_DIRS: &[&str] = &["node_modules", ".turbo", ".git", "target"];

/// Anything that can go wrong packing or cataloguing.
#[derive(Debug, Error)]
pub enum PackError {
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),

    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("no manifest at `{0}`")]
    MissingManifest(String),

    #[error("invalid manifest: {0}")]
    Manifest(#[from] ManifestError),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("no payload files found under `{0}`")]
    EmptyPayload(String),

    #[error(
        "payload cannot run outside this repo: `{0}` still imports workspace packages (`@nucleus/*`) — bundle the apps first (`npm run build && npm run bundle:apps`) and pack again"
    )]
    Unbundled(String),
}

/// A successful pack.
#[derive(Debug, Clone)]
pub struct PackOutcome {
    pub id: String,
    pub version: String,
    pub out: PathBuf,
    /// Number of payload files written (manifest and ledger excluded).
    pub files: usize,
    /// Size of the produced archive in bytes.
    pub bytes: u64,
}

/// Pack `dir` into a `.nucleusapp` archive at `out`.
pub fn pack_app_dir(dir: &Path, out: &Path) -> Result<PackOutcome, PackError> {
    let manifest_path = dir.join(MANIFEST_FILE);
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|_| PackError::MissingManifest(manifest_path.display().to_string()))?;
    let manifest = parse_manifest(&raw)?;

    let mut files: Vec<PathBuf> = Vec::new();
    collect(dir, dir, &mut files)?;
    files.sort();
    if files.is_empty() {
        return Err(PackError::EmptyPayload(dir.display().to_string()));
    }

    // Guard against shipping an app that can only run inside this repo: the
    // archive deliberately excludes `node_modules`, so a server entry that
    // still imports `@nucleus/*` dies instantly with ERR_MODULE_NOT_FOUND on
    // an installed machine (the silent "Open does nothing" of the first
    // bundle release). The pack pipeline must bundle
    // (`npm run bundle:apps`) before packing.
    if let Some(spec) = manifest.launch_spec()
        && spec.kind == LaunchKind::Server
    {
        let entry_arg = spec.args.first().cloned().unwrap_or_default();
        if !entry_arg.is_empty() {
            let entry = dir.join(entry_arg.replace('/', "\\"));
            if entry.is_file() {
                let bytes = fs::read(&entry)?;
                if find_subslice(&bytes, b"\"@nucleus/").is_some()
                    || find_subslice(&bytes, b"'@nucleus/").is_some()
                {
                    return Err(PackError::Unbundled(
                        entry
                            .strip_prefix(dir)
                            .unwrap_or(&entry)
                            .display()
                            .to_string(),
                    ));
                }
            }
        }
    }

    if let Some(parent) = out.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    let mut writer = ZipWriter::new(File::create(out)?);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file(MANIFEST_FILE, options)?;
    writer.write_all(raw.as_bytes())?;

    let mut ledger = serde_json::Map::new();
    for path in &files {
        let relative = path
            .strip_prefix(dir)
            .expect("collected paths live under `dir`")
            .to_string_lossy()
            .replace('\\', "/");
        let payload_path = format!("{PAYLOAD_DIR}/{relative}");
        let bytes = fs::read(path)?;
        ledger.insert(
            payload_path.clone(),
            serde_json::Value::String(format!("sha256:{}", sha256_hex(&bytes))),
        );
        writer.start_file(payload_path, options)?;
        writer.write_all(&bytes)?;
    }

    writer.start_file(DIGESTS_FILE, options)?;
    writer.write_all(&serde_json::to_vec(&serde_json::Value::Object(ledger))?)?;
    writer.finish()?;

    let bytes = fs::metadata(out).map(|meta| meta.len()).unwrap_or(0);
    Ok(PackOutcome {
        id: manifest.id,
        version: manifest.version,
        out: out.to_path_buf(),
        files: files.len(),
        bytes,
    })
}

/// Recursively collect the files to pack, skipping manifest/ledger, other
/// archives, dotfiles and [`SKIP_DIRS`].
fn collect(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), PackError> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();
    entries.sort();
    for path in entries {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() {
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect(root, &path, out)?;
        } else if path.is_file() {
            if name == MANIFEST_FILE || name == DIGESTS_FILE || name.ends_with(".nucleusapp") {
                continue;
            }
            let _ = root;
            out.push(path);
        }
    }
    Ok(())
}

/// One catalogued archive, before it becomes JSON.
struct Cataloged {
    id: String,
    name: String,
    version: String,
    channel: Option<String>,
    asset: String,
    sha256: String,
    size: u64,
}

/// Naive byte-substring search (tiny haystacks, no new dependency).
fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len())
        .position(|window| window == needle)
}

/// Generate a `catalog.json` from every `*.nucleusapp` in `archives_dir`.
///
/// `base_url` prefixes each asset `url` (an HTTP base or a relative folder).
/// When `None`, each archive is written **relative to the catalogue's own
/// folder** (falling back to the bare file name), which
/// [`crate::catalogue::resolve_relative_urls`] turns back into an absolute path
/// — the offline, local-folder case.
pub fn gen_catalog(
    dir: &Path,
    base_url: Option<&str>,
    repo: &str,
    out: &Path,
    launcher_setup: Option<&Path>,
) -> Result<usize, PackError> {
    let mut archives: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("nucleusapp"))
        })
        .collect();
    archives.sort();

    let out_dir = out
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf);

    let mut apps = Vec::new();
    for path in archives {
        let mut zip = ZipArchive::new(File::open(&path)?)?;
        let mut manifest_raw = String::new();
        zip.by_name(MANIFEST_FILE)?
            .read_to_string(&mut manifest_raw)?;
        let manifest = parse_manifest(&manifest_raw)?;
        let sha256 = sha256_reader(&mut File::open(&path)?)?;
        let size = fs::metadata(&path)?.len();
        let asset = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let url = match base_url {
            Some(base) => format!("{}/{}", base.trim_end_matches('/'), asset),
            None => out_dir
                .as_deref()
                .and_then(|dir| path.strip_prefix(dir).ok())
                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| asset.clone()),
        };
        apps.push((
            url,
            Cataloged {
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
                channel: manifest.update_channel.map(|c| c.as_str().to_string()),
                asset,
                sha256,
                size,
            },
        ));
    }

    let mut entries = Vec::new();
    for (url, app) in &apps {
        entries.push(serde_json::json!({
            "id": app.id,
            "name": app.name,
            "repo": repo,
            "releaseAsset": app.asset,
            "version": app.version,
            "channel": app.channel,
            "url": url,
            "sha256": app.sha256,
            "size": app.size,
        }));
    }
    let mut launcher = serde_json::Value::Null;
    if let Some(setup) = launcher_setup {
        let name = setup
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let url = match base_url {
            Some(base) => format!("{}/{}", base.trim_end_matches('/'), name),
            None => name.clone(),
        };
        let sha256 = sha256_reader(&mut File::open(setup)?)?;
        launcher = serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "url": url,
            "sha256": sha256,
        });
    }

    let catalog = serde_json::json!({
        "suiteVersion": env!("CARGO_PKG_VERSION"),
        "generatedAt": now_iso8601(),
        // N1: the signed payload states when it was issued and when it stops
        // being usable, so a fetch can be refused without trusting a clock in
        // the payload itself.
        "issuedAt": now_iso8601(),
        "expiresAt": expires_iso8601(TRUST_MAX_AGE_DAYS),
        "launcher": launcher,
        "apps": entries,
    });
    if let Some(parent) = out.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        out,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&catalog).unwrap_or_else(|_| "{}".into())
        ),
    )?;
    Ok(apps.len())
}

/// A UTC timestamp in ISO-8601, without pulling in a date crate.
fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (rest / 3_600, (rest % 3_600) / 60, rest % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// How long a freshly signed catalogue stays usable. Mirrors
/// `nucleus_launcher_core::trust::CATALOG_MAX_AGE_DAYS`.
pub const TRUST_MAX_AGE_DAYS: i64 = 90;

fn expires_iso8601(days: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64
        + days * 86_400;
    let days = secs.div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T00:00:00Z")
}

/// Days since 1970-01-01 to a civil `(year, month, day)`, using Howard
/// Hinnant's `civil_from_days` algorithm (the inverse of `days_from_civil`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153; // [0, 11]
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    const MANIFEST: &str = r#"{
      "id": "nucleus.notes",
      "name": "Notes",
      "version": "0.1.0",
      "coreApiVersion": "1",
      "launch": { "kind": "server", "args": ["dist/server.js"], "readyPath": "/api/state" }
    }"#;

    fn scratch(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("nucleus-pack-{label}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_app(root: &Path) -> PathBuf {
        let app = root.join("notes-src");
        fs::create_dir_all(app.join("dist")).unwrap();
        fs::create_dir_all(app.join("node_modules/junk")).unwrap();
        fs::write(app.join(MANIFEST_FILE), MANIFEST).unwrap();
        fs::write(app.join("dist/server.js"), b"console.log('notes');").unwrap();
        fs::write(app.join("icon.svg"), b"<svg/>").unwrap();
        fs::write(app.join("node_modules/junk/x.js"), b"should not be packed").unwrap();
        app
    }

    #[test]
    fn packs_a_directory_the_installer_accepts() {
        let root = scratch("roundtrip");
        let app = sample_app(&root);
        let out = root.join("notes.nucleusapp");

        let outcome = pack_app_dir(&app, &out).expect("pack");
        assert_eq!(outcome.id, "nucleus.notes");
        assert_eq!(outcome.version, "0.1.0");
        assert_eq!(
            outcome.files, 2,
            "dist/server.js + icon.svg, not node_modules"
        );
        assert!(outcome.bytes > 0);

        // The produced archive installs cleanly and rejects a wrong hash.
        let apps = root.join("apps");
        let installed = crate::install::install_archive(&out, &apps, outcome_hash(&out).as_deref());
        assert!(installed.is_ok(), "install {installed:?}");
        assert!(apps.join("nucleus.notes/dist/server.js").is_file());
        assert!(!apps.join("nucleus.notes/node_modules").exists());

        let err = crate::install::install_archive(&out, &root.join("apps2"), Some(&"0".repeat(64)));
        assert!(err.is_err(), "a wrong hash must fail");
        let _ = fs::remove_dir_all(&root);
    }

    fn outcome_hash(path: &Path) -> Option<String> {
        sha256_reader(&mut File::open(path).unwrap()).ok()
    }

    #[test]
    fn civil_dates_round_trip_against_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // 2024-01-01 is 19723 days in
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert!(now_iso8601().ends_with('Z'));
        assert_eq!(now_iso8601().len(), 20);
    }

    /// A server payload whose entry still imports `@nucleus/*` cannot run
    /// outside this monorepo (no node_modules goes into the archive): it must
    /// be refused at pack time, pointing at the bundling step.
    #[test]
    fn rejects_a_payload_that_still_imports_workspace_packages() {
        let root = scratch("unbundled");
        let app = sample_app(&root);
        fs::write(
            app.join("dist/server.js"),
            "import { createNotesSession } from \"@nucleus/notes\";\n",
        )
        .unwrap();
        let out = root.join("notes.nucleusapp");
        assert!(matches!(
            pack_app_dir(&app, &out),
            Err(PackError::Unbundled(_))
        ));
        // Same file, bundled form: no workspace import anywhere → pack works.
        fs::write(
            app.join("dist/server.js"),
            "import { readFile } from \"node:fs/promises\";\n",
        )
        .unwrap();
        assert!(pack_app_dir(&app, &out).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn packing_without_a_manifest_fails() {
        let root = scratch("nomanifest");
        let out = root.join("x.nucleusapp");
        assert!(matches!(
            pack_app_dir(&root, &out),
            Err(PackError::MissingManifest(_))
        ));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gen_catalog_lists_archives_with_hashes() {
        let root = scratch("gen");
        let app = sample_app(&root);
        let archives = root.join("mirror/apps");
        fs::create_dir_all(&archives).unwrap();
        pack_app_dir(&app, &archives.join("nucleus.notes-0.1.0-win64.nucleusapp")).unwrap();

        let catalog_path = root.join("mirror/catalog.json");
        let count = gen_catalog(&archives, None, "Skeabby/nucleus", &catalog_path, None).unwrap();
        assert_eq!(count, 1);

        // The catalogue must load and resolve the relative asset path.
        let loaded = crate::net::fetch_catalog(&catalog_path.to_string_lossy()).unwrap();
        assert_eq!(loaded.apps.len(), 1);
        assert_eq!(loaded.apps[0].id, "nucleus.notes");
        assert_eq!(loaded.apps[0].sha256.as_deref().unwrap().len(), 64);
        let _ = fs::remove_dir_all(&root);
    }

    /// §3.5 criterion 2: catalogue → download → install, entirely offline.
    ///
    /// The catalogue is read from disk, the asset URL resolves to a sibling
    /// file (no `http`), and the whole chain runs without touching the network
    /// — which is exactly what CI needs.
    #[test]
    fn offline_catalogue_round_trip_installs_without_network() {
        use std::sync::atomic::AtomicBool;

        let root = scratch("hermetic");
        let app = sample_app(&root);
        let mirror = root.join("mirror");
        let archives = mirror.join("apps");
        fs::create_dir_all(&archives).unwrap();
        let archive = archives.join("nucleus.notes-0.1.0-win64.nucleusapp");
        pack_app_dir(&app, &archive).unwrap();

        let catalog_path = mirror.join("catalog.json");
        gen_catalog(&archives, None, "Skeabby/nucleus", &catalog_path, None).unwrap();

        // 1. Load the catalogue the way the launcher does: fetch, then resolve
        //    relative asset URLs against the catalogue's own folder.
        let source = catalog_path.to_string_lossy().into_owned();
        let catalog = crate::catalogue::resolve_relative_urls(
            crate::net::fetch_catalog(&source).unwrap(),
            &source,
        );
        assert_eq!(catalog.apps.len(), 1);
        let entry = &catalog.apps[0];

        // 2. The relative URL must resolve to the local sibling archive.
        let url = entry.url.clone().expect("url resolved from the catalogue");
        assert!(
            url.starts_with("file://") || Path::new(&url).is_absolute(),
            "relative asset should resolve to a local path, got {url}"
        );

        // 3. Download (a local copy) into the cache, then install with the
        //    catalogue's own hash — no network anywhere in this test.
        let dest = root.join("cache/notes.nucleusapp");
        let cancel = AtomicBool::new(false);
        let mut progress = |_done: u64, _total: Option<u64>| {};
        crate::net::download_archive(&url, &dest, &mut progress, &cancel).unwrap();

        let apps_root = root.join("apps");
        let outcome =
            crate::install::install_archive(&dest, &apps_root, entry.sha256.as_deref()).unwrap();
        assert_eq!(outcome.id, "nucleus.notes");
        assert!(apps_root.join("nucleus.notes/dist/server.js").is_file());

        // 4. A second install of the same version is a clean no-op: it
        //    succeeds, the payload is unchanged, and nothing is duplicated.
        let again =
            crate::install::install_archive(&dest, &apps_root, entry.sha256.as_deref()).unwrap();
        assert_eq!(again.dir, outcome.dir);
        assert_eq!(
            fs::read(apps_root.join("nucleus.notes/dist/server.js")).unwrap(),
            b"console.log('notes');"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
