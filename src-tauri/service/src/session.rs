use std::io::{Read, Write};

use crate::codec::{version_ok, ClientFrame, ServerFrame, PROTOCOL_VERSION};
use crate::error::{Error, Result};
use crate::keys::{provider_keys_from_env, KeyFile};
use crate::tools::LocalWorkspace;
use crate::turn::{ScriptedModel, TurnRequest};
use crate::{ProjectService, TurnEvent};

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
        ClientFrame::Follow { id, cursor } => follow_live(service, &id, cursor),
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

fn follow_live(service: &ProjectService, id: &str, cursor: u64) -> ServerFrame {
    let data_dir = service.data_dir.as_path();
    match crate::live::read_since(data_dir, id, cursor) {
        Ok((frames, next)) => {
            let ended = frames
                .iter()
                .any(|frame| matches!(frame, crate::live::LiveFrame::Done { .. } | crate::live::LiveFrame::Error { .. }));
            let fresh = crate::live::active(data_dir, id, std::time::Duration::from_secs(20)).unwrap_or(false);
            ServerFrame::Live {
                cursor: next,
                active: fresh && !ended,
                frames,
            }
        }
        Err(err) => ServerFrame::Error { message: err.to_string() },
    }
}

fn submit(
    service: &ProjectService,
    keys: &KeyFile,
    request: TurnRequest,
    model: Option<&dyn ScriptedModel>,
) -> ServerFrame {
    let stored = keys.load().unwrap_or_default();
    let resolved = provider_keys_from_env(&stored);
    if !resolved.any() {
        return ServerFrame::Error {
            message: "Copy provider keys to this server in Settings.".into(),
        };
    }
    let workspace = LocalWorkspace { root: service.project.clone() };
    if model.is_some() {
        // Tests inject a scripted model. A real turn calls the provider from the copied keys.
        let Some(model) = model else {
            return ServerFrame::Error { message: "model is missing".into() };
        };
        return match crate::turn::run_scripted_turn(service, &request, &workspace, model) {
            Ok(conversation) => ServerFrame::Done { conversation },
            Err(err) => ServerFrame::Error { message: err.to_string() },
        };
    }
    match crate::turn::run_live_turn(service, &request, &workspace, &resolved, |_| {}) {
        Ok(conversation) => {
            let mut shown = conversation;
            shown.messages = crate::turn::public_messages(&shown);
            ServerFrame::Done { conversation: shown }
        }
        Err(err) => ServerFrame::Error { message: err.to_string() },
    }
}

/// Stream status, text, and the saved conversation. One request, many frames.
pub fn submit_streaming<W: Write>(
    service: &ProjectService,
    keys: &KeyFile,
    request: TurnRequest,
    output: &mut W,
) -> Result<()> {
    let stored = keys.load().unwrap_or_default();
    let resolved = provider_keys_from_env(&stored);
    if !resolved.any() {
        write_server(
            output,
            &ServerFrame::Error {
                message: "Copy provider keys to this server in Settings.".into(),
            },
        )?;
        return Ok(());
    }
    let workspace = LocalWorkspace { root: service.project.clone() };
    let (tx, rx) = std::sync::mpsc::channel();
    let id = request.conversation_id.clone();
    let data_dir = service.data_dir.clone();
    let _ = crate::live::begin(&data_dir, &id);
    let result = crate::turn::run_live_turn(service, &request, &workspace, &resolved, |event| {
        let frame = match event {
            TurnEvent::Status(text) => ServerFrame::Status { text },
            TurnEvent::Delta(text) => ServerFrame::Delta { text },
            TurnEvent::Done(conversation) => ServerFrame::Done { conversation },
            TurnEvent::Error(message) => ServerFrame::Error { message },
        };
        let _ = crate::live::append_server(&data_dir, &id, &frame);
        crate::realtime::publish_server(&id, &frame);
        let _ = tx.send(frame);
    });
    drop(tx);
    for frame in rx {
        write_server(output, &frame)?;
    }
    if let Err(err) = result {
        write_server(output, &ServerFrame::Error { message: err.to_string() })?;
    }
    Ok(())
}

