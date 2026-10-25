//! The installed-apps index (`installed.json`), keyed by app id.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::model::AppSource;

/// A single installation record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRecord {
    pub version: String,
    pub installed_at: String,
    /// `Repo` records are synthesized for locally-discovered apps and must
    /// never be uninstalled; `UserData` records come from the catalogue (M2).
    pub source: AppSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Hash of the archive this copy came from, when it came from a catalogue.
    ///
    /// A version is a promise, not a proof: a rebuild that changes the UI but
    /// keeps `0.4.0` makes "installed 0.4.0 vs catalogue 0.4.0" a lie, and the
    /// update never ships. Comparing the hashes catches that, and it is free —
    /// the catalogue already carries the digest we verified on the way in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_sha256: Option<String>,
}

/// A `BTreeMap` keyed by app id for stable iteration order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledIndex {
    pub apps: BTreeMap<String, InstalledRecord>,
}

impl InstalledIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse an `installed.json` file.
    pub fn load(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Pretty-print with a trailing newline (M2 writes this to disk).
    pub fn save(&self) -> Result<String, serde_json::Error> {
        Ok(format!("{}\n", serde_json::to_string_pretty(self)?))
    }

    pub fn get(&self, id: &str) -> Option<&InstalledRecord> {
        self.apps.get(id)
    }

    pub fn insert(
        &mut self,
        id: impl Into<String>,
        record: InstalledRecord,
    ) -> Option<InstalledRecord> {
        self.apps.insert(id.into(), record)
    }

    pub fn remove(&mut self, id: &str) -> Option<InstalledRecord> {
        self.apps.remove(id)
    }

    pub fn len(&self) -> usize {
        self.apps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.apps.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> InstalledIndex {
        let mut index = InstalledIndex::new();
        index.insert(
            "nucleus.notes",
            InstalledRecord {
                version: "0.1.0".into(),
                installed_at: "2026-10-13T09:00:00Z".into(),
                source: AppSource::UserData,
                channel: Some("stable".into()),
                bundle_sha256: None,
            },
        );
        index
    }

    #[test]
    fn save_load_roundtrip() {
        let index = sample();
        let json = index.save().expect("serialize");
        let loaded = InstalledIndex::load(&json).expect("deserialize");
        assert_eq!(loaded, index);
        assert_eq!(loaded.get("nucleus.notes").unwrap().version, "0.1.0");
    }

    #[test]
    fn remove_drops_key() {
        let mut index = sample();
        assert!(index.remove("nucleus.notes").is_some());
        assert!(index.is_empty());
    }

    #[test]
    fn load_rejects_garbage() {
        assert!(InstalledIndex::load("not json").is_err());
    }
}
