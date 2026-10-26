use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use super::types::{DevChatEvent, DevChatUsage};
use crate::error::{Error, Result};
use crate::grok_cli;
use crate::state::AppState;

fn http_client() -> &'static reqwest::Client {
    crate::model_providers::runner::http_client()
}

pub(crate) fn streams() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static STREAMS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One model round collected inside this process. The local turn loop reads this
/// instead of the webview, so a reload does not drop the round.
pub struct CollectedRound {
    pub text: String,
    pub reasoning: String,
    pub tool_calls: Vec<super::types::DevToolCall>,
    pub thinking: Vec<crate::model_providers::ThinkingBlock>,
    pub usage: Option<DevChatUsage>,
    pub error: Option<String>,
}

pub struct RoundProgress {
    pub kind: &'static str,
    pub text: String,
}

struct RoundSlot {
    tx: std::sync::mpsc::Sender<DevChatEvent>,
}

fn round_slots() -> &'static Mutex<HashMap<String, RoundSlot>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, RoundSlot>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn publish_round_event(event: &DevChatEvent) {
    publish_round(event);
}

/// One small piece of a coalesced delta. The page appends these while the round is open.
pub(crate) fn note_round_piece(stream_id: &str, kind: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    publish_round(&DevChatEvent {
        stream_id: stream_id.to_string(),
        kind: kind.to_string(),
        text: Some(text.to_string()),
        tool_calls: None,
        usage: None,
        thinking: None,
        conversation: None,
    });
}

fn publish_round(event: &DevChatEvent) {
    let Ok(map) = round_slots().lock() else {
        return;
    };
    if let Some(slot) = map.get(&event.stream_id) {
        let _ = slot.tx.send(event.clone());
    }
}

/// Run one model round and return when it finishes. Events are still emitted for a page
/// that is listening, and also queued for the turn that started this stream.
pub async fn collect_chat_round(
    app: AppHandle,
    state: State<'_, AppState>,
    messages: serde_json::Value,
    model: Option<String>,
    effort: Option<String>,
    context_window: Option<u64>,
    journey_id: Option<String>,
    cancel: Arc<AtomicBool>,
    on_progress: impl Fn(RoundProgress) + Send + 'static,
) -> Result<CollectedRound> {
    let stream_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    if let Ok(mut map) = round_slots().lock() {
        map.insert(stream_id.clone(), RoundSlot { tx });
    }
    if let Ok(mut map) = streams().lock() {
        map.insert(stream_id.clone(), cancel);
    }
    let started = dev_chat_start(
        app,
        state,
        stream_id.clone(),
        messages,
        model,
        effort,
        context_window,
        journey_id,
    )
    .await;
    if let Err(err) = started {
        if let Ok(mut map) = round_slots().lock() {
            map.remove(&stream_id);
        }
        return Err(err);
    }
    let stream_id_for_wait = stream_id.clone();
    let round = tokio::task::spawn_blocking(move || wait_round(&stream_id_for_wait, rx, on_progress))
        .await
        .map_err(|err| Error::Other(format!("model round failed: {err}")))?;
    if let Ok(mut map) = round_slots().lock() {
        map.remove(&stream_id);
    }
    Ok(round)
}

