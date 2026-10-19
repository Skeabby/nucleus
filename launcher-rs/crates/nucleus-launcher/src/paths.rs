//! File-system conventions: the repository root, the Nucleus data directory,
//! app roots and the window shell.

use std::env;
use std::path::{Path, PathBuf};

/// Everything about disk layout the launcher needs at startup.
#[derive(Debug, Clone)]
pub struct Paths {
    /// `<repo>` when a checkout was found; `None` on a machine that only has
    /// the released launcher, where the catalogue is the sole source of apps.
    pub repo_root: Option<PathBuf>,
    /// `%APPDATA%\Nucleus\apps` — where catalogue installs land.
    pub user_apps: PathBuf,
    /// App roots in precedence order: `<repo>/apps` first when it exists, then
    /// [`Paths::user_apps`]. First root wins on id.
    pub app_roots: Vec<PathBuf>,
    /// `%APPDATA%\Nucleus\window-profiles\<app id>`.
    pub window_profiles_dir: PathBuf,
    /// `assets/nucleus-shell.exe` when built.
    pub shell_exe: Option<PathBuf>,
    /// `assets/nucleus.ico` (the shell expects an `.ico`, not `.svg`).
    pub icon_ico: Option<PathBuf>,
}

impl Paths {
    /// Resolve paths. `cli_repo` overrides automatic discovery of `<repo>`.
    ///
    /// A missing repository is **not** an error: the launcher then runs
    /// catalogue-only (installs land in the user data directory), which is how
    /// a released binary works on a machine without the checkout. An explicit
    /// `--repo` that does not look like the repository is still rejected.
    pub fn resolve(cli_repo: Option<&Path>) -> Result<Paths, String> {
        let repo_root = match cli_repo {
            Some(path) => {
                if !path.join("apps").is_dir() {
                    return Err(format!(
                        "`{}` does not look like the nucleus repository (no `apps/` directory)",
                        path.display()
                    ));
                }
                Some(path.to_path_buf())
            }
            None => find_repo_root(),
        };

        let data_dir = nucleus_data_dir();
        let user_apps = data_dir.join("apps");
        let mut app_roots = Vec::new();
        if let Some(root) = &repo_root {
            app_roots.push(root.join("apps"));
        }
        app_roots.push(user_apps.clone());

        // A released launcher installs next to neither a repo nor its assets:
        // the shell and the icon are shipped alongside the exe (installer
        // `%LOCALAPPDATA%\Programs\Nucleus`, portable ZIP root). Resolving
        // them there keeps native app windows — not a browser fallback — on
        // catalogue-only machines too.
        let (repo_shell, repo_icon) = repo_root
            .as_ref()
            .map(|root| asset_candidates(root.join("assets")))
            .unwrap_or((None, None));
        let (local_shell, local_icon) = asset_candidates(local_exe_dir());
        let (shell_exe, icon_ico) = (repo_shell.or(local_shell), repo_icon.or(local_icon));

        Ok(Paths {
            repo_root,
            user_apps,
            app_roots,
            window_profiles_dir: data_dir.join("window-profiles"),
            shell_exe,
            icon_ico,
        })
    }
}

/// `%APPDATA%\Nucleus`, falling back to `~/Nucleus` when `APPDATA` is unset.
pub fn nucleus_data_dir() -> PathBuf {
    let root = env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| {
        env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    });
    root.join("Nucleus")
}

/// Directory containing the running launcher (its exe's folder): where the
/// installer and the portable ZIP ship `nucleus-shell.exe` + `nucleus.ico`.
fn local_exe_dir() -> PathBuf {
    let mut exe = env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    exe.pop();
    exe
}

/// Look for `nucleus-shell.exe` / `nucleus.ico` in one candidate directory.
fn asset_candidates(dir: PathBuf) -> (Option<PathBuf>, Option<PathBuf>) {
    let shell = dir.join("nucleus-shell.exe");
    let icon = dir.join("nucleus.ico");
    (
        shell.is_file().then_some(shell),
        icon.is_file().then_some(icon),
    )
}

/// Walk up from the current directory, then from the executable, looking for a
/// directory containing `apps/`.
fn find_repo_root() -> Option<PathBuf> {
    let mut start = env::current_dir().ok()?;
    for _ in 0..12 {
        if start.join("apps").is_dir() {
            return Some(start);
        }
        start = start.parent()?.to_path_buf();
    }
    let mut start = env::current_exe().ok()?;
    start.pop(); // drop the exe name
    for _ in 0..12 {
        if start.join("apps").is_dir() {
            return Some(start);
        }
        if !start.pop() {
            break;
        }
    }
    None
}
