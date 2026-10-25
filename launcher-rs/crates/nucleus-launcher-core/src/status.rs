//! The actionable UI state of an app, derived from install + catalogue state.

use crate::catalog::CatalogEntry;
use crate::installed::InstalledRecord;
use crate::version::is_update;

/// What the launcher shows an app to be — distinct from the manifest's own
/// `status` (`stable`/`beta`/`alpha`) field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AppStatus {
    /// In the catalogue but not installed (M2).
    NotInstalled,
    /// Installed and up to date (or local, without a catalogue entry).
    Installed,
    /// Installed, but the catalogue has a newer version.
    UpdateAvailable,
    /// No install record and no catalogue entry — nothing actionable.
    Unavailable,
    /// Currently running.
    Running,
}

impl AppStatus {
    /// Can this app be opened / is it usable right now?
    pub fn is_installed(self) -> bool {
        matches!(
            self,
            AppStatus::Installed | AppStatus::UpdateAvailable | AppStatus::Running
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AppStatus::NotInstalled => "not installed",
            AppStatus::Installed => "installed",
            AppStatus::UpdateAvailable => "update available",
            AppStatus::Unavailable => "unavailable",
            AppStatus::Running => "running",
        }
    }
}

/// Status rules: running wins, then the catalogue/installed pair.
///
/// An installed record with a newer catalogue version → `UpdateAvailable`;
/// catalogue alone → `NotInstalled`; neither → `Unavailable`.
pub fn derive_status(
    installed: Option<&InstalledRecord>,
    catalog: Option<&CatalogEntry>,
    running: bool,
) -> AppStatus {
    if running {
        return AppStatus::Running;
    }
    match (installed, catalog) {
        (Some(found), Some(cat)) => {
            let latest = cat.version.as_deref().unwrap_or("");
            if !latest.is_empty() && is_update(latest, &found.version) {
                AppStatus::UpdateAvailable
            } else if let (Some(have), Some(want)) =
                (found.bundle_sha256.as_deref(), cat.sha256.as_deref())
            {
                // Same version, different bytes: the publisher rebuilt the app
                // without bumping it. Shipping nothing would leave the user on
                // the old build forever, so treat it as an update.
                if !have.is_empty() && !want.is_empty() && !have.eq_ignore_ascii_case(want) {
                    AppStatus::UpdateAvailable
                } else {
                    AppStatus::Installed
                }
            } else {
                AppStatus::Installed
            }
        }
        (Some(_), None) => AppStatus::Installed,
        (None, Some(_)) => AppStatus::NotInstalled,
        (None, None) => AppStatus::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed(version: &str) -> InstalledRecord {
        InstalledRecord {
            version: version.into(),
            installed_at: String::new(),
            source: crate::model::AppSource::Repo,
            channel: None,
            bundle_sha256: None,
        }
    }

    fn catalog(version: Option<&str>) -> CatalogEntry {
        CatalogEntry {
            id: "nucleus.x".into(),
            repo: "Skeabby/nucleus".into(),
            release_asset: "x.nucleusapp".into(),
            sha256: Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into()),
            version: version.map(str::to_string),
            url: None,
            name: None,
            channel: None,
        }
    }

    #[test]
    fn running_wins() {
        assert_eq!(
            derive_status(
                Some(&installed("0.1.0")),
                Some(&catalog(Some("0.2.0"))),
                true
            ),
            AppStatus::Running
        );
        assert_eq!(derive_status(None, None, true), AppStatus::Running);
    }

    #[test]
    fn update_when_catalog_is_newer() {
        assert_eq!(
            derive_status(
                Some(&installed("0.1.0")),
                Some(&catalog(Some("0.2.0"))),
                false
            ),
            AppStatus::UpdateAvailable
        );
    }

    #[test]
    fn same_version_but_different_bytes_is_an_update() {
        // The publisher rebuilt the app without bumping it: the version lies,
        // the digest does not.
        let mut have = installed("0.1.0");
        have.bundle_sha256 =
            Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_string());
        assert_eq!(
            derive_status(Some(&have), Some(&catalog(Some("0.1.0"))), false),
            AppStatus::UpdateAvailable
        );

        // Matching digests stay quiet, and a record without one stays quiet too
        // (installs made before this field existed must not all light up).
        have.bundle_sha256 =
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string());
        assert_eq!(
            derive_status(Some(&have), Some(&catalog(Some("0.1.0"))), false),
            AppStatus::Installed
        );
        assert_eq!(
            derive_status(
                Some(&installed("0.1.0")),
                Some(&catalog(Some("0.1.0"))),
                false
            ),
            AppStatus::Installed
        );
    }

    #[test]
    fn equal_or_older_catalog_is_installed() {
        assert_eq!(
            derive_status(
                Some(&installed("0.1.0")),
                Some(&catalog(Some("0.1.0"))),
                false
            ),
            AppStatus::Installed
        );
        assert_eq!(
            derive_status(
                Some(&installed("0.2.0")),
                Some(&catalog(Some("0.1.0"))),
                false
            ),
            AppStatus::Installed
        );
    }

    #[test]
    fn catalog_without_version_is_installed() {
        assert_eq!(
            derive_status(Some(&installed("0.1.0")), Some(&catalog(None)), false),
            AppStatus::Installed
        );
    }

    #[test]
    fn installed_without_catalog_is_installed() {
        assert_eq!(
            derive_status(Some(&installed("0.1.0")), None, false),
            AppStatus::Installed
        );
    }

    #[test]
    fn only_catalog_is_not_installed() {
        assert_eq!(
            derive_status(None, Some(&catalog(Some("0.1.0"))), false),
            AppStatus::NotInstalled
        );
    }

    #[test]
    fn neither_is_unavailable() {
        assert_eq!(derive_status(None, None, false), AppStatus::Unavailable);
    }

    #[test]
    fn is_installed_semantics() {
        assert!(AppStatus::Installed.is_installed());
        assert!(AppStatus::UpdateAvailable.is_installed());
        assert!(AppStatus::Running.is_installed());
        assert!(!AppStatus::NotInstalled.is_installed());
        assert!(!AppStatus::Unavailable.is_installed());
    }
}
