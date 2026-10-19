//! The views: header bar, filter toolbar, card grid, sortable table and the
//! status footer.
//!
//! Layout rules mirror the reference design language: a 48 px header, a 34 px
//! control row, a hairline grid of 320 × 280 cards (no gaps — neighbours share
//! their rules), and a 34 px status footer.

use egui::{
    Align, Align2, Color32, CornerRadius, Layout, Margin, Pos2, Rect, Response, RichText, Sense,
    Shape, Stroke, Ui, UiBuilder, Vec2, pos2, vec2,
};

use nucleus_launcher_core::{AppStatus, Card, derive_status};

use super::icons::IconStore;
use super::theme::{CONTROL_H, HUD_SIZE, Tokens, Tone, fonts};
use super::widgets::{self, ButtonKind, Cell};
use crate::runtime::Runtime;

/// Minimum card width; the column count is derived from the available width.
const CARD_MIN_W: f32 = 320.0;
/// Fixed card height.
const CARD_H: f32 = 280.0;
/// Padding inside a card.
const CARD_PAD: f32 = 20.0;
/// Height of the card's top strip (number tab + label).
const STRIP_H: f32 = 40.0;
/// Table header / row heights.
const TABLE_HEADER_H: f32 = 42.0;
const TABLE_ROW_H: f32 = 62.0;
/// Table thumbnail size.
const TABLE_THUMB: f32 = 38.0;
/// Fixed table column widths (the app column takes the remainder).
const COL_CATEGORY: f32 = 110.0;
const COL_STATUS: f32 = 176.0;
const COL_VERSION: f32 = 90.0;
const COL_SOURCE: f32 = 110.0;
const COL_ACTIONS: f32 = 180.0;

/// Which layout is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Grid,
    Table,
    /// The live command feed of every running app (M3-lite).
    Bus,
}

impl View {
    fn label(self) -> &'static str {
        match self {
            View::Grid => "Grid",
            View::Table => "Table",
            View::Bus => "Bus",
        }
    }
}

/// One line of the Bus feed: a command or a proposal status change that
/// happened in a running app, as seen through its SSE stream.
#[derive(Debug, Clone)]
pub struct BusLine {
    /// Short clock stamp, e.g. `14:32:07`.
    pub time: String,
    /// App id, e.g. `nucleus.pdf`.
    pub app: String,
    /// `human` | `agent` | raw unknown actor kind.
    pub actor_kind: String,
    pub actor_id: String,
    /// Command name, e.g. `pdf.removeMany`.
    pub command: String,
    /// Optional human label from the record.
    pub label: String,
    /// `applied` | proposal status (`pending`, `accepted`, `rejected`).
    pub status: String,
}

/// A sortable table column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Name,
    Category,
    Status,
    Version,
}

impl SortKey {
    fn label(self) -> &'static str {
        match self {
            SortKey::Name => "App",
            SortKey::Category => "Category",
            SortKey::Status => "Status",
            SortKey::Version => "Version",
        }
    }
}

/// The filter row selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    All,
    Installed,
    Updates,
    NotInstalled,
    Planned,
}

/// Totals shown in the filter row.
#[derive(Debug, Clone, Copy, Default)]
pub struct Counts {
    pub all: usize,
    pub installed: usize,
    pub updates: usize,
    pub not_installed: usize,
    pub planned: usize,
    pub running: usize,
}

/// An action a view asks the app to perform after the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Open,
    Stop,
    Reveal,
    /// Download + install a catalogue app (M2).
    Install,
    /// Update an installed catalogue app to the catalogue version (M2).
    Update,
    /// Remove a catalogue-installed app (M2).
    Uninstall,
    /// Download the new launcher installer and swap to it (updater).
    SelfUpdate,
}

/// Node availability, disclosed honestly.
#[derive(Debug, Clone)]
pub enum NodeFact {
    Found(String),
    Missing,
}

/// Facts about the running environment.
#[derive(Debug, Clone)]
pub struct Facts {
    pub node: NodeFact,
    pub errors: Vec<String>,
}

impl Facts {
    pub fn node_ok(&self) -> bool {
        matches!(self.node, NodeFact::Found(_))
    }

    pub fn node_path(&self) -> Option<&str> {
        match &self.node {
            NodeFact::Found(path) => Some(path),
            NodeFact::Missing => None,
        }
    }
}

/// The app-level view state the views read/mutate this frame. Every field is a
/// mutable reference so the views can write straight back into the app.
pub struct ViewState<'a> {
    pub view: &'a mut View,
    pub search: &'a mut String,
    pub sort: &'a mut (SortKey, bool),
    pub filter: &'a mut Filter,
    pub dark: &'a mut bool,
}

/// Does a card match the search query?
pub fn matches(query: &str, card: &Card) -> bool {
    if query.trim().is_empty() {
        return true;
    }
    let needle = query.to_lowercase();
    let parts = [
        Some(card.id().to_string()),
        Some(card.title().to_string()),
        card.description().map(str::to_string),
        card.category().map(|c| c.as_str().to_string()),
    ];
    let haystack = parts
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    haystack.contains(&needle)
}

