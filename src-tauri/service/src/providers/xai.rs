//! xAI chat completions. The desktop also sends CLI proxy headers. This module owns the URL,
//! the request body, and the SSE deltas both callers parse.

use serde_json::Value;

pub const API_URL: &str = "https://api.x.ai/v1/chat/completions";
pub const CLI_URL: &str = "https://cli-chat-proxy.grok.com/v1/chat/completions";
pub const KEY_REJECTED: &str = "xAI rejected the API key.";

pub fn endpoint(via_cli: bool) -> &'static str {
    if via_cli { CLI_URL } else { API_URL }
}

pub fn http_error_message(status: u16, body: &str) -> String {
    if status == 401 {
        return KEY_REJECTED.into();
    }
    format!("xAI error {status}: {}", body.chars().take(400).collect::<String>())
}

/// OpenAI-shaped messages stay OpenAI-shaped. Effort is omitted when empty.
///
/// Stored transcripts keep tool calls flat (`id`, `name`, `arguments`). xAI
/// rejects that on the next round with `messages[n]: missing field function`.
/// Nest each call under `function` here, including calls that are already nested.
pub fn chat_body(model: &str, effort: Option<&str>, messages: &Value, tools: &Value) -> Value {
    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": api_messages(messages),
        "tools": tools,
        "tool_choice": "auto",
    });
    if let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) {
        body["reasoning_effort"] = Value::String(effort.to_string());
    }
    body
}

/// One streamed token count. `None` on a side means the payload did not say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cache_read_tokens: u64,
}

pub fn parse_usage(json: &Value) -> Option<Usage> {
    let usage = json.get("usage")?;
    let reported_prompt = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(|v| v.as_u64())?;
    let cached = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let mut completion_tokens = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let reasoning = usage
        .get("completion_tokens_details")
        .and_then(|d| d.get("reasoning_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if reasoning > 0 && completion_tokens < reasoning {
        completion_tokens = completion_tokens.saturating_add(reasoning);
    }
    let mut total_tokens = usage
        .get("total_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(reported_prompt.saturating_add(completion_tokens));
    let sum = reported_prompt.saturating_add(completion_tokens);
    if total_tokens < sum {
        total_tokens = sum;
    }
    if total_tokens > reported_prompt.saturating_add(completion_tokens) {
        completion_tokens = total_tokens.saturating_sub(reported_prompt);
    }
    Some(Usage {
        prompt_tokens: reported_prompt,
        completion_tokens,
        total_tokens,
        cache_read_tokens: cached,
    })
}

pub fn text_from_content(value: &Value) -> String {
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
        let kind = part.get("type").and_then(|item| item.as_str()).unwrap_or("");
        if is_reasoning_part(kind) {
            continue;
        }
        if let Some(text) = part.get("text").and_then(|item| item.as_str()) {
            out.push_str(text);
        }
    }
    out
}

pub fn reasoning_from_delta(delta: &Value) -> String {
    let mut out = String::new();
    if let Some(value) = delta.get("reasoning_content").filter(|item| !item.is_null()) {
        out.push_str(&reasoning_text(value));
    } else if let Some(value) = delta.get("reasoning").filter(|item| !item.is_null()) {
        out.push_str(&reasoning_text(value));
    }
    if let Some(content) = delta.get("content").filter(|item| item.is_array()) {
        out.push_str(&reasoning_text(content));
    }
    out
}

pub fn message_reasoning(choice: &Value) -> String {
    let Some(message) = choice.get("message") else {
        return String::new();
    };
    if let Some(value) = message.get("reasoning_content").filter(|item| !item.is_null()) {
        let text = reasoning_text(value);
        if !text.is_empty() {
            return text;
        }
    }
    if let Some(value) = message.get("reasoning").filter(|item| !item.is_null()) {
        let text = reasoning_text(value);
        if !text.is_empty() {
            return text;
        }
    }
    message.get("content").map(reasoning_text).unwrap_or_default()
}

pub fn fallback_choice_text(choice: &Value) -> String {
    choice
        .get("message")
        .and_then(|message| message.get("content"))
        .map(text_from_content)
        .unwrap_or_default()
}

/// One OpenAI tool-call fragment inside a `delta.tool_calls` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolFragment {
    pub index: u32,
    pub id: String,
    pub name: String,
    pub arguments: String,
}

pub fn tool_fragments(delta: &Value) -> Vec<ToolFragment> {
    let Some(calls) = delta.get("tool_calls").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    calls
        .iter()
        .map(|call| ToolFragment {
            index: call.get("index").and_then(|item| item.as_u64()).unwrap_or(0) as u32,
            id: call.get("id").and_then(|item| item.as_str()).unwrap_or("").to_string(),
            name: call
                .get("function")
                .and_then(|function| function.get("name"))
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .to_string(),
            arguments: call
                .get("function")
                .and_then(|function| function.get("arguments"))
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect()
}

fn api_messages(messages: &Value) -> Value {
    let Some(rows) = messages.as_array() else {
        return messages.clone();
    };
    Value::Array(rows.iter().map(api_message).collect())
}

fn api_message(message: &Value) -> Value {
    let Some(calls) = message.get("tool_calls").and_then(Value::as_array) else {
        return message.clone();
    };
    let mut message = message.clone();
    message["tool_calls"] = Value::Array(calls.iter().map(api_tool_call).collect());
    message
}

fn api_tool_call(call: &Value) -> Value {
    let id = call.get("id").and_then(Value::as_str).unwrap_or("");
    let name = call
        .get("function")
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .or_else(|| call.get("name").and_then(Value::as_str))
        .unwrap_or("");
    let arguments = argument_text(
        call.get("function")
            .and_then(|function| function.get("arguments"))
            .or_else(|| call.get("arguments")),
    );
    serde_json::json!({
        "id": id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": arguments,
        }
    })
}

fn argument_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(other) if !other.is_null() && other.as_str().is_none() => other.to_string(),
        _ => "{}".to_string(),
    }
}

