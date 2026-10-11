use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter, State};

use super::types::{DevChatEvent, DevChatUsage};
use crate::error::{Error, Result};
use crate::grok_cli;
use crate::state::AppState;

fn http_client() -> &'static reqwest::Client {
    crate::model_providers::runner::http_client()
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

const PLAN_TOOL_NAMES: &[&str] = &["enter_plan_mode", "exit_plan_mode"];

pub(crate) fn tools_json(include_journey: bool) -> serde_json::Value {
    tools_json_for(include_journey, true)
}

/// Claude chats do not get Grok's plan-mode tools. The gate lives in the client too.
pub(crate) fn tools_json_for(include_journey: bool, include_plan: bool) -> serde_json::Value {
    let mut tools = base_tools_json();
    if !include_plan {
        if let Some(list) = tools.as_array_mut() {
            list.retain(|tool| {
                tool.get("function")
                    .and_then(|row| row.get("name"))
                    .and_then(|name| name.as_str())
                    .is_none_or(|name| !PLAN_TOOL_NAMES.contains(&name))
            });
        }
    }
    if include_journey {
        if let Some(list) = tools.as_array_mut() {
            list.push(journey_tool_json());
        }
    }
    tools
}

fn base_tools_json() -> serde_json::Value {
    serde_json::json!([
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
                "description": "Show the git diff. Pass a relative path to limit it to one file. Pass a commit hash to show that commit.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "commit": { "type": "string", "description": "Optional commit hash. Omit for the working tree." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_log",
                "description": "Recent commits for this workspace: hash, author, date, subject.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": { "type": "integer", "description": "How many commits. Defaults to 20, max 80." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_commit",
                "description": "Stage the given paths and commit them. Only call this when the user asked to commit. Requires a message.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": { "type": "string" },
                        "paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Workspace-relative paths to stage. Empty stages everything already listed by git status."
                        }
                    },
                    "required": ["message"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web for current information. Use for facts, news, docs, and anything that may have changed since training. Returns a short answer with source URLs.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query. Be specific and include versions or dates when they matter."
                        },
                        "allowed_domains": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Optional domains to limit the search to, at most 5. Omit to search the whole web. Ignored when the user configured a domain policy."
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command in the workspace. The user must approve it first. Always set description to one short sentence of what the command does. That sentence is the chat line. A command runs in the foreground and this tool waits for it. End the command with & only when it should keep running after the tool returns, such as a dev server, file watcher, or other long-lived process. That is the only way a command stays open above the input.",
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
                "description": "Start a child agent with its own context for a delegated task. Use for research, planning, or independent work. The child reports a summary when it finishes. Explore cannot edit files. Plan produces a plan without edits. General-purpose may edit. The child uses the same model as this chat.",
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
                "name": "enter_plan_mode",
                "description": "Switch to plan mode. In plan mode, you can only read the codebase and write a plan. The user approves the plan before you change any code. Use this tool only when the user asks for a plan.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "exit_plan_mode",
                "description": "Show your plan to the user for approval. Plan mode ends when the user approves the plan.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
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
    ])
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_web_search(
    app: AppHandle,
    state: State<'_, AppState>,
    stream_id: String,
    arguments: String,
) -> Result<String> {
    let data_dir = state.data_dir.clone();
    crate::web_search::search(&app, &data_dir, &stream_id, &arguments).await
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
    let model = model
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "grok-4.6".into());
    let provider = crate::model_providers::registry::find(&model);
    let auth = if provider == crate::model_providers::registry::ProviderId::Xai {
        let Some(auth) = grok_cli::resolve_auth(&state.data_dir) else {
            return Err(Error::Other(
                crate::model_providers::registry::sign_in_error(provider).into(),
            ));
        };
        Some(auth)
    } else {
        None
    };
    let anthropic_auth = if provider == crate::model_providers::registry::ProviderId::Anthropic {
        let Some(auth) = crate::anthropic::resolve_claude_auth_fresh().await else {
            return Err(Error::Other(
                crate::model_providers::registry::sign_in_error(provider).into(),
            ));
        };
        Some(auth)
    } else {
        None
    };
    let minimax_auth = if provider == crate::model_providers::registry::ProviderId::Minimax {
        let Some(auth) = crate::minimax::resolve_minimax_auth_fresh().await else {
            return Err(Error::Other(
                crate::model_providers::registry::sign_in_error(provider).into(),
            ));
        };
        Some(auth)
    } else {
        None
    };
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
        let result = if provider == crate::model_providers::registry::ProviderId::Anthropic {
            stream_anthropic(
                &app2,
                &sid,
                anthropic_auth.as_ref().expect("claude auth"),
                messages,
                model,
                effort,
                include_journey,
                cancel,
            )
            .await
        } else if provider == crate::model_providers::registry::ProviderId::Minimax {
            stream_minimax(
                &app2,
                &sid,
                minimax_auth.as_ref().expect("minimax auth"),
                messages,
                model,
                include_journey,
                cancel,
            )
            .await
        } else {
            stream_chat(
                &app2,
                &sid,
                auth.as_ref().expect("xai auth"),
                messages,
                model,
                effort,
                context_window,
                include_journey,
                cancel,
            )
            .await
        };
        if let Err(e) = result {
            let _ = app2.emit(
                "dev-chat",
                DevChatEvent {
                    stream_id: sid,
                    kind: "error".into(),
                    text: Some(e.to_string()),
                    tool_calls: None,
                    usage: None,
                    thinking: None,
                },
            );
        }
        if let Ok(mut map) = streams().lock() {
            map.remove(&stream_id);
        }
    });
    Ok(())
}

