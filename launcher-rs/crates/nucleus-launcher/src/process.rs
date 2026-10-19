//! Process spawning and process-tree killing (Windows-first).

use std::io;
use std::path::Path;
use std::process::{Child, Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// `CREATE_NO_WINDOW` — keep the node console hidden.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `CREATE_NEW_PROCESS_GROUP` — lets us signal/kill the group on Windows.
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Find the node binary: `where node` → `NUCLEUS_NODE` env → `None`.
///
/// `None` means the launcher should tell the user node is missing (spawn falls
/// back to the literal `"node"` so PATH can still resolve it later).
pub fn known_node() -> Option<String> {
    #[cfg(windows)]
    {
        if let Ok(output) = Command::new("where.exe")
            .arg("node")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            && output.status.success()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(first) = stdout.lines().next() {
                let node = first.trim();
                if !node.is_empty() {
                    return Some(node.to_string());
                }
            }
        }
        std::env::var("NUCLEUS_NODE")
            .ok()
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// A per-launch secret for an app's HTTP surface.
///
/// The app servers require it on `/api/*` so a random web page cannot drive the
/// command bus (see SPEC security posture). Built from `RandomState`, which the
/// standard library seeds from OS entropy; no new dependency.
pub fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(0x9e37_79b9_7f4a_7c15);
    let a = hasher.finish();
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(a);
    let b = hasher.finish();
    format!("{a:016x}{b:016x}")
}

/// Spawn an app's node server with `PORT` and `NUCLEUS_TOKEN` set. Node runs
/// hidden; killing the returned process tree (taskkill `/T`) cleans up
/// everything it spawned.
///
/// `stderr` is **piped**: the runtime keeps only its tail (see
/// `spawn_stderr_tail`), so when node dies instantly, the failure surfaces
/// with the real reason instead of a silent 20 s probe timeout. `stdout`
/// stays null: servers are chatty by design and an unread pipe would
/// deadlock them.
pub fn spawn_node(
    node_path: &str,
    args: &[String],
    cwd: &Path,
    port: u16,
    token: &str,
) -> io::Result<Child> {
    #[cfg(windows)]
    {
        Command::new(node_path)
            .args(args)
            .current_dir(cwd)
            .env("PORT", port.to_string())
            .env("NUCLEUS_TOKEN", token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .spawn()
    }
    #[cfg(not(windows))]
    {
        let _ = (node_path, args, cwd, port, token);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "nucleus-launcher is Windows-first (M1)",
        ))
    }
}

/// Spawn a free-standing command (kind=command).
pub fn spawn_command(command: &str, args: &[String], cwd: &Path) -> io::Result<Child> {
    #[cfg(windows)]
    {
        Command::new(command)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .spawn()
    }
    #[cfg(not(windows))]
    {
        let _ = (command, args, cwd);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "nucleus-launcher is Windows-first (M1)",
        ))
    }
}

/// Kill a process tree. Best-effort: `taskkill /pid <pid> /T /F`, spawned
/// hidden, waited on. Errors are swallowed (the process may already be gone).
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        if let Ok(mut child) = Command::new("taskkill.exe")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            let _ = child.wait();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

/// Reveal a directory in Explorer. Best-effort: errors are swallowed.
pub fn reveal(path: &Path) {
    #[cfg(windows)]
    {
        let _ = Command::new("explorer.exe").arg(path).spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spawn_node_then_kill_tree() {
        if std::env::var("NUCLEUS_SKIP_PROC_TESTS").is_ok() {
            return;
        }
        let node = known_node();
        if node.is_none() {
            eprintln!("node not found; skipping");
            return;
        }
        let node = node.unwrap();
        let dir = std::env::temp_dir();
        let args = vec!["-e".to_string(), "setInterval(()=>{},1000)".to_string()];
        let mut child =
            spawn_node(&node, &args, &dir, 43001, "test-token").expect("node must spawn");
        let pid = child.id();
        assert!(pid > 0);
        kill_tree(pid);
        // The child should be reaped quickly.
        let mut waited = false;
        for _ in 0..50 {
            if child.try_wait().ok().flatten().is_some() {
                waited = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(waited, "node process was not killed by kill_tree");
    }

    #[test]
    fn kill_tree_is_best_effort_on_garbage() {
        kill_tree(u32::MAX); // must not panic
    }
}