fn wait_round(
    stream_id: &str,
    rx: std::sync::mpsc::Receiver<DevChatEvent>,
    on_progress: impl Fn(RoundProgress),
) -> CollectedRound {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    let mut thinking = Vec::new();
    let mut usage = None;
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(15 * 60) {
            dev_chat_cancel(stream_id.to_string());
            return CollectedRound {
                text,
                reasoning,
                tool_calls,
                thinking,
                usage,
                error: Some("the model stream timed out".into()),
            };
        }
        let event = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(event) => event,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let gone = streams().lock().ok().is_some_and(|map| !map.contains_key(stream_id));
                if gone && started.elapsed() > Duration::from_millis(500) {
                    return CollectedRound {
                        text,
                        reasoning,
                        tool_calls,
                        thinking,
                        usage,
                        error: Some("the model stream closed".into()),
                    };
                }
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return CollectedRound {
                    text,
                    reasoning,
                    tool_calls,
                    thinking,
                    usage,
                    error: Some("the model stream closed".into()),
                };
            }
        };
        match event.kind.as_str() {
            "delta" => {
                if let Some(chunk) = event.text.clone() {
                    text.push_str(&chunk);
                    on_progress(RoundProgress { kind: "delta", text: chunk });
                }
            }
            "reasoning" => {
                if let Some(chunk) = event.text.clone() {
                    reasoning.push_str(&chunk);
                    on_progress(RoundProgress { kind: "reasoning", text: chunk });
                }
            }
            "usage" => usage = event.usage.or(usage),
            "done" => {
                if let Some(calls) = event.tool_calls {
                    tool_calls = calls;
                }
                if let Some(blocks) = event.thinking {
                    thinking = blocks;
                }
                if let Some(next) = event.usage {
                    usage = Some(next);
                }
                if text.is_empty() {
                    if let Some(full) = event.text {
                        text = full;
                    }
                }
                return CollectedRound {
                    text,
                    reasoning,
                    tool_calls,
                    thinking,
                    usage,
                    error: None,
                };
            }
            "error" => {
                return CollectedRound {
                    text,
                    reasoning,
                    tool_calls,
                    thinking,
                    usage,
                    error: Some(event.text.unwrap_or_else(|| "xAI request failed.".into())),
                };
            }
            _ => {}
        }
    }
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
                "name": "grep",
                "description": "Search file contents in the workspace. Returns matching lines as path:line:text. The pattern is a case-insensitive substring, not a regular expression. Every text file is searched, including .ts and .tsx, unless glob says otherwise. Skips node_modules, target, dist, build, and .git. A miss means the substring was not found. It does not mean a file type was skipped. Use this to find a symbol instead of listing folders or running a shell search.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Literal text to find. Matched case-insensitively. Not a regular expression: dots and brackets match themselves." },
                        "path": { "type": "string", "description": "Folder or file relative to the workspace. Empty searches the whole workspace." },
                        "glob": { "type": "string", "description": "Optional file glob, such as *.rs, *.ts, or src/**/*.tsx. * matches any file name, including .ts and .tsx. Empty searches every text file." }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find files and folders by path pattern. Returns workspace-relative paths. Skips node_modules, target, dist, build, and .git. Use this to find files by name instead of listing the tree.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Glob such as **/*.ts or src/**/mod.rs. * stays in one segment. ** crosses folders." },
                        "path": { "type": "string", "description": "Folder relative to the workspace. Empty starts at the workspace root." }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file in the workspace. Optional offset and limit return a 1-based line range. Use them for large files instead of reading everything. Returned lines are prefixed with their line numbers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "offset": { "type": "integer", "description": "1-based starting line. Omit to start at line 1." },
                        "limit": { "type": "integer", "description": "Max number of lines to return. Omit to read to the end." }
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
    // A local turn already registered this stream's cancel flag. Keep that one so Stop
    // reaches the request. A page-started chat has no flag yet.
    let cancel = streams()
        .lock()
        .ok()
        .and_then(|map| map.get(&stream_id).cloned())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
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
            let event = DevChatEvent {
                stream_id: sid.clone(),
                kind: "error".into(),
                text: Some(e.to_string()),
                tool_calls: None,
                usage: None,
                thinking: None,
                conversation: None,
            };
            publish_round(&event);
            let _ = app2.emit("dev-chat", event);
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
    let body = twanagent_service::xai::chat_body(&model, effort.as_deref(), &messages, &tools_json(include_journey));
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
        let msg = if status.as_u16() == 401 && auth.via_cli {
            "Grok CLI login expired. Run grok login, or add an API key in Settings.".to_string()
        } else {
            twanagent_service::xai::http_error_message(status.as_u16(), &text)
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
                        conversation: None,
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
    let text = delta
        .get("content")
        .map(twanagent_service::xai::text_from_content)
        .unwrap_or_default();
    if !text.is_empty() {
        pieces.push(StreamPiece::Delta(text));
    }
    let thought = twanagent_service::xai::reasoning_from_delta(&delta);
    if !thought.is_empty() {
        pieces.push(StreamPiece::Reasoning(thought));
    }
    let fallback = twanagent_service::xai::fallback_choice_text(choice);
    if !fallback.is_empty() {
        if let Ok(mut slot) = fallback_text.lock() {
            *slot = fallback;
        }
    }
    let thought_fallback = twanagent_service::xai::message_reasoning(choice);
    if !thought_fallback.is_empty() {
        if let Ok(mut slot) = fallback_reasoning.lock() {
            *slot = thought_fallback;
        }
    }
    for call in twanagent_service::xai::tool_fragments(&delta) {
        if !call.id.is_empty() || !call.name.is_empty() {
            pieces.push(StreamPiece::ToolStart {
                index: call.index,
                id: call.id,
                name: call.name,
            });
        }
        if !call.arguments.is_empty() {
            pieces.push(StreamPiece::ToolDelta {
                index: call.index,
                partial: call.arguments,
            });
        }
    }
    pieces
}

