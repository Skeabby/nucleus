//! Network access for the M2 catalogue: fetch `catalog.json` and download a
//! `.nucleusapp` archive, with progress reporting and cooperative
//! cancellation.
//!
//! Both a plain filesystem path and a `file://` URL are accepted anywhere an
//! `http(s)://` URL is, so the whole install flow can run **offline** in tests
//! and on a machine without the catalogue mirror. Downloads are atomic: bytes
//! land in a sibling `.part` file first, so an interrupted transfer never
//! leaves a truncated archive at the destination path.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use nucleus_launcher_core::{Catalog, parse_catalog};
use thiserror::Error;

/// Largest catalogue body we will read into memory (8 MiB).
pub const MAX_CATALOG_BYTES: u64 = 8 * 1024 * 1024;

/// Progress callback: `(bytes_done, total_bytes_when_known)`.
pub type Progress<'a> = &'a mut dyn FnMut(u64, Option<u64>);

/// Anything that can go wrong fetching or downloading.
#[derive(Debug, Error)]
pub enum NetError {
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),

    #[error("network error for `{url}`: {message}")]
    Transport { url: String, message: String },

    #[error("HTTP {status} for `{url}`")]
    Status { status: u16, url: String },

    #[error("unsupported source `{0}` (expected a path, `file://` or `https://` URL)")]
    Unsupported(String),

    #[error("refusing a plain-`http://` source (`{0}`) — TLS is required")]
    Insecure(String),

    #[error("the catalogue is larger than the {limit}-byte limit")]
    TooLarge { limit: u64 },

    #[error("download cancelled")]
    Cancelled,
}

/// Resolve `source` to a local filesystem path when it is *not* an `http(s)://`
/// URL. Accepts a bare path and a `file://` URL (including `file:///C:/x` on
/// Windows). Returns `None` for `http(s)://`.
pub fn local_path(source: &str) -> Option<PathBuf> {
    if let Some(rest) = source.strip_prefix("file://") {
        // `file:///C:/x` → `/C:/x` → `C:/x`; keep POSIX paths untouched.
        let bytes = rest.as_bytes();
        let windows_drive = bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[2] == b':'
            && bytes[1].is_ascii_alphabetic();
        let trimmed = if windows_drive { &rest[1..] } else { rest };
        return Some(PathBuf::from(trimmed));
    }
    // Any other `scheme://` is a remote URL we do not treat as a path, so the
    // caller can report it as unsupported instead of a confusing i/o error.
    if source.contains("://") {
        return None;
    }
    Some(PathBuf::from(source))
}

/// `file://` and bare paths are a developer convenience (and how the test suite
/// runs offline). A shipped build only ever fetches a catalogue over TLS unless
/// this variable is explicitly set.
fn file_sources_allowed() -> bool {
    cfg!(test) || std::env::var("NUCLEUS_ALLOW_FILE_CATALOG").is_ok_and(|value| value == "1")
}

/// Refuse cleartext before opening a socket, and again on the URL we actually
/// ended up at: `/releases/latest/download/` redirects, so checking only the
/// input would let an `https` source downgrade to `http` mid-flight.
fn require_tls(url: &str) -> Result<(), NetError> {
    if url.starts_with("http://") {
        return Err(NetError::Insecure(url.to_string()));
    }
    if !url.starts_with("https://") {
        return Err(NetError::Unsupported(url.to_string()));
    }
    Ok(())
}

fn resolve_local(source: &str) -> Result<Option<PathBuf>, NetError> {
    match local_path(source) {
        Some(path) => {
            if file_sources_allowed() {
                Ok(Some(path))
            } else {
                Err(NetError::Unsupported(source.to_string()))
            }
        }
        None => Ok(None),
    }
}

/// Fetch a resource into memory, refusing anything above `limit` instead of
/// silently truncating it: a signature over a truncated body is a mystery, not
/// a verdict.
pub fn fetch_bytes(source: &str, limit: u64) -> Result<Vec<u8>, NetError> {
    if let Some(path) = resolve_local(source)? {
        let meta = fs::metadata(&path)?;
        if meta.len() > limit {
            return Err(NetError::TooLarge { limit });
        }
        return Ok(fs::read(&path)?);
    }
    require_tls(source)?;
    let response = ureq::get(source)
        .call()
        .map_err(|err| map_ureq(source, err))?;
    let final_url = response.get_url().to_string();
    if final_url.starts_with("http://") {
        return Err(NetError::Insecure(final_url));
    }
    let mut body = Vec::new();
    response
        .into_reader()
        .take(limit + 1)
        .read_to_end(&mut body)?;
    if body.len() as u64 > limit {
        return Err(NetError::TooLarge { limit });
    }
    Ok(body)
}

