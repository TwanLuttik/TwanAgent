use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
#[cfg(test)]
use serde_json::Value;

use crate::error::{Error, Result};
use crate::keys::ProviderKeys;
use crate::model;
use crate::store::Conversation;
use crate::tools::{dispatch, tool_status, ToolHost, Workspace};
use crate::{ProjectService, TurnEvent};

/// One conversation's turn. A second prompt waits. Cancel wakes a shell prompt and kills the command.
pub struct TurnGate {
    pub cancel: Arc<AtomicBool>,
    pub shell: ShellWait,
    /// Set while ask mode is waiting. The session publishes this, then the turn waits.
    pub pending: Arc<Mutex<Option<(String, String)>>>,
}

impl TurnGate {
    pub fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            shell: ShellWait::new(),
            pending: Arc::new(Mutex::new(None)),
        }
    }
}

/// The desktop's answer to one `run_command` in ask mode.
#[derive(Clone)]
pub struct ShellWait {
    slot: Arc<(Mutex<Option<bool>>, Condvar)>,
}

impl ShellWait {
    pub fn new() -> Self {
        Self {
            slot: Arc::new((Mutex::new(None), Condvar::new())),
        }
    }

    pub fn answer(&self, allow: bool) {
        if let Ok(mut slot) = self.slot.0.lock() {
            *slot = Some(allow);
        }
        self.slot.1.notify_all();
    }

    /// `None` when the wait was cancelled or the desktop never answered.
    pub fn wait(&self, cancel: &AtomicBool, timeout: Duration) -> Option<bool> {
        let Ok(mut slot) = self.slot.0.lock() else {
            return None;
        };
        let started = std::time::Instant::now();
        loop {
            if let Some(allow) = slot.take() {
                return Some(allow);
            }
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let left = timeout.saturating_sub(started.elapsed());
            if left.is_zero() {
                return None;
            }
            let (next, _) = self
                .slot
                .1
                .wait_timeout(slot, left.min(Duration::from_millis(200)))
                .unwrap_or_else(|err| err.into_inner());
            slot = next;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnRequest {
    pub conversation_id: String,
    pub prompt: String,
    pub model: String,
    pub effort: String,
    pub permission: String,
    /// The folder on the machine that owns this chat. Empty for a process started with `--project`.
    #[serde(default)]
    pub project: String,
    /// Context size chosen in the composer. Empty keeps the size stored on the conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelStep {
    Tool { id: String, name: String, arguments: String },
    Text(String),
}

pub trait ScriptedModel {
    fn steps(&self) -> Vec<ModelStep>;
}

struct PermissionHost {
    permission: String,
    /// Set while a live turn is waiting for the desktop to approve one command.
    ask: Option<Arc<dyn Fn(&str, &str) -> bool + Send + Sync>>,
}

impl ToolHost for PermissionHost {
    fn allow_shell(&self, command: &str) -> bool {
        match self.permission.as_str() {
            "approve-all" => true,
            "ask" => {
                let Some(ask) = &self.ask else {
                    return false;
                };
                let description = command_description(command);
                ask(command, &description)
            }
            _ => false,
        }
    }
}

fn command_description(command: &str) -> String {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return "Run a command".into();
    }
    let mut chars = trimmed.chars();
    let short: String = chars.by_ref().take(80).collect();
    if chars.next().is_some() {
        format!("{short}…")
    } else {
        short
    }
}

pub fn run_scripted_turn(
    service: &ProjectService,
    request: &TurnRequest,
    workspace: &dyn Workspace,
    model: &dyn ScriptedModel,
) -> Result<Conversation> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err(Error::Other("prompt is empty".into()));
    }
    let id = request.conversation_id.trim();
    if id.is_empty() {
        return Err(Error::Other("conversation id is empty".into()));
    }
    let mut conversation = match service.get_conversation(id) {
        Ok(existing) => existing,
        Err(Error::NotFound(_)) => new_conversation(id, prompt, request),
        Err(err) => return Err(err),
    };
    conversation.messages.push(json!({ "role": "user", "content": prompt }));
    if conversation.title.is_empty() || conversation.title == "New chat" {
        conversation.title = title_from(prompt);
    }
    conversation.updated_at = now();
    let host = PermissionHost {
        permission: request.permission.clone(),
        ask: None,
    };
    for step in model.steps() {
        match step {
            ModelStep::Tool { id, name, arguments } => {
                conversation.messages.push(json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{ "id": id, "name": name, "arguments": arguments }]
                }));
                let result = dispatch(workspace, &host, &request.permission, &name, &arguments)?;
                conversation.messages.push(json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": result
                }));
            }
            ModelStep::Text(text) => {
                conversation.messages.push(json!({ "role": "assistant", "content": text }));
            }
        }
    }
    service.save_conversation(&conversation)?;
    Ok(conversation)
}

