//! The Bus (M3): the pure parts of the launcher's live-feed surface —
//!
//! * an SSE line parser (what app-kit's `/api/events` emits),
//! * event classification into command / proposal frames,
//! * the run-registry wire format (`%APPDATA%\Nucleus\run\apps.json`, §4.4).
//!
//! This crate is I/O-free: the file writes and the HTTP subscribe threads live
//! in the sibling `nucleus-launcher` crate. Everything here is unit-tested
//! inline.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/// One dispatched server-sent event: the (possibly defaulted) `event:` field
/// and the joined `data:` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
}

/// Incremental SSE decoder: feed it the HTTP body **one line at a time** and
/// it yields a [`SseFrame`] at every blank line. Follows the minimal subset of
/// the SSE spec app-kit uses (§M2): `event:`, `data:` (possibly repeated), `:`
/// comments and CR-terminated lines.
#[derive(Debug, Default)]
pub struct SseParser {
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one raw line; returns a frame when the line closes one (blank
    /// line), else `None`.
    pub fn feed_line(&mut self, raw: &str) -> Option<SseFrame> {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.is_empty() {
            // Blank line = dispatch, but only if something was pending (a
            // stream of blank lines must not spam "message" frames).
            return self.take();
        }
        if line.starts_with(':') {
            return None; // comment / heartbeat keep-alive text
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            // `id:`, `retry:` and unknown fields are ignored on purpose: the
            // fixture does not use them and resuming a dropped stream is out
            // of scope for the launcher's read-only subscription.
            _ => {}
        }
        None
    }

    fn take(&mut self) -> Option<SseFrame> {
        if self.event.is_none() && self.data.is_empty() {
            return None;
        }
        let frame = SseFrame {
            event: self.event.take().unwrap_or_else(|| "message".to_string()),
            data: std::mem::take(&mut self.data).join("\n"),
        };
        Some(frame)
    }
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/// An applied command, straight off app-kit's `command` frame (a tape record
/// in FlightRecorder JSON).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandFrame {
    pub seq: Option<u64>,
    pub ts: String,
    pub actor_kind: String,
    pub actor_id: String,
    pub command: String,
    pub label: Option<String>,
}

/// A proposal status change off app-kit's `proposal` frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalFrame {
    pub id: String,
    pub status: String,
    pub actor_kind: String,
    pub actor_id: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BusFrame {
    Command(CommandFrame),
    Proposal(ProposalFrame),
}

/// Classify a frame from the `/api/events` stream app-kit broadcasts. Returns
/// `None` for heartbeats, unknown event kinds and unparseable payloads.
pub fn classify_frame(frame: &SseFrame) -> Option<BusFrame> {
    if frame.data.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&frame.data).ok()?;
    match frame.event.as_str() {
        "command" => Some(BusFrame::Command(CommandFrame {
            seq: value.get("seq").and_then(|v| v.as_u64()),
            ts: text(&value, "ts"),
            actor_kind: value
                .pointer("/actor/kind")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string(),
            actor_id: value
                .pointer("/actor/id")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string(),
            command: value
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            label: value
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        })),
        "proposal" => Some(BusFrame::Proposal(ProposalFrame {
            id: value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string(),
            status: value
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending")
                .to_string(),
            actor_kind: value
                .pointer("/actor/kind")
                .and_then(|v| v.as_str())
                .unwrap_or("agent")
                .to_string(),
            actor_id: value
                .pointer("/actor/id")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string(),
            command: value
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })),
        _ => None,
    }
}

