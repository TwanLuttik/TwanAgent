//! Claude Messages wire format. Auth, the model catalog, and the HTTP call stay with the caller.
//! MiniMax sends the same shape, so it builds on `to_messages_body` and `parse_sse_data`.

use serde_json::Value;

pub const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const KEY_REJECTED: &str = "Anthropic rejected the API key.";

/// One picker row: id, display name, context window, output cap, effort ids.
const CLAUDE_MODELS: &[(&str, &str, u64, u32, &[&str])] = &[
    ("claude-fable-5-1", "Claude Fable 5.1", 1_000_000, 128_000, &["low", "medium", "high", "xhigh", "max"]),
    ("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 128_000, &["low", "medium", "high", "xhigh", "max"]),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, 128_000, &["low", "medium", "high", "xhigh", "max"]),
    ("claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000, 128_000, &["low", "medium", "high"]),
    ("claude-opus-4-8", "Claude Opus 4.8", 1_000_000, 128_000, &["low", "medium", "high", "xhigh", "max"]),
    ("claude-opus-4-7", "Claude Opus 4.7", 1_000_000, 128_000, &["low", "medium", "high", "xhigh", "max"]),
    ("claude-opus-4-6", "Claude Opus 4.6", 1_000_000, 128_000, &["low", "medium", "high", "xhigh", "max"]),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, 64_000, &["low", "medium", "high", "xhigh", "max"]),
    ("claude-sonnet-4-5", "Claude Sonnet 4.5", 200_000, 64_000, &["low", "medium", "high", "xhigh", "max"]),
    ("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000, &["low", "medium", "high"]),
];

pub fn claude_model(id: &str) -> Option<&'static (&'static str, &'static str, u64, u32, &'static [&'static str])> {
    let id = id.trim();
    CLAUDE_MODELS.iter().find(|(row_id, ..)| *row_id == id)
}

/// A chat model id from Anthropic. Dated snapshots (`claude-sonnet-4-5-20250929`) count.
/// Grok's side-by-side tutor ids (`sxs-claude-…`) do not.
pub fn is_claude_model(id: &str) -> bool {
    let id = id.trim();
    if id.starts_with("sxs-") {
        return false;
    }
    if claude_model(id).is_some() {
        return true;
    }
    let rest = id.strip_prefix("claude-").unwrap_or("");
    !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
}

/// Output cap for the Messages API. Not the context window.
pub fn max_tokens_for(id: &str) -> u32 {
    let id = id.trim();
    if let Some(row) = claude_model(id) {
        return row.3;
    }
    let family = id.strip_suffix("-latest").unwrap_or(id);
    if let Some(row) = claude_model(family) {
        return row.3;
    }
    if id.contains("haiku") && !id.contains("haiku-5") {
        64_000
    } else if is_claude_model(id) {
        128_000
    } else {
        16_000
    }
}

/// Opus and Sonnet use adaptive thinking. Haiku keeps a fixed budget.
pub fn supports_adaptive_thinking(id: &str) -> bool {
    let id = id.trim();
    is_claude_model(id) && !id.contains("haiku")
}

/// Manual thinking budget for a model that cannot use adaptive thinking.
/// Must stay below the output cap. `None` means send no thinking field.
pub fn manual_thinking_budget(id: &str, effort: Option<&str>) -> Option<u32> {
    if supports_adaptive_thinking(id) {
        return None;
    }
    let effort = effort.map(str::trim).filter(|value| !value.is_empty())?;
    let cap = max_tokens_for(id);
    let budget = match effort {
        "low" => 1_024,
        "medium" => 4_096,
        "high" | "xhigh" | "max" => 8_192,
        _ => return None,
    };
    Some(budget.min(cap.saturating_sub(1)).max(1_024).min(cap.saturating_sub(1)))
}

pub fn http_error_message(status: u16, body: &str) -> String {
    if status == 401 {
        return KEY_REJECTED.into();
    }
    format!("Anthropic error {status}: {}", body.chars().take(400).collect::<String>())
}

/// OpenAI-shaped chat messages become a Messages API body. No I/O.
pub fn to_messages_body(messages: &Value, model: &str, effort: Option<&str>, tools: &Value) -> Value {
    let rows = messages.as_array().cloned().unwrap_or_default();
    let mut system = String::new();
    let mut out: Vec<Value> = Vec::new();
    for msg in rows {
        let role = msg.get("role").and_then(|item| item.as_str()).unwrap_or("");
        if role == "system" {
            let text = content_string(msg.get("content"));
            if text.is_empty() {
                continue;
            }
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(&text);
            continue;
        }
        if role == "tool" {
            let block = serde_json::json!({
                "type": "tool_result",
                "tool_use_id": msg.get("tool_call_id").and_then(|item| item.as_str()).unwrap_or(""),
                "content": content_string(msg.get("content")),
            });
            if let Some(last) = out.last_mut() {
                if last.get("role").and_then(|item| item.as_str()) == Some("user") {
                    if let Some(content) = last.get_mut("content").and_then(|item| item.as_array_mut()) {
                        content.push(block);
                        continue;
                    }
                }
            }
            out.push(serde_json::json!({ "role": "user", "content": [block] }));
            continue;
        }
        if role == "assistant" {
            let mut blocks = Vec::new();
            blocks.extend(replay_thinking(msg.get("thinking")));
            let text = content_string(msg.get("content"));
            if !text.trim().is_empty() {
                blocks.push(serde_json::json!({ "type": "text", "text": text }));
            }
            if let Some(calls) = msg.get("tool_calls").and_then(|item| item.as_array()) {
                for call in calls {
                    let (name, arguments) = tool_call_fields(call);
                    if name.is_empty() {
                        continue;
                    }
                    blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": call.get("id").and_then(|item| item.as_str()).unwrap_or(""),
                        "name": name,
                        "input": tool_input(&arguments),
                    }));
                }
            }
            if blocks.is_empty() {
                continue;
            }
            out.push(serde_json::json!({ "role": "assistant", "content": blocks }));
            continue;
        }
        let blocks = user_blocks(msg.get("content"));
        if blocks.is_empty() {
            continue;
        }
        out.push(serde_json::json!({ "role": "user", "content": blocks }));
    }
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens_for(model),
        "stream": true,
        "messages": out,
        "tools": reshape_tools(tools),
        "tool_choice": { "type": "auto" },
    });
    if supports_adaptive_thinking(model) {
        body["thinking"] = serde_json::json!({ "type": "adaptive" });
    } else if let Some(budget) = manual_thinking_budget(model, effort) {
        body["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": budget });
    }
    if !system.is_empty() {
        body["system"] = Value::String(system);
    }
    if supports_adaptive_thinking(model) {
        if let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) {
            body["output_config"] = serde_json::json!({ "effort": effort });
        }
    }
    body
}