async fn stream_anthropic(
    app: &AppHandle,
    stream_id: &str,
    auth: &crate::anthropic::ClaudeAuth,
    messages: serde_json::Value,
    model: String,
    effort: Option<String>,
    include_journey: bool,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let body = crate::anthropic::to_messages_body(
        &messages,
        &model,
        effort.as_deref(),
        &tools_json_for(include_journey, crate::model_providers::registry::plan_mode(crate::model_providers::registry::ProviderId::Anthropic)),
    );
    let mut req = http_client()
        .post(crate::anthropic::MESSAGES_URL)
        .header("anthropic-version", crate::anthropic::ANTHROPIC_VERSION);
    req = if auth.via_cli {
        req.bearer_auth(&auth.token)
    } else {
        req.header("x-api-key", &auth.token)
    };
    let resp = req
        .header("content-type", "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("Anthropic request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(crate::anthropic::http_error_message(
            status.as_u16(),
            &text,
        )));
    }
    crate::model_providers::runner::consume_sse(
        app,
        stream_id,
        resp,
        cancel,
        |data| crate::anthropic::parse_sse_data(data).into_iter().collect(),
        |_| None,
    )
    .await
}

async fn stream_minimax(
    app: &AppHandle,
    stream_id: &str,
    auth: &crate::minimax::MinimaxAuth,
    messages: serde_json::Value,
    model: String,
    include_journey: bool,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    let body = crate::minimax::to_minimax_body(
        &messages,
        &model,
        &tools_json_for(
            include_journey,
            crate::model_providers::registry::plan_mode(crate::model_providers::registry::ProviderId::Minimax),
        ),
    );
    let resp = http_client()
        .post(crate::minimax::messages_url(&auth.base_url))
        .header("x-api-key", &auth.token)
        .header("content-type", "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("MiniMax request failed: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(crate::minimax::http_error_message(
            status.as_u16(),
            &text,
        )));
    }
    crate::model_providers::runner::consume_sse(
        app,
        stream_id,
        resp,
        cancel,
        |data| crate::anthropic::parse_sse_data(data).into_iter().collect(),
        |_| None,
    )
    .await
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
    let fallback_text = Arc::new(Mutex::new(String::new()));
    let fallback_reasoning = Arc::new(Mutex::new(String::new()));
    let text_slot = fallback_text.clone();
    let thought_slot = fallback_reasoning.clone();
    crate::model_providers::runner::consume_sse(
        app,
        stream_id,
        resp,
        cancel,
        move |data| parse_xai_data(data, &text_slot, &thought_slot),
        move |session| {
            let reasoning = fallback_reasoning.lock().ok().map(|s| s.clone()).unwrap_or_default();
            if !session.saw_reasoning() && !reasoning.is_empty() {
                let _ = app.emit(
                    "dev-chat",
                    DevChatEvent {
                        stream_id: stream_id.into(),
                        kind: "reasoning".into(),
                        text: Some(reasoning),
                        tool_calls: None,
                        usage: None,
                        thinking: None,
                    },
                );
            }
            let text = fallback_text.lock().ok().map(|s| s.clone()).unwrap_or_default();
            fallback_done_text(session.saw_text(), &text)
        },
    )
    .await
}

