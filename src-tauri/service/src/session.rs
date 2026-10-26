use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, OnceLock};

use crate::codec::{version_ok, ClientFrame, ServerFrame, PROTOCOL_VERSION};
use crate::turn::TurnGate;
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
        ClientFrame::ShellAnswer { .. } | ClientFrame::CancelTurn { .. } => ServerFrame::Ok,
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
        ClientFrame::UsageSince { since_id } => match crate::store::with_conn(&service.store_dir, |conn| {
            crate::usage_log::list_since(conn, since_id.max(0))
        }) {
            Ok(rows) => ServerFrame::Usage { rows },
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
    gate: Option<Arc<TurnGate>>,
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
    let gate_for_turn = gate.clone();
    let chat_id = id.clone();
    let live_dir = data_dir.clone();
    let frames = tx.clone();
    let pending = gate_for_turn.as_ref().map(|gate| gate.pending.clone());
    let watch_dir = data_dir.clone();
    let watch_id = id.clone();
    let watch_tx = tx.clone();
    let stop_watch = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag = stop_watch.clone();
    if let Some(pending) = pending {
        std::thread::spawn(move || {
            let mut sent = String::new();
            while !stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
                let next = pending.lock().ok().and_then(|slot| slot.clone());
                if let Some((command, description)) = next {
                    if sent != command {
                        sent = command.clone();
                        let frame = ServerFrame::ShellApproval {
                            conversation_id: watch_id.clone(),
                            command,
                            description,
                        };
                        let _ = crate::live::append_server(&watch_dir, &watch_id, &frame);
                        crate::realtime::publish_server(&watch_id, &frame);
                        let _ = watch_tx.send(frame);
                    }
                } else {
                    sent.clear();
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        });
    }
    let result = crate::turn::run_live_turn_gated(service, &request, &workspace, &resolved, gate_for_turn.as_deref(), move |event| {
        let frame = match event {
            TurnEvent::Status(text) => ServerFrame::Status { text },
            TurnEvent::Delta(text) => ServerFrame::Delta { text },
            TurnEvent::Done(conversation) => ServerFrame::Done { conversation },
            TurnEvent::Error(message) => ServerFrame::Error { message },
            TurnEvent::ShellApproval { command, description } => ServerFrame::ShellApproval {
                conversation_id: chat_id.clone(),
                command,
                description,
            },
        };
        let _ = crate::live::append_server(&live_dir, &chat_id, &frame);
        crate::realtime::publish_server(&chat_id, &frame);
        let _ = frames.send(frame);
    });
    stop_watch.store(true, std::sync::atomic::Ordering::Relaxed);
    drop(tx);
    for frame in rx {
        write_server(output, &frame)?;
    }
    if let Err(err) = result {
        write_server(output, &ServerFrame::Error { message: err.to_string() })?;
    }
    if let Some(gate) = gate {
        forget_gate(&id, &gate);
    }
    Ok(())
}

fn turn_gates() -> &'static Mutex<HashMap<String, Arc<TurnGate>>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<TurnGate>>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True when this conversation already has a turn. A second prompt is refused, not run beside it.
pub fn turn_busy(id: &str) -> bool {
    turn_gates().lock().ok().is_some_and(|map| map.contains_key(id))
}

fn remember_gate(id: &str, gate: Arc<TurnGate>) {
    if let Ok(mut map) = turn_gates().lock() {
        map.insert(id.to_string(), gate);
    }
}

fn forget_gate(id: &str, gate: &Arc<TurnGate>) {
    if let Ok(mut map) = turn_gates().lock() {
        if map.get(id).is_some_and(|current| Arc::ptr_eq(current, gate)) {
            map.remove(id);
        }
    }
}

fn gate_for(id: &str) -> Option<Arc<TurnGate>> {
    turn_gates().lock().ok().and_then(|map| map.get(id).cloned())
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
        if input.read_exact(&mut body).is_err() {
            // The fifo writer went away after the length. Reopen and keep the turns that are running.
            return Ok(());
        }
        let value: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(err) => {
                write_server(output, &ServerFrame::Error { message: err.to_string() })?;
                continue;
            }
        };
        let (project, token, inner) = split_resident(&value);
        // A frame that is not wrapped has no token. Treat it as a mismatch, not as a call.
        if value.get("frame").is_none() || !crate::keys::token_matches_any(&keys.auth_tokens(), &token) {
            write_server(
                output,
                &ServerFrame::Error {
                    message: "the pairing token does not match".into(),
                },
            )?;
            continue;
        }
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
        match frame {
            ClientFrame::ShellAnswer { id, allow } => {
                if let Some(gate) = gate_for(&id) {
                    gate.shell.answer(allow);
                }
                write_server(output, &ServerFrame::Ok)?;
                continue;
            }
            ClientFrame::CancelTurn { id } => {
                if let Some(gate) = gate_for(&id) {
                    gate.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                    gate.shell.answer(false);
                }
                write_server(output, &ServerFrame::Ok)?;
                continue;
            }
            ClientFrame::SubmitPrompt(request) => {
                if turn_busy(&request.conversation_id) {
                    write_server(
                        output,
                        &ServerFrame::Error {
                            message: "a turn is already running for this chat".into(),
                        },
                    )?;
                    continue;
                }
                let gate = Arc::new(TurnGate::new());
                remember_gate(&request.conversation_id, gate.clone());
                // A turn outlives this read. The socket, not stdout, is what open clients join.
                let keys = keys.clone();
                std::thread::spawn(move || {
                    let mut sink = std::io::sink();
                    let _ = submit_streaming(&service, &keys, request, Some(gate), &mut sink);
                });
                write_server(output, &ServerFrame::Ok)?;
                continue;
            }
            other => {
                let response = handle_frame(&service, keys, other, None);
                write_server(output, &response)?;
            }
        }
    }
}