/// Desktop transcripts nest the call under `function`. The server stores `name` and `arguments` flat.
fn tool_call_fields(call: &Value) -> (String, String) {
    if let Some(function) = call.get("function") {
        let name = function.get("name").and_then(|item| item.as_str()).unwrap_or("");
        if !name.is_empty() {
            let arguments = function.get("arguments").and_then(|item| item.as_str()).unwrap_or("");
            return (name.to_string(), arguments.to_string());
        }
    }
    let name = call.get("name").and_then(|item| item.as_str()).unwrap_or("");
    let arguments = call.get("arguments").and_then(|item| item.as_str()).unwrap_or("");
    (name.to_string(), arguments.to_string())
}

fn replay_thinking(value: Option<&Value>) -> Vec<Value> {
    let Some(rows) = value.and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|block| {
            let kind = block.get("type").and_then(|item| item.as_str()).unwrap_or("");
            match kind {
                "thinking" => {
                    let signature = block.get("signature").and_then(|item| item.as_str()).unwrap_or("");
                    if signature.is_empty() {
                        return None;
                    }
                    Some(serde_json::json!({
                        "type": "thinking",
                        "thinking": block.get("thinking").and_then(|item| item.as_str()).unwrap_or(""),
                        "signature": signature,
                    }))
                }
                "redacted_thinking" => {
                    let data = block.get("data").and_then(|item| item.as_str()).unwrap_or("");
                    if data.is_empty() {
                        return None;
                    }
                    Some(serde_json::json!({ "type": "redacted_thinking", "data": data }))
                }
                _ => None,
            }
        })
        .collect()
}

pub fn reshape_tools(tools: &Value) -> Vec<Value> {
    let Some(rows) = tools.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|tool| {
            let function = tool.get("function").unwrap_or(tool);
            let name = function.get("name").and_then(|item| item.as_str())?;
            if name.is_empty() {
                return None;
            }
            let mut row = serde_json::json!({
                "name": name,
                "input_schema": function.get("parameters").cloned().unwrap_or_else(|| serde_json::json!({
                    "type": "object",
                    "properties": {}
                })),
            });
            if let Some(description) = function.get("description").and_then(|item| item.as_str()) {
                if !description.is_empty() {
                    row["description"] = Value::String(description.to_string());
                }
            }
            Some(row)
        })
        .collect()
}

