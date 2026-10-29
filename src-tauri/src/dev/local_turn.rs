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
const EMPTY_REPLY: &str = "Grok returned an empty reply.";
const CONTEXT_LIMIT_MESSAGE: &str =
    "This conversation is over the context size you chose. Start a new chat, or pick a larger context size.";

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
    /// Subagents still running for this chat. Stopping the parent stops them too.
    children: Mutex<Vec<Arc<AtomicBool>>>,
    /// Model streams opened by those children. Stop cancels these as well as the parent.
    child_streams: Mutex<Vec<String>>,
    /// Shell processes this chat started. Stop kills them instead of waiting out the command.
    commands: Mutex<Vec<String>>,
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
    if let Ok(children) = turn.children.lock() {
        for child in children.iter() {
            child.store(true, Ordering::Relaxed);
        }
    };
    if let Ok(mut streams) = turn.child_streams.lock() {
        for stream_id in streams.drain(..) {
            super::chat::dev_chat_cancel(stream_id);
        }
    };
    // The parent round uses the chat id. A compaction round uses compact:<chat id>.
    // Child rounds use their own ids, cancelled above. One click has to reach all of them.
    super::chat::dev_chat_cancel(conversation_id.clone());
    super::chat::dev_chat_cancel(format!("compact:{conversation_id}"));
    if let Ok(mut commands) = turn.commands.lock() {
        for command_id in commands.drain(..) {
            let _ = super::cmd::stop_command(&command_id);
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
        children: Mutex::new(Vec::new()),
        child_streams: Mutex::new(Vec::new()),
        commands: Mutex::new(Vec::new()),
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
    let home = crate::dev::paths::home_dir().unwrap_or_default();
    let _capabilities = twanagent_service::capabilities::install(id, workspace, &home);
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
    let (mut prompt_tokens, mut compaction) = load_budget(data_dir, &request.workspace, id);
    let mut overflow_retries = 0u8;
    let mut model_tries = 0u8;
    // No tool-round cap. Compaction bounds context, and the user stops a runaway turn.
    loop {
        if stopped(live) {
            emit(app, id, "stopped", None, None, None);
            return;
        }
        close_dangling(&mut transcript);
        match fit_prompt(
            app,
            data_dir,
            workspace,
            &request.workspace,
            id,
            &model,
            &request.effort,
            window,
            &live.cancel,
            live,
            &mut transcript,
            &mut compaction,
            &mut prompt_tokens,
            None,
        ) {
            Fit::Ready => {}
            Fit::Stopped => {
                emit(app, id, "stopped", None, None, None);
                return;
            }
            Fit::TooBig => {
                fail(app, id, &mut transcript, CONTEXT_LIMIT_MESSAGE);
                save(data_dir, &request.workspace, id, &transcript, saved_len, None);
                emit_saved(app, id, &transcript, None, compaction.as_ref());
                return;
            }
        }
        let prompt = build_prompt(workspace, &transcript, compaction.as_ref(), &request.system, &permission, &model, plan, id);
        let round = match stream_round(app, id, id, None, &model, &request.effort, window, prompt, &live.cancel, request.journey_id.clone(), false, twanagent_service::capabilities::tool_defs(id)).await_round() {
            Ok(round) => round,
            Err(err) => {
                let message = err.to_string();
                if recover_overflow(
                    app,
                    data_dir,
                    workspace,
                    &request.workspace,
                    id,
                    &model,
                    &request.effort,
                    window,
                    &live.cancel,
                    live,
                    &mut transcript,
                    &mut compaction,
                    &mut prompt_tokens,
                    &mut overflow_retries,
                    &message,
                    None,
                ) {
                    continue;
                }
                if stopped(live) {
                    save(data_dir, &request.workspace, id, &transcript, saved_len, None);
                    emit_saved(app, id, &transcript, None, compaction.as_ref());
                    emit(app, id, "stopped", None, None, None);
                    return;
                }
                let text = context_failure_text(&message);
                fail(app, id, &mut transcript, text);
                save(data_dir, &request.workspace, id, &transcript, saved_len, None);
                emit_saved(app, id, &transcript, None, compaction.as_ref());
                return;
            }
        };
        record_round_usage(data_dir, &request.workspace, id, &model, round.usage.as_ref());
        if stopped(live) || round.error.as_deref() == Some("Stopped.") {
            keep_partial(&mut transcript, &round);
            save(data_dir, &request.workspace, id, &transcript, saved_len, round.usage.as_ref());
            emit_saved(app, id, &transcript, round.usage.as_ref(), compaction.as_ref());
            emit(app, id, "stopped", None, None, None);
            return;
        }
        if let Some(error) = round.error.clone() {
            if recover_overflow(
                app,
                data_dir,
                workspace,
                &request.workspace,
                id,
                &model,
                &request.effort,
                window,
                &live.cancel,
                live,
                &mut transcript,
                &mut compaction,
                &mut prompt_tokens,
                &mut overflow_retries,
                &error,
                None,
            ) {
                continue;
            }
            if stopped(live) {
                save(data_dir, &request.workspace, id, &transcript, saved_len, round.usage.as_ref());
                emit_saved(app, id, &transcript, round.usage.as_ref(), compaction.as_ref());
                emit(app, id, "stopped", None, None, None);
                return;
            }
            if model_tries < 1 && retryable_model_error(&error) {
                model_tries = 1;
                continue;
            }
            let text = context_failure_text(&error);
            fail(app, id, &mut transcript, text);
            save(data_dir, &request.workspace, id, &transcript, saved_len, round.usage.as_ref());
            emit_saved(app, id, &transcript, round.usage.as_ref(), compaction.as_ref());
            return;
        }
        if let Some(usage) = round.usage.as_ref() {
            prompt_tokens = usage.prompt_tokens;
        }
        overflow_retries = 0;
        // A blank round is usually a dropped final message or a one-off empty completion.
        // Ask once more before ending the turn. The webview loop already did this.
        if round_is_empty(&round) && model_tries < 1 && !stopped(live) {
            model_tries = 1;
            continue;
        }
        model_tries = 0;
        if round.tool_calls.is_empty() {
            if round_is_empty(&round) {
                fail(app, id, &mut transcript, EMPTY_REPLY);
            } else {
                transcript.push(assistant_value(&round.text, &round.reasoning, &[], &round.thinking));
            }
            save(data_dir, &request.workspace, id, &transcript, saved_len, round.usage.as_ref());
            emit_saved(app, id, &transcript, round.usage.as_ref(), compaction.as_ref());
            emit(app, id, "done", None, None, None);
            return;
        }
        transcript.push(assistant_value(&round.text, &round.reasoning, &round.tool_calls, &round.thinking));
        save(data_dir, &request.workspace, id, &transcript, saved_len, round.usage.as_ref());
        emit_saved(app, id, &transcript, round.usage.as_ref(), compaction.as_ref());
        let mut contents = Vec::with_capacity(round.tool_calls.len());
        let mut spawn_waits: Vec<(usize, std::thread::JoinHandle<String>)> = Vec::new();
        for call in &round.tool_calls {
            if stopped(live) {
                contents.push("Skipped: stopped.".to_string());
                continue;
            }
            emit(app, id, "tool", Some(call.name.clone()), Some(call.clone()), None);
            if call.name == "spawn_subagent" && request.allow_spawn {
                let app_child = app.clone();
                let conversation_id = id.to_string();
                let workspace_child = workspace.to_path_buf();
                let data_child = data_dir.to_path_buf();
                let workspace_key = request.workspace.clone();
                let arguments = call.arguments.clone();
                let permission_child = permission.clone();
                let journey_child = request.journey_id.clone();
                let model_child = model.clone();
                let effort_child = request.effort.clone();
                let window_child = request.context_window;
                let live_child = live.clone();
                let plan_child = plan;
                let index = contents.len();
                spawn_waits.push((
                    index,
                    std::thread::spawn(move || {
                        spawn_subagent(
                            &app_child,
                            &conversation_id,
                            &workspace_child,
                            &data_child,
                            &workspace_key,
                            &arguments,
                            &permission_child,
                            journey_child.as_deref(),
                            plan_child,
                            true,
                            &model_child,
                            &effort_child,
                            window_child,
                            &live_child,
                        )
                    }),
                ));
                contents.push(String::new());
                continue;
            }
            contents.push(run_tool(
                app,
                id,
                id,
                workspace,
                data_dir,
                &request.workspace,
                call,
                &permission,
                request.journey_id.as_deref(),
                plan,
                request.allow_spawn,
                &model,
                &request.effort,
                request.context_window,
                live,
            ));
        }
        for (index, wait) in spawn_waits {
            let summary = wait
                .join()
                .unwrap_or_else(|_| "Error: the subagent stopped unexpectedly".into());
            if let Some(slot) = contents.get_mut(index) {
                *slot = summary;
            }
        }
        for (call, content) in round.tool_calls.iter().zip(contents.iter()) {
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
            save(data_dir, &request.workspace, id, &transcript, saved_len, None);
            emit_saved(app, id, &transcript, None, compaction.as_ref());
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
    /// True when the live stream already painted this text, so the dock must not append it again.
    streamed_text: bool,
    streamed_reasoning: bool,
}

struct RoundWait {
    app: AppHandle,
    /// Where parent chat events go. A subagent still reports usage against this id.
    conversation_id: String,
    /// Model stream id. A child uses its own so Stop does not cancel the parent round.
    stream_id: String,
    /// When set, deltas and reasoning paint the subagent dock instead of the parent chat.
    subagent_id: Option<String>,
    model: String,
    effort: String,
    context_window: u64,
    messages: Vec<Value>,
    cancel: Arc<AtomicBool>,
    journey_id: Option<String>,
    /// A compaction summary must not paint the chat as if the model were answering.
    quiet: bool,
    extra_tools: Vec<Value>,
}

impl RoundWait {
    fn await_round(self) -> Result<Round> {
        let RoundWait {
            app,
            conversation_id,
            stream_id,
            subagent_id,
            model,
            effort,
            context_window,
            messages,
            cancel,
            journey_id,
            quiet,
            extra_tools,
        } = self;
        let state = app.state::<AppState>();
        let progress_app = app.clone();
        let progress_id = conversation_id.clone();
        let progress_child = subagent_id.clone();
        // Register before the request starts. Stop during the handshake has to find this flag,
        // not a map that is still empty until the HTTP call returns.
        let cancel = if let Ok(mut map) = super::chat::streams().lock() {
            let flag = map.get(&stream_id).cloned().unwrap_or_else(|| cancel.clone());
            map.insert(stream_id.clone(), flag.clone());
            flag
        } else {
            cancel
        };
        let streamed_text_flag = Arc::new(AtomicBool::new(false));
        let streamed_reasoning_flag = Arc::new(AtomicBool::new(false));
        let streamed_text_progress = streamed_text_flag.clone();
        let streamed_reasoning_progress = streamed_reasoning_flag.clone();
        let collected = tauri::async_runtime::block_on(super::chat::collect_chat_round(
            app.clone(),
            state,
            stream_id.clone(),
            Value::Array(messages),
            Some(model),
            Some(effort).filter(|value| !value.trim().is_empty()),
            (context_window > 0).then_some(context_window),
            // A child can read the knowledge in its prompt, but must not rewrite it.
            if subagent_id.is_some() {
                None
            } else {
                journey_id.filter(|value| !value.trim().is_empty())
            },
            cancel.clone(),
            extra_tools,
            move |progress| {
                if quiet || progress.text.is_empty() {
                    return;
                }
                if let Some(child_id) = progress_child.as_deref() {
                    if progress.kind == "delta" {
                        streamed_text_progress.store(true, Ordering::Relaxed);
                    }
                    if progress.kind == "reasoning" {
                        streamed_reasoning_progress.store(true, Ordering::Relaxed);
                    }
                    emit_subagent(
                        &progress_app,
                        &progress_id,
                        progress.kind,
                        child_id,
                        json!({ "text": progress.text, "append": true }),
                    );
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
            streamed_text: streamed_text_flag.load(Ordering::Relaxed),
            streamed_reasoning: streamed_reasoning_flag.load(Ordering::Relaxed),
        })
    }
}

fn stream_round(
    app: &AppHandle,
    conversation_id: &str,
    stream_id: &str,
    subagent_id: Option<&str>,
    model: &str,
    effort: &str,
    context_window: u64,
    messages: Vec<Value>,
    cancel: &Arc<AtomicBool>,
    journey_id: Option<String>,
    quiet: bool,
    extra_tools: Vec<Value>,
) -> RoundWait {
    RoundWait {
        app: app.clone(),
        conversation_id: conversation_id.to_string(),
        stream_id: {
            let id = stream_id.trim();
            if id.is_empty() { conversation_id.to_string() } else { id.to_string() }
        },
        subagent_id: subagent_id.map(str::to_string).filter(|id| !id.is_empty()),
        model: model.to_string(),
        effort: effort.to_string(),
        context_window,
        messages,
        cancel: cancel.clone(),
        journey_id,
        quiet,
        extra_tools,
    }
}

fn run_tool(
    app: &AppHandle,
    conversation_id: &str,
    capability_id: &str,
    workspace: &Path,
    data_dir: &Path,
    workspace_key: &str,
    call: &DevToolCall,
    permission: &str,
    journey_id: Option<&str>,
    plan: bool,
    allow_spawn: bool,
    model: &str,
    effort: &str,
    context_window: Option<u64>,
    live: &Arc<LiveTurn>,
) -> String {
    if let Some(text) = twanagent_service::capabilities::call(capability_id, &call.name, &call.arguments) {
        return text;
    }
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
        "read_file" => super::files::read_file(workspace, str_arg(&args, "path")).and_then(|text| {
            twanagent_service::numbered_lines(&text, int_arg(&args, "offset"), int_arg(&args, "limit"))
                .map_err(Error::from)
        }),
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
            return spawn_subagent(
                app,
                conversation_id,
                workspace,
                data_dir,
                workspace_key,
                &call.arguments,
                permission,
                journey_id,
                plan,
                allow_spawn,
                model,
                effort,
                context_window,
                live,
            );
        }
        other => return format!("Unknown tool: {other}"),
    };
    match result {
        Ok(text) => text,
        Err(err) => format!("Error: {err}"),
    }
}

/// A child has its own transcript and its own model rounds. The parent waits for the summary.
/// Live pieces go out as `subagent` events so they do not land in the parent chat.
fn spawn_subagent(
    app: &AppHandle,
    conversation_id: &str,
    workspace: &Path,
    data_dir: &Path,
    workspace_key: &str,
    arguments: &str,
    permission: &str,
    journey_id: Option<&str>,
    _plan: bool,
    allow_spawn: bool,
    model: &str,
    effort: &str,
    context_window: Option<u64>,
    live: &Arc<LiveTurn>,
) -> String {
    if !allow_spawn {
        return "Error: subagents cannot spawn subagents.".into();
    }
    let args = parse_args(arguments);
    let prompt = str_arg(&args, "prompt").trim().to_string();
    if prompt.is_empty() {
        return "Error: spawn_subagent requires a prompt.".into();
    }
    let description = {
        let raw = str_arg(&args, "description").trim();
        let label = if raw.is_empty() { "Subagent" } else { raw };
        label.chars().take(80).collect::<String>()
    };
    let child_type = parse_subagent_type(args.get("subagent_type").or_else(|| args.get("subagentType")));
    let child_id = uuid::Uuid::new_v4().to_string();
    let model = if model.trim().is_empty() { "grok-4.6".to_string() } else { model.trim().to_string() };
    emit_subagent(
        app,
        conversation_id,
        "start",
        &child_id,
        json!({
            "id": child_id,
            "description": description,
            "type": child_type,
            "status": "running",
            "prompt": prompt,
            "streamText": "",
            "streamReasoning": "",
            "tools": [],
            "messages": [],
            "summary": "",
        }),
    );
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut children) = live.children.lock() {
        children.push(cancel.clone());
    }
    let knowledge = journey_knowledge(data_dir, workspace_key, journey_id);
    let mut system = subagent_system(&workspace.display().to_string(), child_type, &description, permission, &knowledge, &model);
    let block = twanagent_service::capabilities::prompt_block(conversation_id);
    if !block.is_empty() {
        system.push('\n');
        system.push_str(&block);
    }
    let child_request = LocalTurnStart {
        workspace: workspace_key.to_string(),
        conversation_id: conversation_id.to_string(),
        messages: vec![json!({ "role": "user", "content": prompt })],
        model,
        effort: effort.to_string(),
        context_window,
        permission: permission.to_string(),
        system,
        journey_id: journey_id.map(str::to_string),
        allow_spawn: false,
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        drive_subagent(app, data_dir, workspace, &child_request, child_type, &child_id, &cancel, live)
    }));
    if let Ok(mut children) = live.children.lock() {
        children.retain(|child| !Arc::ptr_eq(child, &cancel));
    }
    match outcome {
        Ok(summary) => summary,
        Err(_) => {
            let error = "the subagent stopped unexpectedly".to_string();
            emit_subagent(app, conversation_id, "error", &child_id, json!({ "error": error }));
            emit_subagent(
                app,
                conversation_id,
                "done",
                &child_id,
                json!({ "status": "error", "summary": error, "messages": [] }),
            );
            format!("Error: {error}")
        }
    }
}

