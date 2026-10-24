//! Installing a `.nucleusapp` archive into `%APPDATA%\Nucleus\apps`.
//!
//! A `.nucleusapp` is a zip with, at its root, `nucleus.app.json`, `DIGESTS.json`
//! and a `payload/` directory. Installation is fail-safe:
//!
//! 1. the archive is opened once and its SHA-256 checked against the catalogue
//!    from the *same* handle (no reopen → no TOCTOU swap);
//! 2. the archive is unpacked into a sibling temp directory, verifying **every**
//!    `payload/` file against its `DIGESTS.json` entry and refusing any path
//!    that escapes the target (zip-slip / MagicDot), oversized entry or
//!    case-insensitive collision;
//! 3. only once everything verified is the temp directory swapped into place,
//!    with the previous version kept aside for rollback. A failure at any step
//!    leaves the existing install untouched, and an interrupted (crashed)
//!    previous run is repaired on the next install.

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{self, Read, Seek};
use std::path::{Path, PathBuf};

use nucleus_launcher_core::verify::{
    DIGESTS_FILE, DigestError, Digests, MAX_META_BYTES, normalize_sha256, parse_digests,
    sanitize_entry_path, sha256_hex,
};
use nucleus_launcher_core::{ManifestError, parse_manifest};
use thiserror::Error;
use zip::ZipArchive;
use zip::result::ZipError;

#[cfg(test)]
use zip::write::SimpleFileOptions;
#[cfg(test)]
use zip::{CompressionMethod, ZipWriter};

use crate::verify::sha256_reader;

/// The app manifest's file name at an archive's (and an install's) root.
pub const MANIFEST_FILE: &str = "nucleus.app.json";
/// The directory inside a `.nucleusapp` that becomes the app root on install.
pub const PAYLOAD_DIR: &str = "payload";

/// Largest single `payload/` file we will write (decompression-bomb cap).
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Largest total decompressed payload we will write per install.
pub const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
/// Largest number of entries we will iterate in a single archive.
pub const MAX_ENTRIES: usize = 10_000;

