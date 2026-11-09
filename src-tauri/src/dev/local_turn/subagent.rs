use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::super::types::DevToolCall;
use super::context::{context_failure_text, fit_prompt, recover_overflow, Fit};
use super::tools::{cap_tool_text, turn_tools};
use super::drive::{run_tool, stream_round};
use super::{
    assistant_value, close_dangling, emit, hold_provider_outage, int_arg, live, normalize_permission, parse_args,
    record_round_usage, retryable_model_error, round_is_empty, stopped, stopped_flag, str_arg, LiveTurn,
    LocalTurnStart, ProviderHold, CONTEXT_LIMIT_MESSAGE, EMPTY_REPLY,
};

/// A child has its own transcript and its own model rounds. The parent waits for the summary.
/// Live pieces go out as `subagent` events so they do not land in the parent chat.
pub(super) fn spawn_subagent(
    app: &AppHandle,
    conversation_id: &str,
    workspace: &Path,
    data_dir: &Path,
    workspace_key: &str,
    arguments: &str,
    call_id: &str,
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
            "callId": call_id,
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
        Ok(summary) => with_conversation(&child_id, summary),
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
            with_conversation(&child_id, format!("Error: {error}"))
        }
    }
}

/// The parent row opens this id. The rest of the text stays the summary the model reads.
fn with_conversation(child_id: &str, body: String) -> String {
    if body.starts_with("Subagent conversation:") {
        return body;
    }
    format!("Subagent conversation: {child_id}\n{body}")
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
    let mut compaction: Option<super::super::types::DevCompaction> = None;
    let mut prompt_tokens = 0u64;
    let mut overflow_retries = 0u8;
    let mut model_tries = 0u8;
    let mut outage_tries = 0u32;
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
        let extra_tools = turn_tools(workspace, parent_id);
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
                match hold_provider_outage(app, parent_id, cancel, &mut outage_tries, &error) {
                    ProviderHold::Retry => continue,
                    ProviderHold::Stopped => {
                        emit_subagent(
                            app,
                            parent_id,
                            "done",
                            child_id,
                            json!({ "status": "stopped", "summary": "Stopped.", "messages": transcript }),
                        );
                        return format!("Subagent stopped: {description}");
                    }
                    ProviderHold::Pass => {}
                }
                if model_tries < 1 && retryable_model_error(&error) {
                    model_tries = 1;
                    continue;
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
            match hold_provider_outage(app, parent_id, cancel, &mut outage_tries, &error) {
                ProviderHold::Retry => continue,
                ProviderHold::Stopped => {
                    emit_subagent(
                        app,
                        parent_id,
                        "done",
                        child_id,
                        json!({ "status": "stopped", "summary": "Stopped.", "messages": transcript }),
                    );
                    return format!("Subagent stopped: {description}");
                }
                ProviderHold::Pass => {}
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
        outage_tries = 0;
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
                super::super::chat::dev_chat_cancel(stream_id.clone());
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

pub(super) fn forget_stream(turn: &LiveTurn, stream_id: &str) {
    if let Ok(mut streams) = turn.child_streams.lock() {
        streams.retain(|id| id != stream_id);
    };
}

pub(super) fn emit_subagent(app: &AppHandle, conversation_id: &str, kind: &str, child_id: &str, mut body: Value) {
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
    let dir = super::super::conv::conv_store_dir(data_dir, workspace);
    crate::store::with_conn(&dir, |conn| crate::store::get_knowledge(&dir, conn, journey_id))
        .unwrap_or_default()
}

/// The child prompt is its own system text plus its own transcript.
/// Tools the child must not use are refused in `child_tool_block` before they run.
fn build_child_prompt(transcript: &[Value], compaction: Option<&super::super::types::DevCompaction>, system: &str) -> Vec<Value> {
    let context = super::super::compact::messages_for_context(transcript, compaction);
    let mut messages = vec![json!({ "role": "system", "content": system.trim() })];
    messages.extend(super::super::compact::api_messages(&context));
    messages
}

/// Same words as the transcript's `toolSummary`, so a live label matches the saved call.
fn tool_activity_label(call: &DevToolCall) -> String {
    let args = parse_args(&call.arguments);
    let path = str_arg(&args, "path");
    match call.name.as_str() {
        "read_file" => {
            let range = read_range_label(&args);
            if range.is_empty() { format!("Read {path}") } else { format!("Read {path} {range}") }
        }
        "write_file" => format!("Write {}", file_label(path)),
        "edit_file" => format!("Edit {}", file_label(path)),
        "list_dir" => format!("List {}", if path.is_empty() { "." } else { path }),
        "grep" => {
            let pattern = first_text(&args, &["pattern", "query"]);
            if pattern.is_empty() { "Search".into() } else { format!("Search {pattern}") }
        }
        "glob" => {
            let pattern = str_arg(&args, "pattern").trim();
            if pattern.is_empty() { "Find files".into() } else { format!("Find {pattern}") }
        }
        "list_chats" => {
            let alias = str_arg(&args, "alias").trim();
            if alias.is_empty() { "Chats".into() } else { format!("Chats in {alias}") }
        }
        "read_chat" => {
            let alias = str_arg(&args, "alias").trim();
            let id = str_arg(&args, "id").trim();
            if !alias.is_empty() && !id.is_empty() {
                format!("Chat {alias} {id}")
            } else if !alias.is_empty() {
                format!("Chat {alias}")
            } else {
                "Chat".into()
            }
        }
        "create_chat" => {
            let alias = str_arg(&args, "alias").trim();
            if alias.is_empty() { "Create chat".into() } else { format!("Create chat {alias}") }
        }
        "git_status" => "Git status".into(),
        "git_diff" => {
            let commit = first_text(&args, &["commit", "hash"]);
            if !commit.is_empty() {
                let short: String = commit.chars().take(7).collect();
                format!("Commit {short}")
            } else if !path.is_empty() {
                format!("Diff {}", file_label(path))
            } else {
                "Diff".into()
            }
        }
        "git_log" => "Git log".into(),
        "git_commit" => "Commit".into(),
        "web_search" => {
            let query = collapse_ws(&first_text(&args, &["query", "search_term"]));
            if query.is_empty() { "Web search".into() } else { format!("Web search: {query}") }
        }
        "run_command" => {
            let description = strip_run_prefix(&collapse_ws(str_arg(&args, "description")));
            if !description.is_empty() {
                format!("Run {description}")
            } else {
                let command = collapse_ws(str_arg(&args, "command"));
                if command.is_empty() { "Run command".into() } else { format!("Run {command}") }
            }
        }
        "spawn_subagent" => {
            let label = str_arg(&args, "description").trim();
            if label.is_empty() { "Subagent".into() } else { format!("Subagent: {label}") }
        }
        "load_skill" => {
            let name = str_arg(&args, "name").trim();
            if name.is_empty() { "Skill".into() } else { format!("Skill {name}") }
        }
        "todo_write" => "Updated todos".into(),
        "enter_plan_mode" => "Enter plan mode".into(),
        "exit_plan_mode" => "Exit plan mode".into(),
        other if other.starts_with("mcp__") => mcp_label(other),
        other => other.to_string(),
    }
}

fn file_label(path: &str) -> String {
    let base = file_base(path);
    if !base.is_empty() {
        base.to_string()
    } else if !path.is_empty() {
        path.to_string()
    } else {
        "file".into()
    }
}

fn read_range_label(args: &serde_json::Map<String, Value>) -> String {
    let offset = int_arg(args, "offset").filter(|line| *line > 0);
    let limit = int_arg(args, "limit").filter(|line| *line > 0);
    if offset.is_none() && limit.is_none() {
        return String::new();
    }
    let start = offset.unwrap_or(1);
    match limit {
        Some(limit) => format!("({start} - {})", start + limit - 1),
        None => format!("({start}+)"),
    }
}

fn first_text(args: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        let text = str_arg(args, key).trim();
        if !text.is_empty() {
            return text.to_string();
        }
    }
    String::new()
}

fn collapse_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_run_prefix(text: &str) -> String {
    let mut chars = text.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    if prefix.eq_ignore_ascii_case("run") && chars.next().is_some_and(char::is_whitespace) {
        return text.chars().skip(4).collect::<String>().trim_start().to_string();
    }
    text.to_string()
}

fn mcp_label(name: &str) -> String {
    let rest = name.trim_start_matches("mcp__").replace("__", " ");
    let rest = rest.trim();
    if rest.is_empty() { "MCP".into() } else { format!("MCP {rest}") }
}

fn file_base(path: &str) -> &str {
    Path::new(path).file_name().and_then(|name| name.to_str()).filter(|name| !name.is_empty()).unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_tool_labels_match_the_saved_transcript() {
        let read = DevToolCall {
            id: "1".into(),
            name: "read_file".into(),
            arguments: r#"{"path":"scripts/shot.mjs","offset":1,"limit":80}"#.into(),
        };
        assert_eq!(tool_activity_label(&read), "Read scripts/shot.mjs (1 - 80)");
        let skill = DevToolCall {
            id: "2".into(),
            name: "load_skill".into(),
            arguments: r#"{"name":"using-superpowers"}"#.into(),
        };
        assert_eq!(tool_activity_label(&skill), "Skill using-superpowers");
        let search = DevToolCall {
            id: "3".into(),
            name: "grep".into(),
            arguments: r#"{"pattern":"const"}"#.into(),
        };
        assert_eq!(tool_activity_label(&search), "Search const");
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
        assert_eq!(
            with_conversation("child-1", "Subagent Find parser finished:\nDone".into()),
            "Subagent conversation: child-1\nSubagent Find parser finished:\nDone"
        );
        assert_eq!(
            with_conversation("child-1", "Subagent conversation: child-1\nkept".into()),
            "Subagent conversation: child-1\nkept"
        );
    }
}
