//! The app-lifecycle engine: spawn app servers, probe them to readiness, open
//! their window shell and tear everything down (tree kill) when asked.

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use nucleus_launcher_core::{AppMeta, LaunchKind, RunningAppRecord};

use crate::ports::free_port;
use crate::probe::READY_TIMEOUT;
use crate::process::{kill_tree, random_token, spawn_command, spawn_node};
use crate::window::open_app_window;

/// What the engine tells the UI, drained once per frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The app process is starting.
    Starting(String),
    /// The app is up and (for servers) answering. `url` is empty for
    /// command-kind apps.
    Ready(String, String),
    /// Launch or readiness probe failed.
    Failed(String, String),
    /// Stopped (by the user, or because the window/process exited on its own).
    Stopped(String),
    /// The Bus (M3-lite): an applied command landed in an app's tape, seen
    /// through its `/api/events` stream.
    Command {
        app: String,
        seq: Option<u64>,
        ts: String,
        actor_kind: String,
        actor_id: String,
        command: String,
        label: String,
    },
    /// The Bus (M3-lite): a proposal changed status in a running app.
    Proposal {
        app: String,
        actor_kind: String,
        actor_id: String,
        command: String,
        status: String,
    },
}

/// Fixed engine options resolved once at startup.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// `where node` result or `NUCLEUS_NODE`; `None` → warn the user, and
    /// spawn falls back to the literal `"node"`.
    pub node_path: Option<String>,
    /// `assets/nucleus-shell.exe` when built.
    pub shell_exe: Option<PathBuf>,
    /// `assets/nucleus.ico` when present.
    pub icon_ico: Option<PathBuf>,
    /// `%APPDATA%\Nucleus\window-profiles`.
    pub window_profiles_dir: PathBuf,
    /// `%APPDATA%\Nucleus\run` — where the running-apps registry (§4.4) is
    /// rewritten atomically on every start/stop/exit.
    pub run_registry_dir: PathBuf,
    /// Shell window size, e.g. `(1440, 900)`.
    pub window_size: (u16, u16),
}

/// A live app the engine is supervising.
struct Running {
    id: String,
    /// Display name (registry).
    name: String,
    /// The app process: node for servers, the command for kind=command.
    node: Option<Child>,
    /// The shell window process (server/url kinds with a window).
    window: Option<Child>,
    /// Pid used to tree-kill the primary process (node/command or window).
    pid: Option<u32>,
    /// Separate pid for the shell window, so closing it kills node too.
    window_pid: Option<u32>,
    port: Option<u16>,
    url: Option<String>,
    /// Bearer token for server-kind apps (registry + Bus subscriber).
    token: Option<String>,
    /// ISO start stamp for the registry.
    started_at: String,
    /// True once the readiness probe answered  the app is genuinely up.
    /// A node process that exits while this is still false is a launch
    /// failure (reported with its stderr tail), not a mere stop.
    ready: bool,
    /// Last bytes of the node process' stderr, kept live by a reader
    /// thread. `None` for url/command kinds and for legacy spawns without
    /// a piped stderr.
    stderr_tail: Option<Arc<Mutex<String>>>,
}

impl Running {
    /// Tree-kill every tracked process; never panics.
    fn kill_all(&self) {
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        if let Some(window_pid) = self.window_pid
            && self.pid != Some(window_pid)
        {
            kill_tree(window_pid);
        }
    }
}

#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Mutex<RuntimeInner>>,
    tx: Sender<Event>,
}

struct RuntimeInner {
    config: RuntimeConfig,
    running: Vec<Running>,
}

impl Runtime {
    /// Create the engine and the event channel the UI must drain.
    pub fn new(config: RuntimeConfig) -> (Runtime, Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        let inner = Arc::new(Mutex::new(RuntimeInner {
            config,
            running: Vec::new(),
        }));
        (Runtime { inner, tx }, rx)
    }