fn drive_subagent(
    app: &AppHandle,
    data_dir: &Path,
    workspace: &Path,
    request: &LocalTurnStart,
    child_type: &str,
    child_id: &str,
    cancel: &Arc<AtomicBool>,
    parent: &Arc<LiveTurn>,
) -> String {
    let parent_id = request.conversation_id.trim();
    let description = request
        .system
        .lines()
        .find_map(|line| line.strip_prefix("Task: ").map(str::trim))
        .filter(|line| !line.is_empty())
        .unwrap_or("Subagent");
    let model = if request.model.trim().is_empty() {
        "grok-4.6".to_string()
    } else {
        request.model.trim().to_string()
    };
    let plan = crate::model_providers::registry::plan_mode(crate::model_providers::registry::find(&model));
    let permission = normalize_permission(&request.permission);
    let mut transcript = request.messages.clone();
    let mut compaction: Option<super::types::DevCompaction> = None;
    let mut prompt_tokens = 0u64;
    let mut overflow_retries = 0u8;
    let mut model_tries = 0u8;
    let window = request.context_window.filter(|value| *value > 0).unwrap_or(0);
    let mut failed = String::new();
    // No tool-round cap. Compaction bounds context, and the user stops a runaway turn.
    loop {
        if stopped_flag(cancel) || stopped(parent) {
            let summary = if failed.is_empty() { "Stopped.".to_string() } else { failed };
            emit_subagent(
                app,
                parent_id,
                "done",
                child_id,
                json!({ "status": "stopped", "summary": summary, "messages": transcript }),
            );
            return format!("Subagent stopped: {description}");
        }
        close_dangling(&mut transcript);
        match fit_prompt(
            app,
            data_dir,
            workspace,
            &request.workspace,
            parent_id,
            &model,
            &request.effort,
            window,
            cancel,
            parent,
            &mut transcript,
            &mut compaction,
            &mut prompt_tokens,
            Some(child_id),
        ) {
            Fit::Ready => {}
            Fit::Stopped => {
                emit_subagent(
                    app,
                    parent_id,
                    "done",
                    child_id,
                    json!({ "status": "stopped", "summary": "Stopped.", "messages": transcript }),
                );
                return format!("Subagent stopped: {description}");
            }
            Fit::TooBig => {
                let error = CONTEXT_LIMIT_MESSAGE.to_string();
                emit_subagent(app, parent_id, "error", child_id, json!({ "error": error }));
                emit_subagent(
                    app,
                    parent_id,
                    "done",
                    child_id,
                    json!({ "status": "error", "summary": error, "messages": transcript }),
                );
                return format!("Subagent failed: {error}");
            }
        }
        let prompt = build_child_prompt(&transcript, compaction.as_ref(), &request.system);
        let extra_tools = twanagent_service::capabilities::tool_defs(parent_id);
        let stream_id = format!("subagent:{child_id}");
        if let Some(turn) = live(parent_id) {
            if let Ok(mut streams) = turn.child_streams.lock() {
                streams.push(stream_id.clone());
            }
        }
        let round = match stream_round(
            app,
            parent_id,
            &stream_id,
            Some(child_id),
            &model,
            &request.effort,
            window,
            prompt,
            cancel,
            request.journey_id.clone(),
            false,
            extra_tools,
        )
        .await_round()
        {
            Ok(round) => round,
            Err(err) => {
                forget_child_stream(parent_id, &stream_id);
                let error = err.to_string();
                if recover_overflow(
                    app,
                    data_dir,
                    workspace,
                    &request.workspace,
                    parent_id,
                    &model,
                    &request.effort,
                    window,
                    cancel,
                    parent,
                    &mut transcript,
                    &mut compaction,
                    &mut prompt_tokens,
                    &mut overflow_retries,
                    &error,
                    Some(child_id),
                ) {
                    continue;
                }
                if stopped_flag(cancel) || stopped(parent) {
                    emit_subagent(
                        app,
                        parent_id,
                        "done",
                        child_id,
                        json!({ "status": "stopped", "summary": "Stopped.", "messages": transcript }),
                    );
                    return format!("Subagent stopped: {description}");
                }
                let text = context_failure_text(&error).to_string();
                emit_subagent(app, parent_id, "error", child_id, json!({ "error": text }));
                emit_subagent(
                    app,
                    parent_id,
                    "done",
                    child_id,
                    json!({ "status": "error", "summary": text, "messages": transcript }),
                );
                return format!("Subagent failed: {text}");
            }
        };
        forget_child_stream(parent_id, &stream_id);
        record_round_usage(data_dir, &request.workspace, parent_id, &model, round.usage.as_ref());
        if stopped_flag(cancel) || stopped(parent) || round.error.as_deref() == Some("Stopped.") {
            emit_subagent(
                app,
                parent_id,
                "done",
                child_id,
                json!({ "status": "stopped", "summary": "Stopped.", "messages": transcript }),
            );
            return format!("Subagent stopped: {description}");
        }
        if let Some(error) = round.error.clone() {
            if recover_overflow(
                app,
                data_dir,
                workspace,
                &request.workspace,
                parent_id,
                &model,
                &request.effort,
                window,
                cancel,
                parent,
                &mut transcript,
                &mut compaction,
                &mut prompt_tokens,
                &mut overflow_retries,
                &error,
                Some(child_id),
            ) {
                continue;
            }
            if stopped_flag(cancel) || stopped(parent) {
                emit_subagent(
                    app,
                    parent_id,
                    "done",
                    child_id,
                    json!({ "status": "stopped", "summary": "Stopped.", "messages": transcript }),
                );
                return format!("Subagent stopped: {description}");
            }
            if model_tries < 1 && retryable_model_error(&error) {
                model_tries = 1;
                continue;
            }
            failed = context_failure_text(&error).to_string();
            emit_subagent(app, parent_id, "error", child_id, json!({ "error": failed }));
            emit_subagent(
                app,
                parent_id,
                "done",
                child_id,
                json!({ "status": "error", "summary": failed, "messages": transcript }),
            );
            return format!("Subagent failed: {failed}");
        }
        if let Some(usage) = round.usage.as_ref() {
            prompt_tokens = usage.prompt_tokens;
        }
        overflow_retries = 0;
        if round_is_empty(&round) && model_tries < 1 && !stopped_flag(cancel) && !stopped(parent) {
            model_tries = 1;
            continue;
        }
        model_tries = 0;
        if !round.streamed_reasoning && !round.reasoning.trim().is_empty() {
            emit_subagent(app, parent_id, "reasoning", child_id, json!({ "text": round.reasoning.trim() }));
        }
        if !round.streamed_text && !round.text.is_empty() {
            emit_subagent(app, parent_id, "delta", child_id, json!({ "text": round.text }));
        }
        if round.tool_calls.is_empty() {
            if round_is_empty(&round) {
                let error = EMPTY_REPLY.to_string();
                emit_subagent(app, parent_id, "error", child_id, json!({ "error": error }));
                emit_subagent(
                    app,
                    parent_id,
                    "done",
                    child_id,
                    json!({ "status": "error", "summary": error, "messages": transcript }),
                );
                return format!("Subagent failed: {error}");
            }
            transcript.push(assistant_value(&round.text, &round.reasoning, &[], &round.thinking));
            let summary = summarize_subagent(&transcript);
            emit_subagent(
                app,
                parent_id,
                "done",
                child_id,
                json!({ "status": "done", "summary": summary, "messages": transcript }),
            );
            return format!("Subagent {description} finished:\n{summary}");
        }
        transcript.push(assistant_value(&round.text, &round.reasoning, &round.tool_calls, &round.thinking));
        emit_subagent(app, parent_id, "update", child_id, json!({ "messages": transcript }));
        for call in &round.tool_calls {
            let content = if stopped_flag(cancel) || stopped(parent) {
                super::chat::dev_chat_cancel(stream_id.clone());
                "Skipped: stopped.".to_string()
            } else if let Some(blocked) = child_tool_block(child_type, &call.name) {
                blocked
            } else {
                let label = tool_activity_label(call);
                if !label.is_empty() {
                    emit_subagent(app, parent_id, "tool", child_id, json!({ "label": label }));
                }
                run_tool(
                    app,
                    parent_id,
                    parent_id,
                    workspace,
                    data_dir,
                    &request.workspace,
                    call,
                    &permission,
                    request.journey_id.as_deref(),
                    plan,
                    false,
                    &model,
                    &request.effort,
                    request.context_window,
                    parent,
                )
            };
            if content.starts_with("Wrote ")
                || content.starts_with("Edited ")
                || content.starts_with("Committed ")
                || call.name == "run_command"
            {
                emit(app, parent_id, "refresh", None, None, None);
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
            emit_subagent(app, parent_id, "update", child_id, json!({ "messages": transcript }));
        }
    }
}

fn forget_child_stream(conversation_id: &str, stream_id: &str) {
    let Some(turn) = live(conversation_id) else {
        return;
    };
    forget_stream(&turn, stream_id);
}

fn forget_stream(turn: &LiveTurn, stream_id: &str) {
    if let Ok(mut streams) = turn.child_streams.lock() {
        streams.retain(|id| id != stream_id);
    };
}

fn emit_subagent(app: &AppHandle, conversation_id: &str, kind: &str, child_id: &str, mut body: Value) {
    if let Some(object) = body.as_object_mut() {
        object.insert("id".into(), Value::String(child_id.to_string()));
        object.insert("event".into(), Value::String(kind.to_string()));
    }
    emit(app, conversation_id, "subagent", Some(body.to_string()), None, None);
}

fn parse_subagent_type(raw: Option<&Value>) -> &'static str {
    match raw.and_then(Value::as_str) {
        Some("explore") => "explore",
        Some("plan") => "plan",
        _ => "general-purpose",
    }
}