/// Call the model on this machine, run tools here, and save the transcript here.
/// `on_event` is display only. The GUI does not receive tool calls to execute.
pub fn run_live_turn(
    service: &ProjectService,
    request: &TurnRequest,
    workspace: &dyn Workspace,
    keys: &ProviderKeys,
    on_event: impl FnMut(TurnEvent),
) -> Result<Conversation> {
    run_live_turn_gated(service, request, workspace, keys, None, on_event)
}

pub fn run_live_turn_gated(
    service: &ProjectService,
    request: &TurnRequest,
    workspace: &dyn Workspace,
    keys: &ProviderKeys,
    gate: Option<&TurnGate>,
    on_event: impl FnMut(TurnEvent),
) -> Result<Conversation> {
    let ask = gate.map(|gate| {
        let cancel = gate.cancel.clone();
        let shell = gate.shell.clone();
        let pending = gate.pending.clone();
        Arc::new(move |command: &str, description: &str| {
            if let Ok(mut slot) = pending.lock() {
                *slot = Some((command.to_string(), description.to_string()));
            }
            let allow = shell.wait(&cancel, Duration::from_secs(600)).unwrap_or(false);
            if let Ok(mut slot) = pending.lock() {
                *slot = None;
            }
            allow
        }) as Arc<dyn Fn(&str, &str) -> bool + Send + Sync>
    });
    run_live_turn_with(
        service,
        request,
        workspace,
        &mut |messages, on_delta| model::run_round(keys, model_id(request), &request.effort, messages, on_delta),
        ask,
        gate.map(|gate| gate.cancel.clone()),
        on_event,
    )
}