/// The status a card presents, ignoring the running state.
fn status_of(card: &Card) -> AppStatus {
    match card {
        Card::App(app) => derive_status(app.installed.as_ref(), app.catalog.as_ref(), false),
        Card::Planned(_) => AppStatus::NotInstalled,
    }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/// The 48 px top bar: wordmark on the left, view switch and theme on the right.
pub fn header(
    ui: &mut Ui,
    t: &Tokens,
    state: &mut ViewState<'_>,
    pending: usize,
    icons: &mut IconStore,
) {
    let mut view = *state.view;
    let mut dark = *state.dark;

    ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
        // Brand lockup: our orbit mark, the wordmark, then the build stamp.
        brand_mark(ui, t, icons, 26.0);
        ui.add_space(9.0);
        ui.label(
            RichText::new("Nucleus")
                .font(fonts::display(17.0))
                .color(t.ink_strong),
        );
        ui.add_space(8.0);
        widgets::chip(ui, concat!("v", env!("CARGO_PKG_VERSION")), t.ink);
        ui.add_space(7.0);
        widgets::hud_inline(ui, "app suite launcher", t.faint, HUD_SIZE, 0.15);

        let right = ui.available_rect_before_wrap();
        ui.scope_builder(
            UiBuilder::new()
                .max_rect(right)
                .layout(Layout::right_to_left(Align::Center)),
            |ui| {
                // Theme toggle.
                let glyph = if dark { "☀" } else { "☾" };
                if widgets::glyph_button(ui, t, glyph, true).clicked() {
                    dark = !dark;
                }
                widgets::header_rule(ui, t);
                // View switch.
                if widgets::nav_link(ui, t, View::Table.label(), view == View::Table).clicked() {
                    view = View::Table;
                }
                if widgets::nav_link(ui, t, View::Grid.label(), view == View::Grid).clicked() {
                    view = View::Grid;
                }
                // The Bus shows pending activity with a badge count.
                let bus_label = if pending > 0 {
                    format!("Bus · {}", pending)
                } else {
                    "Bus".to_string()
                };
                if widgets::nav_link(ui, t, bus_label.as_str(), view == View::Bus).clicked() {
                    view = View::Bus;
                }
                widgets::header_rule(ui, t);
            },
        );
    });

    *state.view = view;
    *state.dark = dark;
}

/// The Nucleus mark: our embedded orbit logo (drawn on a transparent plate),
/// tinted so it reads on both shells. Falls back to an accent square when the
/// SVG cannot be rasterised.
fn brand_mark(ui: &mut Ui, t: &Tokens, icons: &mut IconStore, size: f32) {
    let texture = icons
        .load_bytes(ui.ctx(), "nucleus-mark", crate::ui::icons::MARK_SVG, size)
        .cloned();
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    match texture {
        Some(texture) => ui.painter().image(
            texture.id(),
            rect,
            Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)),
            Color32::WHITE,
        ),
        None => ui.painter().rect_filled(rect, CornerRadius::ZERO, t.accent),
    };
}

/// The 34 px control row: filter cells on the left, search + sort on the right.
///
/// The row is pinned to a `CONTROL_H` strip: a bare `with_layout` would take the
/// whole remaining height and center its content vertically, starving the grid.
pub fn toolbar(ui: &mut Ui, t: &Tokens, state: &mut ViewState<'_>, counts: Counts) {
    let mut filter = *state.filter;
    let mut sort = *state.sort;
    let view = *state.view;

    let strip = vec2(ui.available_width(), CONTROL_H);
    let (row, _) = ui.allocate_exact_size(strip, Sense::hover());
    ui.scope_builder(
        UiBuilder::new()
            .max_rect(row)
            .layout(Layout::left_to_right(Align::Center)),
        |ui| {
            let items = [
                Cell::new("All"),
                Cell::with_count("Installed", counts.installed, t.muted),
                Cell::with_count("Updates", counts.updates, t.warn),
                Cell::with_count("Not installed", counts.not_installed, t.muted),
                Cell::with_count("Roadmap", counts.planned, t.muted),
            ];
            let selected = filter_index(filter);
            if let Some(clicked) = widgets::cells(ui, t, &items, selected) {
                filter = filter_from_index(clicked);
            }

            let right = ui.available_rect_before_wrap();
            ui.scope_builder(
                UiBuilder::new()
                    .max_rect(right)
                    .layout(Layout::right_to_left(Align::Center)),
                |ui| {
                    // Sort control, grid view only (the table sorts from its headers).
                    if view == View::Grid {
                        let combo = egui::ComboBox::from_id_salt("nucleus-sort")
                            .selected_text(
                                RichText::new(sort.0.label())
                                    .font(fonts::body(13.0))
                                    .color(t.ink),
                            )
                            .width(140.0);
                        combo.show_ui(ui, |ui| {
                            for key in [
                                SortKey::Name,
                                SortKey::Category,
                                SortKey::Status,
                                SortKey::Version,
                            ] {
                                if ui.selectable_label(sort.0 == key, key.label()).clicked()
                                    && (sort.0 != key || sort.1)
                                {
                                    sort = if sort.0 == key {
                                        (key, !sort.1)
                                    } else {
                                        (key, true)
                                    };
                                }
                            }
                        });
                        ui.add_space(8.0);
                        widgets::hud_inline(ui, "sort", t.faint, HUD_SIZE, 0.15);
                        ui.add_space(12.0);
                    }
                    search_field(ui, t, state.search);
                },
            );
        },
    );

    *state.filter = filter;
    *state.sort = sort;
}

fn filter_index(filter: Filter) -> usize {
    match filter {
        Filter::All => 0,
        Filter::Installed => 1,
        Filter::Updates => 2,
        Filter::NotInstalled => 3,
        Filter::Planned => 4,
    }
}

fn filter_from_index(index: usize) -> Filter {
    match index {
        1 => Filter::Installed,
        2 => Filter::Updates,
        3 => Filter::NotInstalled,
        4 => Filter::Planned,
        _ => Filter::All,
    }
}

/// The search input: a recessed well with a hairline border.
fn search_field(ui: &mut Ui, t: &Tokens, query: &mut String) -> Response {
    ui.add_sized(
        vec2(200.0, CONTROL_H),
        egui::TextEdit::singleline(query)
            .font(fonts::body(13.5))
            .hint_text(RichText::new("Search apps").color(t.faint))
            .margin(Margin::symmetric(10, 0))
            .vertical_align(Align::Center),
    )
}

