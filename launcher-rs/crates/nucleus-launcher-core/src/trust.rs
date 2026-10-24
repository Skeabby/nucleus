//! Catalogue trust (N1 — update trust).
//!
//! A fetched catalogue is only believed when its **exact bytes** carry a valid
//! Ed25519 signature from a key compiled into the binary. Everything here is
//! pure: no network, no filesystem, no clock except the `today_iso` helper, so
//! the launcher can prove the rules without a live release.
//!
//! The signature lives in a detached `catalog.json.sig` envelope, never inside
//! the JSON it signs — a field inside the payload cannot sign the payload.
//!
//! ```text
//! {"algorithm":"ed25519","keyId":"2026-a","signature":"<base64>"}
//! ```
//!
//! `ring` provides the primitive: it is already compiled in through `ureq`'s
//! rustls backend, so verification arrives without a new crate in the tree.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};

use crate::manifest::{LaunchKind, Manifest};
use crate::version::is_update;

/// Public keys the launcher trusts, most recent first. Rotation is additive:
/// add the new key here, publish catalogues signed with it, then drop the old
/// one in a later release.
pub const TRUSTED_KEYS: &[(&str, [u8; 32])] = &[(
    "2026-a",
    [
        0xc3, 0x2b, 0x08, 0x9a, 0x36, 0xf7, 0xa8, 0xf7, 0x3f, 0xef, 0x8b, 0xca, 0x29, 0x60, 0x42,
        0x45, 0x80, 0x38, 0x51, 0x8e, 0xc3, 0xcc, 0x16, 0x22, 0x3f, 0x19, 0x5a, 0x87, 0xb3, 0x25,
        0x02, 0x63,
    ],
)];

/// How many days a freshly fetched catalogue may be used. A cached catalogue is
/// deliberately exempt: an offline machine keeps the last good one.
pub const CATALOG_MAX_AGE_DAYS: i64 = 90;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TrustError {
    #[error("the catalogue is not signed")]
    Unsigned,
    #[error("the signature is malformed")]
    BadSignature,
    #[error("the signature was made by an unknown key `{0}`")]
    UnknownKey(String),
    #[error("the catalogue expired on {0}")]
    Expired(String),
    #[error("the catalogue is older than the one already trusted")]
    Downgrade,
    #[error("the signature does not match a trusted key")]
    NotTrusted,
}

/// The detached signature file next to `catalog.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureEnvelope {
    #[serde(default = "default_algorithm")]
    pub algorithm: String,
    pub key_id: String,
    pub signature: String,
}

fn default_algorithm() -> String {
    "ed25519".to_string()
}

impl SignatureEnvelope {
    /// Parse `catalog.json.sig`. An empty or unreadable file is [`TrustError::Unsigned`],
    /// never a silent pass.
    pub fn parse(text: &str) -> Result<Self, TrustError> {
        if text.trim().is_empty() {
            return Err(TrustError::Unsigned);
        }
        let envelope: SignatureEnvelope =
            serde_json::from_str(text).map_err(|_| TrustError::BadSignature)?;
        if envelope.signature.trim().is_empty() || envelope.key_id.trim().is_empty() {
            return Err(TrustError::Unsigned);
        }
        if !envelope.algorithm.eq_ignore_ascii_case("ed25519") {
            return Err(TrustError::BadSignature);
        }
        Ok(envelope)
    }
}

/// Verify `bytes` against one of `keys`. Split out from [`verify`] so tests can
/// use their own key without touching the production list.
pub fn verify_with(
    bytes: &[u8],
    signature_b64: &str,
    key_id: &str,
    keys: &[(&str, [u8; 32])],
) -> Result<(), TrustError> {
    let (_, key) = keys
        .iter()
        .find(|(id, _)| *id == key_id)
        .ok_or_else(|| TrustError::UnknownKey(key_id.to_string()))?;
    let signature = BASE64
        .decode(signature_b64.trim())
        .map_err(|_| TrustError::BadSignature)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(bytes, &signature)
        .map_err(|_| TrustError::BadSignature)
}

/// Verify against the keys compiled into this binary.
pub fn verify(bytes: &[u8], envelope: &SignatureEnvelope) -> Result<(), TrustError> {
    verify_with(bytes, &envelope.signature, &envelope.key_id, TRUSTED_KEYS)
}

