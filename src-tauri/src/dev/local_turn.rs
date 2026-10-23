//! A local chat turn runs in this process, not in the webview.
//! Reloading the window, or a React crash that remounts it, leaves the turn running.
//! The new page asks which turns are still going and keeps painting their events.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use super::types::{DevChatEvent, DevToolCall};
use crate::error::{Error, Result};
use crate::state::AppState;

const EVENT: &str = "dev-local-turn";
const FAILURE_PREFIX: &str = "Couldn't continue: ";

#[derive(Debug, Clone, Deserialize)]
pub struct LocalTurnStart {
    pub workspace: String,
    pub conversation_id: String,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub permission: String,
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub journey_id: Option<String>,
    #[serde(default)]
    pub allow_spawn: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalTurnInfo {
    pub conversation_id: String,
    pub workspace: String,
}

struct ShellWait {
    command: String,
    tx: std::sync::mpsc::Sender<bool>,
}

struct PlanWait {
    tx: std::sync::mpsc::Sender<PlanAnswer>,
}

struct PlanAnswer {
    decision: String,
    note: String,
}

struct LiveTurn {
    workspace: PathBuf,
    cancel: Arc<AtomicBool>,
    shell: Mutex<Vec<ShellWait>>,
    plan: Mutex<Vec<PlanWait>>,
}

fn turns() -> &'static Mutex<HashMap<String, Arc<LiveTurn>>> {
    static TURNS: OnceLock<Mutex<HashMap<String, Arc<LiveTurn>>>> = OnceLock::new();
    TURNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emit(app: &AppHandle, conversation_id: &str, kind: &str, text: Option<String>, tool: Option<DevToolCall>, saved: Option<Value>) {
    let _ = app.emit(
        EVENT,
        DevChatEvent {
            stream_id: conversation_id.to_string(),
            kind: kind.to_string(),
            text,
            tool_calls: tool.map(|call| vec![call]),
            usage: None,
            thinking: None,
            conversation: saved,
        },
    );
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_local_turns() -> Vec<LocalTurnInfo> {
    let Ok(map) = turns().lock() else {
        return Vec::new();
    };
    map.iter()
        .filter(|(_, turn)| !turn.cancel.load(Ordering::Relaxed))
        .map(|(id, turn)| LocalTurnInfo {
            conversation_id: id.clone(),
            workspace: turn.workspace.to_string_lossy().into_owned(),
        })
        .collect()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_local_turn_stop(conversation_id: String) {
    let Some(turn) = turns().lock().ok().and_then(|map| map.get(&conversation_id).cloned()) else {
        return;
    };
    turn.cancel.store(true, Ordering::Relaxed);
    if let Ok(mut waits) = turn.shell.lock() {
        for wait in waits.drain(..) {
            let _ = wait.tx.send(false);
        }
    }
    if let Ok(mut waits) = turn.plan.lock() {
        for wait in waits.drain(..) {
            let _ = wait.tx.send(PlanAnswer {
                decision: "decline".into(),
                note: String::new(),
            });
        }
    };
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_local_turn_shell(conversation_id: String, command: String, allow: bool) -> Result<()> {
    let turn = live(&conversation_id).ok_or_else(|| Error::Other("that chat is not waiting on a command".into()))?;
    let mut waits = turn.shell.lock().map_err(|_| Error::Other("shell wait is busy".into()))?;
    if waits.is_empty() {
        return Err(Error::Other("that chat is not waiting on a command".into()));
    }
    let index = waits.iter().position(|wait| wait.command == command).unwrap_or(0);
    let at = index.min(waits.len() - 1);
    let wait = waits.remove(at);
    let _ = wait.tx.send(allow);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_local_turn_plan(conversation_id: String, decision: String, note: Option<String>) -> Result<()> {
    let turn = live(&conversation_id).ok_or_else(|| Error::Other("that chat is not waiting on a plan".into()))?;
    let mut waits = turn.plan.lock().map_err(|_| Error::Other("plan wait is busy".into()))?;
    let Some(wait) = waits.pop() else {
        return Err(Error::Other("that chat is not waiting on a plan".into()));
    };
    let _ = wait.tx.send(PlanAnswer {
        decision,
        note: note.unwrap_or_default(),
    });
    Ok(())
}

fn live(id: &str) -> Option<Arc<LiveTurn>> {
    turns().lock().ok().and_then(|map| map.get(id).cloned())
}

/// Start the turn and return. Events arrive on `dev-local-turn` until `idle`.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_local_turn_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: LocalTurnStart,
) -> Result<()> {
    let id = request.conversation_id.trim().to_string();
    if id.is_empty() {
        return Err(Error::Other("conversation id is empty".into()));
    }
    let workspace = state.require_workspace(&request.workspace)?;
    if let Some(old) = live(&id) {
        old.cancel.store(true, Ordering::Relaxed);
    }
    let live_turn = Arc::new(LiveTurn {
        workspace: workspace.clone(),
        cancel: Arc::new(AtomicBool::new(false)),
        shell: Mutex::new(Vec::new()),
        plan: Mutex::new(Vec::new()),
    });
    if let Ok(mut map) = turns().lock() {
        map.insert(id.clone(), live_turn.clone());
    }
    let data_dir = state.data_dir.clone();
    let app_for_turn = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drive(&app_for_turn, &data_dir, &workspace, &request, &live_turn)
        }));
        if let Err(panic) = outcome {
            let text = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_string()))
                .unwrap_or_else(|| "the turn stopped unexpectedly".into());
            emit(&app_for_turn, &id, "error", Some(text), None, None);
        }
        emit(&app_for_turn, &id, "idle", None, None, None);
        if let Ok(mut map) = turns().lock() {
            if map.get(&id).is_some_and(|slot| Arc::ptr_eq(slot, &live_turn)) {
                map.remove(&id);
            }
        }
    });
    Ok(())
}

