use serde::{Deserialize, Serialize};
use serde_json::json;
#[cfg(test)]
use serde_json::Value;

use crate::error::{Error, Result};
use crate::store::Conversation;
use crate::tools::{dispatch, ToolHost, Workspace};
use crate::ProjectService;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnRequest {
    pub conversation_id: String,
    pub prompt: String,
    pub model: String,
    pub effort: String,
    pub permission: String,
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
}

impl ToolHost for PermissionHost {
    fn allow_shell(&self, _command: &str) -> bool {
        self.permission == "approve-all"
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
                },
                &DenyShellModel,
            )
            .unwrap();
        let tool = saved.messages.iter().find(|msg| msg["role"] == "tool").unwrap();
        assert_eq!(message_text(tool), "User skipped this command.");
        assert!(saved.messages.iter().any(|msg| message_text(msg) == "Stopped after the skip."));
    }
}