// ---------------------------------------------------------------------------
// Main area
// ---------------------------------------------------------------------------

/// The central scrolling area: a card grid or a sortable table.
#[allow(clippy::too_many_arguments)]
pub fn main_area(
    ui: &mut Ui,
    t: &Tokens,
    cards: &[Card],
    runtime: &Runtime,
    state: &mut ViewState<'_>,
    actions: &mut Vec<(String, Action)>,
    icons: &mut IconStore,
    busy: bool,
    feed: &[BusLine],
    pending: &[(String, usize)],
) {
    let filter = *state.filter;
    let search: String = state.search.clone();
    let sort = *state.sort;

    let mut list: Vec<&Card> = Vec::new();
    for card in cards {
        if !matches(&search, card) {
            continue;
        }
        match card {
            Card::App(app) => {
                let status = derive_status(
                    app.installed.as_ref(),
                    app.catalog.as_ref(),
                    runtime.is_running(card.id()),
                );
                let keep = match filter {
                    Filter::All => true,
                    Filter::Installed => status.is_installed(),
                    Filter::Updates => status == AppStatus::UpdateAvailable,
                    Filter::NotInstalled => !status.is_installed(),
                    Filter::Planned => false,
                };
                if keep {
                    list.push(card);
                }
            }
            Card::Planned(_) => {
                if matches!(filter, Filter::All | Filter::Planned) {
                    list.push(card);
                }
            }
        }
    }

    if *state.view == View::Table {
        sort_cards(&mut list, sort);
    }

    // The Bus ignores the app filter/search — it is a live feed over running
    // apps, not a discovery surface.
    if *state.view == View::Bus {
        egui::ScrollArea::vertical()
            .id_salt("nucleus-bus")
            .auto_shrink([false, false])
            .show(ui, |ui| bus_feed(ui, t, feed, pending, runtime));
        return;
    }

    if list.is_empty() {
        ui.add_space(40.0);
        ui.vertical_centered(|ui| {
            widgets::hud(ui, "No apps match", t.faint);
        });
        return;
    }

    match *state.view {
        View::Bus => {} // handled above (returned before the list build)
        View::Grid => {
            egui::ScrollArea::vertical()
                .id_salt("nucleus-grid")
                .auto_shrink([false, false])
                .show(ui, |ui| grid(ui, t, &list, runtime, actions, icons, busy));
        }
        View::Table => {
            egui::ScrollArea::both()
                .id_salt("nucleus-table")
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    table(ui, t, &list, runtime, actions, icons, state.sort, busy)
                });
        }
    }
}

fn sort_cards(list: &mut [&Card], sort: (SortKey, bool)) {
    let (key, ascending) = sort;
    list.sort_by(|a, b| {
        let order = match key {
            SortKey::Name => a.title().to_lowercase().cmp(&b.title().to_lowercase()),
            SortKey::Category => category_str(a).cmp(category_str(b)),
            SortKey::Status => status_rank(&status_of(a)).cmp(&status_rank(&status_of(b))),
            SortKey::Version => version_of(a).cmp(version_of(b)),
        };
        if ascending { order } else { order.reverse() }
    });
}

fn category_str(card: &Card) -> &'static str {
    card.category().map(|c| c.as_str()).unwrap_or("")
}

fn version_of(card: &Card) -> &str {
    match card {
        Card::App(app) => app.manifest.version.as_str(),
        Card::Planned(_) => "",
    }
}

fn status_rank(status: &AppStatus) -> u8 {
    match status {
        AppStatus::Running => 0,
        AppStatus::Installed => 1,
        AppStatus::UpdateAvailable => 2,
        AppStatus::NotInstalled => 3,
        AppStatus::Unavailable => 4,
    }
}

// ---------------------------------------------------------------------------
// Bus feed (M3-lite)
// ---------------------------------------------------------------------------

/// The live command/proposal feed across every running app: summary strip,
/// then newest-first rows. `feed` arrives oldest→newest; display order is
/// reversed here.
fn bus_feed(
    ui: &mut Ui,
    t: &Tokens,
    feed: &[BusLine],
    pending: &[(String, usize)],
    runtime: &Runtime,
) {
    ui.horizontal(|ui| {
        widgets::chip(ui, &format!("{} running", runtime.running_count()), t.ink);
        if pending.is_empty() {
            widgets::chip(ui, "no pending review", t.faint);
        } else {
            let summary: String = format!(
                "{} · {}",
                pending.iter().map(|(_, count)| *count).sum::<usize>(),
                pending
                    .iter()
                    .map(|(app, count)| format!("{app} · {count}"))
                    .collect::<Vec<_>>()
                    .join("   ")
            );
            widgets::badge(ui, t, &format!("AWAITING REVIEW {summary}"), Tone::Warn);
        }
    });
    ui.add_space(12.0);

    if feed.is_empty() {
        ui.add_space(40.0);
        ui.vertical_centered(|ui| {
            widgets::hud(ui, "Quiet. No commands yet.", t.faint);
            ui.add_space(8.0);
            ui.label(
                RichText::new(
                    "Open an app and act in it — every command lands here, human or agent.",
                )
                .font(fonts::body(12.0))
                .color(t.faint),
            );
        });
        return;
    }

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            egui::Grid::new("nucleus-bus-grid")
                .num_columns(5)
                .spacing([14.0, 3.0])
                .striped(true)
                .show(ui, |ui| {
                    for line in feed.iter().rev() {
                        ui.label(
                            RichText::new(&line.time)
                                .font(fonts::mono(11.0))
                                .color(t.faint),
                        );
                        widgets::badge(ui, t, &actor_label(line), actor_tone(&line.actor_kind));
                        ui.add(
                            egui::Label::new(
                                RichText::new(command_text(line))
                                    .font(fonts::mono(12.0))
                                    .color(t.ink_strong),
                            )
                            .truncate(),
                        );
                        ui.label(
                            RichText::new(&line.app)
                                .font(fonts::mono(11.0))
                                .color(t.muted),
                        );
                        widgets::badge(ui, t, &status_label(line), status_tone(&line.status));
                        ui.end_row();
                    }
                });
        });
}

