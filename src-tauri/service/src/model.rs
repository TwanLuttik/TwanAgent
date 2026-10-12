//! One model round on the machine that owns the project.
//!
//! The desktop does not call the model for a hosted turn. This module reads the
//! provider keys copied onto the server and streams the reply itself.

use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::keys::ProviderKeys;

const XAI_URL: &str = "https://api.x.ai/v1/chat/completions";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MINIMAX_URL: &str = "https://api.minimax.io/anthropic/v1/messages";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Round {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Xai,
    Anthropic,
    Minimax,
}

fn provider_for(model: &str) -> Provider {
    let id = model.trim();
    if id.starts_with("sxs-") {
        return Provider::Xai;
    }
    if id.starts_with("MiniMax-") {
        return Provider::Minimax;
    }
    if id.starts_with("claude-") {
        return Provider::Anthropic;
    }
    Provider::Xai
}

fn key_for(keys: &ProviderKeys, provider: Provider) -> Result<String> {
    let value = match provider {
        Provider::Xai => keys.xai.trim(),
        Provider::Anthropic => keys.anthropic.trim(),
        Provider::Minimax => keys.minimax.trim(),
    };
    if value.is_empty() || value == "local-try" {
        return Err(Error::Other(
            "Copy provider keys to this server in Settings.".into(),
        ));
    }
    Ok(value.to_string())
}

/// Tools the server can run next to the project files. The GUI does not get these calls.
pub fn tool_defs() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List files and folders relative to the workspace root.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file in the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create or overwrite a UTF-8 text file in the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "contents": { "type": "string" }
                    },
                    "required": ["path", "contents"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Replace one unique occurrence of old_string with new_string.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "old_string": { "type": "string" },
                        "new_string": { "type": "string" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command in the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "description": { "type": "string" }
                    },
                    "required": ["command", "description"]
                }
            }
        }
    ])
}

pub fn run_round(
    keys: &ProviderKeys,
    model: &str,
    effort: &str,
    messages: &[Value],
    on_delta: &mut dyn FnMut(&str),
) -> Result<Round> {
    let provider = provider_for(model);
    let token = key_for(keys, provider)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|err| Error::Other(format!("could not start the model request: {err}")))?;
    match provider {
        Provider::Xai => xai_round(&client, &token, model, effort, messages, on_delta),
        Provider::Anthropic | Provider::Minimax => {
            let url = if provider == Provider::Minimax { MINIMAX_URL } else { ANTHROPIC_URL };
            messages_round(&client, url, &token, provider, model, messages, on_delta)
        }
    }
}

fn xai_round(
    client: &reqwest::blocking::Client,
    token: &str,
    model: &str,
    effort: &str,
    messages: &[Value],
    on_delta: &mut dyn FnMut(&str),
) -> Result<Round> {
    let mut body = json!({
        "model": model,
        "stream": true,
        "messages": messages,
        "tools": tool_defs(),
        "tool_choice": "auto",
    });
    if !effort.trim().is_empty() {
        body["reasoning_effort"] = Value::String(effort.trim().to_string());
    }
    let response = client
        .post(XAI_URL)
        .bearer_auth(token)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|err| Error::Other(format!("xAI request failed: {err}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        let message = if status.as_u16() == 401 {
            "xAI rejected the API key.".to_string()
        } else {
            format!("xAI error {status}: {}", text.chars().take(400).collect::<String>())
        };
        return Ok(Round { text: String::new(), tool_calls: Vec::new(), error: Some(message) });
    }
    read_sse(response, on_delta, parse_xai_line)
}

fn messages_round(
    client: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    provider: Provider,
    model: &str,
    messages: &[Value],
    on_delta: &mut dyn FnMut(&str),
) -> Result<Round> {
    let body = anthropic_body(model, messages);
    let name = if provider == Provider::Minimax { "MiniMax" } else { "Anthropic" };
    let response = client
        .post(url)
        .header("x-api-key", token)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|err| Error::Other(format!("{name} request failed: {err}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        let message = if status.as_u16() == 401 {
            format!("{name} rejected the API key.")
        } else {
            format!("{name} error {status}: {}", text.chars().take(400).collect::<String>())
        };
        return Ok(Round { text: String::new(), tool_calls: Vec::new(), error: Some(message) });
    }
    read_sse(response, on_delta, parse_anthropic_line)
}

fn read_sse(
    response: reqwest::blocking::Response,
    on_delta: &mut dyn FnMut(&str),
    parse: fn(&str, &mut OpenRound),
) -> Result<Round> {
    let mut open = OpenRound::default();
    let mut buf = String::new();
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(response);
    loop {
        buf.clear();
        let read = reader.read_line(&mut buf).map_err(|err| Error::Other(format!("model stream failed: {err}")))?;
        if read == 0 {
            break;
        }
        let line = buf.trim();
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            if data == "[DONE]" {
                break;
            }
            continue;
        }
        parse(data, &mut open);
        if let Some(text) = open.take_delta() {
            on_delta(&text);
        }
        if open.stop {
            break;
        }
    }
    Ok(open.finish())
}

#[derive(Default)]
struct OpenRound {
    text: String,
    pending: String,
    calls: Vec<ToolCall>,
    stop: bool,
}

impl OpenRound {
    fn take_delta(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }

    fn finish(self) -> Round {
        Round {
            text: self.text,
            tool_calls: self.calls.into_iter().filter(|call| !call.name.is_empty()).collect(),
            error: None,
        }
    }
}