    /// Launch an app; no-op (Ok) when the id is already running.
    ///
    /// Mirrors the TS reference ordering: `starting` first, then spawn +
    /// probe; the window opens once **ready**; `ready` fires.
    pub fn launch(&self, app: &AppMeta) -> Result<(), String> {
        let id = app.id().to_string();
        let name = app.name().to_string();
        let spec = app
            .launch_spec()
            .ok_or_else(|| format!("app `{id}` has no launch spec"))?;

        {
            let guard = self.inner.lock().unwrap();
            if guard.running.iter().any(|entry| entry.id == id) {
                return Ok(()); // already running
            }
        }

        let config = self.inner.lock().unwrap().config.clone();
        let profile_dir = config.window_profiles_dir.join(&id);
        let notify = |event: Event| {
            let _ = self.tx.send(event);
        };

        notify(Event::Starting(id.clone()));

        match spec.kind {
            LaunchKind::Command => {
                let command = spec
                    .command
                    .clone()
                    .unwrap_or_else(|| node_or_literal(&config));
                let child = spawn_command(&command, &spec.args, &app.dir).map_err(|err| {
                    notify(Event::Failed(id.clone(), err.to_string()));
                    format!("failed to spawn `{command}`: {err}")
                })?;
                let pid = child.id();
                let id_ready = id.clone();
                self.push_entry(Running {
                    id: id.clone(),
                    name: name.clone(),
                    node: Some(child),
                    window: None,
                    pid: Some(pid),
                    window_pid: None,
                    port: None,
                    url: None,
                    token: None,
                    started_at: iso_now(),
                    ready: true,
                    stderr_tail: None,
                });
                notify(Event::Ready(id_ready, String::new()));
            }
            LaunchKind::Server => {
                let port = free_port(spec.port).map_err(|err| {
                    notify(Event::Failed(
                        id.clone(),
                        format!("cannot pick a port: {err}"),
                    ));
                    format!("cannot pick a port for `{id}`: {err}")
                })?;
                let command = spec
                    .command
                    .clone()
                    .unwrap_or_else(|| node_or_literal(&config));
                let token = random_token();
                let mut child =
                    spawn_node(&command, &spec.args, &app.dir, port, &token).map_err(|err| {
                        notify(Event::Failed(
                            id.clone(),
                            format!("cannot spawn node: {err}"),
                        ));
                        format!("failed to spawn node for `{id}`: {err}")
                    })?;
                // Hand the piped stderr to a tail reader so it can never fill
                // its pipe and block the app, and so an instant death
                //  surfaces with its real cause.
                let stderr_tail = child.stderr.take().map(spawn_stderr_tail);
                let pid = child.id();
                // The token rides in the URL only for the first load; the app
                // swaps it for an HttpOnly cookie and redirects to the clean URL.
                let url = format!("http://127.0.0.1:{port}/?t={token}");
                let want_window = spec.window.unwrap_or(true);
                let ready_path = spec.ready_path.clone().unwrap_or_else(|| "/".to_string());

                self.push_entry(Running {
                    id: id.clone(),
                    name: name.clone(),
                    node: Some(child),
                    window: None,
                    pid: Some(pid),
                    window_pid: None,
                    port: Some(port),
                    url: Some(url.clone()),
                    token: Some(token.clone()),
                    started_at: iso_now(),
                    ready: false,
                    stderr_tail,
                });

                // Probe in the background so the UI stays responsive; the
                // window opens only once the server answers.
                let runtime = self.clone();
                std::thread::spawn(move || {
                    match crate::probe::wait_ready_with_timeout(
                        port,
                        &ready_path,
                        READY_TIMEOUT,
                        &token,
                    ) {
                        Ok(()) => {
                            let id_ready = runtime.ready_window(
                                &id,
                                &name,
                                &url,
                                want_window,
                                &profile_dir,
                                &config,
                            );
                            if let Some(id_ready) = id_ready {
                                runtime.start_bus(&id_ready);
                                let _ = runtime.tx.send(Event::Ready(id_ready, url));
                            }
                        }
                        Err(message) => runtime.fail(id, message),
                    }
                });
            }
            LaunchKind::Url => {
                let url = spec.url.clone().ok_or_else(|| {
                    notify(Event::Failed(id.clone(), "launch.url is empty".into()));
                    format!("app `{id}` has kind=url but no url")
                })?;
                let want_window = spec.window.unwrap_or(true);
                let window = if want_window {
                    open_app_window(
                        &url,
                        &name,
                        config.icon_ico.as_deref(),
                        &profile_dir,
                        config.window_size,
                        config.shell_exe.as_deref(),
                    )
                } else {
                    None
                };
                let window_pid = window.as_ref().map(Child::id);
                let id_ready = id.clone();
                self.push_entry(Running {
                    id: id.clone(),
                    name: name.clone(),
                    node: None,
                    window,
                    pid: window_pid,
                    window_pid,
                    port: None,
                    url: Some(url.clone()),
                    token: None,
                    started_at: iso_now(),
                    ready: true,
                    stderr_tail: None,
                });
                notify(Event::Ready(id_ready, url));
            }
        }
        Ok(())
    }