fn drive(app: &AppHandle, data_dir: &Path, workspace: &Path, request: &LocalTurnStart, live: &Arc<LiveTurn>) {
    let id = request.conversation_id.trim();
    let model = if request.model.trim().is_empty() {
        "grok-4.6".to_string()
    } else {
        request.model.trim().to_string()
    };
    let provider = crate::model_providers::registry::find(&model);
    let plan = crate::model_providers::registry::plan_mode(provider);
    let permission = normalize_permission(&request.permission);
    let mut transcript = request.messages.clone();
    let saved_len = 0usize;
    let window = request.context_window.filter(|value| *value > 0).unwrap_or(0);
    loop {
        if stopped(live) {
            emit(app, id, "stopped", None, None, None);
            return;
        }
        close_dangling(&mut transcript);
        let prompt = build_prompt(workspace, &transcript, &request.system, &permission, &model, plan);
        let round = match stream_round(app, id, &model, &request.effort, window, prompt, &live.cancel, request.journey_id.clone()).await_round() {
            Ok(round) => round,
            Err(err) => {
                fail(app, id, &mut transcript, &err.to_string());
                save(data_dir, &request.workspace, id, &transcript, saved_len);
                emit_saved(app, id, &transcript);
                return;
            }
        };
        record_round_usage(data_dir, &request.workspace, id, &model, round.usage.as_ref());
        if stopped(live) || round.error.as_deref() == Some("Stopped.") {
            keep_partial(&mut transcript, &round);
            save(data_dir, &request.workspace, id, &transcript, saved_len);
            emit_saved(app, id, &transcript);
            emit(app, id, "stopped", None, None, None);
            return;
        }
        if let Some(error) = round.error {
            fail(app, id, &mut transcript, &error);
            save(data_dir, &request.workspace, id, &transcript, saved_len);
            emit_saved(app, id, &transcript);
            return;
        }
        if round.tool_calls.is_empty() {
            if round.text.trim().is_empty() && round.reasoning.trim().is_empty() {
                fail(app, id, &mut transcript, "Grok returned an empty reply.");
            } else {
                transcript.push(assistant_value(&round.text, &round.reasoning, &[], &round.thinking));
            }
            save(data_dir, &request.workspace, id, &transcript, saved_len);
            emit_saved(app, id, &transcript);
            emit(app, id, "done", None, None, None);
            return;
        }
        transcript.push(assistant_value(&round.text, &round.reasoning, &round.tool_calls, &round.thinking));
        save(data_dir, &request.workspace, id, &transcript, saved_len);
        emit_saved(app, id, &transcript);
        for call in &round.tool_calls {
            let content = if stopped(live) {
                "Skipped: stopped.".to_string()
            } else {
                emit(app, id, "tool", Some(call.name.clone()), Some(call.clone()), None);
                run_tool(app, id, workspace, data_dir, &request.workspace, call, &permission, request.journey_id.as_deref(), plan, request.allow_spawn, live)
            };
            if content.starts_with("Wrote ")
                || content.starts_with("Edited ")
                || content.starts_with("Committed ")
                || call.name == "run_command"
            {
                emit(app, id, "refresh", None, None, None);
            }
            let stored = if content.is_empty() {
                "Error: the command did not finish.".to_string()
            } else {
                cap_tool_text(&content)
            };
            transcript.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": stored,
            }));
            save(data_dir, &request.workspace, id, &transcript, saved_len);
            emit_saved(app, id, &transcript);
        }
    }
}