fn child_tool_block(child_type: &str, name: &str) -> Option<String> {
    let blocked = matches!(
        name,
        "spawn_subagent" | "update_journey_knowledge" | "todo_write" | "enter_plan_mode" | "exit_plan_mode"
    ) || ((child_type == "explore" || child_type == "plan")
        && matches!(name, "write_file" | "edit_file" | "run_command"));
    if blocked {
        Some(format!("Error: {name} is not available to this {child_type} subagent."))
    } else {
        None
    }
}

fn summarize_subagent(messages: &[Value]) -> String {
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let text = message.get("content").and_then(Value::as_str).unwrap_or("").trim();
        if !text.is_empty() {
            return text.to_string();
        }
    }
    "Subagent finished with no summary.".into()
}

fn subagent_system(
    workspace: &str,
    child_type: &str,
    description: &str,
    permission: &str,
    knowledge: &str,
    model: &str,
) -> String {
    let limits = match child_type {
        "explore" => "You are an explore agent. Search with grep and glob, read files, and use the web, but do not edit files or run shell commands.",
        "plan" => "You are a plan agent. Search with grep and glob, explore the codebase and the web, then produce a structured plan. Do not edit files or run shell commands.",
        _ => "You are a general-purpose subagent. Inspect and edit this folder as needed.",
    };
    let who = agent_identity(model, child_type);
    let knowledge_block = if knowledge.trim().is_empty() {
        String::new()
    } else {
        format!("\nJourney knowledge:\n{}", knowledge.trim())
    };
    format!(
        "{who}\nWorkspace: {workspace}\nTask: {description}\n{limits}\n{}\nBe concise. End with a clear summary of findings or work done.{knowledge_block}",
        permission_system_line(permission)
    )
}

