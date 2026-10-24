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

use nucleus_launcher_core::{
    Catalog, TrustState, check_freshness, parse_catalog, today_iso, trusted_bytes,
};

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
    /// The detached signature that got us here, stored beside the override so
    /// the next start can verify it again instead of trusting the file.
    pub signature_json: String,
    /// Remote `suiteVersion` newer than this build — the launcher has an
    /// update. `None` means no usable remote version or identical/older.
    pub launcher_update: Option<String>,
}

/// Point at `base` and fetch the remote catalogue, refusing to parse anything
/// that is not signed by a trusted key (N1).
///
/// Order matters: **verify the bytes, then parse**. Parsing first would let a
/// hostile catalogue shape the error messages, and `serde_json` on untrusted
/// bytes is exactly the surface we are removing.
pub fn survey(base: &str, state: &TrustState) -> Result<Survey, String> {
    let base = base.trim_end_matches('/');
    let source = format!("{base}/catalog.json");
    let bytes = net::fetch_bytes(&source, net::MAX_CATALOG_BYTES).map_err(|err| err.to_string())?;
    let signature_json = net::fetch_text(&format!("{base}/catalog.json.sig")).map_err(|err| {
        format!("the catalogue is not signed ({err}) — keeping the last known good one")
    })?;
    trusted_bytes(&bytes, &signature_json).map_err(|err| err.to_string())?;

    let catalog_json =
        String::from_utf8(bytes).map_err(|_| "catalogue is not UTF-8".to_string())?;
    let catalog = parse_catalog(&catalog_json);

    // Freshness applies to a *fetched* catalogue; the cached/embedded one is
    // exempt so an offline machine keeps working.
    let expires_at = catalog.expires_at.clone().unwrap_or_default();
    if expires_at.trim().is_empty() {
        return Err("the catalogue does not say when it expires".to_string());
    }
    check_freshness(&expires_at, &today_iso()).map_err(|err| err.to_string())?;

    if state.is_downgrade(catalog.issued_at.as_deref(), &catalog.suite_version) {
        return Err(format!(
            "refusing catalogue {} ({}) — older than the one already trusted",
            catalog.suite_version,
            catalog
                .issued_at
                .clone()
                .unwrap_or_else(|| "no date".to_string())
        ));
    }

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
        signature_json,
        launcher_update,
    })
}

/// Write the remote catalogue as the local override, atomically, together with
/// the signature that vouches for it.
///
/// Any existing file is replaced in full (matching the launcher's
/// full-replace posture for `run/apps.json`); the `.part` dance keeps a
/// failed write from producing a half-file override.
pub fn store_override(
    catalog_json: &str,
    signature_json: &str,
    data_dir: &Path,
) -> Result<(), String> {
    write_atomic(&data_dir.join("catalog.json"), catalog_json.as_bytes())?;
    write_atomic(
        &data_dir.join("catalog.json.sig"),
        signature_json.as_bytes(),
    )
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let part = dest.with_extension("part");
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(&part, bytes).map_err(|err| err.to_string())?;
    std::fs::rename(&part, dest).map_err(|err| err.to_string())?;
    Ok(())
}

/// `%APPDATA%\Nucleus\trust.json`: the downgrade high-water mark and the update
/// policy. A missing or unreadable file is the safe default (`ask`, no mark).
pub fn load_trust(data_dir: &Path) -> TrustState {
    std::fs::read_to_string(data_dir.join("trust.json"))
        .map(|text| TrustState::parse(&text))
        .unwrap_or_default()
}

pub fn save_trust(state: &TrustState, data_dir: &Path) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|err| err.to_string())?;
    write_atomic(&data_dir.join("trust.json"), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_override_replaces_atomically() {
        let dir = std::env::temp_dir().join(format!("nucleus-upd-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        store_override(r#"{"suiteVersion":"1"}"#, r#"{"keyId":"a"}"#, &dir).unwrap();
        store_override(r#"{"suiteVersion":"2"}"#, r#"{"keyId":"b"}"#, &dir).unwrap();
        let text = std::fs::read_to_string(dir.join("catalog.json")).unwrap();
        assert_eq!(text, r#"{"suiteVersion":"2"}"#);
        let sig = std::fs::read_to_string(dir.join("catalog.json.sig")).unwrap();
        assert_eq!(sig, r#"{"keyId":"b"}"#);
        assert!(!dir.join("catalog.json.part").exists());
        assert!(!dir.join("catalog.json.sig.part").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_override_fails_loudly_on_bad_dir() {
        let path = std::path::Path::new("Z:\\definitely-not-a-drive\\x");
        assert!(store_override("{}", "{}", path).is_err());
    }
}