/// The bytes of a trusted catalogue, or the reason it cannot be trusted.
pub fn trusted_bytes(bytes: &[u8], signature_text: &str) -> Result<(), TrustError> {
    let envelope = SignatureEnvelope::parse(signature_text)?;
    verify(bytes, &envelope)
}

/// What the user chose for updates. `Ask` is the default: a version number on a
/// banner is not a reason to replace code behind the user's back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePolicy {
    #[default]
    Ask,
    Auto,
}

impl UpdatePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdatePolicy::Ask => "ask",
            UpdatePolicy::Auto => "auto",
        }
    }
}

/// `%APPDATA%\Nucleus\trust.json`: the highest catalogue we have ever accepted,
/// which is what makes a downgrade visible, plus the update policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrustState {
    #[serde(default)]
    pub highest_issued_at: Option<String>,
    #[serde(default)]
    pub highest_suite_version: Option<String>,
    #[serde(default)]
    pub updates: UpdatePolicy,
}

impl TrustState {
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    /// True when `(issued_at, suite_version)` is older than what we already
    /// accepted. An unreadable date is not treated as a downgrade; the
    /// signature is the security boundary, this rule is the anti-rollback one.
    pub fn is_downgrade(&self, issued_at: Option<&str>, suite_version: &str) -> bool {
        if let (Some(have), Some(got)) = (self.highest_issued_at.as_deref(), issued_at)
            && let (Some(have), Some(got)) = (date_of(have), date_of(got))
            && got < have
        {
            return true;
        }
        if let Some(have) = self.highest_suite_version.as_deref() {
            let have = have.trim();
            let got = suite_version.trim();
            if !have.is_empty() && !got.is_empty() && got != have && !is_update(got, have) {
                return true;
            }
        }
        false
    }

    /// Record a catalogue we accepted, so a later, older one is refused.
    pub fn accept(&mut self, issued_at: Option<&str>, suite_version: &str) {
        if let Some(got) = issued_at {
            let newer = match (self.highest_issued_at.as_deref(), date_of(got)) {
                (Some(have), Some(got)) => date_of(have).is_none_or(|have| got > have),
                _ => true,
            };
            if newer {
                self.highest_issued_at = Some(got.to_string());
            }
        }
        let got = suite_version.trim();
        if !got.is_empty() {
            let newer = self
                .highest_suite_version
                .as_deref()
                .is_none_or(|have| have.trim().is_empty() || is_update(got, have.trim()));
            if newer {
                self.highest_suite_version = Some(got.to_string());
            }
        }
    }
}

/// `YYYY-MM-DD` prefix of an ISO-8601 timestamp, as a comparable tuple.
pub fn date_of(iso: &str) -> Option<(i32, u32, u32)> {
    let head = iso.get(0..10)?;
    let mut parts = head.split('-');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok()?;
    let day = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

/// Whole days since the Unix epoch for `date` (Howard Hinnant's `days_from_civil`).
/// Only the round-trip test needs the inverse of [`civil_from_days`].
#[cfg(test)]
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year } as i64;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i64;
    let day = day as i64;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Today in UTC as `YYYY-MM-DD`, so expiry needs no date crate.
pub fn today_iso() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    civil_from_days(days)
}

fn civil_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// A freshly fetched catalogue must not be expired. `expires_at` empty means
/// "no claim", which only the embedded fallback is allowed to be.
pub fn check_freshness(expires_at: &str, today: &str) -> Result<(), TrustError> {
    let expires = expires_at.trim();
    if expires.is_empty() {
        return Ok(());
    }
    match (date_of(expires), date_of(today)) {
        (Some(expires), Some(today)) if today > expires => {
            Err(TrustError::Expired(expires_at.to_string()))
        }
        (Some(_), Some(_)) => Ok(()),
        // An unparsable expiry is not a pass: the publisher must state a date.
        _ => Err(TrustError::Expired(expires_at.to_string())),
    }
}