/// Fetch a UTF-8 text resource (the catalogue) from a path or URL.
pub fn fetch_text(source: &str) -> Result<String, NetError> {
    let bytes = fetch_bytes(source, MAX_CATALOG_BYTES)?;
    String::from_utf8(bytes).map_err(|_| NetError::Unsupported(source.to_string()))
}

/// Fetch and parse the catalogue. A malformed body yields an empty catalogue
/// (parsing is lenient by design), never an error.
pub fn fetch_catalog(source: &str) -> Result<Catalog, NetError> {
    Ok(parse_catalog(&fetch_text(source)?))
}

/// Download `source` to `dest`, reporting progress and honouring `cancel`.
///
/// The bytes are written to `<dest>.part` and renamed into place on success, so
/// a cancelled or failed transfer never appears as a usable archive. Integrity
/// (the whole-archive sha256) is checked by [`crate::install::install_archive`]
/// from the same file handle after this returns.
pub fn download_to_file(
    source: &str,
    dest: &Path,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), NetError> {
    if let Some(local) = local_path(source) {
        let total = fs::metadata(&local).ok().map(|meta| meta.len());
        let reader = File::open(&local)?;
        return finish_copy(reader, dest, total, progress, cancel);
    }
    require_tls(source)?;
    let response = ureq::get(source)
        .call()
        .map_err(|err| map_ureq(source, err))?;
    let final_url = response.get_url().to_string();
    if final_url.starts_with("http://") {
        return Err(NetError::Insecure(final_url));
    }
    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    finish_copy(response.into_reader(), dest, total, progress, cancel)
}

/// Convenience: download a catalogue app's archive into `dest`.
pub fn download_archive(
    url: &str,
    dest: &Path,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), NetError> {
    download_to_file(url, dest, progress, cancel)
}

/// Copy `reader` into a sibling `.part` file, then rename it onto `dest`.
fn finish_copy(
    reader: impl Read,
    dest: &Path,
    total: Option<u64>,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), NetError> {
    if let Some(parent) = dest.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    let part = part_path(dest);
    match copy_with_progress(reader, &part, total, progress, cancel) {
        Ok(()) => {
            fs::rename(&part, dest)?;
            Ok(())
        }
        Err(err) => {
            let _ = fs::remove_file(&part);
            Err(err)
        }
    }
}

/// The temporary sibling a download is streamed into before the atomic rename.
fn part_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    dest.with_file_name(format!(".{name}.{}.part", std::process::id()))
}

fn copy_with_progress(
    mut reader: impl Read,
    dest: &Path,
    total: Option<u64>,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), NetError> {
    let mut file = File::create(dest)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    progress(0, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(NetError::Cancelled);
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])?;
        done += read as u64;
        progress(done, total);
    }
    file.flush()?;
    Ok(())
}

