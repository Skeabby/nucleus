//! Rolling-latest update survey (§4.5 self-update posture).
//!
//! On startup the launcher checks the remote catalogue once:
//!
//! 1. `catalog.json` — if its content differs from the local override, it is
//!    written atomically to `%APPDATA%\Nucleus\catalog.json`, so `catalogue`
//!    loading and `derive_status` pick the new versions up; discovered apps
//!    whose catalogue version is newer become `UpdateAvailable` and are
//!    auto-installed by the app module.
//! 2. `suiteVersion` — compared against the running launcher's version; a
//!    newer remote means the launcher itself has an update (the UI offers the
//!    new installer download; installing simply runs the setup and exits).
//!
//! Offline / malformed responses are non-fatal: the local state simply stays
//! authoritative until the next start.

use std::path::Path;

use nucleus_launcher_core::{Catalog, parse_catalog};

use crate::net;

/// Where the rolling release is served from.
pub const DEFAULT_BASE: &str = "https://github.com/Skeabby/nucleus/releases/latest/download/";

/// What the startup survey found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Survey {
    /// The remote catalogue as-is (lenient parse, bad entries dropped).
    pub catalog: Catalog,
    /// Raw JSON bytes as downloaded (for storing a byte-identical override).
    pub catalog_json: String,
    /// Remote `suiteVersion` newer than this build — the launcher has an
    /// update. `None` means no usable remote version or identical/older.
    pub launcher_update: Option<String>,
}

/// Point at `base` and fetch the remote catalogue.
pub fn survey(base: &str) -> Result<Survey, String> {
    let source = format!("{}/catalog.json", base.trim_end_matches('/'));
    let catalog_json = net::fetch_text(&source).map_err(|err| err.to_string())?;
    let catalog = parse_catalog(&catalog_json);
    let local = env!("CARGO_PKG_VERSION");
    let launcher_update = if catalog.suite_version.is_empty()
        || !nucleus_launcher_core::is_update(&catalog.suite_version, local)
    {
        None
    } else {
        Some(catalog.suite_version.clone())
    };
    Ok(Survey {
        catalog,
        catalog_json,
        launcher_update,
    })
}

/// Write the remote catalogue as the local override, atomically.
///
/// Any existing file is replaced in full (matching the launcher's
/// full-replace posture for `run/apps.json`); the `.part` dance keeps a
/// failed write from producing a half-file override.
pub fn store_override(catalog_json: &str, data_dir: &Path) -> Result<(), String> {
    let dest = data_dir.join("catalog.json");
    let part = data_dir.join("catalog.json.part");
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(&part, catalog_json).map_err(|err| err.to_string())?;
    std::fs::rename(&part, &dest).map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_override_replaces_atomically() {
        let dir = std::env::temp_dir().join(format!("nucleus-upd-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        store_override(r#"{"suiteVersion":"1"}"#, &dir).unwrap();
        store_override(r#"{"suiteVersion":"2"}"#, &dir).unwrap();
        let text = std::fs::read_to_string(dir.join("catalog.json")).unwrap();
        assert_eq!(text, r#"{"suiteVersion":"2"}"#);
        assert!(!dir.join("catalog.json.part").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_override_fails_loudly_on_bad_dir() {
        let path = std::path::Path::new("Z:\\definitely-not-a-drive\\x");
        assert!(store_override("{}", path).is_err());
    }
}
