use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::super::types::DevToolCall;
use super::context::{
    build_prompt, context_failure_text, fit_prompt, load_budget, recover_overflow, Fit,
};
use super::subagent::{emit_subagent, spawn_subagent};
use super::tools::{
    ask_plan, capability_roots, cap_tool_text, commit_files, create_group_chat, git_target,
    group_or_repo, json_ok, list_group_chats, read_group_chat, run_shell, search, todo_text,
    turn_tools, update_journey,
};
use super::{
    assistant_value, close_dangling, emit, emit_saved, fail, hold_provider_outage, int_arg, keep_partial,
    normalize_permission, parse_args, record_round_usage, retryable_model_error, round_is_empty,
    save, stopped, str_arg, LiveTurn, LocalTurnStart, ProviderHold, CONTEXT_LIMIT_MESSAGE, EMPTY_REPLY,
};
use crate::error::{Error, Result};
use crate::state::AppState;

pub(super) fn drive(app: &AppHandle, data_dir: &Path, workspace: &Path, request: &LocalTurnStart, live: &Arc<LiveTurn>) {
    let id = request.conversation_id.trim();
    let home = crate::dev::paths::home_dir().unwrap_or_default();
    let roots = capability_roots(workspace);
    let _capabilities = twanagent_service::capabilities::install_roots(id, &roots, &home);
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
    let mut outage_tries = 0u32;
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
        let round = match stream_round(app, id, id, None, &model, &request.effort, window, prompt, &live.cancel, request.journey_id.clone(), false, turn_tools(workspace, id)).await_round() {
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
                match hold_provider_outage(app, id, &live.cancel, &mut outage_tries, &message) {
                    ProviderHold::Retry => continue,
                    ProviderHold::Stopped => {
                        save(data_dir, &request.workspace, id, &transcript, saved_len, None);
                        emit_saved(app, id, &transcript, None, compaction.as_ref());
                        emit(app, id, "stopped", None, None, None);
                        return;
                    }
                    ProviderHold::Pass => {}
                }
                if model_tries < 1 && retryable_model_error(&message) {
                    model_tries = 1;
                    continue;
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
            match hold_provider_outage(app, id, &live.cancel, &mut outage_tries, &error) {
                ProviderHold::Retry => continue,
                ProviderHold::Stopped => {
                    save(data_dir, &request.workspace, id, &transcript, saved_len, round.usage.as_ref());
                    emit_saved(app, id, &transcript, round.usage.as_ref(), compaction.as_ref());
                    emit(app, id, "stopped", None, None, None);
                    return;
                }
                ProviderHold::Pass => {}
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
        outage_tries = 0;
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

pub(super) struct Round {
    pub(super) text: String,
    pub(super) reasoning: String,
    pub(super) tool_calls: Vec<DevToolCall>,
    pub(super) thinking: Vec<crate::model_providers::ThinkingBlock>,
    pub(super) usage: Option<super::super::types::DevChatUsage>,
    pub(super) error: Option<String>,
    /// True when the live stream already painted this text, so the dock must not append it again.
    pub(super) streamed_text: bool,
    pub(super) streamed_reasoning: bool,
}

pub(super) struct RoundWait {
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
    pub(super) fn await_round(self) -> Result<Round> {
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
        let cancel = if let Ok(mut map) = super::super::chat::streams().lock() {
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
        let collected = tauri::async_runtime::block_on(super::super::chat::collect_chat_round(
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

pub(super) fn stream_round(
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

pub(super) fn run_tool(
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
    if permission == "read-only" && matches!(call.name.as_str(), "write_file" | "edit_file" | "run_command" | "git_commit" | "create_chat") {
        return format!("Error: {} is blocked in read-only mode.", call.name);
    }
    let args = parse_args(&call.arguments);
    let result = match call.name.as_str() {
        "list_dir" => json_ok(super::super::files::list_dir(workspace, str_arg(&args, "path"))),
        "grep" => super::super::files::grep(
            workspace,
            str_arg(&args, "pattern"),
            str_arg(&args, "path"),
            str_arg(&args, "glob"),
        ),
        "glob" => super::super::files::glob(workspace, str_arg(&args, "pattern"), str_arg(&args, "path")),
        "read_file" => super::super::files::read_file(workspace, str_arg(&args, "path")).and_then(|text| {
            twanagent_service::numbered_lines(&text, int_arg(&args, "offset"), int_arg(&args, "limit"))
                .map_err(Error::from)
        }),
        "write_file" => super::super::files::write_file(workspace, str_arg(&args, "path"), str_arg(&args, "contents"))
            .map(|_| format!("Wrote {}", str_arg(&args, "path"))),
        "edit_file" => super::super::files::edit_file(
            workspace,
            str_arg(&args, "path"),
            str_arg(&args, "old_string"),
            str_arg(&args, "new_string"),
        )
        .map(|_| format!("Edited {}", str_arg(&args, "path"))),
        "git_status" => group_or_repo(workspace, |layout| {
            super::super::group_git::status(layout, true)
                .and_then(|rows| serde_json::to_string_pretty(&rows).map_err(Error::from))
        }, || {
            git_target(workspace, data_dir).and_then(|target| {
                super::super::git::git_status_with(&target, true)
                    .and_then(|rows| serde_json::to_string_pretty(&rows).map_err(Error::from))
            })
        }),
        "git_diff" => group_or_repo(workspace, |layout| {
            let commit = str_arg(&args, "commit");
            if commit.is_empty() {
                super::super::group_git::diff(layout, str_arg(&args, "path"))
            } else {
                Err(Error::Other(super::super::group_git::OPEN_REPO.into()))
            }
        }, || {
            git_target(workspace, data_dir).and_then(|target| {
                let commit = str_arg(&args, "commit");
                if commit.is_empty() {
                    super::super::git::git_diff(&target, str_arg(&args, "path"))
                } else {
                    super::super::git::git_show(&target, commit)
                }
            })
        }),
        "git_log" => group_or_repo(workspace, |_| Err(Error::Other(super::super::group_git::OPEN_REPO.into())), || {
            git_target(workspace, data_dir).and_then(|target| {
                let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 80) as u32;
                super::super::git::git_log(&target, limit)
                    .and_then(|rows| serde_json::to_string_pretty(&rows).map_err(Error::from))
            })
        }),
        "git_commit" => commit_files(workspace, data_dir, &args),
        "run_command" => run_shell(
            app,
            conversation_id,
            workspace,
            str_arg(&args, "command"),
            str_arg(&args, "description"),
            permission,
            live,
        ),
        "web_search" => search(app, data_dir, &call.arguments),
        "list_chats" => list_group_chats(data_dir, workspace, &args),
        "read_chat" => read_group_chat(data_dir, workspace, &args),
        "create_chat" => create_group_chat(
            app,
            data_dir,
            workspace,
            &args,
            model,
            effort,
            context_window,
            permission,
        ),
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