fn command_text(line: &BusLine) -> String {
    if line.label.is_empty() {
        line.command.clone()
    } else {
        format!("{} — {}", line.command, line.label)
    }
}

fn actor_label(line: &BusLine) -> String {
    // Agents carry their provenance in the badge: "AGENT · opencode".
    if line.actor_kind == "agent" && !line.actor_id.is_empty() {
        format!("AGENT · {}", line.actor_id)
    } else {
        line.actor_kind.to_uppercase()
    }
}

fn status_label(line: &BusLine) -> String {
    if line.status == "applied" {
        line.status.to_uppercase()
    } else {
        format!("{} · {}", line.status.to_uppercase(), "REVIEW")
    }
}

fn actor_tone(actor_kind: &str) -> Tone {
    match actor_kind {
        "agent" => Tone::Info,    // the cyan accent — non-human actor
        "human" => Tone::Neutral, // normal ink
        _ => Tone::Faint,
    }
}

fn status_tone(status: &str) -> Tone {
    match status {
        "applied" => Tone::Good,
        "pending" => Tone::Warn,
        "accepted" => Tone::Info,
        "rejected" => Tone::Faint,
        _ => Tone::Neutral,
    }
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/// The grid geometry for `count` cards in `available` width: how many columns
/// fit, how wide each one ends up, and how many rows are needed.
fn grid_geometry(available: f32, count: usize) -> (usize, f32, usize) {
    let columns = ((available / CARD_MIN_W).floor() as usize).max(1);
    let card_w = (available / columns as f32).floor().max(1.0);
    let rows = count.div_ceil(columns);
    (columns, card_w, rows)
}

/// A hairline lattice of cards: neighbours share their 1 px rules.
fn grid(
    ui: &mut Ui,
    t: &Tokens,
    list: &[&Card],
    runtime: &Runtime,
    actions: &mut Vec<(String, Action)>,
    icons: &mut IconStore,
    busy: bool,
) {
    let available = ui.available_width();
    let (columns, card_w, rows) = grid_geometry(available, list.len());
    let (area, _) = ui.allocate_exact_size(
        vec2(card_w * columns as f32, rows as f32 * CARD_H),
        Sense::hover(),
    );

    for (index, &entry) in list.iter().enumerate() {
        let cell = Rect::from_min_size(
            pos2(
                area.left() + (index % columns) as f32 * card_w,
                area.top() + (index / columns) as f32 * CARD_H,
            ),
            vec2(card_w, CARD_H),
        );
        card(ui, t, cell, entry, index, runtime, actions, icons, busy);
    }

    // The lattice: one rule per card edge, drawn once thanks to the shared grid.
    let stroke = Stroke::new(1.0_f32, t.line);
    let painter = ui.painter();
    for row in 0..rows {
        let used = (list.len() - row * columns).min(columns);
        let y0 = area.top() + row as f32 * CARD_H;
        let y1 = y0 + CARD_H;
        let x0 = area.left();
        let x1 = x0 + used as f32 * card_w;
        painter.hline(x0..=x1, y1, stroke);
        if row == 0 {
            painter.hline(x0..=x1, y0, stroke);
        }
        for column in 0..=used {
            let x = x0 + column as f32 * card_w;
            painter.vline(x, y0..=y1, stroke);
        }
    }

    ui.add_space(24.0);
}

/// One card, painted into an explicit rect so the grid stays gapless.
#[allow(clippy::too_many_arguments)]
fn card(
    ui: &mut Ui,
    t: &Tokens,
    cell: Rect,
    card: &Card,
    index: usize,
    runtime: &Runtime,
    actions: &mut Vec<(String, Action)>,
    icons: &mut IconStore,
    busy: bool,
) {
    let id = card.id().to_string();
    let running = runtime.is_running(&id);
    let status = if running {
        AppStatus::Running
    } else {
        status_of(card)
    };
    let app_color = widgets::card_color(card, t);
    let app_ink = accent_ink(t, app_color);

    let interaction = ui.make_persistent_id(("nucleus-card", id.as_str()));
    let response = ui.interact(cell, interaction, Sense::hover());
    let lift = ui
        .ctx()
        .animate_bool_with_time(interaction, response.hovered(), 0.18);

    if lift > 0.0 {
        let painter = ui.painter();
        painter.rect_filled(
            cell,
            CornerRadius::ZERO,
            blend(t.bg, app_color, 0.05 * lift),
        );
        // Our reticle: four app-coloured corner brackets fade in on hover.
        widgets::brackets(painter, cell, app_color, (215.0 * lift) as u8);
    }

    let inner = Rect::from_min_max(
        cell.min + vec2(CARD_PAD, CARD_PAD),
        cell.max - vec2(CARD_PAD, CARD_PAD),
    );

    ui.scope_builder(UiBuilder::new().max_rect(inner), |ui| {
        ui.spacing_mut().item_spacing = vec2(8.0, 6.0);
        ui.set_clip_rect(cell);

        // --- top strip: number tab + category label -------------------------
        ui.allocate_ui_with_layout(
            vec2(inner.width(), STRIP_H),
            Layout::left_to_right(Align::Center),
            |ui| {
                ui.spacing_mut().item_spacing = vec2(6.0, 0.0);
                widgets::tag(ui, &format!("{:02}", index + 1), app_color, Color32::BLACK);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    widgets::hud_inline(ui, strip_label(card), t.faint, HUD_SIZE, 0.15);
                });
            },
        );
        let strip_bottom = ui.cursor().top();
        ui.painter()
            .hline(cell.x_range(), strip_bottom, Stroke::new(1.0_f32, t.line));
        ui.add_space(18.0);

        // --- icon + identity ------------------------------------------------
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing = vec2(12.0, 0.0);
            app_icon(ui, t, icons, card, 56.0);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing = vec2(0.0, 4.0);
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                    let (head, tail) = split_name(card.title());
                    ui.label(
                        RichText::new(head)
                            .font(fonts::display(22.0))
                            .color(t.ink_strong),
                    );
                    if let Some(tail) = tail {
                        ui.label(
                            RichText::new(tail)
                                .font(fonts::display(22.0))
                                .color(app_ink),
                        );
                    }
                });
                if let Some(tagline) = card.description() {
                    ui.add(
                        egui::Label::new(
                            RichText::new(tagline)
                                .font(fonts::body(13.5))
                                .color(t.muted),
                        )
                        .truncate(),
                    );
                }
            });
        });

        // --- status + version ----------------------------------------------
        ui.add_space(14.0);
        let (label, tone) = widgets::status_label(status);
        ui.horizontal(|ui| {
            widgets::badge(ui, t, label, tone);
        });
        ui.add_space(4.0);
        ui.label(
            RichText::new(version_line(card))
                .font(fonts::body(12.5))
                .color(t.muted),
        );
    });

    // --- bottom-anchored actions -------------------------------------------
    let actions_rect = Rect::from_min_size(
        pos2(inner.left(), cell.bottom() - CARD_PAD - CONTROL_H),
        vec2(inner.width(), CONTROL_H),
    );
    ui.scope_builder(UiBuilder::new().max_rect(actions_rect), |ui| {
        ui.spacing_mut().item_spacing = vec2(8.0, 0.0);
        ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
            card_actions(ui, t, card, running, status, busy, actions);
        });
    });
}

