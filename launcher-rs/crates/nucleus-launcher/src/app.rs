//! The eframe application: owns discovery, the runtime, the event channel and
//! the three-panel flat layout (header / central / footer).

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use egui::{CentralPanel, Frame, Margin, RichText, Stroke, TopBottomPanel};

use nucleus_launcher_core::{AppStatus, Card, Catalog, derive_status, iso8601, pending_delta};

use crate::discovery::Discovery;
use crate::jobs::{JobEvent, Jobs, Stage};
use crate::paths::Paths;
use crate::runtime::{Event, Runtime};
use crate::ui::icons::IconStore;
use crate::ui::theme::{FOOTER_H, HEADER_H, fonts};
use crate::ui::{
    Action, BusLine, Counts, Facts, Filter, SortKey, Tokens, View, ViewState, configure_theme,
};

/// Live state of the running background job, for the footer.
struct JobStatus {
    id: String,
    label: String,
    stage: Option<Stage>,
    done: u64,
    total: Option<u64>,
}

/// The Nucleus launcher app window.
pub struct LauncherApp {
    discovery: Discovery,
    runtime: Runtime,
    events: Receiver<Event>,
    jobs: Jobs,
    job_events: Receiver<JobEvent>,
    job: Option<JobStatus>,
    paths: Paths,
    catalog: Catalog,
    log: VecDeque<String>,
    search: String,
    view: View,
    sort: (SortKey, bool),
    filter: Filter,
    dark: bool,
    icons: IconStore,
    facts: Facts,
    /// Bus feed (M3-lite): oldest → newest, capped.
    bus: VecDeque<BusLine>,
    /// Open review requests per app id, from proposal events.
    pending: BTreeMap<String, i64>,
}

const LOG_CAP: usize = 40;
const BUS_CAP: usize = 200;

