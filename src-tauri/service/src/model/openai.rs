//! OpenAI round for a hosted turn. The body and the SSE events come from `crate::providers::openai`.

use serde_json::Value;

use super::{failed, read_sse, OpenRound, Round};
use crate::error::{Error, Result};
use crate::providers::openai::{self, SseEvent};

pub(super) fn round(
    client: &reqwest::blocking::Client,
    token: &str,
    model: &str,
    effort: &str,
    service_tier: &str,
    messages: &Value,
    tools: &Value,
    on_delta: &mut dyn FnMut(&str),
) -> Result<Round> {
    let effort = effort.trim();
    let effort = if effort.is_empty() {
        None
    } else {
        Some(effort)
    };
    let mut body = openai::to_responses_body(messages, model, effort, tools);
    if let Some(tier) = openai::service_tier_for(model, service_tier) {
        body["service_tier"] = Value::String(tier.to_string());
    }
    let response = client
        .post(openai::RESPONSES_URL)
        .bearer_auth(token)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&body)
        .send()
        .map_err(|err| Error::Other(format!("OpenAI request failed: {err}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Ok(failed("OpenAI", status, &text));
    }
    read_sse(response, on_delta, apply_line)
}

pub(super) fn apply_line(data: &str, open: &mut OpenRound) {
    for event in openai::parse_sse_data_with(data, &mut open.sse) {
        match event {
            SseEvent::Delta(text) => open.push_text(&text),
            SseEvent::Reasoning(text) => open.push_reasoning(&text),
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
            SseEvent::Usage {
                prompt_tokens,
                completion_tokens,
                cache_read_tokens,
            } => {
                open.note_usage(
                    Some(prompt_tokens),
                    Some(completion_tokens),
                    Some(cache_read_tokens),
                );
            }
            SseEvent::OutputItem(item) => {
                openai::remember_output_item(&mut open.reasoning_items, &item);
            }
            SseEvent::Failed(message) => open.note_failure(message),
            SseEvent::Stop => open.stop = true,
        }
    }
}