/// Frames for the resident process. Each prompt names its project. Store calls do too.
pub fn serve_projects<R: Read, W: Write>(
    data_dir: &std::path::Path,
    keys: &KeyFile,
    input: &mut R,
    output: &mut W,
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
        let value: serde_json::Value = serde_json::from_slice(&body)?;
        let (project, inner) = split_resident(&value);
        if project.is_empty() {
            write_server(output, &ServerFrame::Error { message: "project is empty".into() })?;
            continue;
        }
        let service = match crate::open_server(std::path::Path::new(&project), data_dir) {
            Ok(service) => service,
            Err(err) => {
                write_server(output, &ServerFrame::Error { message: err.to_string() })?;
                continue;
            }
        };
        let frame: ClientFrame = match serde_json::from_value(inner) {
            Ok(frame) => frame,
            Err(err) => {
                write_server(output, &ServerFrame::Error { message: err.to_string() })?;
                continue;
            }
        };
        if let ClientFrame::SubmitPrompt(request) = frame {
            // A turn outlives this read. The socket, not stdout, is what open clients join.
            let keys = keys.clone();
            std::thread::spawn(move || {
                let mut sink = std::io::sink();
                let _ = submit_streaming(&service, &keys, request, &mut sink);
            });
            write_server(output, &ServerFrame::Ok)?;
            continue;
        }
        let response = handle_frame(&service, keys, frame, None);
        write_server(output, &response)?;
    }
}

/// A resident frame is `{ "project": "...", "frame": <ClientFrame> }`.
/// The project is not part of `ClientFrame`, so a store call and a prompt share one shape.
fn split_resident(value: &serde_json::Value) -> (String, serde_json::Value) {
    let wrapped = value.get("frame").is_some();
    let project = value.get("project").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
    let inner = if wrapped {
        value.get("frame").cloned().unwrap_or(serde_json::Value::Null)
    } else {
        value.clone()
    };
    (project, inner)
}

fn write_server<W: Write>(output: &mut W, frame: &ServerFrame) -> Result<()> {
    output.write_all(&crate::codec::encode_frame(frame)?)?;
    output.flush()?;
    Ok(())
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
        if model.is_none() {
            if let ClientFrame::SubmitPrompt(request) = frame {
                submit_streaming(service, keys, request, output)?;
                continue;
            }
        }
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
            project: String::new(),
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
    fn a_follow_reads_frames_written_while_the_turn_runs() {
        let root = tempfile::tempdir().unwrap();
        let service = ProjectService::open(root.path().join("proj"), root.path().join("store")).unwrap();
        let data = service.data_dir.clone();
        crate::live::begin(&data, "c1").unwrap();
        crate::live::append(&data, "c1", &crate::live::LiveFrame::Delta { text: "Hel".into() }).unwrap();
        let first = follow_live(&service, "c1", 0);
        let ServerFrame::Live { cursor, frames, .. } = first else {
            panic!("expected a live frame");
        };
        assert_eq!(frames.len(), 1);
        crate::live::append(&data, "c1", &crate::live::LiveFrame::Delta { text: "lo".into() }).unwrap();
        let second = follow_live(&service, "c1", cursor);
        let ServerFrame::Live { frames: more, .. } = second else {
            panic!("expected the next live frame");
        };
        assert_eq!(more, vec![crate::live::LiveFrame::Delta { text: "lo".into() }]);
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

    #[test]
    fn a_resident_frame_names_the_project_outside_the_client_frame() {
        let value = serde_json::json!({
            "project": "/home/dev/app",
            "frame": { "type": "list_conversations" }
        });
        let (project, inner) = split_resident(&value);
        assert_eq!(project, "/home/dev/app");
        let frame: ClientFrame = serde_json::from_value(inner).unwrap();
        assert!(matches!(frame, ClientFrame::ListConversations));
        let prompt = serde_json::json!({
            "project": "/home/dev/app",
            "frame": {
                "type": "submit_prompt",
                "conversation_id": "c1",
                "prompt": "hi",
                "model": "grok-4",
                "effort": "",
                "permission": "ask"
            }
        });
        let (_, inner) = split_resident(&prompt);
        let frame: ClientFrame = serde_json::from_value(inner).unwrap();
        let ClientFrame::SubmitPrompt(request) = frame else {
            panic!("expected a prompt");
        };
        assert_eq!(request.prompt, "hi");
    }
}