/// The action row of a card: a primary button, optional install/update/remove
/// controls, plus a "reveal" glyph.
fn card_actions(
    ui: &mut Ui,
    t: &Tokens,
    card: &Card,
    running: bool,
    status: AppStatus,
    busy: bool,
    actions: &mut Vec<(String, Action)>,
) {
    let id = card.id().to_string();
    let has_glyph = matches!(card, Card::App(_));
    let secondary_w = 84.0;
    let main_width = (ui.available_width() - CONTROL_H - 8.0).clamp(120.0, 240.0);

    if running {
        if widgets::button(ui, t, "Stop", ButtonKind::Secondary, true, main_width).clicked() {
            actions.push((id.clone(), Action::Stop));
        }
    } else {
        match status {
            AppStatus::UpdateAvailable => {
                let width = (main_width - secondary_w - 8.0).max(96.0);
                if widgets::button(ui, t, "Open", ButtonKind::Secondary, true, width).clicked() {
                    actions.push((id.clone(), Action::Open));
                }
                // Install-type actions queue on a single worker: park them
                // while another job runs instead of failing on submit.
                let update =
                    widgets::button(ui, t, "Update", ButtonKind::Primary, !busy, secondary_w);
                if busy {
                    update.on_hover_text("A job is already running");
                } else if update.clicked() {
                    actions.push((id.clone(), Action::Update));
                }
            }
            AppStatus::Installed => {
                let width = if uninstallable(card) {
                    secondary_w
                } else {
                    main_width
                };
                if widgets::button(ui, t, "Open", ButtonKind::Primary, true, width).clicked() {
                    actions.push((id.clone(), Action::Open));
                }
                if uninstallable(card) {
                    let remove =
                        widgets::button(ui, t, "Remove", ButtonKind::Secondary, !busy, secondary_w);
                    if busy {
                        remove.on_hover_text("A job is already running");
                    } else if remove.clicked() {
                        actions.push((id.clone(), Action::Uninstall));
                    }
                }
            }
            AppStatus::NotInstalled if matches!(card, Card::App(_)) => {
                let install =
                    widgets::button(ui, t, "Install", ButtonKind::Primary, !busy, main_width);
                if busy {
                    install.on_hover_text("A job is already running");
                } else if install.clicked() {
                    actions.push((id.clone(), Action::Install));
                }
            }
            AppStatus::NotInstalled => {
                widgets::button(ui, t, "Planned", ButtonKind::Secondary, false, main_width);
            }
            _ => {
                widgets::button(
                    ui,
                    t,
                    "Unavailable",
                    ButtonKind::Secondary,
                    false,
                    main_width,
                );
            }
        }
    }

    if has_glyph
        && widgets::glyph_button(ui, t, "…", true)
            .on_hover_text("Reveal in Explorer")
            .clicked()
    {
        actions.push((id, Action::Reveal));
    }
}

/// Only catalogue-installed apps (in user data, with an install record) may be
/// removed — never repository apps and never a roadmap placeholder.
fn uninstallable(card: &Card) -> bool {
    matches!(
        card,
        Card::App(app)
            if app.source == nucleus_launcher_core::AppSource::UserData
                && app.installed.is_some()
    )
}