struct Round {
    text: String,
    reasoning: String,
    tool_calls: Vec<DevToolCall>,
    thinking: Vec<crate::model_providers::ThinkingBlock>,
    usage: Option<super::types::DevChatUsage>,
    error: Option<String>,
}

struct RoundWait {
    app: AppHandle,
    conversation_id: String,
    model: String,
    effort: String,
    context_window: u64,
    messages: Vec<Value>,
    cancel: Arc<AtomicBool>,
    journey_id: Option<String>,
}

impl RoundWait {
    fn await_round(self) -> Result<Round> {
        let RoundWait {
            app,
            conversation_id,
            model,
            effort,
            context_window,
            messages,
            cancel,
            journey_id,
        } = self;
        let state = app.state::<AppState>();
        let progress_app = app.clone();
        let progress_id = conversation_id.clone();
        let collected = tauri::async_runtime::block_on(super::chat::collect_chat_round(
            app.clone(),
            state,
            Value::Array(messages),
            Some(model),
            Some(effort).filter(|value| !value.trim().is_empty()),
            (context_window > 0).then_some(context_window),
            journey_id.filter(|value| !value.trim().is_empty()),
            cancel.clone(),
            move |progress| {
                if progress.text.is_empty() {
                    return;
                }
                emit(&progress_app, &progress_id, progress.kind, Some(progress.text), None, None);
            },
        ))?;
        let error = if cancel.load(Ordering::Relaxed) {
            Some("Stopped.".into())
        } else {
            collected.error
        };
        Ok(Round {
            text: collected.text,
            reasoning: collected.reasoning,
            tool_calls: collected.tool_calls,
            thinking: collected.thinking,
            usage: collected.usage,
            error,
        })
    }
}

fn stream_round(
    app: &AppHandle,
    conversation_id: &str,
    model: &str,
    effort: &str,
    context_window: u64,
    messages: Vec<Value>,
    cancel: &Arc<AtomicBool>,
    journey_id: Option<String>,
) -> RoundWait {
    RoundWait {
        app: app.clone(),
        conversation_id: conversation_id.to_string(),
        model: model.to_string(),
        effort: effort.to_string(),
        context_window,
        messages,
        cancel: cancel.clone(),
        journey_id,
    }
}