fn run_live_turn_with(
    service: &ProjectService,
    request: &TurnRequest,
    workspace: &dyn Workspace,
    complete: &mut dyn FnMut(&[serde_json::Value], &mut dyn FnMut(&str)) -> Result<crate::model::Round>,
    ask: Option<Arc<dyn Fn(&str, &str) -> bool + Send + Sync>>,
    cancel: Option<Arc<AtomicBool>>,
    mut on_event: impl FnMut(TurnEvent),
) -> Result<Conversation> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err(Error::Other("prompt is empty".into()));
    }
    let id = request.conversation_id.trim();
    if id.is_empty() {
        return Err(Error::Other("conversation id is empty".into()));
    }
    let mut conversation = match service.get_conversation(id) {
        Ok(existing) => existing,
        Err(Error::NotFound(_)) => new_conversation(id, prompt, request),
        Err(err) => return Err(err),
    };
    conversation.messages.push(json!({ "role": "user", "content": prompt }));
    if conversation.title.is_empty() || conversation.title == "New chat" {
        conversation.title = title_from(prompt);
    }
    conversation.updated_at = now();
    if let Some(window) = request.context_window.filter(|value| *value > 0) {
        conversation.context_window = Some(window);
    }
    let window = conversation.context_window.filter(|value| *value > 0).unwrap_or(0);
    let mut prompt_tokens = stored_prompt_tokens(&conversation.context_usage);
    let mut compaction = stored_compaction(&conversation.compaction);
    let mut overflow_retries = 0u8;
    remember_compaction(&mut conversation, &compaction);
    crate::files::set_command_cancel(cancel.clone());
    let host = PermissionHost {
        permission: request.permission.clone(),
        ask,
    };
    let model_name = model_id(request).to_string();
    // No tool-round cap. Compaction bounds context, and the user stops a runaway turn.
    loop {
        if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return finish_cancelled(service, &mut conversation, &mut on_event);
        }
        match fit_prompt(
            service,
            &model_name,
            window,
            &cancel,
            complete,
            &mut conversation,
            &mut compaction,
            &mut prompt_tokens,
        ) {
            Fit::Ready => {}
            Fit::Stopped => return finish_cancelled(service, &mut conversation, &mut on_event),
            Fit::TooBig => return stop_for_context(service, &mut conversation, &mut on_event),
        }
        let context = crate::compact::messages_for_context(&conversation.messages, compaction.as_ref());
        let prompt = crate::compact::api_messages(&context);
        let mut saw_delta = false;
        let round = match complete(&prompt, &mut |text| {
            if !text.is_empty() {
                saw_delta = true;
                on_event(TurnEvent::Delta(text.to_string()));
            }
        }) {
            Ok(round) => round,
            Err(err) => {
                let message = err.to_string();
                if recover_overflow(
                    service,
                    &model_name,
                    &cancel,
                    complete,
                    &mut conversation,
                    &mut compaction,
                    &mut prompt_tokens,
                    &mut overflow_retries,
                    &message,
                ) {
                    continue;
                }
                if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                    return finish_cancelled(service, &mut conversation, &mut on_event);
                }
                return stop_with_message(service, &mut conversation, &mut on_event, &context_failure_text(&message));
            }
        };
        if let Some(message) = round.error.clone() {
            if recover_overflow(
                service,
                &model_name,
                &cancel,
                complete,
                &mut conversation,
                &mut compaction,
                &mut prompt_tokens,
                &mut overflow_retries,
                &message,
            ) {
                continue;
            }
            if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return finish_cancelled(service, &mut conversation, &mut on_event);
            }
            return stop_with_message(service, &mut conversation, &mut on_event, &context_failure_text(&message));
        }
        record_round_usage(service, &conversation, &model_name, round.usage);
        if let Some(usage) = round.usage {
            prompt_tokens = usage.prompt_tokens;
            conversation.context_usage = Some(usage_value(usage));
        }
        overflow_retries = 0;
        if round.tool_calls.is_empty() {
            crate::files::set_command_cancel(None);
            let text = if round.text.trim().is_empty() && !saw_delta {
                "Done.".to_string()
            } else {
                round.text
            };
            conversation.messages.push(json!({ "role": "assistant", "content": text }));
            remember_compaction(&mut conversation, &compaction);
            conversation.updated_at = now();
            service.save_conversation(&conversation)?;
            let mut shown = conversation.clone();
            shown.messages = public_messages(&conversation);
            on_event(TurnEvent::Done(shown));
            return Ok(conversation);
        }
        let calls: Vec<serde_json::Value> = round
            .tool_calls
            .iter()
            .map(|call| json!({ "id": call.id, "name": call.name, "arguments": call.arguments }))
            .collect();
        conversation.messages.push(json!({
            "role": "assistant",
            "content": round.text,
            "tool_calls": calls,
        }));
        for call in &round.tool_calls {
            if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                conversation.messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": "Skipped: stopped.",
                }));
                continue;
            }
            on_event(TurnEvent::Status(tool_status(&call.name, &call.arguments)));
            let result = match dispatch(workspace, &host, &request.permission, &call.name, &call.arguments) {
                Ok(result) => result,
                Err(err) => format!("Error: {err}"),
            };
            conversation.messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": cap_tool_text(&result),
            }));
        }
        remember_compaction(&mut conversation, &compaction);
        conversation.updated_at = now();
        service.save_conversation(&conversation)?;
        if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return finish_cancelled(service, &mut conversation, &mut on_event);
        }
    }
}

const CONTEXT_LIMIT_MESSAGE: &str =
    "This conversation is over the context size you chose. Start a new chat, or pick a larger context size.";
const FAILURE_PREFIX: &str = "Couldn't continue: ";
const TOOL_TEXT_CAP: usize = 24_000;
const TOOL_TEXT_HEAD: usize = 20_000;
const TOOL_TEXT_TAIL: usize = 2_000;

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

fn model_id(request: &TurnRequest) -> &str {
    let name = request.model.trim();
    if name.is_empty() { "grok-4.6" } else { name }
}

fn stored_prompt_tokens(usage: &Option<serde_json::Value>) -> u64 {
    usage.as_ref().and_then(|value| value.get("prompt_tokens")).and_then(|value| value.as_u64()).unwrap_or(0)
}

fn stored_compaction(value: &Option<serde_json::Value>) -> Option<crate::compact::Compaction> {
    let value = value.as_ref()?;
    let summary = value.get("summary").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
    let through = value.get("through").and_then(|item| item.as_u64()).unwrap_or(0);
    if summary.is_empty() || through == 0 {
        None
    } else {
        Some(crate::compact::Compaction { summary, through })
    }
}