    /// Stop one app: tree-kill its process and window, emit `Stopped`.
    pub fn stop(&self, id: &str) -> bool {
        let entry = {
            let mut guard = self.inner.lock().unwrap();
            let Some(position) = guard.running.iter().position(|entry| entry.id == id) else {
                return false;
            };
            guard.running.remove(position)
        };
        entry.kill_all();
        let _ = self.tx.send(Event::Stopped(entry.id.clone()));
        self.sync_registry();
        true
    }

    /// Stop everything (app exit hook + runtime drop).
    pub fn stop_all(&self) {
        let ids = self.running_ids();
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .running
            .iter()
            .any(|entry| entry.id == id)
    }

    pub fn running_count(&self) -> usize {
        self.inner.lock().unwrap().running.len()
    }

    /// Ids of running apps, in launch order.
    pub fn running_ids(&self) -> Vec<String> {
        let guard = self.inner.lock().unwrap();
        guard.running.iter().map(|entry| entry.id.clone()).collect()
    }

    /// Live details for the inspector: `(url, port)` when the app is running.
    pub fn running_info(&self, id: &str) -> Option<(Option<String>, Option<u16>)> {
        let guard = self.inner.lock().unwrap();
        guard
            .running
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| (entry.url.clone(), entry.port))
    }

    /// Reap exited processes so a closed window or a crashed node auto-stops
    /// the app. Call once per UI frame.
    ///
    /// A node process that dies **before** the readiness probe answered is a
    /// launch failure , not a stop: it is reported as `Failed`
    /// immediately, with the exit code and the stderr tail, instead of the
    /// silent 20 s probe timeout that used to read as "Open does nothing".
    pub fn reconcile(&self) {
        let mut guard = self.inner.lock().unwrap();
        let mut index = 0;
        let mut stopped = Vec::new();
        let mut failed = Vec::new();
        while index < guard.running.len() {
            let entry = &mut guard.running[index];
            let node_exited = exited(&mut entry.node);
            let window_exited = exited(&mut entry.window);
            if node_exited || window_exited {
                let mut entry = guard.running.remove(index);
                let failure = (!entry.ready).then(|| launch_failure_message(&mut entry));
                entry.kill_all();
                if let Some(message) = failure {
                    failed.push((entry.id.clone(), message));
                } else {
                    stopped.push(entry.id);
                }
            } else {
                index += 1;
            }
        }
        drop(guard);
        if !stopped.is_empty() || !failed.is_empty() {
            self.sync_registry();
        }
        for id in stopped {
            let _ = self.tx.send(Event::Stopped(id));
        }
        for (id, message) in failed {
            let _ = self.tx.send(Event::Failed(id, message));
        }
    }

    /// Register a running app. Done before the readiness probe so the UI can
    /// already show the "running" state.
    fn push_entry(&self, entry: Running) {
        self.inner.lock().unwrap().running.push(entry);
        self.sync_registry();
    }

    /// Attach the Bus subscriber (SSE `/api/events`, M2) to a ready
    /// server-kind app. Best-effort: dies with the app's TCP connection.
    pub fn start_bus(&self, id: &str) {
        let Some((port, token)) = (|| {
            let guard = self.inner.lock().unwrap();
            let entry = guard.running.iter().find(|entry| entry.id == id)?;
            Some((entry.port, entry.token.clone()))
        })() else {
            return;
        };
        if let (Some(port), Some(token)) = (port, token) {
            crate::sse_events::spawn(id.to_string(), port, token, self.tx.clone());
        }
    }

    /// Rewrite `%APPDATA%\Nucleus\run\apps.json` from the live supervision
    /// state (§4.4: "on every start/stop/exit"). Full atomic replace — no
    /// read/merge, so a corrupt file self-heals on the next change.
    fn sync_registry(&self) {
        let dir = self.inner.lock().unwrap().config.run_registry_dir.clone();
        let records: Vec<RunningAppRecord> = {
            let guard = self.inner.lock().unwrap();
            guard
                .running
                .iter()
                .map(|entry| RunningAppRecord {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    port: entry.port,
                    token: entry.token.clone(),
                    pid: entry.pid,
                    started_at: entry.started_at.clone(),
                })
                .collect()
        };
        let json = nucleus_launcher_core::serialize_registry(&records);
        if std::fs::create_dir_all(&dir).is_err() {
            return; // no registry surface; the engine itself is unaffected
        }
        let tmp = dir.join("apps.json.tmp");
        let path = dir.join("apps.json");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path); // same volume: replace-atomic
        }
    }

    /// Probe succeeded: open the shell window (if wanted) and return the app
    /// id so the probe thread can emit `Ready`. Returns `None` if the app was
    /// stopped in the meantime.
    fn ready_window(
        &self,
        id: &str,
        name: &str,
        url: &str,
        want_window: bool,
        profile_dir: &Path,
        config: &RuntimeConfig,
    ) -> Option<String> {
        let mut guard = self.inner.lock().unwrap();
        let position = guard.running.iter().position(|entry| entry.id == id)?;
        let entry = &mut guard.running[position];
        entry.ready = true;
        if want_window
            && let Some(window) = open_app_window(
                url,
                name,
                config.icon_ico.as_deref(),
                profile_dir,
                config.window_size,
                config.shell_exe.as_deref(),
            )
        {
            let window_pid = window.id();
            entry.window = Some(window);
            if entry.pid.is_none() {
                entry.pid = Some(window_pid);
            }
            entry.window_pid = Some(window_pid);
        }
        Some(entry.id.clone())
    }

    /// A launch/probe failure: kill any half-started processes, forget the
    /// app, emit `Failed`.
    fn fail(&self, id: String, message: String) {
        let entry = {
            let mut guard = self.inner.lock().unwrap();
            guard
                .running
                .iter()
                .position(|entry| entry.id == id)
                .map(|position| guard.running.remove(position))
        };
        if let Some(entry) = entry {
            entry.kill_all();
        }
        let _ = self.tx.send(Event::Failed(id, message));
        self.sync_registry();
    }
}

