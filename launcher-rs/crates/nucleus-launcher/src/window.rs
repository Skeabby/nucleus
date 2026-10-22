//! The nucleus window shell (`assets/nucleus-shell.exe`, WebView2), or a
//! `cmd /c start` fallback into the default browser.

use std::path::Path;
use std::process::{Child, Command, Stdio};

/// Expected window size for app windows (SPEC: `--size 1440x900`).
pub const APP_WINDOW_SIZE: (u16, u16) = (1440, 900);

/// How long the shell gets to prove it is alive before we assume it died.
const DEAD_SHELL_GRACE: std::time::Duration = std::time::Duration::from_millis(700);

/// Open `url` in its own desktop window.
///
/// Preferred: `nucleus-shell.exe` with a per-app `--user-data-dir` (WebView2
/// keeps its session), the app title, the shared `.ico` and the app size.
/// Falls back to `cmd /c start "" <url>` (the default browser) when the shell
/// binary is missing.
///
/// Returns `Some(child)` when a trackable shell process was spawned. The
/// fallback `cmd` process exits immediately, so `None` is returned for it —
/// such a launch has no process to watch or kill (the browser owns it now).
pub fn open_app_window(
    url: &str,
    title: &str,
    icon_ico: Option<&Path>,
    profile_dir: &Path,
    size: (u16, u16),
    shell_exe: Option<&Path>,
) -> Option<Child> {
    if let Some(shell) = shell_exe.filter(|path| path.is_file()) {
        // The shell needs the profile dir to exist before it starts.
        let _ = std::fs::create_dir_all(profile_dir);
        let mut command = Command::new(shell);
        command
            .arg(url)
            .arg("--title")
            .arg(title)
            .arg("--user-data-dir")
            .arg(profile_dir)
            .arg("--size")
            .arg(format!("{}x{}", size.0, size.1));
        if let Some(ico) = icon_ico {
            command.arg("--icon").arg(ico);
        }
        let Ok(mut child) = command.spawn() else {
            return open_in_browser(url);
        };
        // The shell is a small .NET assembly that exits immediately when its
        // WebView2 companions are missing (an installer bug once shipped that
        // way). Give it a moment: if it is already gone, open the app in the
        // default browser instead of leaving the user with nothing at all.
        std::thread::sleep(DEAD_SHELL_GRACE);
        match child.try_wait() {
            Ok(Some(_)) => open_in_browser(url),
            _ => Some(child),
        }
    } else {
        open_in_browser(url)
    }
}

/// Server the URL to the default browser, untracked, because no shell can.
fn open_in_browser(url: &str) -> Option<Child> {
    let _ = Command::new("cmd")
        .args(["/c", "start", "", url])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok();
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_shell_returns_none_and_does_not_panic() {
        let out = open_app_window(
            "https://example.com",
            "Test",
            None,
            Path::new("C:\\Users\\Public\\nucleus-test-profile"),
            APP_WINDOW_SIZE,
            Some(Path::new("C:\\definitely\\missing\\shell.exe")),
        );
        // Fallback is spawned via cmd /c start — never tracked.
        assert!(out.is_none());
    }

    #[test]
    fn returns_none_for_nonexistent_shell_path_object() {
        assert!(
            open_app_window(
                "http://127.0.0.1:4400/",
                "T",
                None,
                Path::new("C:\\Users\\Public\\nucleus-test-profile-2"),
                (100, 100),
                None,
            )
            .is_none()
        );
    }
}