fn is_reasoning_part(kind: &str) -> bool {
    matches!(kind, "reasoning" | "thinking" | "reasoning_text" | "reasoning_summary")
}

fn reasoning_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(parts) = value.as_array() {
        let mut out = String::new();
        for part in parts {
            let kind = part.get("type").and_then(|item| item.as_str()).unwrap_or("");
            if is_reasoning_part(kind) {
                out.push_str(&part_text(part));
            }
        }
        return out;
    }
    let kind = value.get("type").and_then(|item| item.as_str()).unwrap_or("");
    if kind.is_empty() || is_reasoning_part(kind) {
        return part_text(value);
    }
    String::new()
}

fn part_text(part: &Value) -> String {
    part.get("text")
        .or_else(|| part.get("content"))
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_follows_the_login() {
        assert_eq!(endpoint(false), API_URL);
        assert_eq!(endpoint(true), CLI_URL);
        assert_ne!(endpoint(false), endpoint(true));
    }

    #[test]
    fn flat_tool_calls_gain_a_function_before_they_are_sent() {
        let messages = serde_json::json!([
            { "role": "system", "content": "Be concise." },
            { "role": "user", "content": "search" },
            {
                "role": "assistant",
                "content": "I'll search.",
                "tool_calls": [
                    { "id": "call-1", "name": "web_search", "arguments": "{\"query\":\"x\"}" },
                    { "id": "call-2", "name": "read_file", "arguments": "" }
                ]
            },
            { "role": "tool", "tool_call_id": "call-1", "content": "found" }
        ]);
        let body = chat_body("grok-4.6", None, &messages, &serde_json::json!([]));
        let calls = body["messages"][2]["tool_calls"].as_array().unwrap();
        assert_eq!(calls[0]["id"], "call-1");
        assert_eq!(calls[0]["type"], "function");
        assert_eq!(calls[0]["function"]["name"], "web_search");
        assert_eq!(calls[0]["function"]["arguments"], "{\"query\":\"x\"}");
        assert!(calls[0].get("name").is_none());
        assert_eq!(calls[1]["function"]["name"], "read_file");
        assert_eq!(calls[1]["function"]["arguments"], "{}");
        assert_eq!(body["messages"][3]["tool_call_id"], "call-1");
        assert_eq!(body["messages"][1]["content"], "search");
    }

    #[test]
    fn nested_tool_calls_stay_nested() {
        let messages = serde_json::json!([{
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": { "name": "read_file", "arguments": "{}" }
            }]
        }]);
        let body = chat_body("grok-4.6", None, &messages, &serde_json::json!([]));
        assert_eq!(body["messages"][0]["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(body["messages"][0]["tool_calls"][0]["type"], "function");
    }

    #[test]
    fn body_keeps_messages_and_adds_effort_only_when_set() {
        let body = chat_body(
            "grok-4.6",
            Some("high"),
            &serde_json::json!([{ "role": "user", "content": "hi" }]),
            &serde_json::json!([]),
        );
        assert_eq!(body["model"], "grok-4.6");
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["stream"], true);
        let bare = chat_body("grok-4.6", Some("  "), &serde_json::json!([]), &serde_json::json!([]));
        assert!(bare.get("reasoning_effort").is_none());
    }

    #[test]
    fn usage_folds_reasoning_tokens_into_completion() {
        let json = serde_json::json!({
            "usage": {
                "prompt_tokens": 136,
                "completion_tokens": 3,
                "total_tokens": 736,
                "completion_tokens_details": { "reasoning_tokens": 597 }
            }
        });
        assert_eq!(
            parse_usage(&json),
            Some(Usage {
                prompt_tokens: 136,
                completion_tokens: 600,
                total_tokens: 736,
                cache_read_tokens: 0,
            })
        );
        assert_eq!(parse_usage(&serde_json::json!({})), None);
    }

    #[test]
    fn text_and_reasoning_stay_split() {
        let delta = serde_json::json!({
            "content": [
                { "type": "reasoning", "text": "secret" },
                { "type": "text", "text": "Hi" }
            ]
        });
        assert_eq!(text_from_content(delta.get("content").unwrap()), "Hi");
        assert_eq!(reasoning_from_delta(&delta), "secret");
        let choice = serde_json::json!({
            "message": { "reasoning_content": "Thought.", "content": "Answer" }
        });
        assert_eq!(message_reasoning(&choice), "Thought.");
        assert_eq!(fallback_choice_text(&choice), "Answer");
    }

    #[test]
    fn tool_fragments_keep_the_index() {
        let delta = serde_json::json!({
            "tool_calls": [{ "index": 0, "id": "call-1", "function": { "name": "read_file", "arguments": "{\"path\":" } }]
        });
        let rows = tool_fragments(&delta);
        assert_eq!(rows[0].name, "read_file");
        assert_eq!(rows[0].arguments, "{\"path\":");
    }
}