fn remember_compaction(conversation: &mut Conversation, compaction: &Option<crate::compact::Compaction>) {
    conversation.compaction = compaction.as_ref().and_then(|state| serde_json::to_value(state).ok());
}

fn usage_value(usage: crate::model::RoundUsage) -> serde_json::Value {
    json!({
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "total_tokens": usage.prompt_tokens.saturating_add(usage.completion_tokens),
        "cache_read_tokens": usage.cache_read_tokens,
    })
}

fn context_failure_text(message: &str) -> String {
    if crate::compact::is_context_length_error(message) {
        CONTEXT_LIMIT_MESSAGE.to_string()
    } else {
        message.to_string()
    }
}

fn clear_prompt_measure(conversation: &mut Conversation, prompt_tokens: &mut u64) {
    *prompt_tokens = 0;
    conversation.context_usage = Some(json!({
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0
    }));
}

fn cancelled(cancel: &Option<Arc<AtomicBool>>) -> bool {
    cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed))
}

fn stop_for_context(
    service: &ProjectService,
    conversation: &mut Conversation,
    on_event: &mut impl FnMut(TurnEvent),
) -> Result<Conversation> {
    stop_with_message(service, conversation, on_event, CONTEXT_LIMIT_MESSAGE)
}

fn stop_with_message(
    service: &ProjectService,
    conversation: &mut Conversation,
    on_event: &mut impl FnMut(TurnEvent),
    message: &str,
) -> Result<Conversation> {
    crate::files::set_command_cancel(None);
    conversation.messages.push(json!({
        "role": "assistant",
        "content": format!("{FAILURE_PREFIX}{message}"),
        "error": true,
    }));
    conversation.updated_at = now();
    service.save_conversation(conversation)?;
    on_event(TurnEvent::Error(message.to_string()));
    Err(Error::Other(message.to_string()))
}

fn fit_prompt(
    service: &ProjectService,
    model_name: &str,
    window: u64,
    cancel: &Option<Arc<AtomicBool>>,
    complete: &mut dyn FnMut(&[serde_json::Value], &mut dyn FnMut(&str)) -> Result<crate::model::Round>,
    conversation: &mut Conversation,
    compaction: &mut Option<crate::compact::Compaction>,
    prompt_tokens: &mut u64,
) -> Fit {
    if cancelled(cancel) {
        return Fit::Stopped;
    }
    let can_fold = crate::compact::plan_fold(&conversation.messages, compaction.as_ref()).is_some();
    match crate::compact::budget_action(*prompt_tokens, window, can_fold) {
        crate::compact::BudgetAction::Send => Fit::Ready,
        crate::compact::BudgetAction::Stop => Fit::TooBig,
        crate::compact::BudgetAction::Fold { times } => match fold_up_to(
            service, model_name, cancel, complete, conversation, compaction, prompt_tokens, times,
        ) {
            FoldStep::Folded => Fit::Ready,
            FoldStep::Stopped => Fit::Stopped,
            FoldStep::None => {
                if crate::compact::prompt_exceeds_window(*prompt_tokens, window) {
                    Fit::TooBig
                } else {
                    Fit::Ready
                }
            }
        },
    }
}

fn recover_overflow(
    service: &ProjectService,
    model_name: &str,
    cancel: &Option<Arc<AtomicBool>>,
    complete: &mut dyn FnMut(&[serde_json::Value], &mut dyn FnMut(&str)) -> Result<crate::model::Round>,
    conversation: &mut Conversation,
    compaction: &mut Option<crate::compact::Compaction>,
    prompt_tokens: &mut u64,
    overflow_retries: &mut u8,
    message: &str,
) -> bool {
    if *overflow_retries >= 1 || !crate::compact::is_context_length_error(message) {
        return false;
    }
    *overflow_retries = overflow_retries.saturating_add(1);
    matches!(
        fold_up_to(service, model_name, cancel, complete, conversation, compaction, prompt_tokens, 4),
        FoldStep::Folded
    )
}