fn fallback_done_text(emitted_text: bool, fallback: &str) -> Option<String> {
    if emitted_text || fallback.is_empty() {
        None
    } else {
        Some(fallback.to_string())
    }
}

fn parse_usage(json: &serde_json::Value) -> Option<DevChatUsage> {
    let usage = twanagent_service::xai::parse_usage(json)?;
    Some(DevChatUsage {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        cache_read_tokens: usage.cache_read_tokens,
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
        assert_eq!(twanagent_service::xai::text_from_content(&serde_json::json!("Hello")), "Hello");
        assert_eq!(
            twanagent_service::xai::text_from_content(&serde_json::json!([
                { "type": "text", "text": "Hi " },
                { "type": "output_text", "text": "there" }
            ])),
            "Hi there"
        );
        assert_eq!(twanagent_service::xai::text_from_content(&serde_json::json!(null)), "");
    }

    #[test]
    fn fallback_choice_text_uses_message_when_delta_is_empty() {
        let choice = serde_json::json!({
            "delta": { "content": null },
            "message": { "role": "assistant", "content": "Saved." }
        });
        assert_eq!(twanagent_service::xai::fallback_choice_text(&choice), "Saved.");
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
        assert_eq!(twanagent_service::xai::reasoning_from_delta(&delta), "The ");
    }

    #[test]
    fn text_and_reasoning_stay_split_in_content_parts() {
        let delta = serde_json::json!({
            "content": [
                { "type": "reasoning", "text": "secret" },
                { "type": "text", "text": "Hi" }
            ]
        });
        assert_eq!(twanagent_service::xai::text_from_content(delta.get("content").unwrap()), "Hi");
        assert_eq!(twanagent_service::xai::reasoning_from_delta(&delta), "secret");
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
        assert!(grok.iter().any(|name| name == "grep"));
        assert!(grok.iter().any(|name| name == "glob"));
        let claude = names(tools_json_for(true, false));
        assert!(!claude.iter().any(|name| name == "enter_plan_mode"));
        assert!(!claude.iter().any(|name| name == "exit_plan_mode"));
        assert!(claude.iter().any(|name| name == "grep"));
        assert!(claude.iter().any(|name| name == "glob"));
        assert!(claude.iter().any(|name| name == "update_journey_knowledge"));
    }

    #[test]
    fn read_file_tool_accepts_a_line_range() {
        let tools = tools_json(false);
        let read = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| {
                tool.get("function")
                    .and_then(|row| row.get("name"))
                    .and_then(|name| name.as_str())
                    == Some("read_file")
            })
            .unwrap();
        let props = &read["function"]["parameters"]["properties"];
        assert!(props.get("offset").is_some());
        assert!(props.get("limit").is_some());
    }

    #[test]
    fn message_reasoning_reads_the_final_message() {
        let choice = serde_json::json!({
            "message": { "reasoning_content": "Thought.", "content": "Answer" }
        });
        assert_eq!(twanagent_service::xai::message_reasoning(&choice), "Thought.");
    }
}