/// `try_wait` → true when the process has exited (or failed to start).
fn exited(child: &mut Option<Child>) -> bool {
    child
        .as_mut()
        .map(|child| child.try_wait().ok().flatten().is_some())
        .unwrap_or(false)
}

/// Current wall time as RFC 3339 "Z" (registry `startedAt`).
fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    nucleus_launcher_core::iso8601(secs)
}

/// Exit code of a process that has already exited (`None` = still running,
/// or exited without a code — signal death).
fn exit_code(child: &mut Option<Child>) -> Option<i32> {
    child
        .as_mut()
        .and_then(|child| child.try_wait().ok().flatten())
        .and_then(|status| status.code())
}

/// Why a not-yet-ready node death happened, for the user.
fn launch_failure_message(entry: &mut Running) -> String {
    let code_text = match exit_code(&mut entry.node) {
        Some(code) => format!("exit code {code}"),
        None => "an abnormal termination".to_string(),
    };
    let mut message = format!(
        "`{}` failed to launch: node exited with {code_text} \
         before its HTTP surface answered the readiness probe",
        entry.id
    );
    let tail = entry
        .stderr_tail
        .as_ref()
        .and_then(|tail| tail.lock().ok().map(|tail| tail.clone()))
        .unwrap_or_default();
    if !tail.trim().is_empty() {
        // keep it readable in the footer log: last ~600 chars
        let start = tail
            .char_indices()
            .rev()
            .nth(600)
            .map(|(i, _)| i)
            .unwrap_or(0);
        message.push_str(&format!(" — stderr: {}", &tail[start..]));
    }
    message
}

/// Keep the last `KEEP` bytes of a child's stderr without ever blocking the
/// child (a full pipe deadlocks it). Runs on its own thread until EOF.
fn spawn_stderr_tail<R: std::io::Read + Send + 'static>(mut reader: R) -> Arc<Mutex<String>> {
    const KEEP: usize = 4096;
    let tail = Arc::new(Mutex::new(String::new()));
    let slot = Arc::clone(&tail);
    std::thread::spawn(move || {
        let mut recent: Vec<u8> = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    recent.extend_from_slice(&buf[..n]);
                    if recent.len() > KEEP {
                        recent.drain(..recent.len() - KEEP);
                    }
                }
                Err(_) => break,
            }
        }
        *slot.lock().unwrap() = String::from_utf8_lossy(&recent).into_owned();
    });
    tail
}