/// Anything that can go wrong while installing an archive.
#[derive(Debug, Error)]
pub enum InstallError {
    #[error("i/o error: {0}")]
    Io(#[from] io::Error),

    #[error("not a valid .nucleusapp archive: {0}")]
    Archive(#[from] ZipError),

    #[error("`{0}` is not a valid sha256 digest")]
    InvalidExpectedHash(String),

    #[error("archive hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("archive is missing `{0}`")]
    MissingEntry(String),

    #[error("invalid manifest: {0}")]
    Manifest(#[from] ManifestError),

    #[error("invalid {DIGESTS_FILE}: {0}")]
    Digests(#[from] DigestError),

    #[error("unsafe entry path `{0}` in archive")]
    UnsafePath(String),

    #[error("payload `{0}` has no digest in {DIGESTS_FILE}")]
    Undigested(String),

    #[error("digest listed for `{0}` but the file is not in the archive")]
    MissingPayload(String),

    #[error("digest mismatch for `{path}`: expected {expected}, got {actual}")]
    DigestMismatch {
        path: String,
        expected: String,
        actual: String,
    },

    #[error("archive entry `{path}` is too large: {size} bytes (limit {limit})")]
    TooLarge { path: String, size: u64, limit: u64 },

    #[error("archive entries `{a}` and `{b}` collide on a case-insensitive filesystem")]
    PathCollision { a: String, b: String },

    #[error("failed to roll back `{id}` after a failed install: {source}")]
    RollbackFailed { id: String, source: io::Error },

    #[error("refused `{id}`: {reason}")]
    Refused { id: String, reason: String },
}

/// Where the archive came from, which decides what it is allowed to run.
/// A bundle the user picked on disk may be a `command` app they wrote; a bundle
/// the catalogue pushed may not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallOrigin {
    /// Fetched because a (signed) catalogue listed it.
    Catalog,
    /// Chosen by the user on disk.
    Local,
}

/// [`install_archive`] plus the launch policy for the origin (N1).
///
/// The manifest is only parsed inside `install_archive`, so the policy runs on
/// the manifest that landed on disk; a refusal rolls the app back out instead of
/// leaving a downloaded `kind: command` bundle installed.
pub fn install_checked(
    archive_path: &Path,
    apps_root: &Path,
    expected_sha256: Option<&str>,
    origin: InstallOrigin,
) -> Result<InstallOutcome, InstallError> {
    let outcome = install_archive(archive_path, apps_root, expected_sha256)?;
    if origin == InstallOrigin::Local {
        return Ok(outcome);
    }
    let manifest_path = outcome.dir.join(MANIFEST_FILE);
    let reason = match fs::read_to_string(&manifest_path) {
        Ok(text) => match parse_manifest(&text) {
            Ok(manifest) => nucleus_launcher_core::catalogue_launch_problem(&manifest),
            Err(err) => Some(format!("unreadable manifest: {err}")),
        },
        Err(err) => Some(format!("unreadable manifest: {err}")),
    };
    if let Some(reason) = reason {
        let _ = uninstall_app(&outcome.id, apps_root);
        return Err(InstallError::Refused {
            id: outcome.id,
            reason,
        });
    }
    Ok(outcome)
}

/// A successful install.
#[derive(Debug, Clone)]
pub struct InstallOutcome {
    /// The app id from the manifest (`nucleus.notes`).
    pub id: String,
    /// The installed version (`1.2.0`).
    pub version: String,
    /// The app root: `<apps_root>/<id>`.
    pub dir: PathBuf,
    /// Number of `payload/` files written (the manifest is not counted).
    pub files: usize,
}

/// Removes `path` on drop unless disarmed. Guarantees the staging directory is
/// never leaked, even when a later step returns early with `?`.
struct StagingGuard {
    path: PathBuf,
    armed: bool,
}

impl StagingGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    /// Keep the directory (it has been moved into place).
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// Best-effort recursive delete; never fails the install.
fn cleanup_dir(path: &Path) {
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
}

/// Repair an install interrupted between the stash and the swap: if the live
/// directory is gone but our stash survives, put the stash back.
fn recover_stale(apps_root: &Path, id: &str) {
    let app_dir = apps_root.join(id);
    let stash = apps_root.join(format!(".nucleus-old-{id}"));
    if !app_dir.exists() && stash.exists() {
        let _ = fs::rename(&stash, &app_dir);
    }
}

/// Install `archive_path` under `apps_root/<id>`.
///
/// `expected_sha256` is the catalogue's advertised hash of the whole archive;
/// `None` skips that check (a local, hand-built archive). Any digest, path or
/// I/O problem aborts before the swap, leaving an existing install in place.
pub fn install_archive(
    archive_path: &Path,
    apps_root: &Path,
    expected_sha256: Option<&str>,
) -> Result<InstallOutcome, InstallError> {
    // Open once; hash and parse from the same handle so the archive cannot be
    // swapped between the integrity check and the extraction (TOCTOU).
    let mut file = File::open(archive_path)?;
    if let Some(expected) = expected_sha256 {
        let expected = normalize_sha256(expected)
            .ok_or_else(|| InstallError::InvalidExpectedHash(expected.to_string()))?;
        let actual = sha256_reader(&mut file)?;
        if actual != expected {
            return Err(InstallError::HashMismatch { expected, actual });
        }
        file.rewind()?;
    }

    let mut archive = ZipArchive::new(file)?;
    if archive.len() > MAX_ENTRIES {
        return Err(InstallError::TooLarge {
            path: "<archive>".into(),
            size: archive.len() as u64,
            limit: MAX_ENTRIES as u64,
        });
    }

    let manifest_raw = read_entry(&mut archive, MANIFEST_FILE)?;
    let manifest = parse_manifest(&manifest_raw)?;
    let id = manifest.id.clone();
    let version = manifest.version.clone();

    let digests_raw = read_entry(&mut archive, DIGESTS_FILE)?;
    let digests = parse_digests(&digests_raw)?;

    fs::create_dir_all(apps_root)?;
    recover_stale(apps_root, &id);

    let tmp = apps_root.join(format!(".nucleus-tmp-{id}"));
    cleanup_dir(&tmp);
    fs::create_dir_all(&tmp)?;
    let mut guard = StagingGuard::new(tmp.clone());

    let files = extract(&mut archive, &tmp, &manifest_raw, &digests)?;

    let app_dir = apps_root.join(&id);
    let stash = apps_root.join(format!(".nucleus-old-{id}"));
    // A leftover stash is debris from an earlier crash — never fatal.
    cleanup_dir(&stash);
    let had_previous = app_dir.exists();
    if had_previous {
        fs::rename(&app_dir, &stash)?;
    }
    if let Err(err) = fs::rename(&tmp, &app_dir) {
        if had_previous && let Err(rollback) = fs::rename(&stash, &app_dir) {
            return Err(InstallError::RollbackFailed {
                id,
                source: rollback,
            });
        }
        return Err(err.into()); // guard removes the staging directory
    }
    guard.disarm();
    // Best effort: a running app may hold the old files.
    cleanup_dir(&stash);

    Ok(InstallOutcome {
        id,
        version,
        dir: app_dir,
        files,
    })
}

/// Anything that can go wrong uninstalling a catalogue app.
#[derive(Debug, Error)]
pub enum UninstallError {
    #[error("`{0}` is not installed")]
    NotInstalled(String),

    #[error("refusing to uninstall `{0}`: `{1}` is not a Nucleus app directory")]
    NotAnApp(String, String),

    #[error("invalid app id `{0}`")]
    InvalidId(String),

    #[error("i/o error: {0}")]
    Io(#[from] io::Error),
}

/// Remove a catalogue-installed app (`<apps_root>/<id>`). Only directories that
/// actually look like a Nucleus install are removed, so a stray folder or a
/// repository app (which lives elsewhere) is never deleted.
pub fn uninstall_app(id: &str, apps_root: &Path) -> Result<(), UninstallError> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err(UninstallError::InvalidId(id.to_string()));
    }
    let dir = apps_root.join(id);
    if !dir.is_dir() {
        return Err(UninstallError::NotInstalled(id.to_string()));
    }
    let looks_like_an_app =
        dir.join(MANIFEST_FILE).is_file() || dir.join("current").join(MANIFEST_FILE).is_file();
    if !looks_like_an_app {
        return Err(UninstallError::NotAnApp(
            id.to_string(),
            dir.display().to_string(),
        ));
    }
    fs::remove_dir_all(&dir)?;
    Ok(())
}

fn read_entry(archive: &mut ZipArchive<File>, name: &str) -> Result<String, InstallError> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(ZipError::FileNotFound) => return Err(InstallError::MissingEntry(name.to_string())),
        Err(err) => return Err(InstallError::Archive(err)),
    };
    let size = entry.size();
    if size > MAX_META_BYTES {
        return Err(InstallError::TooLarge {
            path: name.to_string(),
            size,
            limit: MAX_META_BYTES,
        });
    }
    let mut buffer = String::new();
    entry.read_to_string(&mut buffer)?;
    Ok(buffer)
}

