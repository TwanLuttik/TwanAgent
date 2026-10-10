use serde::Serialize;

use crate::grok_cli::{effort_label, DevEffort, DevModel};

pub const PROVIDER_ANTHROPIC: &str = "anthropic";

const CLAUDE_MODELS: &[(&str, &str, u64, u32, &[&str])] = &[
    (
        "claude-opus-4-8",
        "Claude Opus 4.8",
        200_000,
        32_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
        200_000,
        32_000,
        &["low", "medium", "high", "xhigh", "max"],
    ),
    (
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        200_000,
        16_000,
        &["low", "medium", "high"],
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Xai,
    Anthropic,
}

fn efforts_for(ids: &[&str]) -> Vec<DevEffort> {
    ids.iter()
        .map(|id| DevEffort {
            id: (*id).into(),
            label: effort_label(id),
        })
        .collect()
}

pub fn claude_models() -> Vec<DevModel> {
    CLAUDE_MODELS
        .iter()
        .map(|(id, name, window, _max_tokens, efforts)| DevModel {
            id: (*id).into(),
            name: (*name).into(),
            efforts: efforts_for(efforts),
            context_window: Some(*window),
            context_windows: Vec::new(),
            provider: PROVIDER_ANTHROPIC.into(),
        })
        .collect()
}

pub fn claude_model(id: &str) -> Option<&'static (&'static str, &'static str, u64, u32, &'static [&'static str])> {
    let id = id.trim();
    CLAUDE_MODELS.iter().find(|(row_id, ..)| *row_id == id)
}

pub fn is_claude_model(id: &str) -> bool {
    claude_model(id).is_some()
}

pub fn provider_for(id: &str) -> Provider {
    if is_claude_model(id) {
        Provider::Anthropic
    } else {
        Provider::Xai
    }
}

/// Output cap for the Messages API. Not the context window.
pub fn max_tokens_for(id: &str) -> u32 {
    claude_model(id).map(|row| row.3).unwrap_or(16_000)
}

pub const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const SIGN_IN_ERROR: &str =
    "Claude isn’t signed in. Add an Anthropic API key in Settings.";
pub const KEY_REJECTED: &str = "Anthropic rejected the API key.";

/// OpenAI-shaped chat messages become a Messages API body. No I/O.
pub fn to_messages_body(
    messages: &serde_json::Value,
    model: &str,
    effort: Option<&str>,
    tools: &serde_json::Value,
) -> serde_json::Value {
    let rows = messages.as_array().cloned().unwrap_or_default();
    let mut system = String::new();
    let mut out: Vec<serde_json::Value> = Vec::new();
    for msg in rows {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
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
                "tool_use_id": msg.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                "content": content_string(msg.get("content")),
            });
            if let Some(last) = out.last_mut() {
                if last.get("role").and_then(|v| v.as_str()) == Some("user") {
                    if let Some(content) = last.get_mut("content").and_then(|v| v.as_array_mut()) {
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
            let text = content_string(msg.get("content"));
            if !text.trim().is_empty() {
                blocks.push(serde_json::json!({ "type": "text", "text": text }));
            }
            if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                for call in calls {
                    let name = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let arguments = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": call.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        "name": name,
                        "input": tool_input(arguments),
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
        "thinking": { "type": "adaptive" },
    });
    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system);
    }
    if let Some(effort) = effort.map(str::trim).filter(|s| !s.is_empty()) {
        body["output_config"] = serde_json::json!({ "effort": effort });
    }
    body
}

fn reshape_tools(tools: &serde_json::Value) -> Vec<serde_json::Value> {
    let Some(rows) = tools.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|tool| {
            let function = tool.get("function").unwrap_or(tool);
            let name = function.get("name").and_then(|v| v.as_str())?;
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
            if let Some(description) = function.get("description").and_then(|v| v.as_str()) {
                if !description.is_empty() {
                    row["description"] = serde_json::Value::String(description.to_string());
                }
            }
            Some(row)
        })
        .collect()
}

fn content_string(value: Option<&serde_json::Value>) -> String {
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
        if part.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                out.push_str(text);
            }
        }
    }
    out
}

fn user_blocks(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
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
        let kind = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "text" {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    out.push(serde_json::json!({ "type": "text", "text": text }));
                }
            }
            continue;
        }
        if kind == "image_url" {
            let url = part
                .get("image_url")
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(image) = image_block(url) {
                out.push(image);
            }
        }
    }
    out
}