fn text(value: &serde_json::Value, field: &str) -> String {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// A proposal's clock contribution: upstream statuses the launcher counts as
/// "one pending request more" (`pending`), resolved (`accepted`/`rejected`),
/// or irrelevant.
pub fn pending_delta(status: &str) -> i32 {
    match status {
        "pending" => 1,
        "accepted" | "rejected" => -1,
        _ => 0,
    }
}

// ---------------------------------------------------------------------------
// Run registry (§4.4)
// ---------------------------------------------------------------------------

/// One entry of `%APPDATA%\Nucleus\run\apps.json`: what is running right now,
/// where to reach it and with which token (§4.4 — the M4 MCP proxy reads this
/// file to find each app's bearer).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunningAppRecord {
    pub id: String,
    pub name: String,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub pid: Option<u32>,
    pub started_at: String,
}

/// Serialize the registry exactly like the launcher writes it (pretty, with a
/// trailing newline so hand checks look tidy).
pub fn serialize_registry(apps: &[RunningAppRecord]) -> String {
    match serde_json::to_string_pretty(apps) {
        Ok(json) => json + "\n",
        Err(_) => "[]\n".to_string(),
    }
}

/// Parse a registry file. Unparseable content is an empty list, not an error:
/// the launcher rewrites the whole file from live state on every change, so a
/// corrupt file self-heals on the next start/stop.
pub fn parse_registry(json: &str) -> Vec<RunningAppRecord> {
    serde_json::from_str(json).unwrap_or_default()
}