/// Unpack `payload/**` into `dir`, verifying each file as it is written.
fn extract(
    archive: &mut ZipArchive<File>,
    dir: &Path,
    manifest_raw: &str,
    digests: &Digests,
) -> Result<usize, InstallError> {
    fs::write(dir.join(MANIFEST_FILE), manifest_raw)?;

    let mut written: BTreeSet<String> = BTreeSet::new();
    // Lowercased on-disk path → the archive path that claimed it (collision check).
    let mut destinations: HashMap<String, String> = HashMap::new();
    let mut total: u64 = 0;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        let Some(clean) = sanitize_entry_path(&raw_name) else {
            return Err(InstallError::UnsafePath(raw_name));
        };
        let Some(relative) = clean.strip_prefix("payload/") else {
            continue; // manifest / digests / future root files are not payload
        };
        if relative.is_empty() {
            continue;
        }

        let size = entry.size();
        if size > MAX_FILE_BYTES {
            return Err(InstallError::TooLarge {
                path: clean,
                size,
                limit: MAX_FILE_BYTES,
            });
        }
        total = total.saturating_add(size);
        if total > MAX_TOTAL_BYTES {
            return Err(InstallError::TooLarge {
                path: "<archive>".into(),
                size: total,
                limit: MAX_TOTAL_BYTES,
            });
        }

        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;

        let expected = digests
            .get(&clean)
            .ok_or_else(|| InstallError::Undigested(clean.clone()))?;
        let actual = sha256_hex(&bytes);
        if actual != expected {
            return Err(InstallError::DigestMismatch {
                path: clean,
                expected: expected.to_string(),
                actual,
            });
        }

        // On Windows two paths differing only by case land on the same file.
        let key = relative.to_ascii_lowercase();
        if let Some(existing) = destinations.get(&key) {
            return Err(InstallError::PathCollision {
                a: existing.clone(),
                b: clean,
            });
        }

        let destination = dir.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&destination, &bytes)?;
        destinations.insert(key, clean.clone());
        written.insert(clean);
    }

    for path in digests.files.keys() {
        if !written.contains(path) {
            return Err(InstallError::MissingPayload(path.clone()));
        }
    }
    if written.is_empty() {
        return Err(InstallError::MissingEntry(format!("{PAYLOAD_DIR}/")));
    }
    Ok(written.len())
}

