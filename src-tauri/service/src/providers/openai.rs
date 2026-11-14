use std::collections::HashSet;

use serde_json::Value;

pub const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
pub const KEY_REJECTED: &str = "OpenAI rejected the API key.";
pub const MAX_OUTPUT_TOKENS: u32 = 128_000;
/// Input cap. The model window is larger; trimming to this stays inside the request limit.
pub const INPUT_CAP: u64 = 922_000;

/// One picker row: id, display name, input cap used for trimming, output cap, effort ids.
const OPENAI_MODELS: &[(&str, &str, u64, u32, &[&str])] = &[
    (
        "gpt-6-astra",
        "GPT-6 Astra",
        INPUT_CAP,
        MAX_OUTPUT_TOKENS,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "gpt-6.1-sol",
        "GPT-6.1 Sol",
        INPUT_CAP,
        MAX_OUTPUT_TOKENS,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "gpt-6.1-terra",
        "GPT-6.1 Terra",
        INPUT_CAP,
        MAX_OUTPUT_TOKENS,
        &["none", "low", "medium", "high", "xhigh", "max"],
    ),
    (
        "gpt-6-luna",
        "GPT-6 Luna",
        INPUT_CAP,
        MAX_OUTPUT_TOKENS,
        &["none", "low", "medium", "high", "xhigh", "max"],
    ),
];

pub fn catalog() -> &'static [(
    &'static str,
    &'static str,
    u64,
    u32,
    &'static [&'static str],
)] {
    OPENAI_MODELS
}

pub fn is_openai_model(id: &str) -> bool {
    let Some(rest) = id.trim().strip_prefix("gpt-") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
}

/// Composer speed choice to the Responses `service_tier`.
/// Standard is `default`. Ultrafast is only Astra and Sol, so other models drop to Fast.
pub fn service_tier_for(model: &str, choice: &str) -> Option<&'static str> {
    let tier = match choice.trim() {
        "standard" | "default" => "default",
        "flex" => "flex",
        "fast" | "priority" => "fast",
        "ultrafast" => "ultrafast",
        _ => return None,
    };
    if tier == "ultrafast" && !matches!(model.trim(), "gpt-6-astra" | "gpt-6.1-sol") {
        return Some("fast");
    }
    Some(tier)
}

/// `none` is a real effort only on Terra and Luna. Astra and Sol have no such level.
fn allows_none(model: &str) -> bool {
    matches!(model.trim(), "gpt-6.1-terra" | "gpt-6-luna")
}

fn wire_effort(model: &str, effort: Option<&str>) -> Option<String> {
    let effort = effort.map(str::trim).filter(|value| !value.is_empty())?;
    if effort == "none" && !allows_none(model) {
        return Some("low".into());
    }
    Some(effort.to_string())
}

pub fn http_error_message(status: u16, body: &str) -> String {
    if status == 401 {
        return KEY_REJECTED.into();
    }
    format!(
        "OpenAI error {status}: {}",
        body.chars().take(400).collect::<String>()
    )
}

pub fn to_responses_body(
    messages: &Value,
    model: &str,
    effort: Option<&str>,
    tools: &Value,
) -> Value {
    let rows = messages.as_array().cloned().unwrap_or_default();
    let mut instructions = String::new();
    let mut input: Vec<Value> = Vec::new();
    for msg in rows {
        let role = msg.get("role").and_then(|item| item.as_str()).unwrap_or("");
        if role == "system" {
            let text = content_string(msg.get("content"));
            if text.is_empty() {
                continue;
            }
            if !instructions.is_empty() {
                instructions.push_str("\n\n");
            }
            instructions.push_str(&text);
            continue;
        }
        if role == "tool" {
            input.push(serde_json::json!({
                "type": "function_call_output",
                "call_id": msg.get("tool_call_id").and_then(|item| item.as_str()).unwrap_or(""),
                "output": content_string(msg.get("content")),
            }));
            continue;
        }
        if role == "assistant" {
            push_assistant(&mut input, &msg);
            continue;
        }
        push_user(&mut input, &msg);
    }
    let mut body = serde_json::json!({
        "model": model.trim(),
        "store": false,
        "stream": true,
        "input": input,
        "tools": reshape_tools(tools),
        "tool_choice": "auto",
        "max_output_tokens": MAX_OUTPUT_TOKENS,
    });
    if !instructions.is_empty() {
        body["instructions"] = Value::String(instructions);
    }
    let mut reasoning = serde_json::json!({ "summary": "auto" });
    if let Some(effort) = wire_effort(model, effort) {
        reasoning["effort"] = Value::String(effort);
    }
    body["reasoning"] = reasoning;
    body
}

