use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use super::event::{
    apply_thinking, apply_tool, finished_thinking, finished_tools, merge_usage, StreamPiece,
    ThinkingAccum, ToolAccum,
};
use crate::dev::types::{DevChatEvent, DevChatUsage};
use crate::error::{Error, Result};

/// Hold text and reasoning this long before emitting, unless the buffer is large.
pub const COALESCE_INTERVAL: Duration = Duration::from_millis(50);
/// Flush immediately once a pending buffer reaches this many bytes.
pub const COALESCE_MAX_BYTES: usize = 2048;

pub fn http_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Append one SSE piece. Returns true when the buffer should be emitted now.
pub fn note_coalesced(pending: &mut String, piece: &str, last_emit: &mut Option<Instant>) -> bool {
    if piece.is_empty() {
        return false;
    }
    pending.push_str(piece);
    let due = match *last_emit {
        Some(at) => at.elapsed() >= COALESCE_INTERVAL,
        None => {
            *last_emit = Some(Instant::now());
            false
        }
    };
    due || pending.len() >= COALESCE_MAX_BYTES
}

fn split_progress(text: &str) -> Vec<String> {
    const PIECE: usize = 24;
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let mut end = rest.len().min(PIECE);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 {
            end = rest.len();
        }
        out.push(rest[..end].to_string());
        rest = &rest[end..];
    }
    out
}

pub fn take_coalesced(pending: &mut String) -> Option<String> {
    if pending.is_empty() {
        None
    } else {
        Some(std::mem::take(pending))
    }
}

pub struct StreamSession<'a> {
    app: &'a AppHandle,
    stream_id: &'a str,
    tools: ToolAccum,
    thinking: ThinkingAccum,
    last_usage: Option<DevChatUsage>,
    emitted_text: bool,
    emitted_reasoning: bool,
    pending_delta: String,
    pending_reasoning: String,
    last_delta_emit: Option<Instant>,
    last_reasoning_emit: Option<Instant>,
}

impl<'a> StreamSession<'a> {
    pub fn new(app: &'a AppHandle, stream_id: &'a str) -> Self {
        Self {
            app,
            stream_id,
            tools: ToolAccum::default(),
            thinking: ThinkingAccum::default(),
            last_usage: None,
            emitted_text: false,
            emitted_reasoning: false,
            pending_delta: String::new(),
            pending_reasoning: String::new(),
            last_delta_emit: None,
            last_reasoning_emit: None,
        }
    }

    pub fn has_output(&self) -> bool {
        self.emitted_text || self.emitted_reasoning || !self.tools.rows.is_empty()
    }

    pub fn saw_text(&self) -> bool {
        self.emitted_text || !self.pending_delta.is_empty()
    }

    pub fn saw_reasoning(&self) -> bool {
        self.emitted_reasoning || !self.pending_reasoning.is_empty()
    }

    pub fn push(&mut self, piece: StreamPiece) {
        apply_tool(&mut self.tools, &piece);
        apply_thinking(&mut self.thinking, &piece);
        match piece {
            StreamPiece::Delta(text) => {
                if note_coalesced(&mut self.pending_delta, &text, &mut self.last_delta_emit) {
                    self.flush_delta();
                    self.last_delta_emit = Some(Instant::now());
                }
            }
            StreamPiece::Reasoning(text) => {
                if note_coalesced(&mut self.pending_reasoning, &text, &mut self.last_reasoning_emit) {
                    self.flush_reasoning();
                    self.last_reasoning_emit = Some(Instant::now());
                }
            }
            StreamPiece::Usage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_creation_tokens,
            } => {
                let (prompt_tokens, completion_tokens) = merge_usage(
                    self.last_usage
                        .as_ref()
                        .map(|usage| (usage.prompt_tokens, usage.completion_tokens)),
                    prompt_tokens,
                    completion_tokens,
                );
                let usage = super::event::usage_event_with_cache(
                    prompt_tokens,
                    completion_tokens,
                    if cache_read_tokens == u64::MAX {
                        self.last_usage.as_ref().map(|row| row.cache_read_tokens).unwrap_or(0)
                    } else {
                        cache_read_tokens
                    },
                    if cache_creation_tokens == u64::MAX {
                        self.last_usage
                            .as_ref()
                            .map(|row| row.cache_creation_tokens)
                            .unwrap_or(0)
                    } else {
                        cache_creation_tokens
                    },
                );
                let first = self.last_usage.is_none();
                self.last_usage = Some(usage.clone());
                if first {
                    self.emit(DevChatEvent {
                        stream_id: self.stream_id.into(),
                        kind: "usage".into(),
                        text: None,
                        tool_calls: None,
                        usage: Some(usage),
                        thinking: None,
                        conversation: None,
                    });
                }
            }
            _ => {}
        }
    }

    pub fn flush(&mut self) {
        self.flush_delta();
        self.flush_reasoning();
    }

    pub fn finish(&mut self, text: Option<String>) {
        self.flush();
        let tool_calls = finished_tools(&self.tools);
        let thinking = finished_thinking(&self.thinking);
        self.emit(DevChatEvent {
            stream_id: self.stream_id.into(),
            kind: "done".into(),
            text,
            tool_calls: if tool_calls.is_empty() { None } else { Some(tool_calls) },
            usage: self.last_usage.clone(),
            thinking: if thinking.is_empty() { None } else { Some(thinking) },
            conversation: None,
        });
    }

    fn flush_delta(&mut self) {
        let Some(text) = take_coalesced(&mut self.pending_delta) else {
            return;
        };
        self.emitted_text = true;
        // The coalesced buffer is one paint. The local turn wants each piece so a
        // reloaded window can append it instead of replacing the reply.
        for piece in split_progress(&text) {
            crate::dev::chat::note_round_piece(self.stream_id, "delta", &piece);
        }
        self.emit(DevChatEvent {
            stream_id: self.stream_id.into(),
            kind: "delta".into(),
            text: Some(text),
            tool_calls: None,
            usage: None,
            thinking: None,
            conversation: None,
        });
    }

    fn flush_reasoning(&mut self) {
        let Some(text) = take_coalesced(&mut self.pending_reasoning) else {
            return;
        };
        self.emitted_reasoning = true;
        for piece in split_progress(&text) {
            crate::dev::chat::note_round_piece(self.stream_id, "reasoning", &piece);
        }
        self.emit(DevChatEvent {
            stream_id: self.stream_id.into(),
            kind: "reasoning".into(),
            text: Some(text),
            tool_calls: None,
            usage: None,
            thinking: None,
            conversation: None,
        });
    }

    fn emit(&self, event: DevChatEvent) {
        if event.kind != "delta" && event.kind != "reasoning" {
            crate::dev::chat::publish_round_event(&event);
        }
        let _ = self.app.emit("dev-chat", event);
    }
}