fn content_string(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if value.is_null() {
        return String::new();
    }
    let Some(parts) = value.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for part in parts {
        if let Some(text) = part.as_str() {
            out.push_str(text);
            continue;
        }
        if part.get("type").and_then(|item| item.as_str()) == Some("text") {
            if let Some(text) = part.get("text").and_then(|item| item.as_str()) {
                out.push_str(text);
            }
        }
    }
    out
}

fn user_blocks(value: Option<&Value>) -> Vec<Value> {
    let Some(value) = value else {
        return Vec::new();
    };
    if let Some(text) = value.as_str() {
        if text.is_empty() {
            return Vec::new();
        }
        return vec![serde_json::json!({ "type": "text", "text": text })];
    }
    let Some(parts) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for part in parts {
        let kind = part.get("type").and_then(|item| item.as_str()).unwrap_or("");
        if kind == "text" {
            if let Some(text) = part.get("text").and_then(|item| item.as_str()) {
                if !text.is_empty() {
                    out.push(serde_json::json!({ "type": "text", "text": text }));
                }
            }
            continue;
        }
        if kind == "image_url" {
            let url = part
                .get("image_url")
                .and_then(|item| item.get("url"))
                .and_then(|item| item.as_str())
                .unwrap_or("");
            if let Some(image) = image_block(url) {
                out.push(image);
            }
        }
    }
    out
}

fn image_block(url: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if !meta.contains(";base64") || data.is_empty() {
        return None;
    }
    let media_type = meta.split(';').next().unwrap_or("").trim();
    if media_type.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data }
    }))
}

fn tool_input(arguments: &str) -> Value {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return serde_json::json!({});
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) if value.is_object() => value,
        _ => serde_json::json!({ "raw": arguments }),
    }
}

/// One Anthropic SSE event, after the `data:` prefix. Event names are ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseEvent {
    Delta(String),
    Reasoning(String),
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
    },
    ToolStart { index: u32, id: String, name: String },
    ToolDelta { index: u32, partial: String },
    ThinkingStart { index: u32 },
    RedactedThinking { index: u32, data: String },
    ThinkingSignature { index: u32, signature: String },
    Stop,
}

/// One Anthropic SSE `data:` payload. `None` when the line carries nothing to apply.
pub fn parse_sse_data(data: &str) -> Option<SseEvent> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let json: Value = serde_json::from_str(data).ok()?;
    match json.get("type").and_then(|item| item.as_str())? {
        "content_block_start" => {
            let index = json.get("index").and_then(|item| item.as_u64()).unwrap_or(0) as u32;
            let block = json.get("content_block")?;
            match block.get("type").and_then(|item| item.as_str())? {
                "tool_use" => Some(SseEvent::ToolStart {
                    index,
                    id: block.get("id").and_then(|item| item.as_str()).unwrap_or("").to_string(),
                    name: block.get("name").and_then(|item| item.as_str()).unwrap_or("").to_string(),
                }),
                "thinking" => Some(SseEvent::ThinkingStart { index }),
                "redacted_thinking" => Some(SseEvent::RedactedThinking {
                    index,
                    data: block.get("data").and_then(|item| item.as_str()).unwrap_or("").to_string(),
                }),
                _ => None,
            }
        }
        "content_block_delta" => {
            let index = json.get("index").and_then(|item| item.as_u64()).unwrap_or(0) as u32;
            let delta = json.get("delta")?;
            match delta.get("type").and_then(|item| item.as_str())? {
                "text_delta" => {
                    let text = delta.get("text").and_then(|item| item.as_str()).unwrap_or("");
                    if text.is_empty() { None } else { Some(SseEvent::Delta(text.to_string())) }
                }
                "thinking_delta" => {
                    let text = delta.get("thinking").and_then(|item| item.as_str()).unwrap_or("");
                    if text.is_empty() { None } else { Some(SseEvent::Reasoning(text.to_string())) }
                }
                "signature_delta" => {
                    let signature = delta.get("signature").and_then(|item| item.as_str()).unwrap_or("");
                    if signature.is_empty() {
                        None
                    } else {
                        Some(SseEvent::ThinkingSignature { index, signature: signature.to_string() })
                    }
                }
                "input_json_delta" => Some(SseEvent::ToolDelta {
                    index,
                    partial: delta.get("partial_json").and_then(|item| item.as_str()).unwrap_or("").to_string(),
                }),
                _ => None,
            }
        }
        "message_start" => usage_event(json.get("message").and_then(|message| message.get("usage"))),
        "message_delta" => usage_event(json.get("usage")),
        "message_stop" => Some(SseEvent::Stop),
        _ => None,
    }
}

