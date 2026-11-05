use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::{
    emit, parse_args, spawn_local_turn, stopped_flag, str_arg, LiveTurn, LocalTurnStart, PlanWait,
    ShellWait,
};
use crate::error::{Error, Result};

pub(super) fn search(app: &AppHandle, data_dir: &Path, arguments: &str) -> Result<String> {
    let app = app.clone();
    let data_dir = data_dir.to_path_buf();
    let arguments = arguments.to_string();
    let stream = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::block_on(crate::web_search::search(&app, &data_dir, &stream, &arguments))
}

pub(super) fn run_shell(
    app: &AppHandle,
    conversation_id: &str,
    workspace: &Path,
    command: &str,
    description: &str,
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
    // Provider tool ids repeat (`tool_0`) across chats and subagents. The process
    // map is global, so that id would let Stop kill the other command.
    let command_id = uuid::Uuid::new_v4().to_string();
    if let Ok(mut commands) = live.commands.lock() {
        commands.push(command_id.clone());
    }
    emit_command(app, conversation_id, "command-start", &command_id, command, description);
    let app_chunks = app.clone();
    let id = conversation_id.to_string();
    let chunk_id = command_id.clone();
    let outcome = super::super::cmd::run_command_streaming(workspace, command, &command_id, move |chunk| {
        emit_command(&app_chunks, &id, "command", &chunk_id, chunk, "");
    });
    if let Ok(mut commands) = live.commands.lock() {
        commands.retain(|running| running != &command_id);
    }
    let reported = if stopped_flag(&live.cancel) {
        "Skipped: stopped.".to_string()
    } else {
        match &outcome {
            Ok(text) => text.clone(),
            Err(err) => format!("Error: {err}"),
        }
    };
    emit_command(app, conversation_id, "command-exit", &command_id, &reported, "");
    if stopped_flag(&live.cancel) {
        return Ok("Skipped: stopped.".into());
    }
    outcome
}