fn image_block(url: &str) -> Option<serde_json::Value> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(",")?;
    if !meta.contains(";base64") || data.is_empty() {
        return None;
    }
    let media_type = meta.split(';').next().unwrap_or("").trim();
    if media_type.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        }
    }))
}

fn tool_input(arguments: &str) -> serde_json::Value {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return serde_json::json!({});
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(value) if value.is_object() => value,
        _ => serde_json::json!({ "raw": arguments }),
    }
}

pub fn http_error_message(status: u16, body: &str) -> String {
    if status == 401 {
        return KEY_REJECTED.into();
    }
    format!(
        "Anthropic error {status}: {}",
        body.chars().take(400).collect::<String>()
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTool {
    pub index: u32,
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SsePiece {
    Delta(String),
    Reasoning(String),
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
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
    Stop,
}

/// One Anthropic SSE `data:` payload. Event names are ignored; the JSON `type` is enough.
pub fn parse_sse_data(data: &str) -> Option<SsePiece> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(data).ok()?;
    match json.get("type").and_then(|v| v.as_str())? {
        "content_block_start" => {
            let index = json.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let block = json.get("content_block")?;
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                return None;
            }
            Some(SsePiece::ToolStart {
                index,
                id: block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                name: block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        }
        "content_block_delta" => {
            let index = json.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let delta = json.get("delta")?;
            match delta.get("type").and_then(|v| v.as_str())? {
                "text_delta" => {
                    let text = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if text.is_empty() {
                        None
                    } else {
                        Some(SsePiece::Delta(text.to_string()))
                    }
                }
                "thinking_delta" => {
                    let text = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                    if text.is_empty() {
                        None
                    } else {
                        Some(SsePiece::Reasoning(text.to_string()))
                    }
                }
                "input_json_delta" => Some(SsePiece::ToolDelta {
                    index,
                    partial: delta
                        .get("partial_json")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                }),
                _ => None,
            }
        }
        "message_start" => usage_piece(json.get("message").and_then(|m| m.get("usage"))),
        "message_delta" => usage_piece(json.get("usage")),
        "message_stop" => Some(SsePiece::Stop),
        _ => None,
    }
}

fn usage_piece(usage: Option<&serde_json::Value>) -> Option<SsePiece> {
    let usage = usage?;
    let prompt = usage.get("input_tokens").and_then(|v| v.as_u64());
    let completion = usage.get("output_tokens").and_then(|v| v.as_u64());
    // message_delta often carries only output_tokens. None means "keep the previous count".
    if prompt.is_none() && completion.is_none() {
        return None;
    }
    Some(SsePiece::Usage {
        prompt_tokens: prompt.unwrap_or(u64::MAX),
        completion_tokens: completion.unwrap_or(u64::MAX),
    })
}

pub fn merge_usage(prev: Option<(u64, u64)>, prompt_tokens: u64, completion_tokens: u64) -> (u64, u64) {
    let (prev_prompt, prev_completion) = prev.unwrap_or((0, 0));
    (
        if prompt_tokens == u64::MAX { prev_prompt } else { prompt_tokens },
        if completion_tokens == u64::MAX { prev_completion } else { completion_tokens },
    )
}

pub fn apply_tool_piece(tools: &mut Vec<SseTool>, piece: &SsePiece) {
    match piece {
        SsePiece::ToolStart { index, id, name } => {
            if let Some(row) = tools.iter_mut().find(|row| row.index == *index) {
                if !id.is_empty() {
                    row.id = id.clone();
                }
                if !name.is_empty() {
                    row.name = name.clone();
                }
                return;
            }
            tools.push(SseTool {
                index: *index,
                id: id.clone(),
                name: name.clone(),
                arguments: String::new(),
            });
        }
        SsePiece::ToolDelta { index, partial } => {
            if let Some(row) = tools.iter_mut().find(|row| row.index == *index) {
                row.arguments.push_str(partial);
                return;
            }
            tools.push(SseTool {
                index: *index,
                id: String::new(),
                name: String::new(),
                arguments: partial.clone(),
            });
        }
        _ => {}
    }
}

pub fn finished_tools(tools: &[SseTool]) -> Vec<(String, String, String)> {
    let mut rows = tools.to_vec();
    rows.sort_by_key(|row| row.index);
    rows.into_iter()
        .filter(|row| !row.name.is_empty())
        .map(|row| {
            (
                if row.id.is_empty() {
                    format!("toolu_{}", row.index)
                } else {
                    row.id
                },
                row.name,
                row.arguments,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_the_three_claude_models() {
        let rows = claude_models();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]
        );
        assert!(rows.iter().all(|row| row.provider == PROVIDER_ANTHROPIC));
        assert!(rows.iter().all(|row| row.context_window == Some(200_000)));
        assert!(rows.iter().all(|row| row.context_windows.is_empty()));
        assert_eq!(rows[0].efforts[0].id, "low");
        assert_eq!(rows[0].efforts[0].label, "Low");
        assert_eq!(rows[0].efforts[3].label, "Extra high");
        assert_eq!(rows[0].efforts.last().map(|e| e.id.as_str()), Some("max"));
        assert_eq!(rows[0].efforts.last().map(|e| e.label.as_str()), Some("Max"));
        assert_eq!(rows[2].efforts.len(), 3);
    }

    #[test]
    fn provider_matches_only_the_catalog_ids() {
        assert_eq!(provider_for("claude-sonnet-4-6"), Provider::Anthropic);
        assert_eq!(provider_for(" claude-opus-4-8 "), Provider::Anthropic);
        assert!(is_claude_model("claude-haiku-4-5"));
        assert!(!is_claude_model("claude-opus-4-8-latest"));
        assert!(!is_claude_model("sxs-claude-opus-4-6"));
        assert!(!is_claude_model("grok-4.6"));
        assert!(!is_claude_model(""));
        assert_eq!(provider_for("grok-4.6"), Provider::Xai);
        assert_eq!(provider_for(""), Provider::Xai);
        assert_eq!(provider_for("sxs-claude-opus-4-6"), Provider::Xai);
    }

    #[test]
    fn max_tokens_follow_the_catalog() {
        assert_eq!(max_tokens_for("claude-opus-4-8"), 32_000);
        assert_eq!(max_tokens_for("claude-sonnet-4-6"), 32_000);
        assert_eq!(max_tokens_for("claude-haiku-4-5"), 16_000);
        assert_eq!(max_tokens_for("claude-opus-4-8-latest"), 16_000);
    }

    fn sample_tools(include_journey: bool) -> serde_json::Value {
        crate::dev::chat::tools_json(include_journey)
    }

    #[test]
    fn system_messages_leave_the_array_and_effort_is_optional() {
        let body = to_messages_body(
            &serde_json::json!([
                { "role": "system", "content": "You are Claude." },
                { "role": "system", "content": "Be brief." },
                { "role": "user", "content": "hi" }
            ]),
            "claude-sonnet-4-6",
            None,
            &sample_tools(false),
        );
        assert_eq!(body["system"], "You are Claude.\n\nBe brief.");
        assert_eq!(body["max_tokens"], 32_000);
        assert_eq!(body["stream"], true);
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert!(body.get("output_config").is_none());
        assert_eq!(body["messages"].as_array().map(|rows| rows.len()), Some(1));
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
        assert_eq!(body["tool_choice"]["type"], "auto");
        let names: Vec<_> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["name"].as_str())
            .collect();
        assert!(names.contains(&"read_file"));
        assert!(!names.contains(&"update_journey_knowledge"));
        assert!(body["tools"][0].get("input_schema").is_some());
        assert!(body["tools"][0].get("function").is_none());
    }

    #[test]
    fn effort_and_journey_tool_are_included_when_asked() {
        let body = to_messages_body(
            &serde_json::json!([{ "role": "user", "content": "go" }]),
            "claude-haiku-4-5",
            Some("high"),
            &sample_tools(true),
        );
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(body["max_tokens"], 16_000);
        assert!(body.get("system").is_none());
        let names: Vec<_> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["name"].as_str())
            .collect();
        assert!(names.contains(&"update_journey_knowledge"));
    }

    #[test]
    fn image_data_urls_become_base64_blocks_and_remote_urls_are_dropped() {
        let body = to_messages_body(
            &serde_json::json!([{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what is this" },
                    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,abc" } },
                    { "type": "image_url", "image_url": { "url": "https://example.com/a.jpg" } }
                ]
            }]),
            "claude-opus-4-8",
            Some("  "),
            &serde_json::json!([]),
        );
        assert!(body.get("output_config").is_none());
        assert_eq!(body["messages"][0]["content"].as_array().map(|rows| rows.len()), Some(2));
        assert_eq!(body["messages"][0]["content"][1]["type"], "image");
        assert_eq!(body["messages"][0]["content"][1]["source"]["media_type"], "image/jpeg");
        assert_eq!(body["messages"][0]["content"][1]["source"]["data"], "abc");
    }

    #[test]
    fn tool_round_trip_groups_results_and_repairs_arguments() {
        let body = to_messages_body(
            &serde_json::json!([
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "toolu_1",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" }
                        },
                        {
                            "id": "toolu_2",
                            "type": "function",
                            "function": { "name": "list_dir", "arguments": "not-json" }
                        },
                        {
                            "id": "toolu_3",
                            "type": "function",
                            "function": { "name": "git_status", "arguments": "" }
                        }
                    ]
                },
                { "role": "tool", "tool_call_id": "toolu_1", "content": "fn main() {}" },
                { "role": "tool", "tool_call_id": "toolu_2", "content": "[]" }
            ]),
            "claude-sonnet-4-6",
            Some("medium"),
            &sample_tools(false),
        );
        let assistant = &body["messages"][0];
        assert_eq!(assistant["content"].as_array().map(|rows| rows.len()), Some(3));
        assert!(assistant["content"]
            .as_array()
            .unwrap()
            .iter()
            .all(|block| block["type"] == "tool_use"));
        assert_eq!(assistant["content"][0]["input"]["path"], "a.rs");
        assert_eq!(assistant["content"][1]["input"]["raw"], "not-json");
        assert_eq!(assistant["content"][2]["input"], serde_json::json!({}));
        let results = &body["messages"][1];
        assert_eq!(results["role"], "user");
        assert_eq!(results["content"].as_array().map(|rows| rows.len()), Some(2));
        assert_eq!(results["content"][0]["type"], "tool_result");
        assert_eq!(results["content"][0]["tool_use_id"], "toolu_1");
        assert_eq!(results["content"][1]["tool_use_id"], "toolu_2");
    }

    #[test]
    fn sse_fixture_emits_text_thinking_usage_and_a_tool_call() {
        let lines = [
            r#"{"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Look "}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first."}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}"#,
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"read_file"}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"a.rs\"}"}}"#,
            r#"{"type":"message_delta","usage":{"output_tokens":20}}"#,
            r#"{"type":"message_stop"}"#,
        ];
        let mut tools = Vec::new();
        let mut deltas = Vec::new();
        let mut thoughts = Vec::new();
        let mut usages = Vec::new();
        let mut stopped = false;
        for line in lines {
            let Some(piece) = parse_sse_data(line) else {
                continue;
            };
            apply_tool_piece(&mut tools, &piece);
            match piece {
                SsePiece::Delta(text) => deltas.push(text),
                SsePiece::Reasoning(text) => thoughts.push(text),
                SsePiece::Usage { prompt_tokens, completion_tokens } => {
                    usages.push((prompt_tokens, completion_tokens));
                }
                SsePiece::Stop => stopped = true,
                _ => {}
            }
        }
        assert_eq!(deltas.concat(), "Hi");
        assert_eq!(thoughts.concat(), "Look first.");
        assert_eq!(usages, vec![(12, 1), (u64::MAX, 20)]);
        assert_eq!(merge_usage(Some((12, 1)), u64::MAX, 20), (12, 20));
        assert!(stopped);
        let calls = finished_tools(&tools);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "toolu_9");
        assert_eq!(calls[0].1, "read_file");
        assert_eq!(calls[0].2, "{\"path\":\"a.rs\"}");
        assert!(parse_sse_data("").is_none());
        assert!(parse_sse_data("[DONE]").is_none());
    }

    #[test]
    fn claude_does_not_use_the_xai_endpoint() {
        assert_eq!(provider_for("claude-sonnet-4-6"), Provider::Anthropic);
        assert_ne!(MESSAGES_URL, crate::grok_cli::endpoint(false));
        assert_ne!(MESSAGES_URL, crate::grok_cli::endpoint(true));
        assert_eq!(http_error_message(401, "nope"), KEY_REJECTED);
        let other = http_error_message(400, "bad model");
        assert!(other.starts_with("Anthropic error 400:"));
        assert!(other.contains("bad model"));
    }
}
