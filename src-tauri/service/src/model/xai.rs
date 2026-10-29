//! xAI round for a hosted turn. The body and the delta shape come from `crate::providers::xai`.

use serde_json::Value;

use super::{failed, read_sse, OpenRound, Round};
use crate::error::{Error, Result};
use crate::providers::xai::{self, ToolFragment};

pub(super) fn round(
    client: &reqwest::blocking::Client,
    token: &str,
    model: &str,
    effort: &str,
    messages: &Value,
    tools: &Value,
    on_delta: &mut dyn FnMut(&str),
) -> Result<Round> {
    let body = xai::chat_body(model, Some(effort), messages, tools);
    let response = client
        .post(xai::endpoint(false))
        .bearer_auth(token)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|err| Error::Other(format!("xAI request failed: {err}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Ok(failed("xAI", status, &text));
    }
    read_sse(response, on_delta, apply_line)
}

fn apply_line(data: &str, open: &mut OpenRound) {
    let Ok(json) = serde_json::from_str::<Value>(data) else {
        return;
    };
    if let Some(message) = xai::stream_error_message(&json) {
        open.note_failure(message);
        return;
    }
    if let Some(usage) = xai::parse_usage(&json) {
        open.note_usage(
            Some(usage.prompt_tokens),
            Some(usage.completion_tokens),
            Some(usage.cache_read_tokens),
        );
    }
    let Some(choice) = json.get("choices").and_then(|rows| rows.get(0)) else {
        return;
    };
    let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
    open.push_reasoning(&xai::reasoning_from_delta(&delta));
    open.push_text(&xai::text_from_content(delta.get("content").unwrap_or(&Value::Null)));
    for fragment in xai::tool_fragments(&delta) {
        apply_fragment(open, fragment);
    }
    // The last chunk sometimes carries the reply on `message` and leaves `delta` empty.
    let finished = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .is_some_and(|reason| !reason.is_empty());
    if finished {
        if open.text.trim().is_empty() {
            open.push_text(&xai::fallback_choice_text(choice));
        }
        if open.reasoning.trim().is_empty() {
            open.push_reasoning(&xai::message_reasoning(choice));
        }
        if open.calls.iter().all(|call| call.name.is_empty()) {
            for fragment in xai::message_tool_calls(choice) {
                apply_fragment(open, fragment);
            }
        }
    }
    if let Some(message) = xai::choice_stop_error(choice) {
        open.note_failure(message.to_string());
    }
}

fn apply_fragment(open: &mut OpenRound, fragment: ToolFragment) {
    let row = open.ensure_call(fragment.index as usize);
    if !fragment.id.is_empty() {
        row.id = fragment.id;
    }
    if !fragment.name.is_empty() {
        row.name = fragment.name;
    }
    row.arguments.push_str(&fragment.arguments);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deltas_and_tool_calls_accumulate() {
        let mut open = OpenRound::default();
        apply_line(r#"{"choices":[{"delta":{"content":"Hi"}}]}"#, &mut open);
        apply_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}"#,
            &mut open,
        );
        apply_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.rs\"}"}}]}}]}"#,
            &mut open,
        );
        assert_eq!(open.take_delta().as_deref(), Some("Hi"));
        let done = open.finish();
        assert_eq!(done.text, "Hi");
        assert_eq!(done.tool_calls[0].name, "read_file");
        assert_eq!(done.tool_calls[0].arguments, r#"{"path":"a.rs"}"#);
    }

    #[test]
    fn a_final_message_tool_call_is_not_dropped() {
        let mut open = OpenRound::default();
        apply_line(
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls","message":{"content":null,"tool_calls":[{"id":"call-1","function":{"name":"read_file","arguments":"{\"path\":\"a.ts\"}"}}]}}]}"#,
            &mut open,
        );
        let done = open.finish();
        assert!(done.error.is_none());
        assert_eq!(done.tool_calls.len(), 1);
        assert_eq!(done.tool_calls[0].name, "read_file");
        assert_eq!(done.tool_calls[0].arguments, r#"{"path":"a.ts"}"#);
    }

    #[test]
    fn a_stream_error_fails_an_empty_round() {
        let mut open = OpenRound::default();
        apply_line(r#"{"error":{"message":"overloaded"}}"#, &mut open);
        let done = open.finish();
        assert_eq!(done.error.as_deref(), Some("xAI request failed: overloaded"));
        assert!(done.text.is_empty());
    }
}