fn app_icon(ui: &mut Ui, t: &Tokens, icons: &mut IconStore, card: &Card, size: f32) {
    let color = widgets::card_color(card, t);
    let mut texture = None;
    if let Card::App(app) = card
        && let Some(icon) = &app.manifest.icon
    {
        let path = app.dir.join(icon);
        if path.exists() {
            texture = icons.load(ui.ctx(), app.id(), &path, size).cloned();
        }
    }
    widgets::icon_tile(ui, t, texture.as_ref(), card.title(), color, size);
}

/// Split a name so the last word can carry the app colour, like the reference
/// wordmark does ("Art" + "Craft").
fn split_name(name: &str) -> (String, Option<&str>) {
    match name.rsplit_once(' ') {
        Some((head, tail)) if !head.is_empty() => (format!("{head} "), Some(tail)),
        _ => (name.to_string(), None),
    }
}

fn strip_label(card: &Card) -> &'static str {
    match card {
        Card::App(app) => app.manifest.category.map(|c| c.as_str()).unwrap_or("app"),
        Card::Planned(_) => "roadmap",
    }
}

fn version_line(card: &Card) -> String {
    match card {
        Card::App(app) => {
            let mut parts = vec![app.manifest.version.clone()];
            if let Some(status) = app.manifest.status {
                parts.push(status.as_str().to_string());
            }
            parts.push(app.source.as_str().to_string());
            parts.join(" · ")
        }
        Card::Planned(entry) => match &entry.inspired_by {
            Some(inspired) => format!("coming soon · inspired by {inspired}"),
            None => "coming soon".to_string(),
        },
    }
}

/// A readable version of an app colour against the current background.
fn accent_ink(t: &Tokens, color: Color32) -> Color32 {
    if t.dark {
        blend(color, Color32::WHITE, 0.35)
    } else {
        blend(color, Color32::BLACK, 0.20)
    }
}

fn blend(from: Color32, to: Color32, amount: f32) -> Color32 {
    super::theme::blend(from, to, amount)
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/// A table with hairline row dividers, no zebra striping, and columns sortable
/// from their headers.
#[allow(clippy::too_many_arguments)]
fn table(
    ui: &mut Ui,
    t: &Tokens,
    list: &[&Card],
    runtime: &Runtime,
    actions: &mut Vec<(String, Action)>,
    icons: &mut IconStore,
    sort: &mut (SortKey, bool),
    busy: bool,
) {
    let fixed = COL_CATEGORY + COL_STATUS + COL_VERSION + COL_SOURCE + COL_ACTIONS;
    let width = ui.available_width().max(fixed + 240.0);
    let app_w = width - fixed;
    let height = TABLE_HEADER_H + list.len() as f32 * TABLE_ROW_H;
    let (area, _) = ui.allocate_exact_size(vec2(width, height), Sense::hover());

    let offsets = [
        0.0,
        app_w,
        app_w + COL_CATEGORY,
        app_w + COL_CATEGORY + COL_STATUS,
        app_w + COL_CATEGORY + COL_STATUS + COL_VERSION,
        app_w + COL_CATEGORY + COL_STATUS + COL_VERSION + COL_SOURCE,
    ];
    let widths = [
        app_w,
        COL_CATEGORY,
        COL_STATUS,
        COL_VERSION,
        COL_SOURCE,
        COL_ACTIONS,
    ];
    let stroke = Stroke::new(1.0_f32, t.line);

    // --- header ------------------------------------------------------------
    let header = Rect::from_min_size(area.min, vec2(width, TABLE_HEADER_H));
    let sortable = [
        Some(SortKey::Name),
        Some(SortKey::Category),
        Some(SortKey::Status),
        Some(SortKey::Version),
        None,
        None,
    ];
    for index in 0..offsets.len() {
        let cell = Rect::from_min_size(
            pos2(area.left() + offsets[index], header.top()),
            vec2(widths[index], TABLE_HEADER_H),
        );
        let pad = if index == 0 { 16.0 } else { 12.0 };
        let galley = match sortable[index] {
            Some(key) => widgets::hud_galley(ui, key.label(), HUD_SIZE, 0.15),
            None => widgets::hud_galley(ui, "Actions", HUD_SIZE, 0.15),
        };
        let galley_size = galley.size();
        let response = ui.interact(
            cell,
            ui.make_persistent_id(("nucleus-th", index)),
            if sortable[index].is_some() {
                Sense::click()
            } else {
                Sense::hover()
            },
        );
        let active = sortable[index] == Some(sort.0);
        let color = if active || response.hovered() {
            t.ink_strong
        } else {
            t.faint
        };
        let origin = pos2(cell.left() + pad, cell.center().y - galley_size.y * 0.5);
        ui.painter().galley(origin, galley, color);
        // The active column shows its direction; other sortable columns show a
        // ghost arrow while hovered.
        if sortable[index].is_some() && (active || response.hovered()) {
            let arrow = pos2(origin.x + galley_size.x + 8.0, cell.center().y);
            sort_arrow(ui.painter(), arrow, active && sort.1, color);
        }
        if response.clicked()
            && let Some(key) = sortable[index]
        {
            *sort = if key == sort.0 {
                (key, !sort.1)
            } else {
                (key, true)
            };
        }
        if index > 0 {
            ui.painter().vline(cell.left(), cell.y_range(), stroke);
        }
    }
    ui.painter()
        .hline(header.x_range(), header.bottom(), stroke);

    // --- rows --------------------------------------------------------------
    for (index, card) in list.iter().enumerate() {
        let top = area.top() + TABLE_HEADER_H + index as f32 * TABLE_ROW_H;
        let row = Rect::from_min_size(pos2(area.left(), top), vec2(width, TABLE_ROW_H));
        table_row(
            ui, t, row, &offsets, &widths, card, runtime, actions, icons, busy,
        );
        ui.painter().hline(row.x_range(), row.bottom(), stroke);
    }
}

#[allow(clippy::too_many_arguments)]
fn table_row(
    ui: &mut Ui,
    t: &Tokens,
    row: Rect,
    offsets: &[f32; 6],
    widths: &[f32; 6],
    card: &Card,
    runtime: &Runtime,
    actions: &mut Vec<(String, Action)>,
    icons: &mut IconStore,
    busy: bool,
) {
    let running = runtime.is_running(card.id());
    let status = if running {
        AppStatus::Running
    } else {
        status_of(card)
    };
    let app_color = widgets::card_color(card, t);
    let painter = ui.painter().clone();

    // App cell: thumbnail, wordmark and tagline.
    let thumb = Rect::from_min_size(
        pos2(row.left() + 16.0, row.center().y - TABLE_THUMB * 0.5),
        egui::Vec2::splat(TABLE_THUMB),
    );
    icon_tile_at(ui, t, icons, card, thumb);
    let text_x = thumb.right() + 10.0;
    let text_width = (offsets[1] - (text_x - row.left()) - 12.0).max(40.0);
    let name = widgets::line(ui, card.title(), fonts::display(16.0), text_width);
    painter.galley(
        pos2(text_x, row.center().y - name.size().y - 1.0),
        name,
        t.ink_strong,
    );
    if let Some(tagline) = card.description() {
        let line = widgets::line(ui, tagline, fonts::body(12.0), text_width);
        painter.galley(pos2(text_x, row.center().y + 1.0), line, t.muted);
    }

    // Category.
    let category = widgets::hud_galley(ui, category_str(card), HUD_SIZE, 0.15);
    let category_ink = if card.category().is_some() {
        accent_ink(t, app_color)
    } else {
        t.faint
    };
    painter.galley(
        cell_text_origin(row, offsets[1], 12.0, category.size().y),
        category,
        category_ink,
    );

    // Status badge.
    let (label, tone) = widgets::status_label(status);
    let badge_size = widgets::badge_size(ui, label);
    let badge_rect = Rect::from_min_size(
        pos2(
            row.left() + offsets[2] + 12.0,
            row.center().y - badge_size.y * 0.5,
        ),
        badge_size,
    );
    ui.scope_builder(UiBuilder::new().max_rect(badge_rect), |ui| {
        widgets::badge(ui, t, label, tone);
    });

    // Version.
    let version = match card {
        Card::App(app) => app.manifest.version.as_str(),
        Card::Planned(_) => "—",
    };
    painter.text(
        pos2(row.left() + offsets[3] + 12.0, row.center().y),
        Align2::LEFT_CENTER,
        version,
        fonts::mono(13.0),
        if status.is_installed() {
            t.ink
        } else {
            t.faint
        },
    );

    // Source.
    let source = match card {
        Card::App(app) => app.source.as_str(),
        Card::Planned(_) => "roadmap",
    };
    painter.text(
        pos2(row.left() + offsets[4] + 12.0, row.center().y),
        Align2::LEFT_CENTER,
        source,
        fonts::mono(HUD_SIZE),
        t.faint,
    );

    // Actions.
    let actions_rect = Rect::from_min_size(
        pos2(row.left() + offsets[5], row.center().y - CONTROL_H * 0.5),
        vec2(widths[5], CONTROL_H),
    );
    ui.scope_builder(UiBuilder::new().max_rect(actions_rect), |ui| {
        ui.spacing_mut().item_spacing = vec2(8.0, 0.0);
        ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
            ui.add_space(4.0);
            card_actions(ui, t, card, running, status, busy, actions);
        });
    });
}

