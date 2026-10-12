//! A hosted project keeps files and conversations on the server.
//! The GUI sends a prompt. It does not run tools for that turn.

use serde::{Deserialize, Serialize};

use tauri::State;

use crate::error::{Error, Result};
use crate::state::AppState;
use twanagent_service::{ClientFrame, ProviderKeys, ServerFrame, TurnRequest};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostedTurn {
    pub conversation_id: String,
    pub prompt: String,
    pub model: String,
    pub effort: String,
    pub permission: String,
}

/// Build the only frame a send is allowed to produce.
pub fn prompt_frame(turn: &HostedTurn) -> Result<ClientFrame> {
    let prompt = turn.prompt.trim();
    if prompt.is_empty() {
        return Err(Error::Other("prompt is empty".into()));
    }
    let conversation_id = turn.conversation_id.trim();
    if conversation_id.is_empty() {
        return Err(Error::Other("conversation id is empty".into()));
    }
    Ok(ClientFrame::SubmitPrompt(TurnRequest {
        conversation_id: conversation_id.to_string(),
        prompt: prompt.to_string(),
        model: turn.model.trim().to_string(),
        effort: turn.effort.trim().to_string(),
        permission: if turn.permission.trim().is_empty() {
            "ask".into()
        } else {
            turn.permission.trim().to_string()
        },
    }))
}

/// Submit a prompt to a server that is already running and speaking frames on `client`.
pub fn submit_prompt(client: &mut dyn HostedClient, turn: &HostedTurn) -> Result<ServerFrame> {
    let frame = prompt_frame(turn)?;
    client.roundtrip(&frame)
}

/// Run a prompt against a local folder using the same engine the headless server uses.
/// The GUI sends the prompt. Tools run in `twanagent-service`, not in the webview.
/// This path is for trying the engine. A normal local chat still uses the existing turn.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_try(
    state: State<'_, AppState>,
    workspace: String,
    conversation_id: String,
    prompt: String,
    model: Option<String>,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let data = state.data_dir.join("hosted").join(crate::dev::paths::workspace_id_public(&root));
    let service = twanagent_service::open_server(&root, &data).map_err(service_err)?;
    let keys = twanagent_service::key_file(&data);
    if !keys.load().map_err(service_err)?.any() {
        let copied = ProviderKeys {
            xai: crate::secrets::get_xai_key(&state.data_dir).unwrap_or_default(),
            anthropic: crate::secrets::get_anthropic_key(&state.data_dir).unwrap_or_default(),
            minimax: crate::secrets::get_minimax_key(&state.data_dir).unwrap_or_default(),
        };
        if copied.any() {
            keys.save(&copied).map_err(service_err)?;
        } else {
            // A try on this Mac has no separate server keychain. The marker is not a real key.
            keys.save(&ProviderKeys {
                xai: "local-try".into(),
                ..ProviderKeys::default()
            })
            .map_err(service_err)?;
        }
    }
    struct LocalAnswer;
    impl twanagent_service::ScriptedModel for LocalAnswer {
        fn steps(&self) -> Vec<twanagent_service::ModelStep> {
            vec![twanagent_service::ModelStep::Text(
                "Hosted engine saved this prompt. A live model call is not wired yet.".into(),
            )]
        }
    }
    let mut host = ScriptedHost {
        service,
        keys,
        model: &LocalAnswer,
    };
    let done = submit_prompt(
        &mut host,
        &HostedTurn {
            conversation_id,
            prompt,
            model: model.unwrap_or_default(),
            effort: String::new(),
            permission: "ask".into(),
        },
    )?;
    match done {
        ServerFrame::Done { conversation } => serde_json::to_string(&conversation).map_err(Error::from),
        ServerFrame::Error { message } => Err(Error::Other(message)),
        other => Err(Error::Other(format!("unexpected hosted reply: {other:?}"))),
    }
}

fn service_err(err: twanagent_service::Error) -> Error {
    Error::Other(err.to_string())
}