fn emit_command(app: &AppHandle, conversation_id: &str, kind: &str, command_id: &str, text: &str, description: &str) {
    emit(
        app,
        conversation_id,
        kind,
        Some(text.to_string()),
        Some(crate::dev::types::DevToolCall {
            id: command_id.to_string(),
            name: "run_command".into(),
            arguments: description.to_string(),
        }),
        None,
    );
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

pub(super) fn ask_plan(app: &AppHandle, conversation_id: &str, name: &str, live: &LiveTurn) -> String {
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

pub(super) fn group_or_repo(
    workspace: &Path,
    group: impl FnOnce(&super::super::group::GroupLayout) -> Result<String>,
    repo: impl FnOnce() -> Result<String>,
) -> Result<String> {
    if let Some(layout) = super::super::group::layout(workspace) {
        group(&layout)
    } else {
        repo()
    }
}

pub(super) fn turn_tools(workspace: &Path, conversation_id: &str) -> Vec<Value> {
    let mut tools = twanagent_service::capabilities::tool_defs(conversation_id);
    if super::super::group::layout(workspace).is_some() {
        tools.extend(super::super::group_chats::tool_defs());
    }
    tools
}

pub(super) fn list_group_chats(data_dir: &Path, workspace: &Path, args: &serde_json::Map<String, Value>) -> Result<String> {
    let Some(layout) = super::super::group::layout(workspace) else {
        return Err(Error::Other("list_chats is only available in a grouped project".into()));
    };
    let archived = args.get("archived").and_then(Value::as_bool).unwrap_or(false);
    super::super::group_chats::list_member_chats(data_dir, &layout, str_arg(args, "alias"), archived)
}

pub(super) fn read_group_chat(data_dir: &Path, workspace: &Path, args: &serde_json::Map<String, Value>) -> Result<String> {
    let Some(layout) = super::super::group::layout(workspace) else {
        return Err(Error::Other("read_chat is only available in a grouped project".into()));
    };
    super::super::group_chats::read_member_chat(data_dir, &layout, str_arg(args, "alias"), str_arg(args, "id"))
}

pub(super) fn create_group_chat(
    app: &AppHandle,
    data_dir: &Path,
    workspace: &Path,
    args: &serde_json::Map<String, Value>,
    model: &str,
    effort: &str,
    context_window: Option<u64>,
    permission: &str,
) -> Result<String> {
    let Some(layout) = super::super::group::layout(workspace) else {
        return Err(Error::Other("create_chat is only available in a grouped project".into()));
    };
    let message = str_arg(args, "message");
    let created = super::super::group_chats::create_member_chat(
        data_dir,
        &layout,
        str_arg(args, "alias"),
        str_arg(args, "title"),
        message,
        model,
        effort,
        context_window,
        permission,
    )?;
    let member = PathBuf::from(&created.workspace);
    spawn_local_turn(
        app,
        data_dir,
        &member,
        LocalTurnStart {
            workspace: created.workspace.clone(),
            conversation_id: created.summary.id.clone(),
            messages: vec![json!({ "role": "user", "content": message.trim() })],
            model: model.to_string(),
            effort: effort.to_string(),
            context_window,
            permission: permission.to_string(),
            system: String::new(),
            journey_id: None,
            allow_spawn: true,
        },
    );
    let _ = app.emit(
        "dev-conversation-created",
        serde_json::json!({
            "workspace": created.workspace,
            "conversation": created.summary,
            "running": true,
        }),
    );
    Ok(format!(
        "{}\t{}\t{}",
        created.alias, created.summary.id, created.summary.title
    ))
}

pub(super) fn group_prompt(workspace: &Path) -> String {
    let Some(layout) = super::super::group::layout(workspace) else {
        return String::new();
    };
    let aliases = layout
        .members
        .iter()
        .map(|member| member.alias.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "\nThis workspace is several repositories: {aliases}.\nPaths look like alias/file. Each repository has its own git history. A commit must name files in one repository.\n{}",
        super::super::group_chats::PROMPT_LINE
    )
}

pub(super) fn capability_roots(workspace: &Path) -> Vec<std::path::PathBuf> {
    if let Some(layout) = super::super::group::layout(workspace) {
        let mut roots = vec![workspace.to_path_buf()];
        roots.extend(layout.members.into_iter().map(|member| member.path));
        roots
    } else {
        vec![workspace.to_path_buf()]
    }
}

pub(super) fn commit_files(workspace: &Path, data_dir: &Path, args: &serde_json::Map<String, Value>) -> Result<String> {
    let paths: Vec<String> = args
        .get("paths")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if let Some(layout) = super::super::group::layout(workspace) {
        return super::super::group_git::commit_one(&layout, str_arg(args, "message"), &paths);
    }
    let target = git_target(workspace, data_dir)?;
    if paths.is_empty() {
        let pending: Vec<String> = super::super::git::git_status_with(&target, false)?
            .into_iter()
            .filter(|row| !row.staged)
            .map(|row| row.path)
            .collect();
        if !pending.is_empty() {
            super::super::git::git_stage(&target, &pending)?;
        }
    } else {
        super::super::git::git_stage(&target, &paths)?;
    }
    let hash = super::super::git::git_commit(&target, str_arg(args, "message"))?;
    Ok(format!("Committed {hash}"))
}

pub(super) fn git_target(workspace: &Path, data_dir: &Path) -> Result<super::super::git::GitTarget> {
    super::super::git::GitTarget::local_in(workspace, &[], data_dir)
}

pub(super) fn update_journey(
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
    let dir = super::super::conv::conv_store_dir(data_dir, workspace);
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

pub(super) fn todo_text(arguments: &str) -> String {
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

pub(super) fn json_ok<T: serde::Serialize>(result: Result<T>) -> Result<String> {
    result.and_then(|value| serde_json::to_string_pretty(&value).map_err(Error::from))
}

const TOOL_TEXT_CAP: usize = 24_000;
const TOOL_TEXT_HEAD: usize = 20_000;
const TOOL_TEXT_TAIL: usize = 2_000;

/// Keep the start and end of a huge tool result so the next round does not resend it all.
pub(super) fn cap_tool_text(text: &str) -> String {
    let len = text.chars().count();
    if len <= TOOL_TEXT_CAP {
        return text.to_string();
    }
    let head: String = text.chars().take(TOOL_TEXT_HEAD).collect();
    let tail: String = text.chars().skip(len - TOOL_TEXT_TAIL).collect();
    let omitted = len - TOOL_TEXT_HEAD - TOOL_TEXT_TAIL;
    format!("{head}\n… omitted {omitted} characters …\n{tail}")
}

pub(super) fn strip_capability_lines(system: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

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
