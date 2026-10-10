use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, State};

use super::types::{DevChatEvent, DevChatUsage, DevToolCall};
use crate::error::{Error, Result};
use crate::grok_cli;
use crate::state::AppState;

fn http_client() -> &'static reqwest::Client {
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

fn streams() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static STREAMS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn journey_tool_json() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "update_journey_knowledge",
            "description": "Update this Journey's shared knowledge markdown. Use replace for a full rewrite, or edit to change one unique passage.",
            "parameters": {
                "type": "object",
                "properties": {
                    "mode": { "type": "string", "enum": ["replace", "edit"] },
                    "contents": { "type": "string" },
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" }
                },
                "required": ["mode"]
            }
        }
    })
}

fn tools_json(include_journey: bool) -> serde_json::Value {
    let mut tools = serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List files and folders relative to the workspace root.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Relative folder path. Empty for the workspace root." }
                    }
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
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create or overwrite a UTF-8 text file in the workspace. Creates parent folders.",
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
                "description": "Replace one unique occurrence of old_string with new_string in a file.",
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
                "name": "git_status",
                "description": "Show git status for the workspace.",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_diff",
                "description": "Show the git diff. Pass a relative path to limit it to one file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command in the workspace. The user must approve it first. Always set description to one short sentence of what the command does. That sentence is the chat line.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "description": { "type": "string", "description": "One short sentence shown in the chat, such as \"Run membership UI tests\"." }
                    },
                    "required": ["command", "description"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "spawn_subagent",
                "description": "Start a child agent with its own context for a delegated task. Use for research, planning, or independent work. The child reports a summary when it finishes. Explore cannot edit files. Plan produces a plan without edits. General-purpose may edit.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "description": "Full task prompt for the child." },
                        "description": { "type": "string", "description": "Short 3-5 word label shown in the UI." },
                        "subagent_type": {
                            "type": "string",
                            "enum": ["general-purpose", "explore", "plan"],
                            "description": "explore investigates, plan writes a plan, general-purpose can edit."
                        }
                    },
                    "required": ["prompt", "description"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "todo_write",
                "description": "Create or update the step list shown above the user's input. Use for multi-step work. Call at the start of a turn or mid-turn as you progress. Keep at most one item in_progress.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "merge": {
                            "type": "boolean",
                            "description": "If true, merge by id into the current list. If false, replace the list. Defaults to true."
                        },
                        "todos": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": { "type": "string" },
                                    "content": { "type": "string" },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "completed", "cancelled"]
                                    }
                                },
                                "required": ["id", "content", "status"]
                            }
                        }
                    },
                    "required": ["todos"]
                }
            }
        }
    ]);
    if include_journey {
        if let Some(list) = tools.as_array_mut() {
            list.push(journey_tool_json());
        }
    }
    tools
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_chat_cancel(stream_id: String) {
    if let Ok(map) = streams().lock() {
        if let Some(flag) = map.get(&stream_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_chat_start(
    app: AppHandle,
    state: State<'_, AppState>,
    stream_id: String,
    messages: serde_json::Value,
    model: Option<String>,
    effort: Option<String>,
    context_window: Option<u64>,
    journey_id: Option<String>,
) -> Result<()> {
    let Some(auth) = grok_cli::resolve_auth(&state.data_dir) else {
        return Err(Error::Other(
            "Grok isn’t signed in. Run grok login, or add an xAI API key in Settings.".into(),
        ));
    };
    let model = model
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "grok-4.6".into());
    let effort = effort.filter(|s| !s.trim().is_empty());
    let context_window = context_window.filter(|n| *n > 0);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = streams().lock() {
        map.insert(stream_id.clone(), cancel.clone());
    }
    let app2 = app.clone();
    let sid = stream_id.clone();
    tauri::async_runtime::spawn(async move {
        let include_journey = journey_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();
        let result = stream_chat(
            &app2,
            &sid,
            &auth,
            messages,
            model,
            effort,
            context_window,
            include_journey,
            cancel,
        )
        .await;
        if let Err(e) = result {
            let _ = app2.emit(
                "dev-chat",
                DevChatEvent {
                    stream_id: sid,
                    kind: "error".into(),
                    text: Some(e.to_string()),
                    tool_calls: None,
                    usage: None,
                },
            );
        }
        if let Ok(mut map) = streams().lock() {
            map.remove(&stream_id);
        }
    });
    Ok(())
}

async fn stream_chat(
    app: &AppHandle,
    stream_id: &str,
    auth: &grok_cli::GrokAuth,
    messages: serde_json::Value,
    model: String,
    effort: Option<String>,
    context_window: Option<u64>,
    include_journey: bool,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": messages,
        "tools": tools_json(include_journey),
        "tool_choice": "auto",
    });
    if let Some(effort) = effort {
        body["reasoning_effort"] = serde_json::Value::String(effort);
    }
    // SSE breaks when the body is gzip-decoded mid-stream: reqwest then reports
    // "error decoding response body" and the turn stops after the last tool.
    let mut req = http_client()
        .post(grok_cli::endpoint(auth.via_cli))
        .bearer_auth(&auth.token)
        .header("content-type", "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header("x-grok-conv-id", stream_id);
    if auth.via_cli {
        if let Some(tokens) = grok_cli::context_window_header_value(context_window) {
            req = req.header("x-grok-context-window", tokens);
        }
        let headers = grok_cli::cli_proxy_headers(&grok_cli::cached_cli_version());
        req = req
            .header("x-grok-client-version", headers.client_version)
            .header("X-XAI-Token-Auth", headers.token_auth)
            .header("x-grok-client-identifier", headers.client_identifier)
            .header(reqwest::header::USER_AGENT, headers.user_agent)
            .header("x-grok-model-override", &model);
    }
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("xAI request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = if status.as_u16() == 401 {
            if auth.via_cli {
                "Grok CLI login expired. Run grok login, or add an API key in Settings.".to_string()
            } else {
                "xAI rejected the API key.".to_string()
            }
        } else {
            format!(
                "xAI error {status}: {}",
                text.chars().take(400).collect::<String>()
            )
        };
        return Err(Error::Other(msg));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut pending_delta = String::new();
    let mut tool_acc: HashMap<u32, (String, String, String)> = HashMap::new();
    let mut last_usage: Option<DevChatUsage> = None;
    let mut emitted_text = false;
    let mut emitted_reasoning = false;
    let mut fallback_text = String::new();
    let mut fallback_reasoning = String::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            let _ = app.emit(
                "dev-chat",
                DevChatEvent {
                    stream_id: stream_id.into(),
                    kind: "error".into(),
                    text: Some("Stopped.".into()),
                    tool_calls: None,
                    usage: None,
                },
            );
            return Ok(());
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                // A dropped body after we already have text or tool calls is still a usable reply.
                if emitted_text || emitted_reasoning || !pending_delta.is_empty() || !tool_acc.is_empty() {
                    flush_delta(app, stream_id, &mut pending_delta, &mut emitted_text);
                    emit_pending_reasoning(app, stream_id, emitted_reasoning, &fallback_reasoning);
                    emit_done(
                        app,
                        stream_id,
                        &tool_acc,
                        last_usage.clone(),
                        fallback_done_text(emitted_text, &fallback_text),
                    );
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
                flush_delta(app, stream_id, &mut pending_delta, &mut emitted_text);
                emit_pending_reasoning(app, stream_id, emitted_reasoning, &fallback_reasoning);
                emit_done(
                    app,
                    stream_id,
                    &tool_acc,
                    last_usage.clone(),
                    fallback_done_text(emitted_text, &fallback_text),
                );
                return Ok(());
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            if let Some(usage) = parse_usage(&json) {
                let first = last_usage.is_none();
                last_usage = Some(usage.clone());
                if first {
                    let _ = app.emit(
                        "dev-chat",
                        DevChatEvent {
                            stream_id: stream_id.into(),
                            kind: "usage".into(),
                            text: None,
                            tool_calls: None,
                            usage: Some(usage),
                        },
                    );
                }
            }
            let Some(choice) = json.get("choices").and_then(|c| c.get(0)) else {
                continue;
            };
            let delta = choice
                .get("delta")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let piece = delta
                .get("content")
                .map(text_from_content)
                .unwrap_or_default();
            // Flush each SSE data line that carried content. Waiting for [DONE]
            // drops the reply when the provider never sends it or the body ends early.
            if note_streamed_content(&mut pending_delta, &piece) {
                flush_delta(app, stream_id, &mut pending_delta, &mut emitted_text);
            }
            let thought = reasoning_from_delta(&delta);
            if !thought.is_empty() {
                emitted_reasoning = true;
                let _ = app.emit(
                    "dev-chat",
                    DevChatEvent {
                        stream_id: stream_id.into(),
                        kind: "reasoning".into(),
                        text: Some(thought),
                        tool_calls: None,
                        usage: None,
                    },
                );
            }
            let fallback = fallback_choice_text(choice);
            if !fallback.is_empty() {
                fallback_text = fallback;
            }
            let thought_fallback = message_reasoning(choice);
            if !thought_fallback.is_empty() {
                fallback_reasoning = thought_fallback;
            }
            if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
                for call in calls {
                    let index = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32;
                    let entry = tool_acc.entry(index).or_insert_with(|| {
                        (
                            call.get("id")
                                .and_then(|i| i.as_str())
                                .unwrap_or("")
                                .to_string(),
                            String::new(),
                            String::new(),
                        )
                    });
                    if let Some(id) = call.get("id").and_then(|i| i.as_str()) {
                        if !id.is_empty() {
                            entry.0 = id.to_string();
                        }
                    }
                    if let Some(name) = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                    {
                        entry.1.push_str(name);
                    }
                    if let Some(args) = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|n| n.as_str())
                    {
                        entry.2.push_str(args);
                    }
                }
            }
            if choice.get("finish_reason").and_then(|f| f.as_str()) == Some("stop")
                || choice.get("finish_reason").and_then(|f| f.as_str()) == Some("tool_calls")
            {
                // wait for [DONE]
            }
        }
    }
    flush_delta(app, stream_id, &mut pending_delta, &mut emitted_text);
    emit_pending_reasoning(app, stream_id, emitted_reasoning, &fallback_reasoning);
    emit_done(
        app,
        stream_id,
        &tool_acc,
        last_usage,
        fallback_done_text(emitted_text, &fallback_text),
    );
    Ok(())
}