fn map_ureq(url: &str, err: ureq::Error) -> NetError {
    match err {
        ureq::Error::Status(status, _) => NetError::Status {
            status,
            url: url.to_string(),
        },
        ureq::Error::Transport(transport) => NetError::Transport {
            url: url.to_string(),
            message: transport.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("nucleus-net-{label}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file_url(path: &Path) -> String {
        format!("file:///{}", path.to_string_lossy().replace('\\', "/"))
    }

    #[test]
    fn local_path_classifies_sources() {
        assert_eq!(local_path("http://example.com/x.json"), None);
        assert_eq!(local_path("https://example.com/x.json"), None);
        assert_eq!(
            local_path("C:/tmp/catalog.json"),
            Some(PathBuf::from("C:/tmp/catalog.json"))
        );
        assert_eq!(
            local_path("file:///C:/tmp/catalog.json"),
            Some(PathBuf::from("C:/tmp/catalog.json"))
        );
        assert_eq!(
            local_path("/tmp/catalog.json"),
            Some(PathBuf::from("/tmp/catalog.json"))
        );
    }

    #[test]
    fn fetch_text_from_path_and_file_url() {
        let dir = scratch("fetch");
        let path = dir.join("catalog.json");
        fs::write(&path, r#"{"suiteVersion":"0.4.0","apps":[]}"#).unwrap();
        assert!(
            fetch_text(path.to_str().unwrap())
                .unwrap()
                .contains("0.4.0")
        );
        assert!(fetch_text(&file_url(&path)).unwrap().contains("0.4.0"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fetch_catalog_parses_and_is_lenient() {
        let dir = scratch("parse");
        let path = dir.join("catalog.json");
        fs::write(&path, "not json").unwrap();
        let catalog = fetch_catalog(path.to_str().unwrap()).unwrap();
        assert!(catalog.apps.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fetch_rejects_http_like_transport_only_offline() {
        // `ftp://` is neither a local path nor https → unsupported, no network.
        let err = fetch_text("ftp://example.com/catalog.json").unwrap_err();
        assert!(matches!(err, NetError::Unsupported(_)), "got {err:?}");
    }

    #[test]
    fn plain_http_is_refused_before_any_socket() {
        // No network access in the test suite: the refusal must happen first.
        let err = fetch_text("http://example.com/catalog.json").unwrap_err();
        assert!(matches!(err, NetError::Insecure(_)), "got {err:?}");
        let dir = scratch("http");
        let dest = dir.join("out.bin");
        let cancel = AtomicBool::new(false);
        let err = download_to_file("http://example.com/a.bin", &dest, &mut |_, _| {}, &cancel)
            .unwrap_err();
        assert!(matches!(err, NetError::Insecure(_)), "got {err:?}");
        assert!(!dest.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_body_above_the_limit_errors_instead_of_truncating() {
        let dir = scratch("toobig");
        let path = dir.join("catalog.json");
        fs::write(&path, vec![b'x'; 4096]).unwrap();
        let err = fetch_bytes(path.to_str().unwrap(), 1024).unwrap_err();
        assert!(
            matches!(err, NetError::TooLarge { limit: 1024 }),
            "got {err:?}"
        );
        // ...and the exact-size body still reads.
        assert_eq!(
            fetch_bytes(path.to_str().unwrap(), 4096).unwrap().len(),
            4096
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_utf8_catalogue_is_an_error_not_a_panic() {
        let dir = scratch("binary");
        let path = dir.join("catalog.json");
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        let err = fetch_text(path.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, NetError::Unsupported(_)), "got {err:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_copies_and_reports_progress() {
        let dir = scratch("download");
        let src = dir.join("notes.nucleusapp");
        let payload = vec![7u8; 200 * 1024];
        fs::write(&src, &payload).unwrap();

        let dest = dir.join("out/notes.nucleusapp");
        let cancel = AtomicBool::new(false);
        let mut calls: Vec<(u64, Option<u64>)> = Vec::new();
        let mut progress = |done: u64, total: Option<u64>| calls.push((done, total));
        download_to_file(src.to_str().unwrap(), &dest, &mut progress, &cancel).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), payload);
        assert_eq!(calls.first().unwrap().0, 0);
        assert_eq!(calls.last().unwrap().0, payload.len() as u64);
        assert_eq!(calls.last().unwrap().1, Some(payload.len() as u64));
        // The temp file must not survive a successful transfer.
        assert!(!part_path(&dest).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_from_file_url_works() {
        let dir = scratch("fileurl");
        let src = dir.join("a.bin");
        fs::write(&src, b"hello").unwrap();
        let dest = dir.join("b.bin");
        let cancel = AtomicBool::new(false);
        download_to_file(&file_url(&src), &dest, &mut |_, _| {}, &cancel).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"hello");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cancelled_download_leaves_nothing() {
        let dir = scratch("cancel");
        let src = dir.join("big.bin");
        fs::write(&src, vec![0u8; 512 * 1024]).unwrap();
        let dest = dir.join("out.bin");
        let cancel = AtomicBool::new(true); // cancelled before the first chunk
        let err =
            download_to_file(src.to_str().unwrap(), &dest, &mut |_, _| {}, &cancel).unwrap_err();
        assert!(matches!(err, NetError::Cancelled), "got {err:?}");
        assert!(!dest.exists(), "no destination file on cancel");
        assert!(!part_path(&dest).exists(), "no partial file on cancel");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_local_source_errors() {
        let dir = scratch("missing");
        let dest = dir.join("out.bin");
        let cancel = AtomicBool::new(false);
        let err = download_to_file(
            dir.join("nope.bin").to_str().unwrap(),
            &dest,
            &mut |_, _| {},
            &cancel,
        )
        .unwrap_err();
        assert!(matches!(err, NetError::Io(_)), "got {err:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