fn parse_xai_line(data: &str, open: &mut OpenRound) {
    let Ok(json) = serde_json::from_str::<Value>(data) else {
        return;
    };
    let Some(choice) = json.get("choices").and_then(|rows| rows.get(0)) else {
        return;
    };
    let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
    if let Some(text) = delta.get("content").and_then(Value::as_str) {
        if !text.is_empty() {
            open.text.push_str(text);
            open.pending.push_str(text);
        }
    }
    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            while open.calls.len() <= index {
                open.calls.push(ToolCall {
                    id: format!("tool_{}", open.calls.len()),
                    name: String::new(),
                    arguments: String::new(),
                });
            }
            let row = &mut open.calls[index];
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    row.id = id.to_string();
                }
            }
            if let Some(name) = call.get("function").and_then(|row| row.get("name")).and_then(Value::as_str) {
                if !name.is_empty() {
                    row.name = name.to_string();
                }
            }
            if let Some(arguments) = call
                .get("function")
                .and_then(|row| row.get("arguments"))
                .and_then(Value::as_str)
            {
                row.arguments.push_str(arguments);
            }
        }
    }
}

fn parse_anthropic_line(data: &str, open: &mut OpenRound) {
    let Ok(json) = serde_json::from_str::<Value>(data) else {
        return;
    };
    match json.get("type").and_then(Value::as_str).unwrap_or("") {
        "content_block_start" => {
            let Some(block) = json.get("content_block") else {
                return;
            };
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                return;
            }
            open.calls.push(ToolCall {
                id: block.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                name: block.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                arguments: String::new(),
            });
        }
        "content_block_delta" => {
            let Some(delta) = json.get("delta") else {
                return;
            };
            match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                "text_delta" => {
                    let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() {
                        open.text.push_str(text);
                        open.pending.push_str(text);
                    }
                }
                "input_json_delta" => {
                    if let Some(row) = open.calls.last_mut() {
                        row.arguments.push_str(delta.get("partial_json").and_then(Value::as_str).unwrap_or(""));
                    }
                }
                _ => {}
            }
        }
        "message_stop" => open.stop = true,
        _ => {}
    }
}

fn anthropic_body(model: &str, messages: &[Value]) -> Value {
    let mut system = String::new();
    let mut out = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "system" {
            let text = message.get("content").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(text);
            }
            continue;
        }
        if role == "tool" {
            let block = json!({
                "type": "tool_result",
                "tool_use_id": message.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
                "content": message.get("content").and_then(Value::as_str).unwrap_or(""),
            });
            out.push(json!({ "role": "user", "content": [block] }));
            continue;
        }
        if role == "assistant" {
            let mut blocks = Vec::new();
            let text = message.get("content").and_then(Value::as_str).unwrap_or("");
            if !text.trim().is_empty() {
                blocks.push(json!({ "type": "text", "text": text }));
            }
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let arguments = call.get("arguments").and_then(Value::as_str).unwrap_or("{}");
                    let input = serde_json::from_str::<Value>(arguments).unwrap_or_else(|_| json!({}));
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.get("id").and_then(Value::as_str).unwrap_or(""),
                        "name": name,
                        "input": input,
                    }));
                }
            }
            if !blocks.is_empty() {
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
            continue;
        }
        let text = message.get("content").and_then(Value::as_str).unwrap_or("");
        if !text.is_empty() {
            out.push(json!({ "role": "user", "content": text }));
        }
    }
    let tools: Vec<Value> = tool_defs()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|tool| {
            let function = tool.get("function")?.clone();
            Some(json!({
                "name": function.get("name")?,
                "description": function.get("description").cloned().unwrap_or(Value::String(String::new())),
                "input_schema": function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object"})),
            }))
        })
        .collect();
    let mut body = json!({
        "model": model,
        "max_tokens": 16000,
        "stream": true,
        "messages": out,
        "tools": tools,
    });
    if !system.is_empty() {
        body["system"] = Value::String(system);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_follows_the_model_id() {
        assert_eq!(provider_for("grok-4.6"), Provider::Xai);
        assert_eq!(provider_for("claude-sonnet-4-6"), Provider::Anthropic);
        assert_eq!(provider_for("MiniMax-M3"), Provider::Minimax);
        assert_eq!(provider_for("sxs-claude-opus-4-6"), Provider::Xai);
    }

    #[test]
    fn a_missing_key_does_not_call_the_model() {
        let err = key_for(&ProviderKeys::default(), Provider::Xai).unwrap_err();
        assert!(err.to_string().contains("Copy provider keys"));
        let marker = key_for(
            &ProviderKeys { xai: "local-try".into(), ..ProviderKeys::default() },
            Provider::Xai,
        );
        assert!(marker.is_err());
    }

    #[test]
    fn xai_deltas_and_tool_calls_accumulate() {
        let mut open = OpenRound::default();
        parse_xai_line(
            r#"{"choices":[{"delta":{"content":"Hi"}}]}"#,
            &mut open,
        );
        parse_xai_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}"#,
            &mut open,
        );
        parse_xai_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.rs\"}"}}]}}]}"#,
            &mut open,
        );
        assert_eq!(open.take_delta().as_deref(), Some("Hi"));
        let done = open.finish();
        assert_eq!(done.text, "Hi");
        assert_eq!(done.tool_calls[0].name, "read_file");
        assert_eq!(done.tool_calls[0].arguments, r#"{"path":"a.rs"}"#);
    }
}
