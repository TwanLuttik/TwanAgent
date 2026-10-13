//! A hosted project keeps files and conversations on the server.
//! The GUI sends a prompt. It does not run tools for that turn.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::{Error, Result};
use crate::state::AppState;
use twanagent_service::{decode_frame, encode_frame, ClientFrame, ServerFrame, TurnRequest};

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

fn hosted_cancels() -> &'static Mutex<std::collections::HashMap<String, Arc<AtomicBool>>> {
    static CANCELS: OnceLock<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn emit_hosted(app: &AppHandle, stream_id: &str, kind: &str, text: Option<String>, conversation: Option<serde_json::Value>) {
    let _ = app.emit(
        "dev-chat",
        crate::dev::types::DevChatEvent {
            stream_id: stream_id.to_string(),
            kind: kind.to_string(),
            text,
            tool_calls: None,
            usage: None,
            thinking: None,
            conversation,
        },
    );
}

/// A paired cloud project runs the turn on that machine. The GUI only sends the prompt.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_hosted_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace: String,
    stream_id: String,
    conversation_id: String,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
) -> Result<()> {
    let root = state.require_workspace(&workspace)?;
    let project = crate::remote::project_for_workspace(&state, &root)?
        .ok_or_else(|| Error::Other("this project is not on a server".into()))?;
    let conn = crate::appdb::open(&state.data_dir)?;
    let machine = crate::remote::config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let server = crate::remote::agent_server::server_by_host(&conn, &machine.host, machine.port)?
        .ok_or_else(|| Error::Other("Pair this server before sending a message.".into()))?;
    if !server.paired {
        return Err(Error::Other("Pair this server before sending a message.".into()));
    }
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    let frame = prompt_frame(&HostedTurn {
        conversation_id,
        prompt,
        model: model.unwrap_or_default(),
        effort: effort.unwrap_or_default(),
        permission: permission.unwrap_or_else(|| "ask".into()),
    })?;
    let bytes = encode_frame(&frame).map_err(|err| Error::Other(err.to_string()))?;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    let command = hosted_command(&project.remote_path, &encoded);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = hosted_cancels().lock() {
        map.insert(stream_id.clone(), cancel.clone());
    }
    let pool = state.ssh_pool.clone();
    let sid = stream_id.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = match pool.session(&machine, secret.as_deref()) {
            Ok(session) => session,
            Err(err) => {
                emit_hosted(&app2, &sid, "error", Some(err.to_string()), None);
                return;
            }
        };
        let mut buf = Vec::new();
        let result = session.exec_stream(
            &crate::remote::ssh::ExecRequest {
                cwd: "/".into(),
                command,
                timeout_secs: 600,
            },
            &mut |chunk| {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                buf.extend_from_slice(chunk);
                loop {
                    if buf.len() < 4 {
                        break;
                    }
                    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
                    if buf.len() < 4 + len {
                        break;
                    }
                    let body: Vec<u8> = buf.drain(..4 + len).collect();
                    let Ok((frame, _)) = decode_frame::<ServerFrame>(&body) else {
                        continue;
                    };
                    paint_frame(&app2, &sid, frame);
                }
            },
        );
        if let Err(err) = result {
            emit_hosted(&app2, &sid, "error", Some(err.to_string()), None);
        }
        if let Ok(mut map) = hosted_cancels().lock() {
            map.remove(&sid);
        }
    });
    Ok(())
}

