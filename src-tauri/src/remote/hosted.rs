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
    let command = format!(
        "$HOME/.twanagent/bin/twanagent-server --call --project {} --data \"$HOME/.twanagent\" --frame {}",
        crate::remote::ssh::shell_single_quote(&project.remote_path),
        crate::remote::ssh::shell_single_quote(&encoded),
    );
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

/// List, load, save, and delete chats on the paired server. The local mount is not the store.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_call(
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
    let command = format!(
        "$HOME/.twanagent/bin/twanagent-server --call --project {} --data \"$HOME/.twanagent\" --frame {}",
        crate::remote::ssh::shell_single_quote(&project.remote_path),
        crate::remote::ssh::shell_single_quote(&encoded),
    );
    let secret = machine.secret_account.as_deref().and_then(crate::secrets::get_ssh_secret);
    let result = state.ssh_pool.exec(
        &machine,
        secret.as_deref(),
        &crate::remote::ssh::ExecRequest {
            cwd: "/".into(),
            command,
            timeout_secs: 60,
        },
    )?;
    if result.timed_out {
        return Err(Error::Other(format!("timed out talking to {}", machine.host)));
    }
    if result.exit_code.is_some_and(|code| code != 0) && result.stdout.len() < 4 {
        let detail = result.stderr.trim();
        return Err(Error::Other(if detail.is_empty() {
            format!("the server on {} did not answer", machine.host)
        } else {
            detail.to_string()
        }));
    }
    let (frame, _): (ServerFrame, usize) = decode_frame(result.stdout.as_bytes())
        .map_err(|err| Error::Other(format!("the server reply was not a frame: {err}")))?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