/// Append one SSE content piece and report whether it should be emitted now.
/// Empty pieces (tool-call or usage lines) leave any pending text untouched.
fn note_streamed_content(pending: &mut String, piece: &str) -> bool {
    if piece.is_empty() {
        false
    } else {
        pending.push_str(piece);
        true
    }
}

fn flush_delta(app: &AppHandle, stream_id: &str, pending: &mut String, emitted: &mut bool) {
    if pending.is_empty() {
        return;
    }
    *emitted = true;
    let text = std::mem::take(pending);
    let _ = app.emit(
        "dev-chat",
        DevChatEvent {
            stream_id: stream_id.into(),
            kind: "delta".into(),
            text: Some(text),
            tool_calls: None,
            usage: None,
        },
    );
}

fn is_reasoning_part(kind: &str) -> bool {
    matches!(
        kind,
        "reasoning" | "thinking" | "reasoning_text" | "reasoning_summary"
    )
}

fn text_from_content(value: &serde_json::Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    let Some(parts) = value.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for part in parts {
        if let Some(s) = part.as_str() {
            out.push_str(s);
            continue;
        }
        let kind = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if is_reasoning_part(kind) {
            continue;
        }
        if let Some(s) = part.get("text").and_then(|t| t.as_str()) {
            out.push_str(s);
        }
    }
    out
}