/// RFC 3339 "Z" timestamp from unix seconds — no chrono on board. Pure
/// days-from-civil arithmetic (Howard Hinnant's algorithm), unit-tested below
/// against hand-checked anchors.
pub fn iso8601(unix_secs: u64) -> String {
    let days = unix_secs / 86_400;
    let secs_of_day = unix_secs % 86_400;
    let (hour, min, sec) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );

    // days since 1970-01-01 → civil (y, m, d)
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- SSE parser --------------------------------------------------------

    #[test]
    fn sse_basic_frame() {
        let mut parser = SseParser::new();
        assert_eq!(parser.feed_line("event: command"), None);
        assert_eq!(parser.feed_line("data: {\"a\":1}"), None);
        let frame = parser.feed_line("").expect("dispatch on blank line");
        assert_eq!(frame.event, "command");
        assert_eq!(frame.data, "{\"a\":1}");
    }

    #[test]
    fn sse_defaults_to_message_event() {
        let mut parser = SseParser::new();
        assert_eq!(parser.feed_line("data: x"), None);
        let frame = parser.feed_line("").expect("frame");
        assert_eq!(frame.event, "message");
        assert_eq!(frame.data, "x");
    }

    #[test]
    fn sse_multi_data_joins_with_newlines() {
        let mut parser = SseParser::new();
        parser.feed_line("data: line1");
        parser.feed_line("data: line2");
        let frame = parser.feed_line("").expect("frame");
        assert_eq!(frame.data, "line1\nline2");
    }

    #[test]
    fn sse_comments_and_id_are_ignored() {
        let mut parser = SseParser::new();
        assert_eq!(parser.feed_line(": keep-alive"), None);
        assert_eq!(parser.feed_line("id: 42"), None);
        parser.feed_line("data: hello");
        let frame = parser.feed_line("").expect("frame");
        assert_eq!(frame.data, "hello");
    }

    #[test]
    fn sse_cr_suffix_is_stripped() {
        let mut parser = SseParser::new();
        parser.feed_line("event: state\r");
        parser.feed_line("data: {}\r");
        let frame = parser.feed_line("\r").expect("frame");
        assert_eq!(frame.event, "state");
    }

    #[test]
    fn sse_blank_line_alone_yields_nothing() {
        let mut parser = SseParser::new();
        assert_eq!(parser.feed_line(""), None);
        assert_eq!(parser.feed_line(""), None);
    }

    // --- classification ------------------------------------------------------

    const COMMAND_FRAME: &str = concat!(
        "event: command\ndata: {\"seq\":3,\"ts\":\"2026-10-19T12:00:00.000Z\",",
        "\"actor\":{\"kind\":\"human\",\"id\":\"you\"},\"command\":\"doc.addNode\",",
        "\"params\":{},\"label\":\"Test\"}\n\n"
    );

    fn parse_stream(text: &str) -> Vec<SseFrame> {
        let mut parser = SseParser::new();
        let mut frames = Vec::new();
        for line in text.split('\n') {
            if let Some(frame) = parser.feed_line(line) {
                frames.push(frame);
            }
        }
        frames
    }

    #[test]
    fn classify_command_record() {
        let frames = parse_stream(COMMAND_FRAME);
        assert_eq!(frames.len(), 1);
        match classify_frame(&frames[0]) {
            Some(BusFrame::Command(command)) => {
                assert_eq!(command.seq, Some(3));
                assert_eq!(command.actor_kind, "human");
                assert_eq!(command.actor_id, "you");
                assert_eq!(command.command, "doc.addNode");
                assert_eq!(command.label.as_deref(), Some("Test"));
            }
            other => panic!("expected a command frame, got {other:?}"),
        }
    }

    #[test]
    fn classify_proposal_and_heartbeat() {
        let frames = parse_stream(concat!(
            "event: heartbeat\ndata: {}\n\n",
            "event: proposal\ndata: {\"id\":\"p1\",\"status\":\"pending\",",
            "\"command\":\"doc.removeMany\",\"actor\":{\"kind\":\"agent\",\"id\":\"opencode\"}}\n\n"
        ));
        assert_eq!(frames.len(), 2);
        assert_eq!(classify_frame(&frames[0]), None, "heartbeat is noise");
        match classify_frame(&frames[1]) {
            Some(BusFrame::Proposal(proposal)) => {
                assert_eq!(proposal.status, "pending");
                assert_eq!(proposal.actor_kind, "agent");
                assert_eq!(proposal.command, "doc.removeMany");
            }
            other => panic!("expected a proposal frame, got {other:?}"),
        }
    }

    #[test]
    fn classify_survives_garbage_and_missing_actor() {
        assert_eq!(
            classify_frame(&SseFrame {
                event: "command".into(),
                data: "not json".into()
            }),
            None
        );
        assert!(
            classify_frame(&SseFrame {
                event: "command".into(),
                data: "{}".into()
            })
            .is_some()
        );
    }

    #[test]
    fn pending_delta_counts_open_and_resolved() {
        assert_eq!(pending_delta("pending"), 1);
        assert_eq!(pending_delta("accepted"), -1);
        assert_eq!(pending_delta("rejected"), -1);
        assert_eq!(pending_delta("applied"), 0);
    }

    // --- registry ------------------------------------------------------------

    fn record() -> RunningAppRecord {
        RunningAppRecord {
            id: "nucleus.notes".into(),
            name: "Notes".into(),
            port: Some(60012),
            token: Some("t0k".into()),
            pid: Some(4242),
            started_at: "2026-10-19T08:00:00Z".into(),
        }
    }

    #[test]
    fn registry_roundtrip_uses_camel_case() {
        let json = serialize_registry(&[record()]);
        assert!(json.contains("\"startedAt\": \"2026-10-19T08:00:00Z\""));
        assert_eq!(parse_registry(&json), vec![record()]);
    }

    #[test]
    fn registry_corrupt_file_is_self_healing() {
        assert!(parse_registry("garbage{{").is_empty());
        assert_eq!(serialize_registry(&[]), "[]\n");
    }

    // --- iso8601 -------------------------------------------------------------

    #[test]
    fn iso8601_anchors() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(iso8601(1_767_225_600), "2026-01-01T00:00:00Z");
    }

    #[test]
    fn iso8601_leap_day_and_year_rollover() {
        // 2024-02-29 23:00 UTC = 1709247600 (Jan 1 = 1704067200 + 31 d + 28 d +
        // 23 h — the 29th exists in 2024, a leap year)
        assert_eq!(iso8601(1_709_247_600), "2024-02-29T23:00:00Z");
    }
}