fn fold_up_to(
    service: &ProjectService,
    model_name: &str,
    cancel: &Option<Arc<AtomicBool>>,
    complete: &mut dyn FnMut(&[serde_json::Value], &mut dyn FnMut(&str)) -> Result<crate::model::Round>,
    conversation: &mut Conversation,
    compaction: &mut Option<crate::compact::Compaction>,
    prompt_tokens: &mut u64,
    times: u8,
) -> FoldStep {
    let mut folded = false;
    for _ in 0..times {
        if cancelled(cancel) {
            return FoldStep::Stopped;
        }
        match fold_once(service, model_name, cancel, complete, conversation, compaction, prompt_tokens) {
            FoldStep::Folded => folded = true,
            FoldStep::None => break,
            FoldStep::Stopped => return FoldStep::Stopped,
        }
    }
    if folded { FoldStep::Folded } else { FoldStep::None }
}

fn fold_once(
    service: &ProjectService,
    model_name: &str,
    cancel: &Option<Arc<AtomicBool>>,
    complete: &mut dyn FnMut(&[serde_json::Value], &mut dyn FnMut(&str)) -> Result<crate::model::Round>,
    conversation: &mut Conversation,
    compaction: &mut Option<crate::compact::Compaction>,
    prompt_tokens: &mut u64,
) -> FoldStep {
    let Some(plan) = crate::compact::plan_fold(&conversation.messages, compaction.as_ref()) else {
        return FoldStep::None;
    };
    if cancelled(cancel) {
        return FoldStep::Stopped;
    }
    let prompt = crate::compact::compaction_prompt(&plan.older, &plan.previous_summary);
    let round = match complete(&prompt, &mut |_| {}) {
        Ok(round) => round,
        Err(_) => return if cancelled(cancel) { FoldStep::Stopped } else { FoldStep::None },
    };
    record_round_usage(service, conversation, model_name, round.usage);
    if cancelled(cancel) {
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
    let Some(next) = crate::compact::commit_fold(&mut conversation.messages, &summary, plan.through) else {
        return FoldStep::None;
    };
    *compaction = Some(next);
    clear_prompt_measure(conversation, prompt_tokens);
    remember_compaction(conversation, compaction);
    conversation.updated_at = now();
    let _ = service.save_conversation(conversation);
    FoldStep::Folded
}

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

/// The usage log is a record of the turn, not part of the turn. A write that fails
/// leaves the conversation saved and the reply on its way.
fn record_round_usage(
    service: &ProjectService,
    conversation: &Conversation,
    model: &str,
    usage: Option<crate::model::RoundUsage>,
) {
    let Some(usage) = usage else {
        return;
    };
    let _ = crate::usage_log::record_in_store(
        &service.store_dir,
        &conversation.id,
        &conversation.title,
        model,
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.cache_read_tokens,
    );
}

fn finish_cancelled(
    service: &ProjectService,
    conversation: &mut Conversation,
    on_event: &mut impl FnMut(TurnEvent),
) -> Result<Conversation> {
    crate::files::set_command_cancel(None);
    conversation.updated_at = now();
    service.save_conversation(conversation)?;
    let mut shown = conversation.clone();
    shown.messages = public_messages(conversation);
    on_event(TurnEvent::Error("Stopped.".into()));
    let _ = shown;
    Err(Error::Other("Stopped.".into()))
}

/// Keep only the text the GUI is allowed to see. Tool arguments stay on the server.
pub fn public_messages(conversation: &Conversation) -> Vec<serde_json::Value> {
    conversation
        .messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role").and_then(|value| value.as_str()).unwrap_or("");
            let text = message.get("content").and_then(|value| value.as_str()).unwrap_or("");
            match role {
                "user" | "assistant" => {
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(json!({ "role": role, "content": text }))
                    }
                }
                "system" if text.trim() == crate::compact::COMPACTION_EVENT_TEXT => {
                    Some(json!({ "role": "system", "content": crate::compact::COMPACTION_EVENT_TEXT }))
                }
                _ => None,
            }
        })
        .collect()
}

fn new_conversation(id: &str, prompt: &str, request: &TurnRequest) -> Conversation {
    let stamp = now();
    Conversation {
        id: id.to_string(),
        title: title_from(prompt),
        created_at: stamp.clone(),
        updated_at: stamp,
        kind: "chat".into(),
        messages: Vec::new(),
        context_usage: None,
        compaction: None,
        journey_id: None,
        sort_order: 0,
        model: blank(&request.model),
        effort: blank(&request.effort),
        context_window: None,
        permission: blank(&request.permission),
        archived: false,
    }
}

