use std::io::{Read, Write};

use crate::codec::{version_ok, ClientFrame, ServerFrame, PROTOCOL_VERSION};
use crate::error::{Error, Result};
use crate::keys::{provider_keys_from_env, KeyFile};
use crate::tools::{tool_status, LocalWorkspace};
use crate::turn::{ModelStep, ScriptedModel, TurnRequest};
use crate::ProjectService;

pub(crate) fn handle_frame(
    service: &ProjectService,
    keys: &KeyFile,
    frame: ClientFrame,
    model: Option<&dyn ScriptedModel>,
) -> ServerFrame {
    match frame {
        ClientFrame::Hello { version } => match version_ok(version) {
            Ok(()) => ServerFrame::Hello { version: PROTOCOL_VERSION },
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
        ClientFrame::ListConversations => match service.list_conversations() {
            Ok(rows) => ServerFrame::Conversations { rows },
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
        ClientFrame::GetConversation { id } => match service.get_conversation(&id) {
            Ok(conversation) => ServerFrame::Conversation(conversation),
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
        ClientFrame::SaveConversation(conversation) => match service.save_conversation(&conversation) {
            Ok(()) => ServerFrame::Conversation(conversation),
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
        ClientFrame::DeleteConversation { id } => match service.delete_conversation(&id) {
            Ok(()) => ServerFrame::Ok,
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
        ClientFrame::ReorderConversations { ids } => match service.reorder_conversations(&ids) {
            Ok(rows) => ServerFrame::Conversations { rows },
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
        ClientFrame::SetArchived { id, archived } => match service.set_archived(&id, archived) {
            Ok(()) => ServerFrame::Ok,
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
        ClientFrame::SubmitPrompt(request) => submit(service, keys, request, model),
        ClientFrame::CopyKeys(incoming) => match keys.save(&incoming) {
            Ok(()) => ServerFrame::Keys {
                present: keys.load().map(|row| row.any()).unwrap_or(false),
            },
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
        ClientFrame::RemoveKeys => match keys.remove() {
            Ok(()) => ServerFrame::Keys { present: false },
            Err(err) => ServerFrame::Error { message: err.to_string() },
        },
    }
}

fn submit(
    service: &ProjectService,
    keys: &KeyFile,
    request: TurnRequest,
    model: Option<&dyn ScriptedModel>,
) -> ServerFrame {
    let stored = keys.load().unwrap_or_default();
    if !provider_keys_from_env(&stored).any() {
        return ServerFrame::Error {
            message: "Copy provider keys to this server in Settings.".into(),
        };
    }
    let Some(model) = model else {
        return ServerFrame::Error {
            message: "This server build cannot call a model yet.".into(),
        };
    };
    for step in model.steps() {
        if let ModelStep::Tool { name, arguments, .. } = step {
            let _status = ServerFrame::Status { text: tool_status(&name, &arguments) };
        }
    }
    let workspace = LocalWorkspace { root: service.project.clone() };
    match crate::turn::run_scripted_turn(service, &request, &workspace, model) {
        Ok(conversation) => ServerFrame::Done { conversation },
        Err(err) => ServerFrame::Error { message: err.to_string() },
    }
}

pub fn serve<R: Read, W: Write>(
    service: &ProjectService,
    keys: &KeyFile,
    input: &mut R,
    output: &mut W,
    model: Option<&dyn ScriptedModel>,
) -> Result<()> {
    loop {
        let mut header = [0u8; 4];
        match read_header(input, &mut header)? {
            Header::Eof => return Ok(()),
            Header::Ready => {}
        }
        let len = u32::from_be_bytes(header) as usize;
        if len > 8_000_000 {
            return Err(Error::Other("frame is too large".into()));
        }
        let mut body = vec![0u8; len];
        input.read_exact(&mut body)?;
        let frame: ClientFrame = serde_json::from_slice(&body)?;
        let response = handle_frame(service, keys, frame, model);
        output.write_all(&crate::codec::encode_frame(&response)?)?;
        output.flush()?;
    }
}

enum Header {
    Eof,
    Ready,
}

fn read_header<R: Read>(input: &mut R, buf: &mut [u8]) -> Result<Header> {
    let mut filled = 0;
    while filled < buf.len() {
        match input.read(&mut buf[filled..])? {
            0 if filled == 0 => return Ok(Header::Eof),
            0 => return Err(Error::Other("frame ended early".into())),
            n => filled += n,
        }
    }
    Ok(Header::Ready)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::ProviderKeys;
    use crate::turn::{ModelStep, ScriptedModel, TurnRequest};

    struct Answer;

    impl ScriptedModel for Answer {
        fn steps(&self) -> Vec<ModelStep> {
            vec![ModelStep::Text("Saved on the server.".into())]
        }
    }

    fn request() -> TurnRequest {
        TurnRequest {
            conversation_id: "c1".into(),
            prompt: "hello".into(),
            model: "grok-4".into(),
            effort: String::new(),
            permission: "ask".into(),
        }
    }

    #[test]
    fn a_session_refuses_a_turn_until_keys_are_copied() {
        let root = tempfile::tempdir().unwrap();
        let service = ProjectService::open(root.path().join("proj"), root.path().join("store")).unwrap();
        let keys = KeyFile::in_dir(&root.path().join("data"));
        let blocked = handle_frame(&service, &keys, ClientFrame::SubmitPrompt(request()), Some(&Answer));
        assert!(matches!(blocked, ServerFrame::Error { .. }));
        let copied = handle_frame(
            &service,
            &keys,
            ClientFrame::CopyKeys(ProviderKeys {
                xai: "xai-secret".into(),
                ..ProviderKeys::default()
            }),
            None,
        );
        assert_eq!(copied, ServerFrame::Keys { present: true });
        let done = handle_frame(&service, &keys, ClientFrame::SubmitPrompt(request()), Some(&Answer));
        assert!(matches!(done, ServerFrame::Done { .. }));
        let store_bytes = std::fs::read(root.path().join("store/store.db")).unwrap_or_default();
        assert!(!String::from_utf8_lossy(&store_bytes).contains("xai-secret"));
    }

    #[test]
    fn stdin_frames_save_a_conversation() {
        let root = tempfile::tempdir().unwrap();
        let service = ProjectService::open(root.path().join("proj"), root.path().join("store")).unwrap();
        let keys = KeyFile::in_dir(&root.path().join("data"));
        keys.save(&ProviderKeys { xai: "xai-secret".into(), ..ProviderKeys::default() }).unwrap();
        let mut input = crate::codec::encode_frame(&ClientFrame::SubmitPrompt(TurnRequest {
            prompt: "hello from stdin".into(),
            ..request()
        }))
        .unwrap();
        input.extend(crate::codec::encode_frame(&ClientFrame::GetConversation { id: "c1".into() }).unwrap());
        let mut output = Vec::new();
        serve(&service, &keys, &mut input.as_slice(), &mut output, Some(&Answer)).unwrap();
        let (first, used): (ServerFrame, usize) = crate::codec::decode_frame(&output).unwrap();
        assert!(matches!(first, ServerFrame::Done { .. }));
        let (second, _): (ServerFrame, _) = crate::codec::decode_frame(&output[used..]).unwrap();
        let ServerFrame::Conversation(conversation) = second else {
            panic!("expected a reload");
        };
        assert_eq!(conversation.messages[0]["content"], "hello from stdin");
    }
}
