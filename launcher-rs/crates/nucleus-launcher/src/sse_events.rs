//! The Bus subscriber: one thread per running server app, reading its
//! `/api/events` SSE stream (M2) and forwarding classified frames into the
//! engine's event channel. Read-only and best-effort: it dies with the app's
//! TCP connection and never resurrects the app.

use std::io::{BufRead, BufReader};
use std::sync::mpsc::Sender;

use nucleus_launcher_core::bus::{BusFrame, SseParser, classify_frame};

use crate::runtime::Event;

/// Spawn the per-app thread. `id`/`token` come from the engine's launch
/// bookkeeping; frames come back as [`Event::Command`] / [`Event::Proposal`].
pub fn spawn(app_id: String, port: u16, token: String, tx: Sender<Event>) {
    std::thread::spawn(move || run(app_id, port, token, tx));
}

fn run(app_id: String, port: u16, token: String, tx: Sender<Event>) {
    let url = format!("http://127.0.0.1:{port}/api/events");
    let auth = format!("Bearer {token}");
    let Ok(response) = ureq::get(&url)
        .set("Authorization", &auth)
        .set("accept", "text/event-stream")
        .call()
    else {
        return; // app died before answering; nothing to report
    };
    let reader = response.into_reader();
    let mut lines = BufReader::new(reader).lines();
    let mut parser = SseParser::new();
    while let Some(Ok(line)) = lines.next() {
        let Some(frame) = parser.feed_line(&line) else {
            continue;
        };
        match classify_frame(&frame) {
            Some(BusFrame::Command(command)) => {
                let _ = tx.send(Event::Command {
                    app: app_id.clone(),
                    seq: command.seq,
                    ts: command.ts,
                    actor_kind: command.actor_kind,
                    actor_id: command.actor_id,
                    command: command.command,
                    label: command.label.unwrap_or_default(),
                });
            }
            Some(BusFrame::Proposal(proposal)) => {
                let _ = tx.send(Event::Proposal {
                    app: app_id.clone(),
                    actor_kind: proposal.actor_kind,
                    actor_id: proposal.actor_id,
                    command: proposal.command,
                    status: proposal.status,
                });
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::time::{Duration, Instant};

    use super::*;

    /// A fake app-kit: answers one HTTP request with an SSE stream holding a
    /// command, a proposal and a heartbeat. Verifies the reader honours the
    /// bearer, classifies frames and drops noise.
    #[test]
    fn subscriber_turns_sse_into_events() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("ephemeral port");
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0u8; 4096];
            let read = stream.read(&mut request).expect("read request");
            assert!(
                String::from_utf8_lossy(&request[..read]).contains("Bearer bus-test-token"),
                "the subscriber must send the app's bearer token"
            );
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
                      event: command\ndata: {\"seq\":1,\"ts\":\"2026-10-19T10:00:00.000Z\",\"actor\":{\"kind\":\"human\",\"id\":\"you\"},\"command\":\"doc.addNode\"}\n\n\
                      event: proposal\ndata: {\"id\":\"p1\",\"status\":\"pending\",\"command\":\"doc.removeMany\",\"actor\":{\"kind\":\"agent\",\"id\":\"opencode\"}}\n\n\
                      event: heartbeat\ndata: {}\n\n",
                )
                .expect("write stream");
            // Keep the socket open so the reader drains both frames.
            std::thread::sleep(Duration::from_millis(150));
        });

        let (tx, rx) = mpsc::channel::<Event>();
        spawn(
            "nucleus.notes".to_string(),
            port,
            "bus-test-token".to_string(),
            tx,
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut commands = Vec::new();
        let mut proposals = Vec::new();
        let mut noise = 0;
        while Instant::now() < deadline && (commands.is_empty() || proposals.is_empty()) {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Event::Command { command, .. }) => commands.push(command),
                Ok(Event::Proposal { status, .. }) => proposals.push(status),
                Ok(_) => noise += 1,
                Err(RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        assert_eq!(commands, vec!["doc.addNode".to_string()]);
        assert_eq!(proposals, vec!["pending".to_string()]);
        assert_eq!(noise, 0, "heartbeats must not surface as Bus events");
        server.join().expect("fake server thread");
    }
}