/// What a catalogue may run. A `.nucleusapp` that came from the network is only
/// allowed a local Node server with relative arguments; `command` is for a
/// bundle the user picked on disk, behind an explicit warning.
pub fn catalogue_launch_problem(manifest: &Manifest) -> Option<String> {
    let Some(launch) = manifest.launch.as_ref() else {
        return Some("the manifest has no launch spec".to_string());
    };
    match launch.kind {
        LaunchKind::Command => Some(
            "a downloaded app may not run arbitrary commands (kind: command is local-only)"
                .to_string(),
        ),
        LaunchKind::Server => {
            let command = launch.command.as_deref().unwrap_or("node");
            let command = command.rsplit(['/', '\\']).next().unwrap_or(command);
            if !command.eq_ignore_ascii_case("node") && !command.eq_ignore_ascii_case("node.exe") {
                return Some(format!(
                    "a downloaded app may only start with node, not `{command}`"
                ));
            }
            if launch.args.is_empty() {
                return Some("a server app needs script arguments".to_string());
            }
            for arg in &launch.args {
                if arg.contains("..") || arg.starts_with('/') || arg.starts_with('\\') {
                    return Some(format!("argument `{arg}` points outside the app directory"));
                }
                let bytes = arg.as_bytes();
                let absolute =
                    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic();
                if absolute {
                    return Some(format!("argument `{arg}` points outside the app directory"));
                }
            }
            None
        }
        // A `url` app opens a page in the shell; it runs no local code.
        LaunchKind::Url => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed seed (`0x00..0x1f`) and a fixed payload make this vector
    /// reproducible; the signature is the literal from
    /// `node tools/sign-catalog.mjs` on that seed, so the verifier can never
    /// change silently.
    const TEST_KEY: (&str, [u8; 32]) = (
        "test-1",
        [
            0x03, 0xa1, 0x07, 0xbf, 0xf3, 0xce, 0x10, 0xbe, 0x1d, 0x70, 0xdd, 0x18, 0xe7, 0x4b,
            0xc0, 0x99, 0x67, 0xe4, 0xd6, 0x30, 0x9b, 0xa5, 0x0d, 0x5f, 0x1d, 0xdc, 0x86, 0x64,
            0x12, 0x55, 0x31, 0xb8,
        ],
    );
    const GOLDEN_BYTES: &[u8] = br#"{"suiteVersion":"9.9.9","issuedAt":"2026-10-24T00:00:00Z","expiresAt":"2027-01-22T00:00:00Z","apps":[]}"#;
    const GOLDEN_SIG: &str =
        "dJlMfSHpXtNN5KSqNtyrTPy0JDczQsZqkoaKRm16mh1CuJyuWDqrjWkkqYgvNkNL+duHV3Y0dPfH7ALFOc2YAA==";

    #[test]
    fn golden_vector_verifies() {
        verify_with(GOLDEN_BYTES, GOLDEN_SIG, "test-1", &[TEST_KEY]).unwrap();
    }

    #[test]
    fn a_tampered_catalogue_is_rejected() {
        let mut bytes = GOLDEN_BYTES.to_vec();
        // Flip one byte in the suiteVersion: the signature must not survive.
        let index = bytes.windows(3).position(|w| w == b"9.9").unwrap();
        bytes[index] = b'8';
        let err = verify_with(&bytes, GOLDEN_SIG, "test-1", &[TEST_KEY]).unwrap_err();
        assert_eq!(err, TrustError::BadSignature);
    }

    #[test]
    fn a_signature_from_another_key_is_rejected() {
        let other = ("test-1", [7u8; 32]);
        let err = verify_with(GOLDEN_BYTES, GOLDEN_SIG, "test-1", &[other]).unwrap_err();
        assert_eq!(err, TrustError::BadSignature);
    }

    #[test]
    fn an_unknown_key_id_is_refused() {
        let err = verify_with(GOLDEN_BYTES, GOLDEN_SIG, "2031-z", &[TEST_KEY]).unwrap_err();
        assert_eq!(err, TrustError::UnknownKey("2031-z".to_string()));
    }

    #[test]
    fn an_unsigned_or_malformed_envelope_is_refused() {
        assert_eq!(
            SignatureEnvelope::parse(""),
            Err(TrustError::Unsigned),
            "an empty .sig is not a pass"
        );
        assert_eq!(
            SignatureEnvelope::parse("{}"),
            Err(TrustError::BadSignature)
        );
        assert_eq!(
            SignatureEnvelope::parse(r#"{"keyId":"a","signature":""}"#),
            Err(TrustError::Unsigned)
        );
        assert_eq!(
            SignatureEnvelope::parse(r#"{"algorithm":"rsa","keyId":"a","signature":"x"}"#),
            Err(TrustError::BadSignature)
        );
        let ok = SignatureEnvelope::parse(&format!(
            r#"{{"algorithm":"ed25519","keyId":"test-1","signature":"{GOLDEN_SIG}"}}"#
        ))
        .unwrap();
        assert_eq!(ok.key_id, "test-1");
        verify_with(GOLDEN_BYTES, &ok.signature, &ok.key_id, &[TEST_KEY]).unwrap();
    }

    #[test]
    fn the_production_key_is_present() {
        assert!(
            TRUSTED_KEYS.iter().any(|(id, _)| *id == "2026-a"),
            "rotation must keep a usable key"
        );
    }

    #[test]
    fn a_downgrade_is_refused_and_an_upgrade_accepted() {
        let mut state = TrustState::default();
        assert!(!state.is_downgrade(Some("2026-10-24"), "0.5.0"));
        state.accept(Some("2026-10-24"), "0.5.0");
        assert!(state.is_downgrade(Some("2026-09-01"), "0.5.0"));
        assert!(state.is_downgrade(Some("2026-10-24"), "0.4.9"));
        assert!(!state.is_downgrade(Some("2026-10-25"), "0.6.0"));
        // A missing date does not invent a downgrade; the version still counts.
        assert!(!state.is_downgrade(None, "0.6.0"));
    }

    #[test]
    fn accepting_never_lowers_the_high_water_mark() {
        let mut state = TrustState::default();
        state.accept(Some("2026-10-24"), "0.5.0");
        state.accept(Some("2026-10-01"), "0.4.0");
        assert_eq!(state.highest_issued_at.as_deref(), Some("2026-10-24"));
        assert_eq!(state.highest_suite_version.as_deref(), Some("0.5.0"));
    }

    #[test]
    fn an_expired_catalogue_is_refused_but_a_missing_date_is_a_claim() {
        assert!(check_freshness("2027-01-22", "2026-10-24").is_ok());
        assert_eq!(
            check_freshness("2026-01-01", "2026-10-24"),
            Err(TrustError::Expired("2026-01-01".to_string()))
        );
        // The embedded fallback carries no expiry.
        assert!(check_freshness("", "2026-10-24").is_ok());
        // A garbage date is not a pass for a fetched catalogue.
        assert!(check_freshness("soon", "2026-10-24").is_err());
    }

    #[test]
    fn dates_round_trip_and_order() {
        assert_eq!(date_of("2026-10-24T12:00:00Z"), Some((2026, 10, 24)));
        assert_eq!(date_of("nope"), None);
        assert_eq!(date_of("2026-13-01"), None);
        assert!(date_of("2026-10-24") > date_of("2026-09-30"));
        let today = today_iso();
        assert_eq!(today.len(), 10);
        assert!(date_of(&today).is_some(), "today parses: {today}");
        assert_eq!(civil_from_days(days_from_civil(2026, 10, 24)), "2026-10-24");
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), "2024-02-29");
    }

    fn manifest_with(kind: LaunchKind, command: Option<&str>, args: &[&str]) -> Manifest {
        let json = serde_json::json!({
            "id": "nucleus.test",
            "name": "Test",
            "version": "1.0.0",
            "coreApiVersion": "1",
            "category": "system",
            "description": "test",
            "entry": "public/index.html",
            "launch": { "kind": kind.as_str(), "command": command, "args": args, "url": null },
        });
        crate::manifest::parse_manifest(&json.to_string()).unwrap()
    }

    #[test]
    fn a_catalogue_bundle_may_only_run_a_relative_node_server() {
        let ok = manifest_with(LaunchKind::Server, Some("node"), &["server.js", "--port=0"]);
        assert_eq!(catalogue_launch_problem(&ok), None);

        let command = manifest_with(LaunchKind::Command, Some("cmd.exe"), &["/c", "whoami"]);
        assert!(
            catalogue_launch_problem(&command)
                .unwrap()
                .contains("local-only"),
            "kind=command must not come from the catalogue"
        );

        let escape = manifest_with(
            LaunchKind::Server,
            Some("node"),
            &["../../Windows/System32/evil.js"],
        );
        assert!(catalogue_launch_problem(&escape).is_some());

        let absolute = manifest_with(
            LaunchKind::Server,
            Some("node"),
            &["C:\\Windows\\System32\\evil.js"],
        );
        assert!(catalogue_launch_problem(&absolute).is_some());

        let other = manifest_with(LaunchKind::Server, Some("powershell"), &["-c", "echo hi"]);
        assert!(catalogue_launch_problem(&other).is_some());
    }
}
