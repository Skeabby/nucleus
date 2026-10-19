//! The egui UI: a flat, hairline-ruled header + card grid or table + status
//! footer, built from the Nucleus design tokens.

pub mod icons;
pub mod theme;
pub mod views;
pub mod widgets;

pub use theme::{Tokens, configure_theme, install_fonts};
pub use views::{Action, BusLine, Counts, Facts, Filter, NodeFact, SortKey, View, ViewState};