impl LauncherApp {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cc: &eframe::CreationContext<'_>,
        discovery: Discovery,
        runtime: Runtime,
        events: Receiver<Event>,
        facts: Facts,
        paths: Paths,
        catalog: Catalog,
    ) -> Self {
        crate::ui::install_fonts(&cc.egui_ctx);
        configure_theme(&cc.egui_ctx, &Tokens::dark());
        let (jobs, job_events) = Jobs::new();
        Self {
            discovery,
            runtime,
            events,
            jobs,
            job_events,
            job: None,
            paths,
            catalog,
            log: VecDeque::new(),
            search: String::new(),
            view: View::Grid,
            sort: (SortKey::Name, true),
            filter: Filter::All,
            dark: true,
            icons: IconStore::new(),
            facts,
            bus: VecDeque::new(),
            pending: BTreeMap::new(),
        }
    }

    /// The totals shown in the filter row and footer.
    fn counts(&self) -> Counts {
        let mut counts = Counts::default();
        for card in &self.discovery.cards {
            match card {
                Card::App(app) => {
                    let status = derive_status(
                        app.installed.as_ref(),
                        app.catalog.as_ref(),
                        self.runtime.is_running(app.id()),
                    );
                    counts.all += 1;
                    if status.is_installed() {
                        counts.installed += 1;
                    } else {
                        counts.not_installed += 1;
                    }
                    if status == AppStatus::UpdateAvailable {
                        counts.updates += 1;
                    }
                }
                Card::Planned(_) => counts.planned += 1,
            }
        }
        counts.running = self.runtime.running_count();
        counts
    }

    /// Drain runtime events into the log.
    fn step_events(&mut self) {
        while let Ok(event) = self.events.try_recv() {
            match event {
                Event::Starting(id) => self.log_line(format!("starting {id}")),
                Event::Ready(id, url) => {
                    if url.is_empty() {
                        self.log_line(format!("{id} launched"));
                    } else {
                        self.log_line(format!("{id} ready at {url}"));
                    }
                }
                Event::Failed(id, message) => self.log_line(format!("{id} failed: {message}")),
                Event::Stopped(id) => {
                    self.pending.remove(&id);
                    self.log_line(format!("{id} stopped"));
                }
                Event::Command {
                    app,
                    ts,
                    actor_kind,
                    actor_id,
                    command,
                    label,
                    ..
                } => {
                    self.log_line(format!("{actor_kind} · {app} · {command}"));
                    self.bus_line(BusLine {
                        time: short_time(&ts),
                        app,
                        actor_kind,
                        actor_id,
                        command,
                        label,
                        status: "applied".to_string(),
                    });
                }
                Event::Proposal {
                    app,
                    actor_kind,
                    actor_id,
                    command,
                    status,
                } => {
                    let delta = i64::from(pending_delta(&status));
                    if delta != 0 {
                        let counter = self.pending.entry(app.clone()).or_insert(0);
                        *counter = (*counter + delta).max(0);
                    }
                    self.log_line(format!(
                        "{actor_kind} · {app} · {command} proposal {status}"
                    ));
                    self.bus_line(BusLine {
                        time: clock_now(),
                        app,
                        actor_kind,
                        actor_id,
                        command,
                        label: String::new(),
                        status,
                    });
                }
            }
        }
    }

    fn log_line(&mut self, line: impl Into<String>) {
        self.log.push_back(line.into());
        while self.log.len() > LOG_CAP {
            self.log.pop_front();
        }
    }

    /// One landed Bus event → feed (newest last internally, displayed newest
    /// first) with a cap.
    fn bus_line(&mut self, line: BusLine) {
        self.bus.push_back(line);
        while self.bus.len() > BUS_CAP {
            self.bus.pop_front();
        }
    }

    /// `(app id, count)` pairs with an open review request, for the UI.
    fn pending_list(&self) -> Vec<(String, usize)> {
        self.pending
            .iter()
            .filter_map(|(app, count)| (*count > 0).then_some((app.clone(), *count as usize)))
            .collect()
    }

    /// Total open review requests — the header badge.
    fn pending_total(&self) -> usize {
        self.pending_list().iter().map(|(_, count)| count).sum()
    }

    /// Drain background job events into the log + [`JobStatus`], and re-run
    /// discovery once an install/uninstall lands so the cards update.
    fn step_jobs(&mut self) {
        let mut rediscover = false;
        while let Ok(event) = self.job_events.try_recv() {
            match event {
                JobEvent::Started { id, label } => {
                    self.log_line(format!("{label}…"));
                    self.job = Some(JobStatus {
                        id,
                        label,
                        stage: None,
                        done: 0,
                        total: None,
                    });
                }
                JobEvent::Stage { id, stage } => {
                    if let Some(job) = &mut self.job
                        && job.id == id
                    {
                        job.stage = Some(stage);
                    }
                }
                JobEvent::Progress { id, done, total } => {
                    if let Some(job) = &mut self.job
                        && job.id == id
                    {
                        job.done = done;
                        job.total = total;
                    }
                }
                JobEvent::Finished { summary, .. } => {
                    self.log_line(summary);
                    self.job = None;
                    rediscover = true;
                }
                JobEvent::Failed { id, message } => {
                    self.log_line(format!("{id} failed: {message}"));
                    self.job = None;
                }
                JobEvent::Cancelled { id } => {
                    self.log_line(format!("{id} cancelled"));
                    self.job = None;
                }
            }
        }
        if rediscover {
            self.discovery = crate::discovery::discover(&self.paths, &self.catalog);
        }
    }

    /// A one-line summary of the running job for the footer.
    fn job_line(&self) -> Option<String> {
        let job = self.job.as_ref()?;
        let stage = job.stage.map(Stage::label).unwrap_or("Working");
        match job.total {
            Some(total) if total > 0 => Some(format!(
                "{} · {} {}%",
                job.label,
                stage,
                job.done.saturating_mul(100) / total
            )),
            _ => Some(format!("{} · {}", job.label, stage)),
        }
    }

    /// Download (if needed) and install a catalogue app on a worker thread.
    fn start_install(&mut self, id: &str) {
        let Some(entry) = self
            .catalog
            .apps
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
        else {
            self.log_line(format!("{id}: not in the catalogue"));
            return;
        };
        let url = entry.url.clone().unwrap_or_else(|| {
            format!(
                "https://github.com/{}/releases/latest/download/{}",
                entry.repo, entry.release_asset
            )
        });
        let data_dir = crate::paths::nucleus_data_dir();
        let dest = data_dir.join("cache").join(&entry.release_asset);
        let apps_root = data_dir.join("apps");
        let sha = entry.sha256.clone();
        let label = format!(
            "Install {}",
            entry.name.clone().unwrap_or_else(|| entry.id.clone())
        );
        let started = self.jobs.submit(id.to_string(), label, move |ctx| {
            ctx.stage(Stage::Downloading);
            let cancel = ctx.cancel_flag();
            let mut progress = |done: u64, total: Option<u64>| ctx.progress(done, total);
            crate::net::download_archive(&url, &dest, &mut progress, &cancel)
                .map_err(|err| err.to_string())?;
            if ctx.is_cancelled() {
                return Err("cancelled".into());
            }
            // Verify the catalogue digest against the bytes we actually got,
            // before anything is unpacked into the app store.
            ctx.stage(Stage::Verifying);
            if let Some(expected) = sha.as_deref() {
                let mut file = std::fs::File::open(&dest)
                    .map_err(|err| format!("cache file for {}: {err}", entry.release_asset))?;
                let actual = crate::verify::sha256_reader(&mut file)
                    .map_err(|err| format!("reading cache file: {err}"))?;
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(format!(
                        "{}: digest mismatch (expected {expected}, got {actual})",
                        entry.release_asset
                    ));
                }
            }
            if ctx.is_cancelled() {
                return Err("cancelled".into());
            }
            ctx.stage(Stage::Installing);
            crate::install::install_archive(&dest, &apps_root, sha.as_deref())
                .map(|outcome| format!("installed {} {}", outcome.id, outcome.version))
                .map_err(|err| err.to_string())
        });
        if !started {
            self.log_line("a job is already running");
        }
    }

    /// Remove a catalogue-installed app on a worker thread.
    fn start_uninstall(&mut self, id: &str) {
        let apps_root = crate::paths::nucleus_data_dir().join("apps");
        let id_owned = id.to_string();
        let label = format!("Remove {id}");
        let started = self.jobs.submit(id.to_string(), label, move |ctx| {
            ctx.stage(Stage::Removing);
            crate::install::uninstall_app(&id_owned, &apps_root)
                .map(|()| format!("removed {id_owned}"))
                .map_err(|err| err.to_string())
        });
        if !started {
            self.log_line("a job is already running");
        }
    }

    /// Apply a queued action after the frame's panels are drawn.
    fn apply_action(&mut self, id: String, action: Action) {
        match action {
            Action::Open => {
                if let Some(app) = self.discovery.app(&id)
                    && let Err(message) = self.runtime.launch(app)
                {
                    self.log_line(message);
                }
            }
            Action::Stop => {
                self.runtime.stop(&id);
            }
            Action::Reveal => {
                if let Some(app) = self.discovery.app(&id) {
                    crate::process::reveal(&app.dir);
                }
            }
            Action::Install | Action::Update => self.start_install(&id),
            Action::Uninstall => self.start_uninstall(&id),
        }
    }
}