fn push_assistant(input: &mut Vec<Value>, msg: &Value) {
    if let Some(rows) = msg.get("reasoning_items").and_then(|item| item.as_array()) {
        // Stored output order. A reasoning item has to stay next to the item that followed it.
        // Stop after the last message or function call. Reasoning after that has no partner.
        let end = rows
            .iter()
            .rposition(|item| {
                matches!(
                    item.get("type").and_then(|value| value.as_str()),
                    Some("message" | "function_call")
                )
            })
            .map(|index| index + 1);
        if let Some(end) = end {
            input.extend(rows[..end].iter().cloned());
            return;
        }
    }
    let text = content_string(msg.get("content"));
    let calls = msg.get("tool_calls").and_then(|item| item.as_array());
    let has_text = !text.trim().is_empty();
    let has_call =
        calls.is_some_and(|rows| rows.iter().any(|call| !tool_call_fields(call).0.is_empty()));
    if !has_text && !has_call {
        return;
    }
    if let Some(rows) = msg.get("reasoning_items").and_then(|item| item.as_array()) {
        for item in rows {
            let encrypted = item
                .get("encrypted_content")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if encrypted.is_empty() {
                continue;
            }
            input.push(item.clone());
        }
    }
    if has_text {
        input.push(serde_json::json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text }],
        }));
    }
    let Some(calls) = calls else {
        return;
    };
    for call in calls {
        let (name, arguments) = tool_call_fields(call);
        if name.is_empty() {
            continue;
        }
        input.push(serde_json::json!({
            "type": "function_call",
            "call_id": call.get("id").and_then(|item| item.as_str()).unwrap_or(""),
            "name": name,
            "arguments": arguments,
        }));
    }
}