fn parse_xai_data(
    data: &str,
    fallback_text: &Mutex<String>,
    fallback_reasoning: &Mutex<String>,
) -> Vec<crate::model_providers::event::StreamPiece> {
    use crate::model_providers::event::StreamPiece;
    let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
        return Vec::new();
    };
    let mut pieces = Vec::new();
    if let Some(usage) = parse_usage(&json) {
        pieces.push(StreamPiece::Usage {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
        });
    }
    let Some(choice) = json.get("choices").and_then(|c| c.get(0)) else {
        return pieces;
    };
    let delta = choice.get("delta").cloned().unwrap_or(serde_json::Value::Null);
    let text = delta.get("content").map(text_from_content).unwrap_or_default();
    if !text.is_empty() {
        pieces.push(StreamPiece::Delta(text));
    }
    let thought = reasoning_from_delta(&delta);
    if !thought.is_empty() {
        pieces.push(StreamPiece::Reasoning(thought));
    }
    let fallback = fallback_choice_text(choice);
    if !fallback.is_empty() {
        if let Ok(mut slot) = fallback_text.lock() {
            *slot = fallback;
        }
    }
    let thought_fallback = message_reasoning(choice);
    if !thought_fallback.is_empty() {
        if let Ok(mut slot) = fallback_reasoning.lock() {
            *slot = thought_fallback;
        }
    }
    if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
        for call in calls {
            let index = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32;
            let id = call.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
            let name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            if !id.is_empty() || !name.is_empty() {
                pieces.push(StreamPiece::ToolStart { index, id, name });
            }
            if !arguments.is_empty() {
                pieces.push(StreamPiece::ToolDelta {
                    index,
                    partial: arguments,
                });
            }
        }
    }
    pieces
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

fn parse_usage(json: &serde_json::Value) -> Option<DevChatUsage> {
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
    // xAI already counts cached tokens inside prompt_tokens. Keep the breakdown anyway.
    let prompt_tokens = reported_prompt;
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
        cache_read_tokens: cached,
        cache_creation_tokens: 0,
    })
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
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
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
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
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
    fn claude_tools_omit_grok_plan_mode() {
        let names = |tools: serde_json::Value| {
            tools
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|tool| {
                    tool.get("function")
                        .and_then(|row| row.get("name"))
                        .and_then(|name| name.as_str())
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
        };
        let grok = names(tools_json(false));
        assert!(grok.iter().any(|name| name == "enter_plan_mode"));
        assert!(grok.iter().any(|name| name == "exit_plan_mode"));
        let claude = names(tools_json_for(true, false));
        assert!(!claude.iter().any(|name| name == "enter_plan_mode"));
        assert!(!claude.iter().any(|name| name == "exit_plan_mode"));
        assert!(claude.iter().any(|name| name == "update_journey_knowledge"));
    }

    #[test]
    fn message_reasoning_reads_the_final_message() {
        let choice = serde_json::json!({
            "message": { "reasoning_content": "Thought.", "content": "Answer" }
        });
        assert_eq!(message_reasoning(&choice), "Thought.");
    }
}
