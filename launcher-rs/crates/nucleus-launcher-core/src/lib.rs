//! # nucleus-launcher-core
//!
//! Pure data model and parsers for the Nucleus app suite.
//!
//! This crate is **I/O-free and GUI-free**: only serde types, parsers and pure
//! functions for manifests, the roadmap, the offline catalogue, the installed
//! index, version comparison and derived UI status.
//!
//! The filesystem/process/window side lives in the sibling `nucleus-launcher`
//! binary crate.

#![forbid(unsafe_code)]

pub mod bus;
pub mod catalog;
pub mod error;
pub mod installed;
pub mod manifest;
pub mod model;
pub mod roadmap;
pub mod status;
pub mod verify;
pub mod version;

pub use bus::{
    BusFrame, CommandFrame, ProposalFrame, RunningAppRecord, SseFrame, SseParser, classify_frame,
    iso8601, parse_registry, pending_delta, serialize_registry,
};
pub use catalog::{Catalog, CatalogEntry, parse_catalog};
pub use error::ManifestError;
pub use installed::{InstalledIndex, InstalledRecord};
pub use manifest::{
    Category, Channel, LaunchKind, LaunchSpec, Manifest, Permission, ReleaseStatus, parse_manifest,
    validate,
};
pub use model::{AppMeta, AppSource};
pub use roadmap::{Card, RoadmapEntry, merge_roadmap};
pub use status::{AppStatus, derive_status};
pub use verify::{
    DIGESTS_FILE, DigestError, Digests, normalize_sha256, parse_digests, sanitize_entry_path,
    sha256_hex,
};
pub use version::is_update;