fn agent_identity(model: &str, child_type: &str) -> String {
    let id = model.trim();
    let name = agent_name_for(id);
    if !name.is_empty() && !id.is_empty() {
        format!("You are {name} ({id}), a {child_type} subagent in TwanAgent.")
    } else if !name.is_empty() {
        format!("You are {name}, a {child_type} subagent in TwanAgent.")
    } else {
        format!("You are a {child_type} subagent in TwanAgent.")
    }
}

fn agent_name_for(model: &str) -> &'static str {
    let id = model.trim().to_ascii_lowercase();
    if id.starts_with("claude") {
        "Claude"
    } else if id.starts_with("minimax") || id.starts_with("abab") {
        "MiniMax"
    } else if id.starts_with("grok") {
        "Grok"
    } else {
        ""
    }
}

fn permission_system_line(permission: &str) -> &'static str {
    match normalize_permission(permission).as_str() {
        "approve-all" => "Use tools to inspect and edit this folder. File edits and shell commands run without asking.",
        "read-only" => "Use tools to inspect this folder. Read-only: do not edit files or run shell commands. Web search is allowed.",
        _ => "Use tools to inspect and edit this folder. File edits apply immediately. Shell commands require the user to approve.",
    }
}

fn journey_knowledge(data_dir: &Path, workspace: &str, journey_id: Option<&str>) -> String {
    let Some(journey_id) = journey_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return String::new();
    };
    let dir = super::conv::conv_store_dir(data_dir, workspace);
    crate::store::with_conn(&dir, |conn| crate::store::get_knowledge(&dir, conn, journey_id))
        .unwrap_or_default()
}