fn paint_frame(app: &AppHandle, stream_id: &str, frame: ServerFrame) {
    match frame {
        ServerFrame::Status { text } => emit_hosted(app, stream_id, "status", Some(text), None),
        ServerFrame::Delta { text } => emit_hosted(app, stream_id, "delta", Some(text), None),
        ServerFrame::Done { conversation } => {
            let value = serde_json::to_value(&conversation).ok();
            emit_hosted(app, stream_id, "done", None, value);
        }
        ServerFrame::Error { message } => emit_hosted(app, stream_id, "error", Some(message), None),
        ServerFrame::Conversation(conversation) => {
            let value = serde_json::to_value(&conversation).ok();
            emit_hosted(app, stream_id, "conversation", None, value);
        }
        _ => {}
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_cancel(stream_id: String) {
    if let Ok(map) = hosted_cancels().lock() {
        if let Some(flag) = map.get(&stream_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn hosted_follows() -> &'static Mutex<std::collections::HashMap<String, Arc<AtomicBool>>> {
    static FOLLOWS: OnceLock<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FOLLOWS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn hosted_command(project_path: &str, encoded: &str) -> String {
    format!(
        "$HOME/.twanagent/bin/twanagent-server --call --project {} --data \"$HOME/.twanagent\" --frame {}",
        crate::remote::ssh::shell_single_quote(project_path),
        crate::remote::ssh::shell_single_quote(encoded),
    )
}

/// The first four bytes are a length. A shell banner, or the copy's "installed", is not a frame.
fn decode_server_reply(bytes: &[u8], stderr: &str) -> Result<(ServerFrame, usize)> {
    if let Ok(decoded) = decode_frame(bytes) {
        return Ok(decoded);
    }
    if let Some(at) = bytes.windows(1).position(|window| window[0] == b'{') {
        if let Ok(decoded) = decode_frame(&bytes[at.saturating_sub(4)..]) {
            return Ok(decoded);
        }
    }
    let note = stderr.trim();
    if !note.is_empty() {
        return Err(Error::Other(note.to_string()));
    }
    if bytes.is_empty() {
        return Err(Error::Other("the server did not answer".into()));
    }
    Err(Error::Other("the server reply was not a frame".into()))
}

fn encode_client(frame: &ClientFrame) -> Result<String> {
    let bytes = encode_frame(frame).map_err(|err| Error::Other(err.to_string()))?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes))
}

/// Follow a turn that is already running on the server.
/// The window that started the turn already has its own stream. This is for every other window.
/// The socket is on the server's localhost. SSH forwards it here, so nothing is exposed.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_hosted_follow(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace: String,
    stream_id: String,
    conversation_id: String,
) -> Result<()> {
    let root = state.require_workspace(&workspace)?;
    let project = crate::remote::project_for_workspace(&state, &root)?
        .ok_or_else(|| Error::Other("this project is not on a server".into()))?;
    let conn = crate::appdb::open(&state.data_dir)?;
    let machine = crate::remote::config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let server = crate::remote::agent_server::server_by_host(&conn, &machine.host, machine.port)?
        .ok_or_else(|| Error::Other("Pair this server before opening its chats.".into()))?;
    if !server.paired {
        return Err(Error::Other("Pair this server before opening its chats.".into()));
    }
    let secret = machine.secret_account.as_deref().and_then(crate::secrets::get_ssh_secret);
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = hosted_follows().lock() {
        if let Some(previous) = map.insert(stream_id.clone(), stop.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
    }
    let pool = state.ssh_pool.clone();
    let sid = stream_id.clone();
    let chat_id = conversation_id.clone();
    let remote_path = project.remote_path.clone();
    let app2 = app.clone();
    let machine2 = machine.clone();
    let secret = secret.clone();
    tauri::async_runtime::spawn(async move {
        let _ = wake_live(pool, machine2.clone(), secret, remote_path).await;
        let local = match open_live_tunnel(&machine2).await {
            Ok(port) => port,
            Err(err) => {
                emit_hosted(&app2, &sid, "error", Some(err.to_string()), None);
                emit_hosted(&app2, &sid, "idle", None, None);
                return;
            }
        };
        if let Err(err) = read_live_socket(&app2, &sid, local, &chat_id, &stop).await {
            emit_hosted(&app2, &sid, "error", Some(err.to_string()), None);
        }
        emit_hosted(&app2, &sid, "idle", None, None);
        if let Ok(mut map) = hosted_follows().lock() {
            map.remove(&sid);
        }
    });
    Ok(())
}

async fn wake_live(
    pool: std::sync::Arc<crate::remote::ssh::Pool>,
    machine: crate::remote::config::Machine,
    secret: Option<String>,
    remote_path: String,
) -> Result<()> {
    let encoded = encode_client(&ClientFrame::Hello { version: twanagent_service::PROTOCOL_VERSION })?;
    crate::state::run_blocking(move || {
        let _ = pool.exec(
            &machine,
            secret.as_deref(),
            &crate::remote::ssh::ExecRequest {
                cwd: "/".into(),
                command: format!(
                    "$HOME/.twanagent/bin/twanagent-server --live --data \"$HOME/.twanagent\" >/dev/null 2>&1 & {call}",
                    call = hosted_command(&remote_path, &encoded)
                ),
                timeout_secs: 8,
            },
        );
        Ok(())
    })
    .await
}

async fn open_live_tunnel(machine: &crate::remote::config::Machine) -> Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| Error::Other(format!("could not open a local port: {err}")))?;
    let port = listener
        .local_addr()
        .map_err(|err| Error::Other(err.to_string()))?
        .port();
    drop(listener);
    let mut command = tokio::process::Command::new("ssh");
    command
        .arg("-N")
        .arg("-L")
        .arg(format!("{port}:127.0.0.1:{}", twanagent_service::LIVE_PORT))
        .arg("-p")
        .arg(machine.port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ConnectTimeout=8")
        .arg(format!("{}@{}", machine.user, machine.host))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
        .spawn()
        .map_err(|err| Error::Other(format!("could not open the live tunnel: {err}")))?;
    Ok(port)
}

async fn read_live_socket(
    app: &AppHandle,
    stream_id: &str,
    port: u16,
    conversation_id: &str,
    stop: &AtomicBool,
) -> Result<()> {
    let url = format!("ws://127.0.0.1:{port}");
    let (socket, _) = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        tokio_tungstenite::connect_async(&url),
    )
    .await
    .map_err(|_| Error::Other("the server did not open its live socket".into()))?
    .map_err(|err| Error::Other(format!("could not connect to the live socket: {err}")))?;
    let (mut write, mut read) = socket.split();
    let hello = twanagent_service::subscribe_text(conversation_id);
    use futures_util::{SinkExt, StreamExt};
    write
        .send(tokio_tungstenite::tungstenite::Message::Text(hello.into()))
        .await
        .map_err(|err| Error::Other(format!("could not subscribe: {err}")))?;
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let next = tokio::time::timeout(std::time::Duration::from_secs(30), read.next()).await;
        let message = match next {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(err))) => return Err(Error::Other(format!("live socket closed: {err}"))),
            Ok(None) => break,
            Err(_) => continue,
        };
        let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text.as_str()) else {
            continue;
        };
        let kind = value.get("type").and_then(|item| item.as_str()).unwrap_or("");
        match kind {
            "delta" => emit_hosted(app, stream_id, "delta", value.get("text").and_then(|item| item.as_str()).map(str::to_string), None),
            "status" => emit_hosted(app, stream_id, "status", value.get("text").and_then(|item| item.as_str()).map(str::to_string), None),
            "done" => {
                let conversation = value.get("conversation").cloned();
                emit_hosted(app, stream_id, "done", None, conversation);
                break;
            }
            "error" => {
                emit_hosted(app, stream_id, "error", value.get("message").and_then(|item| item.as_str()).map(str::to_string), None);
                break;
            }
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_unfollow(stream_id: String) {
    if let Ok(map) = hosted_follows().lock() {
        if let Some(flag) = map.get(&stream_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// List, load, save, and delete chats on the paired server. The local mount is not the store.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_hosted_call(
    state: State<'_, AppState>,
    workspace: String,
    frame_json: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let project = crate::remote::project_for_workspace(&state, &root)?
        .ok_or_else(|| Error::Other("this project is not on a server".into()))?;
    let conn = crate::appdb::open(&state.data_dir)?;
    let machine = crate::remote::config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let server = crate::remote::agent_server::server_by_host(&conn, &machine.host, machine.port)?
        .ok_or_else(|| Error::Other("Pair this server before opening its chats.".into()))?;
    if !server.paired {
        return Err(Error::Other("Pair this server before opening its chats.".into()));
    }
    let value: serde_json::Value = serde_json::from_str(&frame_json).map_err(|err| Error::Other(err.to_string()))?;
    let frame: ClientFrame = serde_json::from_value(value).map_err(|err| Error::Other(err.to_string()))?;
    let bytes = encode_frame(&frame).map_err(|err| Error::Other(err.to_string()))?;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    let command = hosted_command(&project.remote_path, &encoded);
    let secret = machine.secret_account.as_deref().and_then(crate::secrets::get_ssh_secret);
    let pool = state.ssh_pool.clone();
    let host = machine.host.clone();
    crate::state::run_blocking(move || {
        let result = pool.exec(
            &machine,
            secret.as_deref(),
            &crate::remote::ssh::ExecRequest {
                cwd: "/".into(),
                command,
                timeout_secs: 60,
            },
        )?;
        if result.timed_out {
            return Err(Error::Other(format!("timed out talking to {host}")));
        }
        if result.exit_code.is_some_and(|code| code != 0) && result.stdout_bytes.len() < 4 {
            let detail = result.stderr.trim();
            return Err(Error::Other(if detail.is_empty() {
                format!("the server on {host} did not answer")
            } else {
                detail.to_string()
            }));
        }
        let (frame, _) = decode_server_reply(&result.stdout_bytes, &result.stderr)?;
        match frame {
            ServerFrame::Error { message } => Err(Error::Other(message)),
            ServerFrame::Conversations { rows } => {
                serde_json::to_string(&serde_json::json!({ "rows": rows })).map_err(Error::from)
            }
            ServerFrame::Conversation(conversation) | ServerFrame::Done { conversation } => {
                serde_json::to_string(&conversation).map_err(Error::from)
            }
            other => serde_json::to_string(&other).map_err(Error::from),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[test]
    fn a_copy_banner_is_not_reported_as_a_short_frame() {
        let err = decode_server_reply(b"installed\n", "").unwrap_err().to_string();
        assert!(!err.contains("frame header"));
        assert!(err.contains("not a frame"));
        let detail = decode_server_reply(b"", "the program is missing").unwrap_err().to_string();
        assert_eq!(detail, "the program is missing");
        let frame = encode_frame(&ServerFrame::Ok).unwrap();
        assert!(matches!(decode_server_reply(&frame, "").unwrap().0, ServerFrame::Ok));
    }

    #[test]
    fn a_binary_reply_keeps_bytes_the_string_form_drops() {
        // A length byte of 0x80 is valid in the frame header and illegal in UTF-8.
        // Turning the reply into a string replaces it, so the body no longer matches.
        let body = br#"{"type":"ok"}"#;
        let mut raw = (body.len() as u32).to_be_bytes().to_vec();
        raw[1] = 0x80;
        raw[3] = body.len() as u8;
        let claimed = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
        raw.resize(4 + claimed, b' ');
        raw[4..4 + body.len()].copy_from_slice(body);
        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains('\u{FFFD}'));
        assert!(decode_frame::<ServerFrame>(text.as_bytes()).is_err());
        let (frame, _): (ServerFrame, usize) = decode_frame(&raw).unwrap();
        assert!(matches!(frame, ServerFrame::Ok));
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
}