fn run_tool(
    app: &AppHandle,
    conversation_id: &str,
    workspace: &Path,
    data_dir: &Path,
    workspace_key: &str,
    call: &DevToolCall,
    permission: &str,
    journey_id: Option<&str>,
    plan: bool,
    allow_spawn: bool,
    live: &Arc<LiveTurn>,
) -> String {
    if permission == "read-only" && matches!(call.name.as_str(), "write_file" | "edit_file" | "run_command" | "git_commit") {
        return format!("Error: {} is blocked in read-only mode.", call.name);
    }
    let args = parse_args(&call.arguments);
    let result = match call.name.as_str() {
        "list_dir" => json_ok(super::files::list_dir(workspace, str_arg(&args, "path"))),
        "grep" => super::files::grep(
            workspace,
            str_arg(&args, "pattern"),
            str_arg(&args, "path"),
            str_arg(&args, "glob"),
        ),
        "glob" => super::files::glob(workspace, str_arg(&args, "pattern"), str_arg(&args, "path")),
        "read_file" => super::files::read_file(workspace, str_arg(&args, "path")),
        "write_file" => super::files::write_file(workspace, str_arg(&args, "path"), str_arg(&args, "contents"))
            .map(|_| format!("Wrote {}", str_arg(&args, "path"))),
        "edit_file" => super::files::edit_file(
            workspace,
            str_arg(&args, "path"),
            str_arg(&args, "old_string"),
            str_arg(&args, "new_string"),
        )
        .map(|_| format!("Edited {}", str_arg(&args, "path"))),
        "git_status" => git_target(workspace, data_dir).and_then(|target| {
            super::git::git_status_with(&target, true)
                .and_then(|rows| serde_json::to_string_pretty(&rows).map_err(Error::from))
        }),
        "git_diff" => git_target(workspace, data_dir).and_then(|target| {
            let commit = str_arg(&args, "commit");
            if commit.is_empty() {
                super::git::git_diff(&target, str_arg(&args, "path"))
            } else {
                super::git::git_show(&target, commit)
            }
        }),
        "git_log" => git_target(workspace, data_dir).and_then(|target| {
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 80) as u32;
            super::git::git_log(&target, limit)
                .and_then(|rows| serde_json::to_string_pretty(&rows).map_err(Error::from))
        }),
        "git_commit" => commit_files(workspace, data_dir, &args),
        "run_command" => run_shell(app, conversation_id, workspace, str_arg(&args, "command"), permission, live),
        "web_search" => search(app, data_dir, &call.arguments),
        "todo_write" => Ok(todo_text(&call.arguments)),
        "update_journey_knowledge" => update_journey(data_dir, workspace_key, journey_id, &args),
        "enter_plan_mode" | "exit_plan_mode" => {
            if !plan {
                return format!("Error: {} is only available in a Grok chat.", call.name);
            }
            return ask_plan(app, conversation_id, &call.name, live);
        }
        "spawn_subagent" => {
            if !allow_spawn {
                return "Error: subagents cannot spawn subagents.".into();
            }
            return "Error: spawn_subagent is not available while the app is reloading. Ask again after it reopens.".into();
        }
        other => return format!("Unknown tool: {other}"),
    };
    match result {
        Ok(text) => text,
        Err(err) => format!("Error: {err}"),
    }
}

fn search(app: &AppHandle, data_dir: &Path, arguments: &str) -> Result<String> {
    let app = app.clone();
    let data_dir = data_dir.to_path_buf();
    let arguments = arguments.to_string();
    let stream = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::block_on(crate::web_search::search(&app, &data_dir, &stream, &arguments))
}

fn run_shell(
    app: &AppHandle,
    conversation_id: &str,
    workspace: &Path,
    command: &str,
    permission: &str,
    live: &LiveTurn,
) -> Result<String> {
    let allowed = match permission {
        "approve-all" => true,
        "read-only" => false,
        _ => ask_shell(app, conversation_id, command, live)?,
    };
    if !allowed {
        return Ok("User skipped this command.".into());
    }
    if stopped_flag(&live.cancel) {
        return Ok("Skipped: stopped.".into());
    }
    let app_chunks = app.clone();
    let id = conversation_id.to_string();
    super::cmd::run_command_streaming(workspace, command, &uuid::Uuid::new_v4().to_string(), move |chunk| {
        emit(&app_chunks, &id, "command", Some(chunk.to_string()), None, None);
    })
}

fn ask_shell(app: &AppHandle, conversation_id: &str, command: &str, live: &LiveTurn) -> Result<bool> {
    let (tx, rx) = std::sync::mpsc::channel();
    if let Ok(mut waits) = live.shell.lock() {
        waits.push(ShellWait {
            command: command.to_string(),
            tx,
        });
    }
    emit(app, conversation_id, "shell", Some(command.to_string()), None, None);
    Ok(rx.recv_timeout(Duration::from_secs(600)).unwrap_or(false))
}