/// The child prompt is its own system text plus its own transcript.
/// Tools the child must not use are refused in `child_tool_block` before they run.
fn build_child_prompt(transcript: &[Value], compaction: Option<&super::types::DevCompaction>, system: &str) -> Vec<Value> {
    let context = super::compact::messages_for_context(transcript, compaction);
    let mut messages = vec![json!({ "role": "system", "content": system.trim() })];
    messages.extend(super::compact::api_messages(&context));
    messages
}

fn tool_activity_label(call: &DevToolCall) -> String {
    let args = parse_args(&call.arguments);
    match call.name.as_str() {
        "read_file" => format!("Read {}", file_base(str_arg(&args, "path"))),
        "write_file" => format!("Write {}", file_base(str_arg(&args, "path"))),
        "edit_file" => format!("Edit {}", file_base(str_arg(&args, "path"))),
        "list_dir" => format!("List {}", {
            let path = str_arg(&args, "path");
            if path.is_empty() { "." } else { path }
        }),
        "grep" => "Search".into(),
        "glob" => "Find files".into(),
        "git_status" => "Git status".into(),
        "git_diff" => "Diff".into(),
        "git_log" => "Git log".into(),
        "git_commit" => "Commit".into(),
        "web_search" => {
            let query = str_arg(&args, "query").trim();
            if query.is_empty() { "Web search".into() } else { format!("Web search: {query}") }
        }
        "run_command" => {
            let description = str_arg(&args, "description").trim().trim_start_matches("Run ").trim_start_matches("run ");
            if description.is_empty() { "Run command".into() } else { format!("Run {description}") }
        }
        "todo_write" => "Updated todos".into(),
        "load_skill" => {
            let name = str_arg(&args, "name").trim();
            if name.is_empty() { "Load skill".into() } else { format!("Load skill {name}") }
        }
        _ => call.name.clone(),
    }
}