/// A resident frame is `{ "project": "...", "token": "...", "frame": <ClientFrame> }`.
/// The project is not part of `ClientFrame`, so a store call and a prompt share one shape.
/// A body with no `frame` is not a call. The caller refuses it before the token is compared.
fn split_resident(value: &serde_json::Value) -> (String, String, serde_json::Value) {
    let project = value.get("project").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
    let token = value.get("token").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
    let inner = value.get("frame").cloned().unwrap_or(serde_json::Value::Null);
    (project, token, inner)
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
                submit_streaming(service, keys, request, None, output)?;
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
            context_window: None,
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
    fn a_resident_frame_without_the_token_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("auth-token"), "0123456789abcdef0123456789abcdef\n").unwrap();
        let keys = KeyFile::in_dir(&data);
        let body = serde_json::json!({
            "project": root.path().join("proj"),
            "token": "nope",
            "frame": { "type": "list_conversations" }
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&bytes);
        let mut output = Vec::new();
        serve_projects(&data, &keys, &mut frame.as_slice(), &mut output).unwrap();
        let (decoded, _): (ServerFrame, _) = crate::codec::decode_frame(&output).unwrap();
        let ServerFrame::Error { message } = decoded else {
            panic!("expected a token error");
        };
        assert!(message.contains("token"));
    }

    #[test]
    fn a_resident_frame_names_the_project_outside_the_client_frame() {
        let value = serde_json::json!({
            "project": "/home/dev/app",
            "token": "abc",
            "frame": { "type": "list_conversations" }
        });
        let (project, token, inner) = split_resident(&value);
        assert_eq!(project, "/home/dev/app");
        assert_eq!(token, "abc");
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
        let (_, _, inner) = split_resident(&prompt);
        let frame: ClientFrame = serde_json::from_value(inner).unwrap();
        let ClientFrame::SubmitPrompt(request) = frame else {
            panic!("expected a prompt");
        };
        assert_eq!(request.prompt, "hi");
    }
}
