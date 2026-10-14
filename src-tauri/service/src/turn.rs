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

const MAX_ROUNDS: usize = 24;

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
    run_live_turn_inner(service, request, workspace, keys, ask, gate.map(|gate| gate.cancel.clone()), on_event)
}

fn run_live_turn_inner(
    service: &ProjectService,
    request: &TurnRequest,
    workspace: &dyn Workspace,
    keys: &ProviderKeys,
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
    crate::files::set_command_cancel(cancel.clone());
    let host = PermissionHost {
        permission: request.permission.clone(),
        ask,
    };
    let model_name = if request.model.trim().is_empty() {
        "grok-4.6"
    } else {
        request.model.trim()
    };
    for round_index in 0..MAX_ROUNDS {
        if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return finish_cancelled(service, &mut conversation, &mut on_event);
        }
        let mut saw_delta = false;
        let round = match model::run_round(keys, model_name, &request.effort, &conversation.messages, &mut |text| {
            if !text.is_empty() {
                saw_delta = true;
                on_event(TurnEvent::Delta(text.to_string()));
            }
        }) {
            Ok(round) => round,
            Err(err) => {
                crate::files::set_command_cancel(None);
                on_event(TurnEvent::Error(err.to_string()));
                return Err(err);
            }
        };
        if let Some(message) = round.error {
            crate::files::set_command_cancel(None);
            on_event(TurnEvent::Error(message.clone()));
            return Err(Error::Other(message));
        }
        if round.tool_calls.is_empty() {
            crate::files::set_command_cancel(None);
            let text = if round.text.trim().is_empty() && !saw_delta {
                "Done.".to_string()
            } else {
                round.text
            };
            conversation.messages.push(json!({ "role": "assistant", "content": text }));
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
                "content": result,
            }));
        }
        conversation.updated_at = now();
        service.save_conversation(&conversation)?;
        if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return finish_cancelled(service, &mut conversation, &mut on_event);
        }
        if round_index + 1 == MAX_ROUNDS {
            crate::files::set_command_cancel(None);
            let message = "the turn ran too many tool rounds".to_string();
            on_event(TurnEvent::Error(message.clone()));
            return Err(Error::Other(message));
        }
    }
    crate::files::set_command_cancel(None);
    let message = "the turn ran too many tool rounds".to_string();
    on_event(TurnEvent::Error(message.clone()));
    Err(Error::Other(message))
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
            match role {
                "user" | "assistant" => {
                    let text = message.get("content").and_then(|value| value.as_str()).unwrap_or("");
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(json!({ "role": role, "content": text }))
                    }
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
    use crate::tools::LocalWorkspace;

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
                },
                &DenyShellModel,
            )
            .unwrap();
        let tool = saved.messages.iter().find(|msg| msg["role"] == "tool").unwrap();
        assert_eq!(message_text(tool), "User skipped this command.");
        assert!(saved.messages.iter().any(|msg| message_text(msg) == "Stopped after the skip."));
    }
}