fn part_text(part: &serde_json::Value) -> String {
    part.get("text")
        .or_else(|| part.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string()
}

fn reasoning_text(value: &serde_json::Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    if let Some(parts) = value.as_array() {
        let mut out = String::new();
        for part in parts {
            let kind = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if is_reasoning_part(kind) {
                out.push_str(&part_text(part));
            }
        }
        return out;
    }
    let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if kind.is_empty() || is_reasoning_part(kind) {
        return part_text(value);
    }
    String::new()
}

fn reasoning_from_delta(delta: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(value) = delta.get("reasoning_content").filter(|v| !v.is_null()) {
        out.push_str(&reasoning_text(value));
    } else if let Some(value) = delta.get("reasoning").filter(|v| !v.is_null()) {
        out.push_str(&reasoning_text(value));
    }
    if let Some(content) = delta.get("content").filter(|v| v.is_array()) {
        out.push_str(&reasoning_text(content));
    }
    out
}

fn message_reasoning(choice: &serde_json::Value) -> String {
    let Some(message) = choice.get("message") else {
        return String::new();
    };
    if let Some(value) = message.get("reasoning_content").filter(|v| !v.is_null()) {
        let text = reasoning_text(value);
        if !text.is_empty() {
            return text;
        }
    }
    if let Some(value) = message.get("reasoning").filter(|v| !v.is_null()) {
        let text = reasoning_text(value);
        if !text.is_empty() {
            return text;
        }
    }
    message
        .get("content")
        .map(reasoning_text)
        .unwrap_or_default()
}

fn emit_pending_reasoning(app: &AppHandle, stream_id: &str, emitted: bool, fallback: &str) {
    if emitted || fallback.is_empty() {
        return;
    }
    let _ = app.emit(
        "dev-chat",
        DevChatEvent {
            stream_id: stream_id.into(),
            kind: "reasoning".into(),
            text: Some(fallback.to_string()),
            tool_calls: None,
            usage: None,
        },
    );
}

fn fallback_choice_text(choice: &serde_json::Value) -> String {
    choice
        .get("message")
        .and_then(|m| m.get("content"))
        .map(text_from_content)
        .unwrap_or_default()
}

fn fallback_done_text(emitted_text: bool, fallback: &str) -> Option<String> {
    if emitted_text || fallback.is_empty() {
        None
    } else {
        Some(fallback.to_string())
    }
}

fn emit_done(
    app: &AppHandle,
    stream_id: &str,
    tool_acc: &HashMap<u32, (String, String, String)>,
    usage: Option<DevChatUsage>,
    text: Option<String>,
) {
    let tool_calls = finish_tools(tool_acc);
    let _ = app.emit(
        "dev-chat",
        DevChatEvent {
            stream_id: stream_id.into(),
            kind: "done".into(),
            text,
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
            usage,
        },
    );
}

fn parse_usage(json: &serde_json::Value) -> Option<DevChatUsage> {
    let usage = json.get("usage")?;
    let prompt_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(|v| v.as_u64())?;
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
        .unwrap_or(prompt_tokens.saturating_add(completion_tokens));
    let sum = prompt_tokens.saturating_add(completion_tokens);
    if total_tokens < sum {
        total_tokens = sum;
    }
    if total_tokens > prompt_tokens.saturating_add(completion_tokens) {
        completion_tokens = total_tokens.saturating_sub(prompt_tokens);
    }
    Some(DevChatUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
    })
}

