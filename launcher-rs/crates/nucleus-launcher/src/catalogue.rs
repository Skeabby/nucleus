//! Locating and loading the offline catalogue (`catalog.json`).
//!
//! Precedence:
//! 1. the `NUCLEUS_CATALOG` environment variable — a path, `file://` or
//!    `http(s)://` URL, fetched with [`crate::net::fetch_catalog`];
//! 2. `<data_dir>/catalog.json` — a catalogue previously placed on disk;
//! 3. the copy embedded at build time from `launcher-rs/mirror/catalog.json`,
//!    so the launcher always has *some* catalogue and works fully offline.
//!
//! Loading never fails: a source that cannot be read logs a warning and the
//! next source is tried; the embedded catalogue is always available.

use std::path::Path;

use nucleus_launcher_core::{Catalog, parse_catalog};

/// The catalogue compiled into the binary (repo `launcher-rs/mirror/catalog.json`).
pub const EMBEDDED: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../mirror/catalog.json"
));

/// The embedded catalogue. Parsing is lenient, so this never fails.
pub fn embedded() -> Catalog {
    parse_catalog(EMBEDDED)
}

/// Load the catalogue, returning it with any non-fatal warnings.
pub fn load(data_dir: &Path) -> (Catalog, Vec<String>) {
    load_with(data_dir, nucleus_launcher_core::trust::TRUSTED_KEYS)
}

/// [`load`] with an explicit key list, so the test suite can sign its own
/// fixture instead of holding the release key.
pub fn load_with(data_dir: &Path, keys: &[(&str, [u8; 32])]) -> (Catalog, Vec<String>) {
    let mut warnings = Vec::new();

    if let Ok(source) = std::env::var("NUCLEUS_CATALOG") {
        let source = source.trim();
        if !source.is_empty() {
            match crate::net::fetch_catalog(source) {
                Ok(catalog) => return (resolve_relative_urls(catalog, source), warnings),
                Err(err) => warnings.push(format!("NUCLEUS_CATALOG: {err}")),
            }
        }
    }

    let local = data_dir.join("catalog.json");
    if local.is_file() {
        match load_trusted_override(&local, keys) {
            Ok(catalog) => {
                let source = local.to_string_lossy().into_owned();
                return (resolve_relative_urls(catalog, &source), warnings);
            }
            Err(err) => warnings.push(format!("{}: {err}", local.display())),
        }
    }

    (embedded(), warnings)
}

/// A catalogue on disk counts only when `catalog.json.sig` verifies against the
/// bytes beside it (N1). Hand-writing the override no longer changes what the
/// launcher installs — that is the whole point of signing the bytes.
fn load_trusted_override(path: &Path, keys: &[(&str, [u8; 32])]) -> Result<Catalog, String> {
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    let signature_path = path.with_extension("json.sig");
    let signature = std::fs::read_to_string(&signature_path)
        .map_err(|_| format!("unsigned catalogue (no {})", signature_path.display()))?;
    let envelope = nucleus_launcher_core::SignatureEnvelope::parse(&signature)
        .map_err(|err| err.to_string())?;
    nucleus_launcher_core::verify_with(&bytes, &envelope.signature, &envelope.key_id, keys)
        .map_err(|err| err.to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| "catalogue is not UTF-8".to_string())?;
    Ok(parse_catalog(&text))
}