/// Drive one HTTP stream. `parse` turns each `data:` payload into zero or more pieces.
/// A decode error after any output finishes the turn instead of failing it.
pub async fn consume_sse(
    app: &AppHandle,
    stream_id: &str,
    resp: reqwest::Response,
    cancel: Arc<AtomicBool>,
    mut parse: impl FnMut(&str) -> Vec<StreamPiece>,
    mut on_stop_text: impl FnMut(&StreamSession) -> Option<String>,
) -> Result<()> {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut session = StreamSession::new(app, stream_id);
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            session.flush();
            let _ = app.emit(
                "dev-chat",
                DevChatEvent {
                    stream_id: stream_id.into(),
                    kind: "error".into(),
                    text: Some("Stopped.".into()),
                    tool_calls: None,
                    usage: None,
                    thinking: None,
                    conversation: None,
                },
            );
            return Ok(());
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                session.flush();
                if session.has_output() {
                    session.finish(on_stop_text(&session));
                    return Ok(());
                }
                return Err(Error::Other(format!("error decoding response body: {err}")));
            }
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..=idx);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                session.finish(on_stop_text(&session));
                return Ok(());
            }
            let mut stop = false;
            for piece in parse(data) {
                if matches!(piece, StreamPiece::Stop) {
                    stop = true;
                    continue;
                }
                session.push(piece);
            }
            if stop {
                session.finish(on_stop_text(&session));
                return Ok(());
            }
        }
    }
    session.flush();
    if session.has_output() {
        session.finish(on_stop_text(&session));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rapid_pieces_stay_buffered_until_the_interval_elapses() {
        let mut pending = String::new();
        let mut last = None;
        assert!(!note_coalesced(&mut pending, "Hel", &mut last));
        assert_eq!(pending, "Hel");
        assert!(last.is_some());
        assert!(!note_coalesced(&mut pending, "lo", &mut last));
        assert_eq!(pending, "Hello");
    }

    #[test]
    fn piece_after_the_interval_flushes_the_previous_buffer() {
        let mut pending = String::new();
        let mut last = Some(Instant::now() - COALESCE_INTERVAL);
        assert!(note_coalesced(&mut pending, "lo", &mut last));
        assert_eq!(pending, "lo");
    }

    #[test]
    fn large_buffer_flushes_immediately() {
        let mut pending = "x".repeat(COALESCE_MAX_BYTES - 1);
        let mut last = None;
        assert!(!note_coalesced(&mut pending, "", &mut last));
        assert!(last.is_none());
        assert!(note_coalesced(&mut pending, "yy", &mut last));
        assert!(pending.len() >= COALESCE_MAX_BYTES);
    }

    #[test]
    fn flush_now_sends_whatever_is_pending() {
        let mut pending = String::from("held");
        assert_eq!(take_coalesced(&mut pending), Some("held".into()));
        assert!(pending.is_empty());
        assert_eq!(take_coalesced(&mut pending), None);
    }

    #[test]
    fn empty_pieces_do_not_flush_or_change_the_buffer() {
        let mut pending = String::from("stay");
        let mut last = Some(Instant::now() - COALESCE_INTERVAL - Duration::from_millis(10));
        let before = last;
        assert!(!note_coalesced(&mut pending, "", &mut last));
        assert_eq!(pending, "stay");
        assert_eq!(last, before);
    }
}