fn cell_text_origin(row: Rect, offset: f32, pad: f32, text_height: f32) -> Pos2 {
    pos2(
        row.left() + offset + pad,
        row.center().y - text_height * 0.5,
    )
}

fn icon_tile_at(ui: &mut Ui, t: &Tokens, icons: &mut IconStore, card: &Card, rect: Rect) {
    let color = widgets::card_color(card, t);
    let mut texture = None;
    if let Card::App(app) = card
        && let Some(icon) = &app.manifest.icon
    {
        let path = app.dir.join(icon);
        if path.exists() {
            texture = icons.load(ui.ctx(), app.id(), &path, rect.width()).cloned();
        }
    }
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::ZERO, t.sunken);
    match texture {
        Some(texture) => {
            painter.image(
                texture.id(),
                rect.shrink(rect.width() * 0.10),
                Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)),
                Color32::WHITE,
            );
        }
        None => {
            let glyph = card
                .title()
                .chars()
                .next()
                .map(|c| c.to_uppercase().to_string())
                .unwrap_or_else(|| "?".into());
            painter.text(
                rect.center(),
                Align2::CENTER_CENTER,
                glyph,
                fonts::display(rect.width() * 0.45),
                color,
            );
        }
    }
    painter.rect_stroke(
        rect,
        CornerRadius::ZERO,
        Stroke::new(1.0_f32, t.line),
        egui::StrokeKind::Inside,
    );
}