impl eframe::App for LauncherApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.step_events();
        self.step_jobs();
        self.runtime.reconcile();

        if self.runtime.running_count() > 0 {
            // Keep polling for exited windows/processes while anything runs.
            ctx.request_repaint_after(Duration::from_millis(250));
        }
        if self.job.is_some() {
            // Keep the progress line live while a background job runs.
            ctx.request_repaint_after(Duration::from_millis(100));
        }

        let t = if self.dark {
            Tokens::dark()
        } else {
            Tokens::light()
        };
        configure_theme(ctx, &t);

        let counts = self.counts();
        let job_line = self.job_line();
        let busy = self.jobs.is_busy();
        // Bus data precomputed once (owned snapshots): the panel closures
        // below hold &mut field borrows and must not re-borrow self.
        let pending_badge = self.pending_total();
        let bus_snapshot: Vec<BusLine> = self.bus.iter().cloned().collect();
        let pending_list = self.pending_list();
        let mut actions: Vec<(String, Action)> = Vec::new();
        let border = Stroke::new(1.0_f32, t.line);

        {
            let mut state = ViewState {
                view: &mut self.view,
                search: &mut self.search,
                sort: &mut self.sort,
                filter: &mut self.filter,
                dark: &mut self.dark,
            };

            // --- header, doubling as the title bar --------------------------
            TopBottomPanel::top("nucleus-header")
                .exact_height(HEADER_H)
                .frame(
                    Frame::NONE
                        .fill(t.bg)
                        .inner_margin(Margin::symmetric(20, 0))
                        .stroke(border),
                )
                .show(ctx, |ui| {
                    crate::ui::views::header(ui, &t, &mut state, pending_badge, &mut self.icons);
                });

            // --- footer, the status bar -------------------------------------
            TopBottomPanel::bottom("nucleus-footer")
                .exact_height(FOOTER_H)
                .frame(
                    Frame::NONE
                        .fill(t.bg)
                        .inner_margin(Margin::symmetric(20, 0))
                        .stroke(border),
                )
                .show(ctx, |ui| {
                    let mut log: Vec<String> = self.log.iter().cloned().collect();
                    if let Some(line) = &job_line {
                        log.push(line.clone());
                    }
                    crate::ui::views::footer(ui, &t, counts, &self.facts, &self.runtime, &log);
                });

            // --- central: toolbar + grid/table ------------------------------
            let discovery = &self.discovery;
            let runtime = &self.runtime;
            let facts = &self.facts;
            let icons = &mut self.icons;
            CentralPanel::default()
                .frame(
                    Frame::NONE
                        .fill(t.bg)
                        .inner_margin(Margin::symmetric(20, 0)),
                )
                .show(ctx, |ui| {
                    ui.add_space(14.0);
                    crate::ui::views::toolbar(ui, &t, &mut state, counts);
                    ui.add_space(18.0);

                    if !facts.node_ok() || !facts.errors.is_empty() {
                        Frame::NONE
                            .fill(t.sunken)
                            .stroke(border)
                            .inner_margin(Margin::symmetric(14, 10))
                            .show(ui, |ui| {
                                if !facts.node_ok() {
                                    ui.label(
                                        RichText::new(
                                            "Node.js was not found on PATH. Apps cannot start \
                                             until it is installed or NUCLEUS_NODE points at \
                                             `node.exe`.",
                                        )
                                        .font(fonts::body(13.0))
                                        .color(t.warn),
                                    );
                                }
                                for error in &facts.errors {
                                    ui.label(
                                        RichText::new(error).font(fonts::body(12.0)).color(t.warn),
                                    );
                                }
                            });
                        ui.add_space(14.0);
                    }

                    crate::ui::views::main_area(
                        ui,
                        &t,
                        &discovery.cards,
                        runtime,
                        &mut state,
                        &mut actions,
                        icons,
                        busy,
                        &bus_snapshot,
                        &pending_list,
                    );
                });
        }

        for (id, action) in actions {
            self.apply_action(id, action);
        }

        // --- frame corners: our reticle, painted last so it sits on top -----
        {
            let painter = ctx.layer_painter(egui::LayerId::new(
                egui::Order::Foreground,
                egui::Id::new("nucleus-frame"),
            ));
            let rect = ctx.screen_rect().shrink(3.0);
            crate::ui::widgets::brackets(&painter, rect, t.accent, 120);
        }
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.jobs.cancel();
        self.runtime.stop_all();
    }
}

/// `HH:MM:SS` right now — proposal rows carry no timestamp of their own, so
/// the launcher stamps them on arrival.
fn clock_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    short_time(&iso8601(secs))
}

/// Strip an RFC 3339 stamp down to its clock part.
fn short_time(ts: &str) -> String {
    ts.get(11..19).unwrap_or(ts).to_string()
}