fn file_base(path: &str) -> &str {
    Path::new(path).file_name().and_then(|name| name.to_str()).filter(|name| !name.is_empty()).unwrap_or(path)
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
    let command_id = uuid::Uuid::new_v4().to_string();
    if let Ok(mut commands) = live.commands.lock() {
        commands.push(command_id.clone());
    }
    let outcome = super::cmd::run_command_streaming(workspace, command, &command_id, move |chunk| {
        emit(&app_chunks, &id, "command", Some(chunk.to_string()), None, None);
    });
    if let Ok(mut commands) = live.commands.lock() {
        commands.retain(|running| running != &command_id);
    }
    if stopped_flag(&live.cancel) {
        return Ok("Skipped: stopped.".into());
    }
    outcome
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

fn strip_capability_lines(system: &str) -> String {
    system
        .lines()
        .filter(|line| {
            !line.contains("load_skill")
                && !line.contains("mcp__server__tool")
                && !line.contains("not connected")
                && !line.contains("not auto-loaded")
                && !line.contains("MCP this turn")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_prompt(
    workspace: &Path,
    transcript: &[Value],
    compaction: Option<&super::types::DevCompaction>,
    system: &str,
    permission: &str,
    model: &str,
    plan: bool,
    conversation_id: &str,
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
    let base = strip_capability_lines(&base);
    let block = twanagent_service::capabilities::prompt_block(conversation_id);
    let base = if block.is_empty() {
        base
    } else if base.is_empty() {
        block
    } else {
        format!("{base}\n{block}")
    };
    let context = super::compact::messages_for_context(transcript, compaction);
    let mut messages = vec![json!({ "role": "system", "content": base })];
    messages.extend(super::compact::api_messages(&context));
    messages
}

enum Fit {
    Ready,
    Stopped,
    TooBig,
}

enum FoldStep {
    Folded,
    None,
    Stopped,
}

fn context_failure_text(message: &str) -> &str {
    if super::compact::is_context_length_error(message) {
        CONTEXT_LIMIT_MESSAGE
    } else {
        message
    }
}

/// The next prompt is measured from the last stored round, not from the webview.
fn load_budget(data_dir: &Path, workspace: &str, id: &str) -> (u64, Option<super::types::DevCompaction>) {
    let dir = super::conv::conv_store_dir(data_dir, workspace);
    let Ok(row) = crate::store::with_conn(&dir, |conn| crate::store::get_conversation(conn, id)) else {
        return (0, None);
    };
    let tokens = row.context_usage.as_ref().map(|usage| usage.prompt_tokens).unwrap_or(0);
    (tokens, row.compaction)
}

fn fit_prompt(
    app: &AppHandle,
    data_dir: &Path,
    workspace: &Path,
    workspace_key: &str,
    id: &str,
    model: &str,
    effort: &str,
    window: u64,
    cancel: &Arc<AtomicBool>,
    live: &Arc<LiveTurn>,
    transcript: &mut Vec<Value>,
    compaction: &mut Option<super::types::DevCompaction>,
    prompt_tokens: &mut u64,
    child_id: Option<&str>,
) -> Fit {
    if stopped(live) || stopped_flag(cancel) {
        return Fit::Stopped;
    }
    let can_fold = super::compact::plan_fold(transcript, compaction.as_ref()).is_some();
    match super::compact::budget_action(*prompt_tokens, window, can_fold) {
        super::compact::BudgetAction::Send => Fit::Ready,
        super::compact::BudgetAction::Stop => Fit::TooBig,
        super::compact::BudgetAction::Fold { times } => match fold_up_to(
            app,
            data_dir,
            workspace,
            workspace_key,
            id,
            model,
            effort,
            window,
            cancel,
            live,
            transcript,
            compaction,
            prompt_tokens,
            child_id,
            times,
        ) {
            FoldStep::Folded => Fit::Ready,
            FoldStep::Stopped => Fit::Stopped,
            FoldStep::None => {
                if super::compact::prompt_exceeds_window(*prompt_tokens, window) {
                    Fit::TooBig
                } else {
                    Fit::Ready
                }
            }
        },
    }
}

fn recover_overflow(
    app: &AppHandle,
    data_dir: &Path,
    workspace: &Path,
    workspace_key: &str,
    id: &str,
    model: &str,
    effort: &str,
    window: u64,
    cancel: &Arc<AtomicBool>,
    live: &Arc<LiveTurn>,
    transcript: &mut Vec<Value>,
    compaction: &mut Option<super::types::DevCompaction>,
    prompt_tokens: &mut u64,
    overflow_retries: &mut u8,
    message: &str,
    child_id: Option<&str>,
) -> bool {
    if *overflow_retries >= 1 || !super::compact::is_context_length_error(message) {
        return false;
    }
    *overflow_retries = overflow_retries.saturating_add(1);
    match fold_up_to(
        app,
        data_dir,
        workspace,
        workspace_key,
        id,
        model,
        effort,
        window,
        cancel,
        live,
        transcript,
        compaction,
        prompt_tokens,
        child_id,
        4,
    ) {
        FoldStep::Folded => true,
        FoldStep::None | FoldStep::Stopped => false,
    }
}

fn fold_up_to(
    app: &AppHandle,
    data_dir: &Path,
    workspace: &Path,
    workspace_key: &str,
    id: &str,
    model: &str,
    effort: &str,
    window: u64,
    cancel: &Arc<AtomicBool>,
    live: &Arc<LiveTurn>,
    transcript: &mut Vec<Value>,
    compaction: &mut Option<super::types::DevCompaction>,
    prompt_tokens: &mut u64,
    child_id: Option<&str>,
    times: u8,
) -> FoldStep {
    let mut folded = false;
    for _ in 0..times {
        if stopped(live) || stopped_flag(cancel) {
            return FoldStep::Stopped;
        }
        match fold_once(
            app,
            data_dir,
            workspace,
            workspace_key,
            id,
            model,
            effort,
            window,
            cancel,
            live,
            transcript,
            compaction,
            prompt_tokens,
            child_id,
        ) {
            FoldStep::Folded => folded = true,
            FoldStep::None => break,
            FoldStep::Stopped => return FoldStep::Stopped,
        }
    }
    if folded { FoldStep::Folded } else { FoldStep::None }
}

fn fold_once(
    app: &AppHandle,
    data_dir: &Path,
    _workspace: &Path,
    workspace_key: &str,
    id: &str,
    model: &str,
    effort: &str,
    window: u64,
    cancel: &Arc<AtomicBool>,
    live: &Arc<LiveTurn>,
    transcript: &mut Vec<Value>,
    compaction: &mut Option<super::types::DevCompaction>,
    prompt_tokens: &mut u64,
    child_id: Option<&str>,
) -> FoldStep {
    let Some(plan) = super::compact::plan_fold(transcript, compaction.as_ref()) else {
        return FoldStep::None;
    };
    if stopped(live) || stopped_flag(cancel) {
        return FoldStep::Stopped;
    }
    let stream_id = match child_id {
        Some(child) => format!("compact:{child}"),
        None => format!("compact:{id}"),
    };
    // A child summary is not the chat id Stop cancels on its own. Remember it with the
    // other child streams so the same click reaches this request.
    if child_id.is_some() {
        if let Ok(mut streams) = live.child_streams.lock() {
            streams.push(stream_id.clone());
        }
    }
    let round = match stream_round(
        app,
        id,
        &stream_id,
        None,
        model,
        effort,
        window,
        super::compact::compaction_prompt(&plan.older, &plan.previous_summary),
        cancel,
        None,
        true,
        Vec::new(),
    )
    .await_round()
    {
        Ok(round) => {
            if child_id.is_some() {
                forget_stream(live, &stream_id);
            }
            round
        }
        Err(_) => {
            if child_id.is_some() {
                forget_stream(live, &stream_id);
            }
            return if stopped(live) || stopped_flag(cancel) {
                FoldStep::Stopped
            } else {
                FoldStep::None
            };
        }
    };
    record_round_usage(data_dir, workspace_key, id, model, round.usage.as_ref());
    if stopped(live) || stopped_flag(cancel) || round.error.as_deref() == Some("Stopped.") {
        return FoldStep::Stopped;
    }
    if round.error.is_some() {
        return FoldStep::None;
    }
    let summary = if !round.text.trim().is_empty() {
        round.text.trim().to_string()
    } else {
        round.reasoning.trim().to_string()
    };
    let Some(next) = super::compact::commit_fold(transcript, &summary, plan.through) else {
        return FoldStep::None;
    };
    // The summary request is not the size of the next prompt.
    *prompt_tokens = 0;
    *compaction = Some(next);
    if let Some(state) = compaction.as_ref() {
        persist_fold(app, data_dir, workspace_key, id, transcript, state, child_id);
    }
    FoldStep::Folded
}

/// Parent folds are stored on the conversation. A child folds in memory only.
fn persist_fold(
    app: &AppHandle,
    data_dir: &Path,
    workspace_key: &str,
    id: &str,
    transcript: &[Value],
    compaction: &super::types::DevCompaction,
    child_id: Option<&str>,
) {
    if let Some(child_id) = child_id {
        emit_subagent(app, id, "update", child_id, json!({ "messages": transcript }));
        return;
    }
    let cleared = super::types::DevChatUsage {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
    };
    save(data_dir, workspace_key, id, transcript, 0, Some(&cleared));
    let dir = super::conv::conv_store_dir(data_dir, workspace_key);
    let _ = crate::store::with_conn(&dir, |conn| {
        crate::store::set_conversation_compaction(conn, id, compaction)
    });
    emit_saved(app, id, transcript, Some(&cleared), Some(compaction));
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
            cache_read_tokens: usage.cache_read_tokens,
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

fn save(
    data_dir: &Path,
    workspace: &str,
    id: &str,
    messages: &[Value],
    from_index: usize,
    usage: Option<&super::types::DevChatUsage>,
) {
    let dir = super::conv::conv_store_dir(data_dir, workspace);
    let updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let _ = crate::store::with_conn(&dir, |conn| {
        crate::store::save_conversation_suffix_with_usage(
            conn,
            id,
            &updated_at,
            messages,
            from_index,
            usage,
        )
    });
}

fn emit_saved(
    app: &AppHandle,
    id: &str,
    messages: &[Value],
    usage: Option<&super::types::DevChatUsage>,
    compaction: Option<&super::types::DevCompaction>,
) {
    let mut conversation = json!({ "id": id, "messages": messages });
    if let Some(usage) = usage {
        conversation["context_usage"] = serde_json::to_value(usage).unwrap_or(Value::Null);
    }
    if let Some(compaction) = compaction {
        conversation["compaction"] = serde_json::to_value(compaction).unwrap_or(Value::Null);
    }
    emit(app, id, "saved", None, None, Some(conversation));
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

fn int_arg(args: &serde_json::Map<String, Value>, key: &str) -> Option<u32> {
    args.get(key).and_then(twanagent_service::parse_line_int)
}

fn round_is_empty(round: &Round) -> bool {
    round.error.is_none()
        && round.tool_calls.is_empty()
        && round.text.trim().is_empty()
        && round.reasoning.trim().is_empty()
}

/// Transport and provider failures the webview loop already tries once more.
/// Context-length errors are not included: those fold the transcript instead.
fn retryable_model_error(error: &str) -> bool {
    if super::compact::is_context_length_error(error) {
        return false;
    }
    let text = error.to_lowercase();
    if text.is_empty()
        || text.contains("stopped")
        || text.contains("signed in")
        || text.contains("401")
        || text.contains("api key")
        || text.contains("login expired")
    {
        return false;
    }
    text.contains("xai request failed")
        || text.contains("429")
        || text.contains("500")
        || text.contains("502")
        || text.contains("503")
        || text.contains("504")
        || text.contains("timed out")
        || text.contains("timeout")
        || text.contains("decoding response body")
        || text.contains("connection reset")
        || text.contains("broken pipe")
        || text.contains("model stream closed")
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
    fn a_child_cannot_spawn_or_edit_when_it_is_only_exploring() {
        assert_eq!(
            child_tool_block("general-purpose", "spawn_subagent").as_deref(),
            Some("Error: spawn_subagent is not available to this general-purpose subagent.")
        );
        assert!(child_tool_block("general-purpose", "read_file").is_none());
        assert!(child_tool_block("general-purpose", "edit_file").is_none());
        assert_eq!(
            child_tool_block("explore", "write_file").as_deref(),
            Some("Error: write_file is not available to this explore subagent.")
        );
        assert_eq!(
            child_tool_block("plan", "run_command").as_deref(),
            Some("Error: run_command is not available to this plan subagent.")
        );
        assert!(child_tool_block("explore", "grep").is_none());
        assert!(child_tool_block("plan", "web_search").is_none());
        assert!(child_tool_block("explore", "update_journey_knowledge").is_some());
    }

    #[test]
    fn spawn_args_need_a_prompt_and_keep_the_three_child_types() {
        let missing = parse_args(r#"{"description":"Look"}"#);
        assert!(str_arg(&missing, "prompt").trim().is_empty());
        assert_eq!(parse_subagent_type(Some(&serde_json::json!("explore"))), "explore");
        assert_eq!(parse_subagent_type(Some(&serde_json::json!("plan"))), "plan");
        assert_eq!(parse_subagent_type(Some(&serde_json::json!("nope"))), "general-purpose");
        assert_eq!(parse_subagent_type(None), "general-purpose");
        let long = "x".repeat(100);
        assert_eq!(long.chars().take(80).collect::<String>().chars().count(), 80);
    }

    #[test]
    fn the_child_prompt_names_the_model_and_blocks_edits_for_explore() {
        let prompt = subagent_system("/tmp/app", "explore", "Find parser", "ask", "", "grok-4.6");
        assert!(prompt.contains("You are Grok (grok-4.6), a explore subagent"));
        assert!(prompt.contains("do not edit files"));
        assert!(prompt.contains("Task: Find parser"));
        assert!(!prompt.contains("Journey knowledge:"));
        let with_notes = subagent_system("/tmp/app", "plan", "Write a plan", "approve-all", "- voice is casual", "claude-opus-4-8");
        assert!(with_notes.contains("You are Claude (claude-opus-4-8), a plan subagent"));
        assert!(with_notes.contains("Journey knowledge:\n- voice is casual"));
        assert!(with_notes.contains("without asking"));
        assert_eq!(
            summarize_subagent(&[json!({ "role": "assistant", "content": "Parser is in dev.ts" })]),
            "Parser is in dev.ts"
        );
        assert_eq!(
            summarize_subagent(&[json!({ "role": "user", "content": "look" })]),
            "Subagent finished with no summary."
        );
    }

    #[test]
    fn permission_defaults_to_ask() {
        assert_eq!(normalize_permission(""), "ask");
        assert_eq!(normalize_permission("approve-all"), "approve-all");
        assert_eq!(normalize_permission("nope"), "ask");
    }

    #[test]
    fn a_blank_round_is_empty_and_a_real_reply_is_not() {
        let mut round = Round {
            text: "  ".into(),
            reasoning: String::new(),
            tool_calls: Vec::new(),
            thinking: Vec::new(),
            usage: None,
            error: None,
            streamed_text: false,
            streamed_reasoning: false,
        };
        assert!(round_is_empty(&round));
        round.text = "done".into();
        assert!(!round_is_empty(&round));
        round.text.clear();
        round.reasoning = "looked".into();
        assert!(!round_is_empty(&round));
        round.reasoning.clear();
        round.tool_calls.push(DevToolCall {
            id: "1".into(),
            name: "read_file".into(),
            arguments: "{}".into(),
        });
        assert!(!round_is_empty(&round));
        round.tool_calls.clear();
        round.error = Some("xAI request failed: overloaded".into());
        assert!(!round_is_empty(&round));
    }

    #[test]
    fn empty_and_transport_failures_are_retried_once_but_auth_and_context_are_not() {
        assert!(retryable_model_error("xAI request failed: overloaded"));
        assert!(retryable_model_error("error decoding response body"));
        assert!(retryable_model_error("the model stream closed"));
        assert!(!retryable_model_error("Stopped."));
        assert!(!retryable_model_error("Grok CLI login expired. Run grok login."));
        assert!(!retryable_model_error("xAI rejected the API key."));
        assert!(!retryable_model_error(
            "This model's maximum context length was exceeded"
        ));
    }

    #[test]
    fn int_arg_reads_string_and_number_line_counts() {
        let args = parse_args(r#"{"offset":"10","limit":51}"#);
        assert_eq!(int_arg(&args, "offset"), Some(10));
        assert_eq!(int_arg(&args, "limit"), Some(51));
        assert_eq!(int_arg(&args, "missing"), None);
    }

    #[test]
    fn the_next_round_starts_from_the_stored_prompt_and_summary() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("proj");
        std::fs::create_dir_all(&workspace).unwrap();
        let ws = workspace.to_str().unwrap();
        let row = crate::dev::Conversation {
            id: "c1".into(),
            title: "Hello".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            kind: "chat".into(),
            messages: vec![json!({ "role": "user", "content": "hi" })],
            context_usage: Some(crate::dev::DevChatUsage {
                prompt_tokens: 400_000,
                completion_tokens: 10,
                total_tokens: 400_010,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            }),
            compaction: Some(crate::dev::DevCompaction {
                summary: "Read the first files.".into(),
                through: 5,
            }),
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        };
        let store = crate::dev::conv::conv_store_dir(dir.path(), ws);
        crate::store::with_conn(&store, |conn| crate::store::save_conversation(conn, &row)).unwrap();
        let (tokens, compaction) = load_budget(dir.path(), ws, "c1");
        assert_eq!(tokens, 400_000);
        let compaction = compaction.expect("summary");
        assert_eq!(compaction.summary, "Read the first files.");
        assert_eq!(compaction.through, 5);
        let (missing, none) = load_budget(dir.path(), ws, "missing");
        assert_eq!(missing, 0);
        assert!(none.is_none());
    }

    #[test]
    fn the_model_prompt_sends_the_summary_instead_of_the_folded_reads() {
        let mut stored = vec![
            json!({ "role": "user", "content": "find the crash" }),
            json!({ "role": "assistant", "content": "", "reasoning": "private thought", "tool_calls": [{ "id": "1", "name": "read_file", "arguments": "{}" }] }),
            json!({ "role": "tool", "tool_call_id": "1", "content": "first-file" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "2", "name": "read_file", "arguments": "{}" }] }),
            json!({ "role": "tool", "tool_call_id": "2", "content": "second-file" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "3", "name": "read_file", "arguments": "{}" }] }),
            json!({ "role": "tool", "tool_call_id": "3", "content": "third-file" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "4", "name": "read_file", "arguments": "{}" }] }),
            json!({ "role": "tool", "tool_call_id": "4", "content": "last-file" }),
        ];
        let state = crate::dev::compact::commit_fold(&mut stored, "Read the first files.", 5).unwrap();
        let prompt = build_prompt(Path::new("workspace"), &stored, Some(&state), "", "ask", "grok-4.7", false, "chat");
        let rendered = serde_json::to_string(&prompt).unwrap();
        assert!(rendered.contains("Read the first files."));
        assert!(!rendered.contains("private thought"));
        assert!(!rendered.contains("Conversation compacted"));
        assert!(!rendered.contains("first-file"));
        assert!(rendered.contains("last-file"));
        assert!(prompt.iter().any(|msg| msg["tool_calls"][0]["id"].as_str() == Some("4")));
        assert!(prompt.iter().all(|msg| msg["tool_calls"][0]["id"].as_str() != Some("1")));
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