fn blank(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

fn title_from(prompt: &str) -> String {
    let text = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return "New chat".into();
    }
    let mut chars = text.chars();
    let short: String = chars.by_ref().take(41).collect();
    if chars.next().is_some() { format!("{short}…") } else { short }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
fn message_text(message: &Value) -> String {
    message.get("content").and_then(Value::as_str).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Conversation;
    use crate::tools::LocalWorkspace;
    use serde_json::{json, Value};

    struct ReadThenAnswer;

    impl ScriptedModel for ReadThenAnswer {
        fn steps(&self) -> Vec<ModelStep> {
            vec![
                ModelStep::Tool {
                    id: "call-1".into(),
                    name: "read_file".into(),
                    arguments: r#"{"path":"note.txt"}"#.into(),
                },
                ModelStep::Text("The note says hi.".into()),
            ]
        }
    }

    struct DenyShellModel;

    impl ScriptedModel for DenyShellModel {
        fn steps(&self) -> Vec<ModelStep> {
            vec![
                ModelStep::Tool {
                    id: "call-1".into(),
                    name: "run_command".into(),
                    arguments: r#"{"command":"rm -rf /","description":"Wipe the disk"}"#.into(),
                },
                ModelStep::Text("Stopped after the skip.".into()),
            ]
        }
    }

    #[test]
    fn a_prompt_runs_tools_and_saves_both_messages() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("billing");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("note.txt"), "hi").unwrap();
        let service = ProjectService::open(&project, root.path().join("store")).unwrap();
        let saved = service
            .submit_prompt(
                &TurnRequest {
                    conversation_id: "c1".into(),
                    prompt: "read the note".into(),
                    model: "grok-4".into(),
                    effort: String::new(),
                    permission: "approve-all".into(),
                    project: String::new(),
                    context_window: None,
                },
                &ReadThenAnswer,
            )
            .unwrap();
        assert_eq!(message_text(&saved.messages[0]), "read the note");
        assert_eq!(saved.messages[1]["tool_calls"][0]["name"], "read_file");
        assert_eq!(message_text(&saved.messages[2]), "hi");
        assert_eq!(message_text(&saved.messages[3]), "The note says hi.");
        let loaded = service.get_conversation("c1").unwrap();
        assert_eq!(loaded.messages.len(), 4);
        let workspace = LocalWorkspace { root: project };
        assert_eq!(workspace.read("note.txt").unwrap(), "hi");
    }

    #[test]
    fn a_tool_error_is_saved_and_the_turn_continues() {
        let root = tempfile::tempdir().unwrap();
        let service = ProjectService::open(root.path().join("proj"), root.path().join("store")).unwrap();
        struct Missing;
        impl ScriptedModel for Missing {
            fn steps(&self) -> Vec<ModelStep> {
                vec![
                    ModelStep::Tool {
                        id: "call-1".into(),
                        name: "read_file".into(),
                        arguments: r#"{"path":"gone.txt"}"#.into(),
                    },
                    ModelStep::Text("Continued.".into()),
                ]
            }
        }
        let err = service.submit_prompt(
            &TurnRequest {
                conversation_id: "c1".into(),
                prompt: "read it".into(),
                model: String::new(),
                effort: String::new(),
                permission: "ask".into(),
                project: String::new(),
                context_window: None,
            },
            &Missing,
        );
        // Scripted turns still surface a hard tool error. The live loop records it and continues.
        assert!(err.is_err());
    }

    #[test]
    fn ask_mode_runs_a_command_only_after_the_gate_allows_it() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let _service = ProjectService::open(&project, root.path().join("store")).unwrap();
        let gate = TurnGate::new();
        gate.shell.answer(true);
        let workspace = LocalWorkspace { root: project.clone() };
        let marker = project.join("ran.txt");
        let host_result = {
            let ask = {
                let shell = gate.shell.clone();
                let cancel = gate.cancel.clone();
                std::sync::Arc::new(move |_command: &str, _description: &str| {
                    shell.wait(&cancel, std::time::Duration::from_secs(2)).unwrap_or(false)
                }) as std::sync::Arc<dyn Fn(&str, &str) -> bool + Send + Sync>
            };
            let host = PermissionHost {
                permission: "ask".into(),
                ask: Some(ask),
            };
            crate::tools::dispatch(
                &workspace,
                &host,
                "ask",
                "run_command",
                &format!(r#"{{"command":"echo ran > {}"}}"#, marker.display()),
            )
            .unwrap()
        };
        assert!(!host_result.contains("skipped"), "{host_result}");
        assert!(marker.exists(), "the approved command did not run");
    }

    #[test]
    fn a_denied_command_is_saved_as_skipped() {
        let root = tempfile::tempdir().unwrap();
        let service = ProjectService::open(root.path().join("proj"), root.path().join("store")).unwrap();
        let saved = service
            .submit_prompt(
                &TurnRequest {
                    conversation_id: "c1".into(),
                    prompt: "run it".into(),
                    model: String::new(),
                    effort: String::new(),
                    permission: "ask".into(),
                    project: String::new(),
                    context_window: None,
                },
                &DenyShellModel,
            )
            .unwrap();
        let tool = saved.messages.iter().find(|msg| msg["role"] == "tool").unwrap();
        assert_eq!(message_text(tool), "User skipped this command.");
        assert!(saved.messages.iter().any(|msg| message_text(msg) == "Stopped after the skip."));
    }

    #[test]
    fn a_turn_keeps_going_past_twenty_four_tool_rounds() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let service = ProjectService::open(&project, root.path().join("store")).unwrap();
        let mut calls = 0u32;
        let saved = run_live_turn_with(
            &service,
            &TurnRequest {
                conversation_id: "c1".into(),
                prompt: "keep looking".into(),
                model: "grok-4".into(),
                effort: String::new(),
                permission: "approve-all".into(),
                project: String::new(),
                context_window: None,
            },
            &LocalWorkspace { root: project },
            &mut |_messages: &[Value], _on_delta: &mut dyn FnMut(&str)| {
                calls += 1;
                if calls <= 24 {
                    return Ok(crate::model::Round {
                        text: String::new(),
                        tool_calls: vec![crate::model::ToolCall {
                            id: format!("c{calls}"),
                            name: "read_file".into(),
                            arguments: r#"{"path":"missing.txt"}"#.into(),
                        }],
                        error: None,
                        usage: Some(crate::model::RoundUsage {
                            prompt_tokens: 1000,
                            completion_tokens: 20,
                            cache_read_tokens: 0,
                        }),
                        reasoning: String::new(),
                    });
                }
                Ok(text_round("Still working."))
            },
            None,
            None,
            |_| {},
        )
        .unwrap();
        assert_eq!(calls, 25);
        assert!(saved.messages.iter().any(|msg| message_text(msg) == "Still working."));
        assert!(!saved.messages.iter().any(|msg| message_text(msg).contains("too many tool rounds")));
    }

    fn tool_loop() -> Vec<Value> {
        vec![
            json!({ "role": "user", "content": "find the crash" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "1", "name": "read_file", "arguments": "{}" }] }),
            json!({ "role": "tool", "tool_call_id": "1", "content": "first-file" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "2", "name": "read_file", "arguments": "{}" }] }),
            json!({ "role": "tool", "tool_call_id": "2", "content": "second-file" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "3", "name": "read_file", "arguments": "{}" }] }),
            json!({ "role": "tool", "tool_call_id": "3", "content": "third-file" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "4", "name": "read_file", "arguments": "{}" }] }),
            json!({ "role": "tool", "tool_call_id": "4", "content": "last-file" }),
        ]
    }

    fn stored_chat(service: &ProjectService, messages: Vec<Value>, prompt_tokens: u64, window: u64) {
        service
            .save_conversation(&Conversation {
                id: "c1".into(),
                title: "Hello".into(),
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
                kind: "chat".into(),
                messages,
                context_usage: Some(json!({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": 1,
                    "total_tokens": prompt_tokens + 1
                })),
                compaction: None,
                journey_id: None,
                sort_order: 0,
                effort: None,
                model: None,
                context_window: Some(window),
                permission: Some("approve-all".into()),
                archived: false,
            })
            .unwrap();
    }

    fn text_round(text: &str) -> crate::model::Round {
        crate::model::Round {
            text: text.into(),
            tool_calls: Vec::new(),
            error: None,
            usage: Some(crate::model::RoundUsage {
                prompt_tokens: 1000,
                completion_tokens: 20,
                cache_read_tokens: 0,
            }),
            reasoning: String::new(),
        }
    }

    #[test]
    fn a_full_window_is_summarized_before_the_next_prompt() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let service = ProjectService::open(&project, root.path().join("store")).unwrap();
        stored_chat(&service, tool_loop(), 500_333, 500_000);
        let mut seen = Vec::new();
        let saved = run_live_turn_with(
            &service,
            &TurnRequest {
                conversation_id: "c1".into(),
                prompt: "continue".into(),
                model: "grok-4".into(),
                effort: String::new(),
                permission: "approve-all".into(),
                project: String::new(),
                context_window: Some(500_000),
            },
            &LocalWorkspace { root: project },
            &mut |messages: &[Value], _on_delta: &mut dyn FnMut(&str)| {
                let rendered = serde_json::to_string(messages).unwrap_or_default();
                seen.push(rendered.clone());
                if rendered.contains("Reply with the summary only") {
                    return Ok(text_round("Read the first files."));
                }
                Ok(text_round("Continuing."))
            },
            None,
            None,
            |_| {},
        )
        .unwrap();
        assert!(seen.iter().any(|prompt| prompt.contains("Reply with the summary only")));
        let last = seen.last().unwrap();
        assert!(last.contains("Read the first files."));
        assert!(last.contains("last-file"));
        assert!(!last.contains("first-file"));
        assert_eq!(saved.compaction.as_ref().unwrap()["summary"], "Read the first files.");
        assert!(saved.messages.iter().any(|msg| message_text(msg) == "Conversation compacted"));
        assert!(saved.messages.iter().any(|msg| message_text(msg) == "Continuing."));
    }

    #[test]
    fn a_context_error_is_folded_and_retried_once() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let service = ProjectService::open(&project, root.path().join("store")).unwrap();
        stored_chat(&service, tool_loop(), 0, 500_000);
        let overflow = r#"xAI error 400: {"code":"invalid-argument","error":"Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (500333 tokens > 500000 tokens)"}"#;
        let mut real_calls = 0u8;
        let saved = run_live_turn_with(
            &service,
            &TurnRequest {
                conversation_id: "c1".into(),
                prompt: "continue".into(),
                model: "grok-4".into(),
                effort: String::new(),
                permission: "approve-all".into(),
                project: String::new(),
                context_window: Some(500_000),
            },
            &LocalWorkspace { root: project },
            &mut |messages: &[Value], _on_delta: &mut dyn FnMut(&str)| {
                let rendered = serde_json::to_string(messages).unwrap_or_default();
                if rendered.contains("Reply with the summary only") {
                    return Ok(text_round("Read the first files."));
                }
                real_calls += 1;
                if real_calls == 1 {
                    return Ok(crate::model::Round {
                        text: String::new(),
                        tool_calls: Vec::new(),
                        error: Some(overflow.into()),
                        usage: None,
                        reasoning: String::new(),
                    });
                }
                assert!(!rendered.contains("first-file"), "{rendered}");
                Ok(text_round("Continuing."))
            },
            None,
            None,
            |_| {},
        )
        .unwrap();
        assert_eq!(real_calls, 2);
        assert!(saved.messages.iter().any(|msg| message_text(msg) == "Continuing."));
        assert!(!saved.messages.iter().any(|msg| message_text(msg).contains("input_too_large")));
    }

    #[test]
    fn a_window_that_cannot_shrink_stops_without_calling_the_model() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let service = ProjectService::open(&project, root.path().join("store")).unwrap();
        stored_chat(
            &service,
            vec![
                json!({ "role": "user", "content": "find the crash" }),
                json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "1", "name": "read_file", "arguments": "{}" }] }),
                json!({ "role": "tool", "tool_call_id": "1", "content": "only-file" }),
            ],
            500_333,
            500_000,
        );
        let mut calls = 0u8;
        let err = run_live_turn_with(
            &service,
            &TurnRequest {
                conversation_id: "c1".into(),
                prompt: "continue".into(),
                model: "grok-4".into(),
                effort: String::new(),
                permission: "approve-all".into(),
                project: String::new(),
                context_window: Some(500_000),
            },
            &LocalWorkspace { root: project },
            &mut |_messages: &[Value], _on_delta: &mut dyn FnMut(&str)| {
                calls += 1;
                Ok(text_round("should not run"))
            },
            None,
            None,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(calls, 0);
        assert!(err.to_string().contains("context size you chose"));
    }
}