/// Repack a directory as a `.nucleusapp` archive: `nucleus.app.json` and
/// `DIGESTS.json` at the root, every other file under `payload/`.
///
/// Test-only helper (and the shape the future `pack-app` tool must match).
#[cfg(test)]
fn pack_archive(dir: &Path, name: &str, files: &[(&str, &[u8])]) -> PathBuf {
    let archive_path = dir.join(name);
    let file = File::create(&archive_path).unwrap();
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let manifest = files
        .iter()
        .find(|(path, _)| *path == MANIFEST_FILE)
        .expect("a manifest is required");
    writer.start_file(MANIFEST_FILE, options).unwrap();
    std::io::Write::write_all(&mut writer, manifest.1).unwrap();

    let mut ledger = serde_json::Map::new();
    for (path, bytes) in files {
        if *path == MANIFEST_FILE || *path == DIGESTS_FILE {
            continue;
        }
        let payload_path = format!("{PAYLOAD_DIR}/{path}");
        ledger.insert(
            payload_path.clone(),
            serde_json::Value::String(format!("sha256:{}", sha256_hex(bytes))),
        );
        writer.start_file(payload_path, options).unwrap();
        std::io::Write::write_all(&mut writer, bytes).unwrap();
    }
    writer.start_file(DIGESTS_FILE, options).unwrap();
    let ledger_json = serde_json::to_vec(&serde_json::Value::Object(ledger)).unwrap();
    std::io::Write::write_all(&mut writer, &ledger_json).unwrap();
    writer.finish().unwrap();
    archive_path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    const MANIFEST: &[u8] = br#"{
      "id": "nucleus.notes",
      "name": "Notes",
      "version": "0.1.0",
      "coreApiVersion": "1",
      "launch": { "kind": "server", "args": ["dist/server.js"], "readyPath": "/api/state" }
    }"#;

    /// A fresh scratch directory; the caller removes it.
    fn scratch(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "nucleus-install-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_files() -> Vec<(&'static str, &'static [u8])> {
        vec![
            (MANIFEST_FILE, MANIFEST),
            ("dist/server.js", b"console.log('notes');"),
            ("icon.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
        ]
    }

    /// Write a zip with exactly the entries given (raw names, no ledger logic).
    fn raw_archive(dir: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join(name);
        let file = File::create(&path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (entry_name, bytes) in entries {
            writer.start_file(*entry_name, options).unwrap();
            std::io::Write::write_all(&mut writer, bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    #[test]
    fn installs_payload_and_manifest() {
        let root = scratch("ok");
        let archive = pack_archive(&root, "notes.nucleusapp", &sample_files());
        let apps = root.join("apps");

        let outcome = install_archive(&archive, &apps, None).expect("install");
        assert_eq!(outcome.id, "nucleus.notes");
        assert_eq!(outcome.version, "0.1.0");
        assert_eq!(outcome.files, 2);

        let app_dir = apps.join("nucleus.notes");
        assert_eq!(
            fs::read_to_string(app_dir.join(MANIFEST_FILE)).unwrap(),
            String::from_utf8_lossy(MANIFEST)
        );
        assert_eq!(
            fs::read_to_string(app_dir.join("dist/server.js")).unwrap(),
            "console.log('notes');"
        );
        assert!(app_dir.join("icon.svg").is_file());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_discovered_install_is_seen_by_the_launcher() {
        let root = scratch("discover");
        let archive = pack_archive(&root, "notes.nucleusapp", &sample_files());
        let apps = root.join("apps");
        install_archive(&archive, &apps, None).expect("install");

        let empty = root.join("empty-apps");
        fs::create_dir_all(&empty).unwrap();
        let paths = crate::paths::Paths {
            repo_root: Some(root.clone()),
            user_apps: apps.clone(),
            app_roots: vec![empty, apps],
            window_profiles_dir: root.join("profiles"),
            shell_exe: None,
            icon_ico: None,
        };
        let discovery =
            crate::discovery::discover(&paths, &nucleus_launcher_core::Catalog::default());
        let app = discovery.app("nucleus.notes").expect("installed app seen");
        assert_eq!(app.source, nucleus_launcher_core::AppSource::UserData);
        assert_eq!(app.name(), "Notes");
        assert_eq!(app.dir, root.join("apps").join("nucleus.notes"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_wrong_archive_hash() {
        let root = scratch("hash");
        let archive = pack_archive(&root, "notes.nucleusapp", &sample_files());
        let apps = root.join("apps");
        let err = install_archive(&archive, &apps, Some(&"0".repeat(64))).unwrap_err();
        assert!(
            matches!(err, InstallError::HashMismatch { .. }),
            "got {err:?}"
        );
        assert!(!apps.join("nucleus.notes").exists(), "nothing installed");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_a_correct_archive_hash() {
        let root = scratch("hash-ok");
        let archive = pack_archive(&root, "notes.nucleusapp", &sample_files());
        let apps = root.join("apps");
        let digest = sha256_reader(&mut File::open(&archive).unwrap()).unwrap();
        let outcome = install_archive(&archive, &apps, Some(&format!("sha256:{digest}"))).unwrap();
        assert_eq!(outcome.id, "nucleus.notes");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_malformed_expected_hash() {
        let root = scratch("hash-bad");
        let archive = pack_archive(&root, "notes.nucleusapp", &sample_files());
        let apps = root.join("apps");
        let err = install_archive(&archive, &apps, Some("not-a-hash")).unwrap_err();
        assert!(
            matches!(err, InstallError::InvalidExpectedHash(_)),
            "got {err:?}"
        );
        assert!(!apps.join("nucleus.notes").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_tampered_payload_fails_and_leaves_nothing() {
        let root = scratch("digest");
        // Build a valid archive, then swap a payload byte after the ledger was written.
        let files = sample_files();
        let archive = pack_archive(&root, "notes.nucleusapp", &files);

        // Rewrite the archive with one payload file altered but the old ledger kept.
        let file = File::create(root.join("tampered.nucleusapp")).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut original = ZipArchive::new(File::open(&archive).unwrap()).unwrap();
        let mut ledger = String::new();
        original
            .by_name(DIGESTS_FILE)
            .unwrap()
            .read_to_string(&mut ledger)
            .unwrap();
        writer.start_file(MANIFEST_FILE, options).unwrap();
        std::io::Write::write_all(&mut writer, MANIFEST).unwrap();
        writer
            .start_file("payload/dist/server.js", options)
            .unwrap();
        std::io::Write::write_all(&mut writer, b"evil();").unwrap();
        writer.start_file("payload/icon.svg", options).unwrap();
        std::io::Write::write_all(&mut writer, b"<svg xmlns='http://www.w3.org/2000/svg'/>")
            .unwrap();
        writer.start_file(DIGESTS_FILE, options).unwrap();
        std::io::Write::write_all(&mut writer, ledger.as_bytes()).unwrap();
        writer.finish().unwrap();

        let apps = root.join("apps");
        let err = install_archive(&root.join("tampered.nucleusapp"), &apps, None).unwrap_err();
        assert!(
            matches!(err, InstallError::DigestMismatch { .. }),
            "got {err:?}"
        );
        assert!(!apps.join("nucleus.notes").exists());
        assert!(
            !apps.join(".nucleus-tmp-nucleus.notes").exists(),
            "temp directory cleaned up"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_update_replaces_the_previous_install() {
        let root = scratch("update");
        let apps = root.join("apps");
        let v1 = pack_archive(&root, "v1.nucleusapp", &sample_files());
        install_archive(&v1, &apps, None).unwrap();
        assert!(apps.join("nucleus.notes/dist/server.js").is_file());

        // A re-pack without dist/ must fully replace the old tree.
        let v2_files: Vec<(&str, &[u8])> = vec![
            (MANIFEST_FILE, MANIFEST),
            ("icon.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
        ];
        let v2 = pack_archive(&root, "v2.nucleusapp", &v2_files);
        install_archive(&v2, &apps, None).unwrap();
        assert!(apps.join("nucleus.notes/icon.svg").is_file());
        assert!(
            !apps.join("nucleus.notes/dist").exists(),
            "stale files from the previous version are gone"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_traversing_payload_path() {
        let root = scratch("slip");
        let payload = b"pwned";
        let ledger = serde_json::json!({
            "payload/evil.txt": format!("sha256:{}", sha256_hex(payload)),
        });
        // `payload/.. /evil.txt` — Win32 strips the trailing space, escaping the app root.
        let archive = raw_archive(
            &root,
            "slip.nucleusapp",
            &[
                (MANIFEST_FILE, MANIFEST),
                ("payload/.. /evil.txt", payload),
                (DIGESTS_FILE, ledger.to_string().as_bytes()),
            ],
        );
        let apps = root.join("apps");
        let err = install_archive(&archive, &apps, None).unwrap_err();
        assert!(matches!(err, InstallError::UnsafePath(_)), "got {err:?}");
        assert!(!root.join("apps/evil.txt").exists());
        assert!(!root.join("evil.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_case_insensitive_collision() {
        let root = scratch("case");
        let a = b"upper";
        let b = b"lower";
        let ledger = serde_json::json!({
            "payload/Icon.svg": format!("sha256:{}", sha256_hex(a)),
            "payload/icon.svg": format!("sha256:{}", sha256_hex(b)),
        });
        let archive = raw_archive(
            &root,
            "case.nucleusapp",
            &[
                (MANIFEST_FILE, MANIFEST),
                ("payload/Icon.svg", a),
                ("payload/icon.svg", b),
                (DIGESTS_FILE, ledger.to_string().as_bytes()),
            ],
        );
        let apps = root.join("apps");
        let err = install_archive(&archive, &apps, None).unwrap_err();
        assert!(
            matches!(err, InstallError::PathCollision { .. }),
            "got {err:?}"
        );
        assert!(!apps.join("nucleus.notes").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstalls_an_installed_app() {
        let root = scratch("uninstall");
        let archive = pack_archive(&root, "notes.nucleusapp", &sample_files());
        let apps = root.join("apps");
        install_archive(&archive, &apps, None).unwrap();
        assert!(apps.join("nucleus.notes").is_dir());

        uninstall_app("nucleus.notes", &apps).unwrap();
        assert!(!apps.join("nucleus.notes").exists());
        // A second call reports it is already gone.
        assert!(matches!(
            uninstall_app("nucleus.notes", &apps),
            Err(UninstallError::NotInstalled(_))
        ));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_uninstall_a_non_app_directory() {
        let root = scratch("uninstall-guard");
        let apps = root.join("apps");
        fs::create_dir_all(apps.join("nucleus.notes")).unwrap();
        fs::write(apps.join("nucleus.notes/random.txt"), b"hi").unwrap();
        let err = uninstall_app("nucleus.notes", &apps).unwrap_err();
        assert!(matches!(err, UninstallError::NotAnApp(_, _)), "got {err:?}");
        assert!(apps.join("nucleus.notes").exists(), "left untouched");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_an_id_with_a_separator() {
        let root = scratch("uninstall-id");
        let apps = root.join("apps");
        fs::create_dir_all(&apps).unwrap();
        assert!(matches!(
            uninstall_app("..\\evil", &apps),
            Err(UninstallError::InvalidId(_))
        ));
        assert!(matches!(
            uninstall_app("a/b", &apps),
            Err(UninstallError::InvalidId(_))
        ));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_crashed_install_is_recovered_on_the_next_run() {
        let root = scratch("recover");
        let apps = root.join("apps");
        let archive = pack_archive(&root, "notes.nucleusapp", &sample_files());

        // Simulate a crash mid-swap: the live dir is gone, the stash survives.
        let stash = apps.join(".nucleus-old-nucleus.notes");
        fs::create_dir_all(&stash).unwrap();
        fs::write(stash.join("dist-server.js"), b"stale").unwrap();
        assert!(!apps.join("nucleus.notes").exists());

        // The next install must repair first, then succeed.
        let outcome = install_archive(&archive, &apps, None).unwrap();
        assert_eq!(outcome.id, "nucleus.notes");
        assert!(apps.join("nucleus.notes/dist/server.js").is_file());
        assert!(!stash.exists(), "recovered stash cleaned up");
        let _ = fs::remove_dir_all(&root);
    }
}