fn ask_plan(app: &AppHandle, conversation_id: &str, name: &str, live: &LiveTurn) -> String {
    let prompt = if name == "enter_plan_mode" {
        json!({ "kind": "enter" })
    } else {
        json!({ "kind": "exit", "content": "" })
    };
    let (tx, rx) = std::sync::mpsc::channel();
    if let Ok(mut waits) = live.plan.lock() {
        waits.push(PlanWait { tx });
    }
    emit(app, conversation_id, "plan", Some(prompt.to_string()), None, None);
    let Ok(answer) = rx.recv_timeout(Duration::from_secs(600)) else {
        return "Skipped: stopped.".into();
    };
    if name == "enter_plan_mode" {
        return if answer.decision == "approve" {
            "Plan mode is active. Explore and write the plan with write_file to path plan.md. Do not edit other files. Call exit_plan_mode when the plan is ready.".into()
        } else {
            "The user declined plan mode. Stay in normal mode and continue the task.".into()
        };
    }
    match answer.decision.as_str() {
        "approve" => {
            let extra = answer.note.trim();
            if extra.is_empty() {
                "The user approved the plan. Plan mode is off. Implement the plan.".into()
            } else {
                format!("The user approved the plan. Plan mode is off. Implement the plan.\nThe user edited the plan. Implement this version:\n{extra}")
            }
        }
        "quit" => "The user quit the plan. Plan mode is off. Do not implement it.".into(),
        _ => {
            let extra = answer.note.trim();
            if extra.is_empty() {
                "The user wants changes. Plan mode stays active. Revise plan.md.".into()
            } else {
                format!("The user wants changes. Plan mode stays active. Revise plan.md to address:\n{extra}")
            }
        }
    }
}

fn commit_files(workspace: &Path, data_dir: &Path, args: &serde_json::Map<String, Value>) -> Result<String> {
    let target = git_target(workspace, data_dir)?;
    let paths: Vec<String> = args
        .get("paths")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if paths.is_empty() {
        let pending: Vec<String> = super::git::git_status_with(&target, false)?
            .into_iter()
            .filter(|row| !row.staged)
            .map(|row| row.path)
            .collect();
        if !pending.is_empty() {
            super::git::git_stage(&target, &pending)?;
        }
    } else {
        super::git::git_stage(&target, &paths)?;
    }
    let hash = super::git::git_commit(&target, str_arg(args, "message"))?;
    Ok(format!("Committed {hash}"))
}

fn git_target(workspace: &Path, data_dir: &Path) -> Result<super::git::GitTarget> {
    super::git::GitTarget::local_in(workspace, &[], data_dir)
}

fn update_journey(
    data_dir: &Path,
    workspace: &str,
    journey_id: Option<&str>,
    args: &serde_json::Map<String, Value>,
) -> Result<String> {
    let Some(journey_id) = journey_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Err(Error::Other(
            "update_journey_knowledge is only available in a Journey chat.".into(),
        ));
    };
    let dir = super::conv::conv_store_dir(data_dir, workspace);
    crate::store::with_conn(&dir, |conn| {
        crate::store::update_knowledge(
            &dir,
            conn,
            journey_id,
            str_arg(args, "mode"),
            args.get("contents").and_then(Value::as_str),
            args.get("old_string").and_then(Value::as_str),
            args.get("new_string").and_then(Value::as_str),
        )
    })
}

fn todo_text(arguments: &str) -> String {
    let count = parse_args(arguments)
        .get("todos")
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);
    if count == 1 {
        "Updated 1 todo.".into()
    } else {
        format!("Updated {count} todos.")
    }
}

fn json_ok<T: serde::Serialize>(result: Result<T>) -> Result<String> {
    result.and_then(|value| serde_json::to_string_pretty(&value).map_err(Error::from))
}

const TOOL_TEXT_CAP: usize = 24_000;
const TOOL_TEXT_HEAD: usize = 20_000;
const TOOL_TEXT_TAIL: usize = 2_000;