fn push_user(input: &mut Vec<Value>, msg: &Value) {
    let mut parts = Vec::new();
    match msg.get("content") {
        Some(Value::String(text)) => {
            let text = strip_image_tokens(text, msg.get("images"));
            if !text.is_empty() {
                parts.push(serde_json::json!({ "type": "input_text", "text": text }));
            }
        }
        Some(Value::Array(rows)) => {
            for part in rows {
                let kind = part
                    .get("type")
                    .and_then(|item| item.as_str())
                    .unwrap_or("");
                if kind == "text" {
                    if let Some(text) = part.get("text").and_then(|item| item.as_str()) {
                        if !text.is_empty() {
                            parts.push(serde_json::json!({ "type": "input_text", "text": text }));
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
                    push_image(&mut parts, url);
                }
            }
        }
        _ => {}
    }
    if let Some(rows) = msg.get("images").and_then(|item| item.as_array()) {
        for row in rows {
            let url = row
                .get("dataUrl")
                .and_then(|item| item.as_str())
                .unwrap_or("");
            push_image(&mut parts, url);
        }
    }
    if parts.is_empty() {
        return;
    }
    input.push(serde_json::json!({
        "type": "message",
        "role": "user",
        "content": parts,
    }));
}

fn push_image(parts: &mut Vec<Value>, url: &str) {
    let Some(url) = image_data_url(url) else {
        return;
    };
    let seen = parts
        .iter()
        .any(|part| part.get("image_url").and_then(|item| item.as_str()) == Some(url));
    if seen {
        return;
    }
    parts.push(serde_json::json!({ "type": "input_image", "image_url": url }));
}

fn image_data_url(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if data.is_empty() || !meta.contains(";base64") {
        return None;
    }
    let media = meta.split(';').next().unwrap_or("").trim();
    if !media.starts_with("image/") || media.contains("svg") {
        return None;
    }
    Some(url)
}

/// `[filename]` markers the composer inserts for an attached picture. The bytes travel separately.
fn strip_image_tokens(text: &str, images: Option<&Value>) -> String {
    let Some(rows) = images.and_then(|item| item.as_array()) else {
        return text.to_string();
    };
    if rows.is_empty() || !text.contains('[') {
        return text.to_string();
    }
    let mut labels = Vec::new();
    for row in rows {
        let name = row
            .get("name")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .trim();
        let label = name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(name)
            .trim()
            .replace(['[', ']', '\r', '\n'], "");
        let label = label.trim();
        if !label.is_empty() {
            labels.push(label.to_string());
        }
    }
    if labels.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();
    for label in labels {
        let token = format!("[{label}]");
        if out.contains(&token) {
            out = out.replace(&token, " ");
        }
    }
    let mut collapsed = String::new();
    let mut spaced = false;
    let mut line_start = true;
    for ch in out.chars() {
        if ch == '\n' {
            while collapsed.ends_with(' ') {
                collapsed.pop();
            }
            collapsed.push('\n');
            spaced = false;
            line_start = true;
            continue;
        }
        if ch.is_whitespace() {
            if !line_start {
                spaced = true;
            }
            continue;
        }
        if spaced {
            collapsed.push(' ');
        }
        collapsed.push(ch);
        spaced = false;
        line_start = false;
    }
    while collapsed.ends_with(' ') || collapsed.ends_with('\n') {
        collapsed.pop();
    }
    collapsed
}

fn tool_call_fields(call: &Value) -> (String, String) {
    if let Some(function) = call.get("function") {
        let name = function
            .get("name")
            .and_then(|item| item.as_str())
            .unwrap_or("");
        if !name.is_empty() {
            return (name.to_string(), arguments_text(function.get("arguments")));
        }
    }
    let name = call
        .get("name")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    (name.to_string(), arguments_text(call.get("arguments")))
}

fn arguments_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => {
            if text.trim().is_empty() {
                "{}".into()
            } else {
                text.clone()
            }
        }
        Some(other) if !other.is_null() => other.to_string(),
        _ => "{}".into(),
    }
}

