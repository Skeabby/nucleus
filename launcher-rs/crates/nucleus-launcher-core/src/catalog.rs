//! The offline catalogue (`mirror/catalog.json`). Parsing is lenient: entries
//! that miss required fields or carry an invalid sha256 are dropped, never fatal.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub repo: String,
    pub release_asset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub version: Option<String>,
    pub url: Option<String>,
    pub name: Option<String>,
    pub channel: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherRelease {
    pub version: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct Catalog {
    #[serde(default)]
    pub suite_version: String,
    pub generated_at: Option<String>,
    /// When the publisher signed this payload (N1). Drives the downgrade rule.
    pub issued_at: Option<String>,
    /// Freshness deadline for a *fetched* catalogue (N1). Empty for the
    /// embedded fallback, which never expires.
    pub expires_at: Option<String>,
    /// The installer matching [`Catalog::suite_version`], so a self-update is
    /// checked against the signed payload instead of a guessed URL.
    pub launcher: Option<LauncherRelease>,
    #[serde(default)]
    pub apps: Vec<CatalogEntry>,
}

/// Parse a catalogue file, dropping malformed entries. A totally unreadable
/// file yields an empty [`Catalog`].
pub fn parse_catalog(json: &str) -> Catalog {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return Catalog::default();
    };
    let suite_version = root
        .get("suiteVersion")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let generated_at = root
        .get("generatedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let issued_at = root
        .get("issuedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let expires_at = root
        .get("expiresAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let launcher = root.get("launcher").and_then(launcher_from_value);
    let mut apps = Vec::new();
    if let Some(list) = root.get("apps").and_then(Value::as_array) {
        for item in list {
            if let Some(entry) = catalog_entry_from_value(item) {
                apps.push(entry);
            }
        }
    }
    Catalog {
        suite_version,
        generated_at,
        issued_at,
        expires_at,
        launcher,
        apps,
    }
}

/// The signed `launcher` block: a self-update is only offered for a release the
/// signature covers, with its own checksum.
fn launcher_from_value(value: &Value) -> Option<LauncherRelease> {
    let obj = value.as_object()?;
    let get = |key: &str| obj.get(key).and_then(Value::as_str).map(str::to_string);
    let version = get("version")?;
    let url = get("url")?;
    if version.trim().is_empty() || url.trim().is_empty() {
        return None;
    }
    let sha256 = get("sha256");
    if let Some(hash) = &sha256 {
        let valid = hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit());
        if !valid {
            return None;
        }
    }
    Some(LauncherRelease {
        version,
        url,
        sha256,
    })
}

/// `None` when required fields are missing, or the sha256 is not 64 hex chars.
fn catalog_entry_from_value(value: &Value) -> Option<CatalogEntry> {
    let obj = value.as_object()?;
    let get = |key: &str| obj.get(key).and_then(Value::as_str).map(str::to_string);
    let id = get("id")?;
    let repo = get("repo")?;
    let release_asset = get("releaseAsset")?;
    if id.is_empty() || repo.is_empty() || release_asset.is_empty() {
        return None;
    }
    let sha256 = get("sha256");
    if let Some(hash) = &sha256 {
        let valid = hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit());
        if !valid {
            return None;
        }
    }
    Some(CatalogEntry {
        id,
        repo,
        release_asset,
        sha256,
        version: get("version"),
        url: get("url"),
        name: get("name"),
        channel: get("channel"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_good_entries_and_drops_bad() {
        let json = r#"{
          "suiteVersion": "0.1.0",
          "generatedAt": "2026-10-13T00:00:00Z",
          "apps": [
            {
              "id": "nucleus.notes",
              "repo": "Skeabby/nucleus",
              "releaseAsset": "nucleus.notes.nucleusapp",
              "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              "version": "0.1.0",
              "name": "Notes"
            },
            {
              "id": "nucleus.broken",
              "repo": "missing releaseAsset only"
            },
            {
              "id": "nucleus.badsha",
              "repo": "Skeabby/nucleus",
              "releaseAsset": "x.nucleusapp",
              "sha256": "not-a-real-hash"
            }
          ]
        }"#;
        let catalog = parse_catalog(json);
        assert_eq!(catalog.suite_version, "0.1.0");
        assert_eq!(
            catalog.generated_at.as_deref(),
            Some("2026-10-13T00:00:00Z")
        );
        assert_eq!(catalog.apps.len(), 1);
        assert_eq!(catalog.apps[0].id, "nucleus.notes");
        assert_eq!(catalog.apps[0].sha256.as_deref().unwrap().len(), 64);
    }

    #[test]
    fn garbage_file_yields_empty_catalog() {
        let catalog = parse_catalog("this is not json");
        assert!(catalog.apps.is_empty());
        assert!(catalog.suite_version.is_empty());
    }

    #[test]
    fn empty_apps_is_fine() {
        let catalog = parse_catalog(r#"{"suiteVersion":"0.1.0","apps":[]}"#);
        assert!(catalog.apps.is_empty());
    }
}
