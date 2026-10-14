//! Claude round for a hosted turn. The body and the SSE events come from `crate::providers::anthropic`.

use super::{failed, read_sse, OpenRound, Round};
use crate::error::{Error, Result};
use crate::providers::anthropic::{self, SseEvent};

pub(super) fn round(
    client: &reqwest::blocking::Client,
    token: &str,
    model: &str,
    effort: &str,
    messages: &serde_json::Value,
    tools: &serde_json::Value,
    on_delta: &mut dyn FnMut(&str),
) -> Result<Round> {
    let effort = effort.trim();
    let effort = if effort.is_empty() { None } else { Some(effort) };
    let body = anthropic::to_messages_body(messages, model, effort, tools);
    let response = client
        .post(anthropic::MESSAGES_URL)
        .header("x-api-key", token)
        .header("anthropic-version", anthropic::ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|err| Error::Other(format!("Anthropic request failed: {err}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Ok(failed("Anthropic", status, &text));
    }
    read_sse(response, on_delta, apply_line)
}

pub(super) fn apply_line(data: &str, open: &mut OpenRound) {
    let Some(event) = anthropic::parse_sse_data(data) else {
        return;
    };
    match event {
        SseEvent::Delta(text) => open.push_text(&text),
        SseEvent::ToolStart { index, id, name } => {
            let row = open.tool_block(index as usize);
            if !id.is_empty() {
                row.id = id;
            }
            if !name.is_empty() {
                row.name = name;
            }
        }
        SseEvent::ToolDelta { index, partial } => {
            open.tool_block(index as usize).arguments.push_str(&partial);
        }
        SseEvent::Stop => open.stop = true,
        SseEvent::Reasoning(_)
        | SseEvent::Usage { .. }
        | SseEvent::ThinkingStart { .. }
        | SseEvent::RedactedThinking { .. }
        | SseEvent::ThinkingSignature { .. } => {}
    }
}