/// A small filled triangle marking the active sort column.
fn sort_arrow(painter: &egui::Painter, center: Pos2, up: bool, color: Color32) {
    let (half_w, half_h) = (4.0, 3.0);
    let points = if up {
        vec![
            pos2(center.x, center.y - half_h),
            pos2(center.x - half_w, center.y + half_h),
            pos2(center.x + half_w, center.y + half_h),
        ]
    } else {
        vec![
            pos2(center.x, center.y + half_h),
            pos2(center.x - half_w, center.y - half_h),
            pos2(center.x + half_w, center.y - half_h),
        ]
    };
    painter.add(Shape::convex_polygon(points, color, Stroke::NONE));
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

/// The 34 px status bar: totals on the left, environment on the right.
pub fn footer(
    ui: &mut Ui,
    t: &Tokens,
    counts: Counts,
    facts: &Facts,
    runtime: &Runtime,
    log: &[String],
) {
    ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
        let summary = format!(
            "{} app{} · {} installed · {} update{} · {} planned",
            counts.all,
            plural(counts.all),
            counts.installed,
            counts.updates,
            plural(counts.updates),
            counts.planned,
        );
        widgets::hud_inline(ui, &summary, t.faint, HUD_SIZE, 0.15);

        if counts.running > 0 {
            ui.add_space(10.0);
            let mut parts: Vec<String> = Vec::new();
            for id in runtime.running_ids() {
                let detail = runtime
                    .running_info(&id)
                    .and_then(|(url, port)| url.or_else(|| port.map(|p| format!(":{p}"))));
                parts.push(match detail {
                    Some(detail) => format!("{id} {detail}"),
                    None => id,
                });
            }
            widgets::hud_inline(
                ui,
                &format!("running · {}", parts.join("  ")),
                t.good,
                HUD_SIZE,
                0.15,
            );
        } else if let Some(last) = log.last() {
            ui.add_space(10.0);
            widgets::hud_inline(ui, last, t.faint, HUD_SIZE, 0.15);
        }

        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            widgets::hud_inline(
                ui,
                concat!("Nucleus ", env!("CARGO_PKG_VERSION")),
                t.faint,
                HUD_SIZE,
                0.15,
            );
            ui.add_space(12.0);
            match facts.node_path() {
                Some(path) => {
                    widgets::hud_inline(ui, &format!("node {path}"), t.faint, HUD_SIZE, 0.15);
                }
                None => {
                    widgets::hud_inline(ui, "node not found", t.warn, HUD_SIZE, 0.15);
                }
            }
        });
    });
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_launcher_core::{AppSource, parse_manifest};

    fn app(id: &str, name: &str) -> Card {
        Card::App(Box::new(nucleus_launcher_core::AppMeta {
            manifest: parse_manifest(&format!(
                r#"{{"id":"{id}","name":"{name}","version":"0.1.0","coreApiVersion":"1","launch":{{"kind":"server","args":["server.js"]}}}}"#
            ))
            .unwrap(),
            dir: std::path::PathBuf::from("."),
            manifest_path: std::path::PathBuf::from("."),
            source: AppSource::Repo,
            installed: None,
            catalog: None,
        }))
    }

    #[test]
    fn search_matches_id_name_and_description() {
        let card = app("nucleus.notes", "Notes");
        assert!(matches("", &card));
        assert!(matches("notes", &card));
        assert!(matches("NUCLEUS.NOTES", &card));
        assert!(!matches("zzz", &card));
    }

    #[test]
    fn filter_index_round_trips() {
        for filter in [
            Filter::All,
            Filter::Installed,
            Filter::Updates,
            Filter::NotInstalled,
            Filter::Planned,
        ] {
            assert_eq!(filter_from_index(filter_index(filter)), filter);
        }
    }

    #[test]
    fn split_name_puts_the_last_word_in_the_tail() {
        assert_eq!(
            split_name("PDF Workbench"),
            ("PDF ".to_string(), Some("Workbench"))
        );
        assert_eq!(split_name("Notes"), ("Notes".to_string(), None));
    }

    #[test]
    fn sorting_by_name_is_case_insensitive() {
        let a = app("nucleus.a", "alpha");
        let b = app("nucleus.b", "Beta");
        let mut list = vec![&b, &a];
        sort_cards(&mut list, (SortKey::Name, true));
        assert_eq!(list[0].title(), "alpha");
        sort_cards(&mut list, (SortKey::Name, false));
        assert_eq!(list[0].title(), "Beta");
    }

    /// The control row must be pinned to its 34 px strip: a bare `with_layout`
    /// used to swallow the page height and center itself, leaving the grid with
    /// no room at all (it rendered as an empty page).
    #[test]
    fn toolbar_keeps_most_of_the_page_height() {
        let ctx = egui::Context::default();
        crate::ui::theme::install_fonts(&ctx);
        let mut remaining = 0.0;
        let output = ctx.run(Default::default(), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let t = Tokens::dark();
                let mut view = View::Grid;
                let mut search = String::new();
                let mut sort = (SortKey::Name, true);
                let mut filter = Filter::All;
                let mut dark = true;
                let mut state = ViewState {
                    view: &mut view,
                    search: &mut search,
                    sort: &mut sort,
                    filter: &mut filter,
                    dark: &mut dark,
                };
                let before = ui.available_height();
                toolbar(ui, &t, &mut state, Counts::default());
                remaining = ui.available_height();
                assert!(remaining < before, "the toolbar allocated nothing");
            });
        });
        assert!(
            output.shapes.is_empty() || remaining > 200.0,
            "toolbar left {remaining} px of page height; it should keep the page"
        );
    }

    /// Cards must be laid out inside the visible area, not off-screen.
    #[test]
    fn grid_geometry_fits_the_available_width() {
        let (columns, card_w, rows) = grid_geometry(1200.0, 4);
        assert_eq!(columns, 3, "1200 px should fit three 320 px columns");
        assert!(
            card_w >= CARD_MIN_W,
            "columns must respect the minimum width"
        );
        assert!(
            card_w * columns as f32 <= 1200.0,
            "columns must not overflow"
        );
        assert_eq!(rows, 2);

        let (columns, card_w, _) = grid_geometry(300.0, 1);
        assert_eq!(columns, 1, "a narrow page still shows one full column");
        assert!(card_w > 0.0);
    }
}