fn node_or_literal(config: &RuntimeConfig) -> String {
    config
        .node_path
        .clone()
        .unwrap_or_else(|| "node".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_launcher_core::{AppSource, parse_manifest};

    fn config() -> RuntimeConfig {
        RuntimeConfig {
            node_path: None,
            shell_exe: None,
            icon_ico: None,
            window_profiles_dir: std::env::temp_dir().join("nucleus-test-profiles"),
            run_registry_dir: std::env::temp_dir().join("nucleus-test-run"),
            window_size: (100, 100),
        }
    }

    fn url_app() -> AppMeta {
        AppMeta {
            manifest: parse_manifest(
                r#"{"id":"nucleus.url","name":"Url","version":"0.1.0","coreApiVersion":"1","launch":{"kind":"url","url":"http://127.0.0.1:9/"}}"#,
            )
            .expect("valid"),
            dir: std::env::temp_dir(),
            manifest_path: std::env::temp_dir().join("nucleus.app.json"),
            source: AppSource::Repo,
            installed: None,
            catalog: None,
        }
    }

    #[test]
    fn url_launch_reports_starting_then_ready_then_stopped() {
        let (runtime, rx) = Runtime::new(config());
        // No shell binary configured → falls back to `cmd /c start` which we
        // never track, yet the app is still reported ready.
        runtime.launch(&url_app()).expect("url launch succeeds");
        assert!(runtime.is_running("nucleus.url"));

        assert_eq!(
            rx.try_recv().unwrap(),
            Event::Starting("nucleus.url".into())
        );
        match rx.try_recv().unwrap() {
            Event::Ready(id, url) => {
                assert_eq!(id, "nucleus.url");
                assert_eq!(url, "http://127.0.0.1:9/");
            }
            other => panic!("expected Ready, got {other:?}"),
        }

        assert!(runtime.stop("nucleus.url"));
        assert!(!runtime.is_running("nucleus.url"));
        assert!(matches!(rx.try_recv().unwrap(), Event::Stopped(id) if id == "nucleus.url"));
    }

    #[test]
    fn stop_unknown_id_returns_false() {
        let (runtime, _rx) = Runtime::new(config());
        assert!(!runtime.stop("nucleus.nope"));
    }

    #[test]
    fn stop_all_clears() {
        let (runtime, _rx) = Runtime::new(config());
        runtime.launch(&url_app()).unwrap();
        assert_eq!(runtime.running_count(), 1);
        runtime.stop_all();
        assert_eq!(runtime.running_count(), 0);
    }

    /// A node server that dies instantly (a bad entry, a missing module…) must
    /// surface as `Failed` **immediately** on the next `reconcile()` — exit
    /// code + stderr tail included — instead of the silent 20 s readiness
    /// timeout. This is the "Open does nothing" bug guard. Needs a node on
    /// PATH like `spawn_node_then_kill_tree`.
    #[test]
    fn server_that_dies_instantly_fails_fast_with_stderr() {
        if std::env::var("NUCLEUS_SKIP_PROC_TESTS").is_ok() {
            return;
        }
        let node = crate::process::known_node();
        if node.is_none() {
            eprintln!("node not found; skipping");
            return;
        }
        let app = AppMeta {
            manifest: parse_manifest(
                r#"{"id":"nucleus.dying","name":"Dying","version":"0.1.0","coreApiVersion":"1","launch":{"kind":"server","args":["-e","console.error('kaboom'); process.exit(3);"],"readyPath":"/api/state"}}"#,
            )
            .expect("valid"),
            dir: std::env::temp_dir(),
            manifest_path: std::env::temp_dir().join("nucleus.app.json"),
            source: AppSource::Repo,
            installed: None,
            catalog: None,
        };

        let (runtime, rx) = Runtime::new(config());
        runtime.launch(&app).unwrap();

        // Pump the engine the way the UI does, until the failure lands. The
        // window must stay below the probe's READY_TIMEOUT (20 s): catching the
        // death through reconcile is what makes this "fast". CI runners are
        // slow to spin up a node process, so allow a generous margin.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut failed: Option<Event> = None;
        while std::time::Instant::now() < deadline {
            runtime.reconcile();
            if let Ok(event) = rx.try_recv()
                && matches!(event, Event::Failed(..))
            {
                failed = Some(event);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }

        match failed {
            Some(Event::Failed(id, message)) => {
                assert_eq!(id, "nucleus.dying");
                assert!(message.contains("exit code 3"), "got: {message}");
                assert!(message.contains("kaboom"), "stderr tail missing: {message}");
            }
            other => panic!("expected a fast Failed event, got {other:?}"),
        }
        assert!(
            !runtime.is_running("nucleus.dying"),
            "the dead app must be forgotten from the runtime"
        );
    }
}