/// Keep the start and end of a huge tool result so the next round does not resend it all.
fn cap_tool_text(text: &str) -> String {
    let len = text.chars().count();
    if len <= TOOL_TEXT_CAP {
        return text.to_string();
    }
    let head: String = text.chars().take(TOOL_TEXT_HEAD).collect();
    let tail: String = text.chars().skip(len - TOOL_TEXT_TAIL).collect();
    let omitted = len - TOOL_TEXT_HEAD - TOOL_TEXT_TAIL;
    format!("{head}\n… omitted {omitted} characters …\n{tail}")
}

fn build_prompt(
    workspace: &Path,
    transcript: &[Value],
    system: &str,
    permission: &str,
    model: &str,
    plan: bool,
) -> Vec<Value> {
    let base = if system.trim().is_empty() {
        let perm = match permission {
            "approve-all" => "File edits and shell commands run without asking.",
            "read-only" => "Read-only: do not edit files or run shell commands.",
            _ => "File edits apply immediately. Shell commands require the user to approve.",
        };
        let plan_line = if plan {
            " Plan mode tools are available. Use them only when the user asks for a plan."
        } else {
            ""
        };
        format!(
            "You are a coding agent in TwanAgent ({model}).\nWorkspace: {}\n{perm}{plan_line}\nPrefer edit_file for small changes. Don't commit unless asked. Be concise.",
            workspace.display()
        )
    } else {
        system.trim().to_string()
    };
    let mut messages = vec![json!({ "role": "system", "content": base })];
    messages.extend(transcript.iter().cloned());
    messages
}

fn fail(app: &AppHandle, id: &str, transcript: &mut Vec<Value>, error: &str) {
    emit(app, id, "error", Some(error.to_string()), None, None);
    transcript.push(json!({
        "role": "assistant",
        "content": format!("{FAILURE_PREFIX}{error}"),
        "error": true,
    }));
}

fn keep_partial(transcript: &mut Vec<Value>, round: &Round) {
    if round.text.trim().is_empty() && round.reasoning.trim().is_empty() {
        return;
    }
    transcript.push(assistant_value(&round.text, &round.reasoning, &[], &round.thinking));
}

fn assistant_value(text: &str, reasoning: &str, tools: &[DevToolCall], thinking: &[crate::model_providers::ThinkingBlock]) -> Value {
    let mut message = json!({ "role": "assistant", "content": text });
    if !reasoning.trim().is_empty() {
        message["reasoning"] = Value::String(reasoning.trim().to_string());
    }
    if !tools.is_empty() {
        message["tool_calls"] = serde_json::to_value(tools).unwrap_or(Value::Null);
    }
    if !thinking.is_empty() {
        if let Ok(value) = serde_json::to_value(thinking) {
            message["thinking"] = value;
        }
    }
    message
}

fn close_dangling(transcript: &mut Vec<Value>) {
    let mut answered = HashSet::new();
    for message in transcript.iter() {
        if message.get("role").and_then(Value::as_str) == Some("tool") {
            if let Some(id) = message.get("tool_call_id").and_then(Value::as_str) {
                answered.insert(id.to_string());
            }
        }
    }
    let mut missing = Vec::new();
    for message in transcript.iter() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(calls) = message.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        for call in calls {
            let Some(id) = call.get("id").and_then(Value::as_str) else {
                continue;
            };
            if id.is_empty() || !answered.insert(id.to_string()) {
                continue;
            }
            missing.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": "Error: the command did not finish.",
            }));
        }
    }
    transcript.extend(missing);
}