fn usage_count(usage: &Value, key: &str) -> Option<u64> {
    usage.get(key).and_then(|item| item.as_u64())
}

fn usage_event(usage: Option<&Value>) -> Option<SseEvent> {
    let usage = usage?;
    let fresh = usage_count(usage, "input_tokens");
    let completion = usage_count(usage, "output_tokens");
    let cache_read = usage_count(usage, "cache_read_input_tokens");
    let cache_creation = usage_count(usage, "cache_creation_input_tokens");
    if fresh.is_none() && completion.is_none() && cache_read.is_none() && cache_creation.is_none() {
        return None;
    }
    // Cached reads and writes still occupy the window. Anthropic leaves them out of input_tokens.
    let prompt_tokens = match fresh {
        Some(fresh) => fresh.saturating_add(cache_read.unwrap_or(0)).saturating_add(cache_creation.unwrap_or(0)),
        None => u64::MAX,
    };
    Some(SseEvent::Usage {
        prompt_tokens,
        completion_tokens: completion.unwrap_or(u64::MAX),
        cache_read_tokens: cache_read.unwrap_or(u64::MAX),
        cache_creation_tokens: cache_creation.unwrap_or(u64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_accepts_dated_snapshots_and_rejects_tutor_ids() {
        assert!(is_claude_model("claude-sonnet-4-6"));
        assert!(is_claude_model(" claude-opus-4-8 "));
        assert!(is_claude_model("claude-sonnet-4-5-20250929"));
        assert!(!is_claude_model("sxs-claude-opus-4-6"));
        assert!(!is_claude_model("grok-4.6"));
        assert!(!is_claude_model(""));
        assert!(!is_claude_model("claude-"));
    }

    #[test]
    fn haiku_uses_a_fixed_budget() {
        assert!(supports_adaptive_thinking("claude-opus-4-8"));
        assert!(!supports_adaptive_thinking("claude-haiku-4-5"));
        assert_eq!(manual_thinking_budget("claude-haiku-4-5", Some("high")), Some(8_192));
        assert_eq!(manual_thinking_budget("claude-opus-4-8", Some("high")), None);
        assert_eq!(max_tokens_for("claude-sonnet-4-6"), 64_000);
        assert_eq!(max_tokens_for("claude-3-haiku-20240307"), 64_000);
    }

    #[test]
    fn flat_and_nested_tool_calls_both_become_tool_use() {
        let body = to_messages_body(
            &serde_json::json!([
                { "role": "system", "content": "You are Claude." },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{ "id": "call-1", "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" }]
                },
                { "role": "tool", "tool_call_id": "call-1", "content": "fn main() {}" }
            ]),
            "claude-sonnet-4-6",
            Some("high"),
            &serde_json::json!([{
                "type": "function",
                "function": { "name": "read_file", "description": "Read.", "parameters": { "type": "object" } }
            }]),
        );
        assert_eq!(body["system"], "You are Claude.");
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["messages"][0]["content"][0]["name"], "read_file");
        assert_eq!(body["messages"][0]["content"][0]["input"]["path"], "a.rs");
        assert_eq!(body["messages"][1]["content"][0]["type"], "tool_result");
        assert_eq!(body["tools"][0]["name"], "read_file");
        assert!(body["tools"][0].get("function").is_none());
    }

    #[test]
    fn sse_reads_text_and_a_tool() {
        let text = parse_sse_data(r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}"#);
        assert_eq!(text, Some(SseEvent::Delta("Hi".into())));
        let tool = parse_sse_data(
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"read_file"}}"#,
        );
        assert!(matches!(tool, Some(SseEvent::ToolStart { name, .. }) if name == "read_file"));
        assert!(parse_sse_data("[DONE]").is_none());
        assert_eq!(parse_sse_data(r#"{"type":"message_stop"}"#), Some(SseEvent::Stop));
    }
}
