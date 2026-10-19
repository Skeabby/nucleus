//! Launcher single-instance (§4.5): a second launcher window must not happen.
//!
//! Implementation: an advisory file lock on `%APPDATA%\Nucleus\launcher.lock`
//! held for the process's whole lifetime. `std::fs` advisory locks auto-release
//! on process death (even a hard kill), so there is no stale-lock problem and
//! no pid probing to get wrong.

use std::fs::{File, OpenOptions};
use std::path::Path;

pub struct LauncherLock {
    _file: File,
}

impl std::fmt::Debug for LauncherLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LauncherLock")
    }
}

/// Acquire the exclusive launcher lock, or fail when another launcher already
/// holds it.
pub fn acquire(data_dir: &Path) -> Result<LauncherLock, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|err| format!("cannot create {} : {err}", data_dir.display()))?;
    let path = data_dir.join("launcher.lock");
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|err| format!("cannot open {}: {err}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(LauncherLock { _file: file }),
        Err(_) => Err("Nucleus launcher is already running".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_lock_is_refused() {
        let dir = std::env::temp_dir().join(format!("nucleus-locktest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("launcher.lock");
        std::fs::remove_file(&path).ok();
        let first = acquire(&dir).expect("first lock");
        let second = acquire(&dir);
        assert!(second.is_err(), "a second launcher must be refused");
        assert!(second.unwrap_err().contains("already running"));
        let second_err = acquire(&dir).unwrap_err();
        assert_eq!(&second_err, "Nucleus launcher is already running");
        drop(first);
        let reborn = acquire(&dir).expect("released lock is re-acquirable");
        assert!(File::open(&path).is_ok());
        drop(reborn);
        std::fs::remove_dir_all(&dir).ok();
    }
}