pub use client_io::{HostedClient, ScriptedHost};

#[cfg(test)]
mod tests {
    use super::*;
    use twanagent_service::{ModelStep, ScriptedModel};

    struct Echo;

    impl ScriptedModel for Echo {
        fn steps(&self) -> Vec<ModelStep> {
            vec![ModelStep::Text("Saved on the server.".into())]
        }
    }

    #[test]
    fn a_hosted_send_is_only_the_prompt() {
        let frame = prompt_frame(&HostedTurn {
            conversation_id: "c1".into(),
            prompt: "read the note".into(),
            model: "grok-4".into(),
            effort: "low".into(),
            permission: "ask".into(),
        })
        .unwrap();
        let bytes = twanagent_service::encode_frame(&frame).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("read the note"));
        assert!(!text.contains("read_file"));
        assert!(!text.contains("run_command"));
    }

    #[test]
    fn the_server_saves_the_turn_and_the_client_reloads_it() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("billing");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("note.txt"), "hi").unwrap();
        let data = root.path().join("data");
        let service = twanagent_service::open_server(&project, &data).unwrap();
        let keys = twanagent_service::key_file(&data);
        keys.save(&ProviderKeys {
            xai: "xai-secret".into(),
            ..ProviderKeys::default()
        })
        .unwrap();
        let mut host = ScriptedHost {
            service,
            keys,
            model: &Echo,
        };
        let done = submit_prompt(
            &mut host,
            &HostedTurn {
                conversation_id: "c1".into(),
                prompt: "hello from the mac".into(),
                model: "grok-4".into(),
                effort: String::new(),
                permission: "ask".into(),
            },
        )
        .unwrap();
        let twanagent_service::ServerFrame::Done { conversation } = done else {
            panic!("expected the server to finish the turn");
        };
        assert_eq!(conversation.messages[0]["content"], "hello from the mac");
        let loaded = host.roundtrip(&ClientFrame::GetConversation { id: "c1".into() }).unwrap();
        let twanagent_service::ServerFrame::Conversation(again) = loaded else {
            panic!("expected a reload");
        };
        assert_eq!(again.messages.len(), 2);
        let missing = submit_prompt(
            &mut ScriptedHost {
                service: twanagent_service::open_server(&root.path().join("other"), &root.path().join("other-data")).unwrap(),
                keys: twanagent_service::key_file(&root.path().join("other-data")),
                model: &Echo,
            },
            &HostedTurn {
                conversation_id: "c2".into(),
                prompt: "no keys".into(),
                model: String::new(),
                effort: String::new(),
                permission: "ask".into(),
            },
        )
        .unwrap();
        assert!(matches!(missing, twanagent_service::ServerFrame::Error { .. }));
    }
}

mod client_io {
    use twanagent_service::{serve, ClientFrame, KeyFile, ProjectService, ScriptedModel, ServerFrame};

    use crate::error::{Error, Result};

    pub trait HostedClient {
        fn roundtrip(&mut self, frame: &ClientFrame) -> Result<ServerFrame>;
    }

    pub struct ScriptedHost<'a> {
        pub service: ProjectService,
        pub keys: KeyFile,
        pub model: &'a dyn ScriptedModel,
    }

    impl HostedClient for ScriptedHost<'_> {
        fn roundtrip(&mut self, frame: &ClientFrame) -> Result<ServerFrame> {
            let bytes = twanagent_service::encode_frame(frame).map_err(|err| Error::Other(err.to_string()))?;
            let mut output = Vec::new();
            serve(&self.service, &self.keys, &mut bytes.as_slice(), &mut output, Some(self.model))
                .map_err(|err| Error::Other(err.to_string()))?;
            let (decoded, _): (ServerFrame, usize) =
                twanagent_service::decode_frame(&output).map_err(|err| Error::Other(err.to_string()))?;
            Ok(decoded)
        }
    }
}