fn finish_tools(acc: &HashMap<u32, (String, String, String)>) -> Vec<DevToolCall> {
    let mut keys: Vec<u32> = acc.keys().copied().collect();
    keys.sort();
    keys.into_iter()
        .filter_map(|k| {
            let (id, name, arguments) = acc.get(&k)?;
            if name.is_empty() {
                return None;
            }
            Some(DevToolCall {
                id: if id.is_empty() {
                    format!("call_{k}")
                } else {
                    id.clone()
                },
                name: name.clone(),
                arguments: arguments.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_usage_reads_openai_style_counts() {
        let json = serde_json::json!({
            "choices": [],
            "usage": {
                "prompt_tokens": 24100,
                "completion_tokens": 800,
                "total_tokens": 24900
            }
        });
        assert_eq!(
            parse_usage(&json),
            Some(DevChatUsage {
                prompt_tokens: 24100,
                completion_tokens: 800,
                total_tokens: 24900,
            })
        );
    }

    #[test]
    fn parse_usage_folds_reasoning_tokens_into_completion() {
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
            Some(DevChatUsage {
                prompt_tokens: 136,
                completion_tokens: 600,
                total_tokens: 736,
            })
        );
    }

    #[test]
    fn parse_usage_returns_none_without_prompt_tokens() {
        assert_eq!(parse_usage(&serde_json::json!({})), None);
        assert_eq!(
            parse_usage(&serde_json::json!({ "usage": { "completion_tokens": 3 } })),
            None
        );
    }

    #[test]
    fn text_from_content_reads_string_and_text_parts() {
        assert_eq!(text_from_content(&serde_json::json!("Hello")), "Hello");
        assert_eq!(
            text_from_content(&serde_json::json!([
                { "type": "text", "text": "Hi " },
                { "type": "output_text", "text": "there" }
            ])),
            "Hi there"
        );
        assert_eq!(text_from_content(&serde_json::json!(null)), "");
    }

    #[test]
    fn fallback_choice_text_uses_message_when_delta_is_empty() {
        let choice = serde_json::json!({
            "delta": { "content": null },
            "message": { "role": "assistant", "content": "Saved." }
        });
        assert_eq!(fallback_choice_text(&choice), "Saved.");
    }

    #[test]
    fn fallback_done_text_only_when_nothing_was_streamed() {
        assert_eq!(fallback_done_text(true, "Saved."), None);
        assert_eq!(fallback_done_text(false, ""), None);
        assert_eq!(fallback_done_text(false, "Saved."), Some("Saved.".into()));
    }

    #[test]
    fn content_lines_flush_without_waiting_for_done() {
        let mut pending = String::new();
        assert!(!note_streamed_content(&mut pending, ""));
        assert!(pending.is_empty());

        assert!(note_streamed_content(&mut pending, "Hel"));
        assert_eq!(pending, "Hel");
        let flushed = std::mem::take(&mut pending);
        assert_eq!(flushed, "Hel");

        assert!(note_streamed_content(&mut pending, "lo"));
        assert_eq!(pending, "lo");
        assert!(!note_streamed_content(&mut pending, ""));
        assert_eq!(pending, "lo");
    }

    #[test]
    fn reasoning_from_delta_reads_reasoning_content() {
        let delta = serde_json::json!({ "reasoning_content": "The ", "role": "assistant" });
        assert_eq!(reasoning_from_delta(&delta), "The ");
    }

    #[test]
    fn text_and_reasoning_stay_split_in_content_parts() {
        let delta = serde_json::json!({
            "content": [
                { "type": "reasoning", "text": "secret" },
                { "type": "text", "text": "Hi" }
            ]
        });
        assert_eq!(text_from_content(delta.get("content").unwrap()), "Hi");
        assert_eq!(reasoning_from_delta(&delta), "secret");
    }

    #[test]
    fn message_reasoning_reads_the_final_message() {
        let choice = serde_json::json!({
            "message": { "reasoning_content": "Thought.", "content": "Answer" }
        });
        assert_eq!(message_reasoning(&choice), "Thought.");
    }
}