/// One model round, including a tool round. The usage screen reads this database.
/// A reload can drop the page, so the turn records it here instead of waiting for the webview.
fn record_round_usage(
    data_dir: &Path,
    workspace: &str,
    conversation_id: &str,
    model: &str,
    usage: Option<&super::types::DevChatUsage>,
) {
    let Some(usage) = usage else {
        return;
    };
    if usage.prompt_tokens == 0 && usage.completion_tokens == 0 {
        return;
    }
    let title = crate::store::with_conn(&super::conv::conv_store_dir(data_dir, workspace), |conn| {
        crate::store::get_conversation(conn, conversation_id).map(|row| row.title)
    })
    .ok()
    .filter(|title| !title.trim().is_empty())
    .unwrap_or_else(|| "Chat".into());
    let _ = crate::usage::record(
        data_dir,
        crate::usage::UsageRecord {
            workspace_path: workspace.to_string(),
            workspace_name: workspace_name(workspace),
            conversation_id: conversation_id.to_string(),
            conversation_title: title,
            model: model.to_string(),
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            duration_ms: None,
        },
    );
}

fn workspace_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Folder")
        .to_string()
}

fn save(data_dir: &Path, workspace: &str, id: &str, messages: &[Value], from_index: usize) {
    let dir = super::conv::conv_store_dir(data_dir, workspace);
    let updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let _ = crate::store::with_conn(&dir, |conn| {
        crate::store::save_conversation_suffix(conn, id, &updated_at, messages, from_index)
    });
}

fn emit_saved(app: &AppHandle, id: &str, messages: &[Value]) {
    emit(
        app,
        id,
        "saved",
        None,
        None,
        Some(json!({ "id": id, "messages": messages })),
    );
}

fn stopped(live: &LiveTurn) -> bool {
    stopped_flag(&live.cancel)
}

fn stopped_flag(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

fn normalize_permission(raw: &str) -> String {
    match raw.trim() {
        "approve-all" => "approve-all".into(),
        "read-only" => "read-only".into(),
        _ => "ask".into(),
    }
}

fn parse_args(raw: &str) -> serde_json::Map<String, Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn str_arg<'a>(args: &'a serde_json::Map<String, Value>, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_tool_result_is_closed() {
        let mut messages = vec![json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{ "id": "call-1", "name": "read_file", "arguments": "{}" }]
        })];
        close_dangling(&mut messages);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "call-1");
    }

    #[test]
    fn a_minimax_round_is_written_to_the_usage_database() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("billing");
        std::fs::create_dir_all(&workspace).unwrap();
        record_round_usage(
            dir.path(),
            workspace.to_str().unwrap(),
            "9d5099c0-f864-48d7-9754-e1a5aecd0ed0",
            "MiniMax-M3",
            Some(&crate::dev::types::DevChatUsage {
                prompt_tokens: 1200,
                completion_tokens: 80,
                total_tokens: 1280,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            }),
        );
        let rows = crate::usage::list_since(dir.path(), None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model, "MiniMax-M3");
        assert_eq!(rows[0].prompt_tokens, 1200);
        assert_eq!(rows[0].completion_tokens, 80);
        assert_eq!(rows[0].workspace_name, "billing");
        record_round_usage(dir.path(), workspace.to_str().unwrap(), "c1", "MiniMax-M3", None);
        assert_eq!(crate::usage::list_since(dir.path(), None).unwrap().len(), 1);
    }

    #[test]
    fn permission_defaults_to_ask() {
        assert_eq!(normalize_permission(""), "ask");
        assert_eq!(normalize_permission("approve-all"), "approve-all");
        assert_eq!(normalize_permission("nope"), "ask");
    }

    #[test]
    fn long_tool_text_keeps_head_and_tail() {
        let short = "a".repeat(TOOL_TEXT_CAP);
        assert_eq!(cap_tool_text(&short), short);
        let long = format!("{}{}{}", "H".repeat(TOOL_TEXT_HEAD), "M".repeat(5_000), "T".repeat(TOOL_TEXT_TAIL));
        let capped = cap_tool_text(&long);
        let omitted = long.chars().count() - TOOL_TEXT_HEAD - TOOL_TEXT_TAIL;
        let marker = format!("\n… omitted {omitted} characters …\n");
        let (head, rest) = capped.split_once(&marker).unwrap();
        assert_eq!(head, "H".repeat(TOOL_TEXT_HEAD));
        assert_eq!(rest, "T".repeat(TOOL_TEXT_TAIL));
        assert!(capped.chars().count() < long.chars().count());
    }
}