fn reshape_tools(tools: &Value) -> Vec<Value> {
    let Some(rows) = tools.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|tool| {
            if tool.get("type").and_then(|item| item.as_str()).is_some_and(|kind| kind != "function") {
                return None;
            }
            let function = tool.get("function").unwrap_or(tool);
            let name = function.get("name").and_then(|item| item.as_str()).filter(|name| !name.is_empty())?;
            let mut row = serde_json::json!({
                "type": "function",
                "name": name,
                "parameters": function.get("parameters").cloned().unwrap_or_else(|| serde_json::json!({
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

#[derive(Debug, Clone, PartialEq)]
pub enum SseEvent {
    Delta(String),
    Reasoning(String),
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
    },
    ToolStart {
        index: u32,
        id: String,
        name: String,
    },
    ToolDelta {
        index: u32,
        partial: String,
    },
    /// Output items to replay: a reasoning item, message, or function call, in output order.
    OutputItem(Value),
    Failed(String),
    Stop,
}

/// Summaries that already emitted text, keyed by item id (or output index) and summary index.
/// `part.done` repeats a summary that already streamed as deltas, so it is only a fallback.
#[derive(Debug, Default, Clone)]
pub struct SseState {
    seen_summaries: HashSet<(String, usize)>,
}

pub fn parse_sse_data_with(data: &str, state: &mut SseState) -> Vec<SseEvent> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Vec::new();
    }
    let Ok(json) = serde_json::from_str::<Value>(data) else {
        return Vec::new();
    };
    match json
        .get("type")
        .and_then(|item| item.as_str())
        .unwrap_or("")
    {
        "response.output_text.delta" => text_event(&json, "delta")
            .into_iter()
            .map(SseEvent::Delta)
            .collect(),
        "response.reasoning_summary_text.delta" => {
            let text = text_event(&json, "delta");
            if text.is_some() {
                state.seen_summaries.insert(summary_key(&json));
            }
            text.into_iter().map(SseEvent::Reasoning).collect()
        }
        "response.reasoning_summary_part.added" => Vec::new(),
        "response.reasoning_summary_part.done" => {
            let key = summary_key(&json);
            if state.seen_summaries.contains(&key) {
                return Vec::new();
            }
            let text = json
                .pointer("/part/text")
                .or_else(|| json.get("text"))
                .and_then(|item| item.as_str())
                .unwrap_or("");
            if text.is_empty() {
                return Vec::new();
            }
            state.seen_summaries.insert(key);
            vec![SseEvent::Reasoning(text.to_string())]
        }
        "response.output_item.added" => item_added(&json),
        "response.function_call_arguments.delta" => {
            let partial = json
                .get("delta")
                .and_then(|item| item.as_str())
                .unwrap_or("");
            vec![SseEvent::ToolDelta {
                index: output_index(&json),
                partial: partial.to_string(),
            }]
        }
        "response.output_item.done" => json.get("item").map(output_events).unwrap_or_default(),
        "response.completed" => completed(&json),
        "response.failed" | "response.error" | "error" => {
            vec![SseEvent::Failed(short_error(&json))]
        }
        _ => Vec::new(),
    }
}

fn summary_index(json: &Value) -> usize {
    json.get("summary_index")
        .and_then(|item| item.as_u64())
        .and_then(|index| usize::try_from(index).ok())
        .unwrap_or(0)
}

fn summary_key(json: &Value) -> (String, usize) {
    let owner = json
        .get("item_id")
        .and_then(|item| item.as_str())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("output:{}", output_index(json)));
    (owner, summary_index(json))
}

fn text_event(json: &Value, key: &str) -> Option<String> {
    let text = json.get(key).and_then(|item| item.as_str()).unwrap_or("");
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn output_index(json: &Value) -> u32 {
    json.get("output_index")
        .and_then(|item| item.as_u64())
        .unwrap_or(0) as u32
}

fn item_added(json: &Value) -> Vec<SseEvent> {
    let Some(item) = json.get("item") else {
        return Vec::new();
    };
    // `added` can carry a truncated reasoning ciphertext. Replay the item from `done`.
    if item.get("type").and_then(|value| value.as_str()) != Some("function_call") {
        return Vec::new();
    }
    let index = output_index(json);
    let id = item
        .get("call_id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let name = item
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let mut out = vec![SseEvent::ToolStart {
        index,
        id: id.to_string(),
        name: name.to_string(),
    }];
    let arguments = item
        .get("arguments")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !arguments.is_empty() {
        out.push(SseEvent::ToolDelta {
            index,
            partial: arguments.to_string(),
        });
    }
    out
}

fn output_events(item: &Value) -> Vec<SseEvent> {
    output_item(item).into_iter().collect()
}

fn output_item(item: &Value) -> Option<SseEvent> {
    match item.get("type").and_then(|value| value.as_str()) {
        Some("message" | "function_call") => Some(SseEvent::OutputItem(item.clone())),
        Some("reasoning") => encrypted_reasoning(item),
        _ => None,
    }
}

fn encrypted_reasoning(item: &Value) -> Option<SseEvent> {
    if item.get("type").and_then(|value| value.as_str()) != Some("reasoning") {
        return None;
    }
    let encrypted = item
        .get("encrypted_content")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if encrypted.is_empty() {
        None
    } else {
        Some(SseEvent::OutputItem(item.clone()))
    }
}

fn completed(json: &Value) -> Vec<SseEvent> {
    let mut out = Vec::new();
    if let Some(response) = json.get("response") {
        if let Some(usage) = usage_event(response.get("usage")) {
            out.push(usage);
        }
        if let Some(rows) = response.get("output").and_then(|item| item.as_array()) {
            for item in rows {
                out.extend(output_events(item));
            }
        }
    }
    out.push(SseEvent::Stop);
    out
}

fn usage_event(usage: Option<&Value>) -> Option<SseEvent> {
    let usage = usage?;
    let prompt = usage.get("input_tokens").and_then(|item| item.as_u64())?;
    let completion = usage
        .get("output_tokens")
        .and_then(|item| item.as_u64())
        .unwrap_or(0);
    let cached = usage
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(|item| item.as_u64())
        .unwrap_or(0);
    Some(SseEvent::Usage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        cache_read_tokens: cached,
    })
}

fn short_error(json: &Value) -> String {
    let message = json
        .get("message")
        .and_then(|item| item.as_str())
        .or_else(|| {
            json.pointer("/error/message")
                .and_then(|item| item.as_str())
        })
        .or_else(|| {
            json.pointer("/response/error/message")
                .and_then(|item| item.as_str())
        })
        .unwrap_or("OpenAI request failed.");
    message.chars().take(400).collect()
}

/// One reasoning item per id. A later copy replaces the stored ciphertext.
pub fn remember_reasoning_item(items: &mut Vec<Value>, item: &Value) -> bool {
    let encrypted = item
        .get("encrypted_content")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if encrypted.is_empty() {
        return false;
    }
    let id = item
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !id.is_empty() {
        if let Some(row) = items
            .iter_mut()
            .find(|row| row.get("id").and_then(|value| value.as_str()) == Some(id))
        {
            if row == item {
                return false;
            }
            *row = item.clone();
            return true;
        }
    }
    let seen = items.iter().any(|row| {
        row.get("encrypted_content")
            .and_then(|value| value.as_str())
            == Some(encrypted)
    });
    if seen {
        return false;
    }
    items.push(item.clone());
    true
}

/// Keep output items in arrival order. A later message or function call with the same id is dropped.
pub fn remember_output_item(items: &mut Vec<Value>, item: &Value) -> bool {
    match item
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("")
    {
        "reasoning" => remember_reasoning_item(items, item),
        "message" | "function_call" => {
            if output_seen(items, item) {
                return false;
            }
            items.push(item.clone());
            true
        }
        _ => false,
    }
}

fn output_seen(items: &[Value], item: &Value) -> bool {
    let id = item
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !id.is_empty() {
        return items
            .iter()
            .any(|row| row.get("id").and_then(|value| value.as_str()) == Some(id));
    }
    let call_id = item
        .get("call_id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if call_id.is_empty() {
        return false;
    }
    items
        .iter()
        .any(|row| row.get("call_id").and_then(|value| value.as_str()) == Some(call_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_claims_gpt_ids_and_rejects_an_empty_prefix() {
        assert_eq!(catalog().len(), 4);
        assert_eq!(catalog()[1].0, "gpt-6.1-sol");
        assert!(is_openai_model("gpt-6.1-sol"));
        assert!(is_openai_model(" gpt-6-astra "));
        assert!(is_openai_model("gpt-6.1-terra"));
        assert!(is_openai_model("gpt-6-luna"));
        assert!(is_openai_model("gpt-future_1.0"));
        assert!(!is_openai_model("gpt-"));
        assert!(!is_openai_model("grok-4.6"));
        assert!(!is_openai_model("claude-sonnet-4-6"));
        assert!(!is_openai_model(""));
        assert!(!is_openai_model("GPT-6"));
    }

    #[test]
    fn body_moves_system_to_instructions_and_replays_calls() {
        let body = to_responses_body(
            &serde_json::json!([
                { "role": "system", "content": "You are GPT." },
                { "role": "system", "content": "Be brief." },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "see" },
                        { "type": "image_url", "image_url": { "url": "data:image/png;base64,aaaa" } }
                    ],
                    "images": [{ "name": "notes.txt", "kind": "file", "dataUrl": "data:text/plain;base64,bbb" }]
                },
                {
                    "role": "assistant",
                    "content": "ok",
                    "thinking": [{ "type": "thinking", "thinking": "secret", "signature": "sig" }],
                    "reasoning_items": [{
                        "type": "reasoning",
                        "id": "rs_1",
                        "encrypted_content": "enc",
                        "summary": []
                    }],
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" }
                    }]
                },
                { "role": "tool", "tool_call_id": "call-1", "content": "fn main() {}" }
            ]),
            "gpt-6.1-sol",
            Some("high"),
            &serde_json::json!([{
                "type": "function",
                "function": { "name": "read_file", "description": "Read.", "parameters": { "type": "object" } }
            }]),
        );
        assert_eq!(body["model"], "gpt-6.1-sol");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "You are GPT.\n\nBe brief.");
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["max_output_tokens"], 128_000);
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["reasoning"]["summary"], "auto");
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_logprobs").is_none());
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "read_file");
        assert!(body["tools"][0].get("function").is_none());
        let input = body["input"].as_array().unwrap();
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[0]["content"][0]["text"], "see");
        assert_eq!(input[0]["content"][1]["type"], "input_image");
        assert_eq!(
            input[0]["content"][1]["image_url"],
            "data:image/png;base64,aaaa"
        );
        assert_eq!(input[0]["content"].as_array().unwrap().len(), 2);
        assert_eq!(input[1]["type"], "reasoning");
        assert_eq!(input[1]["id"], "rs_1");
        assert_eq!(input[1]["encrypted_content"], "enc");
        assert_eq!(input[2]["type"], "message");
        assert_eq!(input[2]["role"], "assistant");
        assert_eq!(input[2]["content"][0]["type"], "output_text");
        assert_eq!(input[2]["content"][0]["text"], "ok");
        assert!(input[2].get("thinking").is_none());
        assert_eq!(input[3]["type"], "function_call");
        assert_eq!(input[3]["call_id"], "call-1");
        assert_eq!(input[3]["name"], "read_file");
        assert_eq!(input[3]["arguments"], r#"{"path":"a.rs"}"#);
        assert_eq!(input[4]["type"], "function_call_output");
        assert_eq!(input[4]["call_id"], "call-1");
        assert_eq!(input[4]["output"], "fn main() {}");
        let dumped = body.to_string();
        assert!(!dumped.contains("secret"));
        assert!(!dumped.contains("notes.txt"));
    }

    #[test]
    fn service_tier_follows_the_speed_chip() {
        assert_eq!(service_tier_for("gpt-6-luna", "standard"), Some("default"));
        assert_eq!(service_tier_for("gpt-6-luna", "flex"), Some("flex"));
        assert_eq!(service_tier_for("gpt-6-luna", "fast"), Some("fast"));
        assert_eq!(service_tier_for("gpt-6-luna", "ultrafast"), Some("fast"));
        assert_eq!(
            service_tier_for("gpt-6-astra", "ultrafast"),
            Some("ultrafast")
        );
        assert_eq!(
            service_tier_for("gpt-6.1-sol", "ultrafast"),
            Some("ultrafast")
        );
        assert_eq!(service_tier_for("gpt-6-luna", ""), None);
        assert_eq!(service_tier_for("gpt-6-luna", "batch"), None);
    }

    #[test]
    fn effort_none_is_low_on_astra_and_stays_none_on_luna() {
        let astra = to_responses_body(
            &serde_json::json!([{ "role": "user", "content": "hi" }]),
            "gpt-6-astra",
            Some("none"),
            &serde_json::json!([]),
        );
        assert_eq!(astra["reasoning"]["effort"], "low");
        let sol = to_responses_body(
            &serde_json::json!([{ "role": "user", "content": "hi" }]),
            "gpt-6.1-sol",
            Some("none"),
            &serde_json::json!([]),
        );
        assert_eq!(sol["reasoning"]["effort"], "low");
        let luna = to_responses_body(
            &serde_json::json!([{ "role": "user", "content": "hi" }]),
            "gpt-6-luna",
            Some("none"),
            &serde_json::json!([]),
        );
        assert_eq!(luna["reasoning"]["effort"], "none");
        let terra = to_responses_body(
            &serde_json::json!([{ "role": "user", "content": "hi" }]),
            "gpt-6.1-terra",
            Some("none"),
            &serde_json::json!([]),
        );
        assert_eq!(terra["reasoning"]["effort"], "none");
        let empty = to_responses_body(
            &serde_json::json!([{ "role": "user", "content": "hi" }]),
            "gpt-6-luna",
            Some("  "),
            &serde_json::json!([]),
        );
        assert!(empty["reasoning"].get("effort").is_none());
        assert_eq!(empty["reasoning"]["summary"], "auto");
    }

    #[test]
    fn sse_fixture_reads_text_reasoning_tools_usage_and_encrypted_reasoning() {
        let lines = [
            r#"{"type":"response.output_text.delta","delta":"Hi","output_index":1,"item_id":"msg_1"}"#,
            r#"{"type":"response.reasoning_summary_text.delta","delta":"Look","output_index":0,"item_id":"rs_1","summary_index":0}"#,
            r#"{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":""}}"#,
            r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\"path\":\"a.rs\"}"}"#,
            r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc-1","summary":[{"type":"summary_text","text":"Look"}]}}"#,
            r#"{"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":3}},"output":[{"type":"reasoning","id":"rs_1","encrypted_content":"enc-1"},{"type":"reasoning","id":"rs_2","encrypted_content":"enc-2"},{"type":"reasoning","id":"rs_3","summary":[]}]}}"#,
            r#"{"type":"error","message":"bad model"}"#,
            r#"{"type":"response.failed","response":{"error":{"message":"nope"}}}"#,
        ];
        let mut state = SseState::default();
        let mut pieces = Vec::new();
        for line in lines {
            pieces.extend(parse_sse_data_with(line, &mut state));
        }
        assert!(pieces.contains(&SseEvent::Delta("Hi".into())));
        assert!(pieces.contains(&SseEvent::Reasoning("Look".into())));
        assert!(pieces.contains(&SseEvent::ToolStart {
            index: 2,
            id: "call_1".into(),
            name: "read_file".into(),
        }));
        assert!(pieces.contains(&SseEvent::ToolDelta {
            index: 2,
            partial: r#"{"path":"a.rs"}"#.into(),
        }));
        assert!(pieces.contains(&SseEvent::Usage {
            prompt_tokens: 10,
            completion_tokens: 4,
            cache_read_tokens: 3,
        }));
        assert!(pieces.contains(&SseEvent::Stop));
        assert!(pieces.contains(&SseEvent::Failed("bad model".into())));
        assert!(pieces.contains(&SseEvent::Failed("nope".into())));
        let mut items = Vec::new();
        for piece in &pieces {
            if let SseEvent::OutputItem(item) = piece {
                remember_reasoning_item(&mut items, item);
            }
        }
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["encrypted_content"], "enc-1");
        assert_eq!(items[1]["id"], "rs_2");
        assert_eq!(items[1]["encrypted_content"], "enc-2");
    }

    #[test]
    fn reasoning_summary_done_does_not_repeat_the_delta() {
        let lines = [
            r#"{"type":"response.reasoning_summary_text.delta","delta":"Lo","summary_index":0}"#,
            r#"{"type":"response.reasoning_summary_text.delta","delta":"ok","summary_index":0}"#,
            r#"{"type":"response.reasoning_summary_part.added","summary_index":0,"part":{"type":"summary_text","text":"Look"}}"#,
            r#"{"type":"response.reasoning_summary_part.done","summary_index":0,"part":{"type":"summary_text","text":"Look"}}"#,
            r#"{"type":"response.reasoning_summary_part.done","summary_index":1,"part":{"type":"summary_text","text":"Next"}}"#,
        ];
        let mut state = SseState::default();
        let mut text = String::new();
        for line in lines {
            for event in parse_sse_data_with(line, &mut state) {
                if let SseEvent::Reasoning(piece) = event {
                    text.push_str(&piece);
                }
            }
        }
        assert_eq!(text, "LookNext");
    }

    #[test]
    fn part_done_from_a_second_item_is_kept_when_summary_index_repeats() {
        let lines = [
            r#"{"type":"response.reasoning_summary_text.delta","delta":"Lo","output_index":0,"item_id":"rs_a","summary_index":0}"#,
            r#"{"type":"response.reasoning_summary_text.delta","delta":"ok","output_index":0,"item_id":"rs_a","summary_index":0}"#,
            r#"{"type":"response.reasoning_summary_part.done","output_index":0,"item_id":"rs_a","summary_index":0,"part":{"type":"summary_text","text":"Look"}}"#,
            r#"{"type":"response.reasoning_summary_part.done","output_index":1,"item_id":"rs_b","summary_index":0,"part":{"type":"summary_text","text":"Only B"}}"#,
            r#"{"type":"response.reasoning_summary_part.done","output_index":1,"item_id":"rs_b","summary_index":0,"part":{"type":"summary_text","text":"Only B"}}"#,
        ];
        let mut state = SseState::default();
        let mut text = String::new();
        for line in lines {
            for event in parse_sse_data_with(line, &mut state) {
                if let SseEvent::Reasoning(piece) = event {
                    text.push_str(&piece);
                }
            }
        }
        assert_eq!(text, "LookOnly B");
    }

    #[test]
    fn picture_text_keeps_newlines() {
        let body = to_responses_body(
            &serde_json::json!([{
                "role": "user",
                "content": "line one\nline two [shot.png]",
                "images": [{
                    "name": "dir/shot[\n].png",
                    "dataUrl": "data:image/png;base64,aaaa"
                }]
            }]),
            "gpt-6-luna",
            None,
            &serde_json::json!([]),
        );
        assert_eq!(body["input"][0]["content"][0]["text"], "line one\nline two");
    }

    #[test]
    fn reasoning_item_stays_next_to_the_output_that_followed_it() {
        let reasoning = serde_json::json!({
            "type": "reasoning",
            "id": "rs_1",
            "encrypted_content": "enc-1",
            "summary": []
        });
        let call = serde_json::json!({
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_1",
            "name": "read_file",
            "arguments": "{}"
        });
        let message = serde_json::json!({
            "type": "message",
            "id": "msg_1",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "I read it." }]
        });
        let body = to_responses_body(
            &serde_json::json!([
                { "role": "user", "content": "go" },
                {
                    "role": "assistant",
                    "content": "I read it.",
                    "reasoning_items": [
                        reasoning.clone(),
                        call.clone(),
                        message.clone(),
                        {
                            "type": "reasoning",
                            "id": "rs_tail",
                            "encrypted_content": "enc-tail",
                            "summary": []
                        }
                    ],
                    "tool_calls": [{
                        "id": "call_1",
                        "name": "read_file",
                        "arguments": "{}"
                    }]
                }
            ]),
            "gpt-6-luna",
            None,
            &serde_json::json!([]),
        );
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[1], reasoning);
        assert_eq!(input[2], call);
        assert_eq!(input[3], message);
        assert!(input
            .iter()
            .all(|item| { item.get("id").and_then(|value| value.as_str()) != Some("rs_tail") }));
    }

    #[test]
    fn a_reasoning_item_with_nothing_after_it_is_omitted() {
        let body = to_responses_body(
            &serde_json::json!([{
                "role": "assistant",
                "content": "",
                "reasoning_items": [{
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": "enc"
                }]
            }]),
            "gpt-6-luna",
            None,
            &serde_json::json!([]),
        );
        assert!(body["input"].as_array().unwrap().is_empty());
    }

    #[test]
    fn output_items_stay_in_arrival_order() {
        let mut state = SseState::default();
        let mut items = Vec::new();
        let lines = [
            r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc-1"}}"#,
            r#"{"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{}"}}"#,
            r#"{"type":"response.completed","response":{"output":[{"type":"reasoning","id":"rs_1","encrypted_content":"enc-1"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{}"},{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}]}}"#,
        ];
        for line in lines {
            for event in parse_sse_data_with(line, &mut state) {
                if let SseEvent::OutputItem(item) = event {
                    remember_output_item(&mut items, &item);
                }
            }
        }
        assert_eq!(
            items
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["rs_1", "fc_1", "msg_1"]
        );
    }

    #[test]
    fn partial_ciphertext_from_item_added_is_replaced_by_done() {
        let lines = [
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"partial"}}"#,
            r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"final"}}"#,
        ];
        let mut state = SseState::default();
        let mut items = Vec::new();
        for line in lines {
            for event in parse_sse_data_with(line, &mut state) {
                if let SseEvent::OutputItem(item) = event {
                    remember_output_item(&mut items, &item);
                }
            }
        }
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "rs_1");
        assert_eq!(items[0]["encrypted_content"], "final");
    }

    #[test]
    fn rejected_key_uses_the_openai_sentence() {
        assert_eq!(http_error_message(401, "nope"), KEY_REJECTED);
        let other = http_error_message(400, "bad model");
        assert!(other.starts_with("OpenAI error 400:"));
        assert!(!other.to_lowercase().contains("xai"));
    }
}
