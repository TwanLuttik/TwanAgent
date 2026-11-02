use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::subagent::{emit_subagent, forget_stream};
use super::tools::{group_prompt, strip_capability_lines};
use super::drive::stream_round;
use super::{
    emit_saved, record_round_usage, save, stopped, stopped_flag, LiveTurn,
    CONTEXT_LIMIT_MESSAGE,
};

pub(super) fn build_prompt(
    workspace: &Path,
    transcript: &[Value],
    compaction: Option<&super::super::types::DevCompaction>,
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
    let base = format!("{base}{}", group_prompt(workspace));
    let base = strip_capability_lines(&base);
    let block = twanagent_service::capabilities::prompt_block(conversation_id);
    let base = if block.is_empty() {
        base
    } else if base.is_empty() {
        block
    } else {
        format!("{base}\n{block}")
    };
    let context = super::super::compact::messages_for_context(transcript, compaction);
    let mut messages = vec![json!({ "role": "system", "content": base })];
    messages.extend(super::super::compact::api_messages(&context));
    messages
}

pub(super) enum Fit {
    Ready,
    Stopped,
    TooBig,
}

enum FoldStep {
    Folded,
    None,
    Stopped,
}

pub(super) fn context_failure_text(message: &str) -> &str {
    if super::super::compact::is_context_length_error(message) {
        CONTEXT_LIMIT_MESSAGE
    } else {
        message
    }
}

/// The next prompt is measured from the last stored round, not from the webview.
pub(super) fn load_budget(data_dir: &Path, workspace: &str, id: &str) -> (u64, Option<super::super::types::DevCompaction>) {
    let dir = super::super::conv::conv_store_dir(data_dir, workspace);
    let Ok(row) = crate::store::with_conn(&dir, |conn| crate::store::get_conversation(conn, id)) else {
        return (0, None);
    };
    let tokens = row.context_usage.as_ref().map(|usage| usage.prompt_tokens).unwrap_or(0);
    (tokens, row.compaction)
}

pub(super) fn fit_prompt(
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
    compaction: &mut Option<super::super::types::DevCompaction>,
    prompt_tokens: &mut u64,
    child_id: Option<&str>,
) -> Fit {
    if stopped(live) || stopped_flag(cancel) {
        return Fit::Stopped;
    }
    let can_fold = super::super::compact::plan_fold(transcript, compaction.as_ref()).is_some();
    match super::super::compact::budget_action(*prompt_tokens, window, can_fold) {
        super::super::compact::BudgetAction::Send => Fit::Ready,
        super::super::compact::BudgetAction::Stop => Fit::TooBig,
        super::super::compact::BudgetAction::Fold { times } => match fold_up_to(
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
                if super::super::compact::prompt_exceeds_window(*prompt_tokens, window) {
                    Fit::TooBig
                } else {
                    Fit::Ready
                }
            }
        },
    }
}

pub(super) fn recover_overflow(
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
    compaction: &mut Option<super::super::types::DevCompaction>,
    prompt_tokens: &mut u64,
    overflow_retries: &mut u8,
    message: &str,
    child_id: Option<&str>,
) -> bool {
    if *overflow_retries >= 1 || !super::super::compact::is_context_length_error(message) {
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
    compaction: &mut Option<super::super::types::DevCompaction>,
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
    compaction: &mut Option<super::super::types::DevCompaction>,
    prompt_tokens: &mut u64,
    child_id: Option<&str>,
) -> FoldStep {
    let Some(plan) = super::super::compact::plan_fold(transcript, compaction.as_ref()) else {
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
        super::super::compact::compaction_prompt(&plan.older, &plan.previous_summary),
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
    let Some(next) = super::super::compact::commit_fold(transcript, &summary, plan.through) else {
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
    compaction: &super::super::types::DevCompaction,
    child_id: Option<&str>,
) {
    if let Some(child_id) = child_id {
        emit_subagent(app, id, "update", child_id, json!({ "messages": transcript }));
        return;
    }
    let cleared = super::super::types::DevChatUsage {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
    };
    save(data_dir, workspace_key, id, transcript, 0, Some(&cleared));
    let dir = super::super::conv::conv_store_dir(data_dir, workspace_key);
    let _ = crate::store::with_conn(&dir, |conn| {
        crate::store::set_conversation_compaction(conn, id, compaction)
    });
    emit_saved(app, id, transcript, Some(&cleared), Some(compaction));
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