/// Rewrite every app `url` that is a relative path into an absolute path
/// resolved against the catalogue's own directory. This lets a catalogue be a
/// plain folder on disk (`mirror/catalog.json` next to `mirror/apps/*`), which
/// is what makes `NUCLEUS_CATALOG=…/catalog.json` install **offline**.
pub(crate) fn resolve_relative_urls(mut catalog: Catalog, source: &str) -> Catalog {
    let Some(base) = crate::net::local_path(source)
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
    else {
        return catalog;
    };
    for entry in &mut catalog.apps {
        if let Some(url) = &entry.url
            && !url.contains("://")
            && !Path::new(url).is_absolute()
        {
            entry.url = Some(base.join(url).to_string_lossy().into_owned());
        }
    }
    catalog
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "nucleus-catalogue-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_embedded_catalogue_parses() {
        // The embedded file must be valid enough to parse and carry the
        // metadata the launcher relies on; a broken one would silently yield an
        // empty catalogue, defeating M2.
        let catalog = embedded();
        assert!(
            catalog.generated_at.is_some(),
            "embedded catalogue has generatedAt"
        );
        assert!(
            !catalog.suite_version.is_empty(),
            "embedded catalogue has suiteVersion"
        );
    }

    /// The fixture is signed with the seed `0x00..0x1f` (key id `test-1`), the
    /// same deterministic test key as `core::trust`. The release key never
    /// reaches the test suite.
    const TEST_KEY: (&str, [u8; 32]) = (
        "test-1",
        [
            0x03, 0xa1, 0x07, 0xbf, 0xf3, 0xce, 0x10, 0xbe, 0x1d, 0x70, 0xdd, 0x18, 0xe7, 0x4b,
            0xc0, 0x99, 0x67, 0xe4, 0xd6, 0x30, 0x9b, 0xa5, 0x0d, 0x5f, 0x1d, 0xdc, 0x86, 0x64,
            0x12, 0x55, 0x31, 0xb8,
        ],
    );
    const FIXTURE_CATALOG: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/catalog.json"
    ));
    const FIXTURE_SIG: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/catalog.json.sig"
    ));

    fn write_fixture(dir: &Path, with_signature: bool) {
        fs::write(dir.join("catalog.json"), FIXTURE_CATALOG).unwrap();
        if with_signature {
            fs::write(dir.join("catalog.json.sig"), FIXTURE_SIG).unwrap();
        }
    }

    #[test]
    fn loads_a_signed_catalogue_from_the_data_dir() {
        if std::env::var("NUCLEUS_CATALOG").is_ok() {
            return; // the env override legitimately takes precedence
        }
        let dir = scratch("data");
        write_fixture(&dir, true);
        let (catalog, warnings) = load_with(&dir, &[TEST_KEY]);
        assert_eq!(catalog.suite_version, "9.9.9");
        assert_eq!(catalog.issued_at.as_deref(), Some("2026-10-24T00:00:00Z"));
        assert!(warnings.is_empty(), "warnings: {warnings:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relative_asset_urls_resolve_against_the_catalogue_dir() {
        let dir = scratch("relative");
        write_fixture(&dir, true);
        let (catalog, _) = load_with(&dir, &[TEST_KEY]);
        let url = catalog.apps[0].url.as_deref().unwrap();
        assert!(
            Path::new(url).is_absolute(),
            "resolved to an absolute path: {url}"
        );
        assert!(url.ends_with("notes.nucleusapp"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsigned_override_is_ignored() {
        if std::env::var("NUCLEUS_CATALOG").is_ok() {
            return;
        }
        let dir = scratch("unsigned");
        write_fixture(&dir, false);
        let (catalog, warnings) = load_with(&dir, &[TEST_KEY]);
        assert_eq!(
            catalog.suite_version,
            embedded().suite_version,
            "an unsigned file must not win over the embedded catalogue"
        );
        assert!(
            warnings.iter().any(|line| line.contains("unsigned")),
            "warnings: {warnings:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tampered_override_is_ignored() {
        if std::env::var("NUCLEUS_CATALOG").is_ok() {
            return;
        }
        let dir = scratch("tampered");
        let mut bytes = FIXTURE_CATALOG.to_vec();
        let index = bytes
            .windows(5)
            .position(|window| window == b"9.9.9")
            .unwrap();
        bytes[index] = b'8';
        fs::write(dir.join("catalog.json"), &bytes).unwrap();
        fs::write(dir.join("catalog.json.sig"), FIXTURE_SIG).unwrap();
        let (catalog, warnings) = load_with(&dir, &[TEST_KEY]);
        assert_eq!(catalog.suite_version, embedded().suite_version);
        assert!(!warnings.is_empty(), "a refusal is reported, not swallowed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_override_signed_by_an_unknown_key_is_ignored() {
        if std::env::var("NUCLEUS_CATALOG").is_ok() {
            return;
        }
        let dir = scratch("unknownkey");
        write_fixture(&dir, true);
        let (catalog, warnings) = load_with(&dir, &[("2031-z", [0u8; 32])]);
        assert_eq!(catalog.suite_version, embedded().suite_version);
        assert!(
            warnings.iter().any(|line| line.contains("unknown key")),
            "warnings: {warnings:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn falls_back_to_the_embedded_catalogue() {
        if std::env::var("NUCLEUS_CATALOG").is_ok() {
            return;
        }
        let dir = scratch("empty");
        let (catalog, warnings) = load(&dir);
        assert_eq!(catalog.suite_version, embedded().suite_version);
        assert!(warnings.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
