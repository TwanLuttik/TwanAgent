//! A hosted project keeps files and conversations on the server.
//! The GUI sends a prompt. It does not run tools for that turn.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::error::{Error, Result};
use crate::process::WindowlessCommand;
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
        project: String::new(),
    }))
}

fn emit_live_socket(app: &AppHandle, stream_id: &str, conversation_id: &str, port: u16, direction: &str, text: &str) {
    let _ = app.emit(
        "dev-live-socket",
        crate::dev::types::DevLiveSocketEvent {
            stream_id: stream_id.to_string(),
            conversation_id: conversation_id.to_string(),
            port,
            direction: direction.to_string(),
            text: text.to_string(),
        },
    );
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
    let token = server_token(&conn, &server.id)?;
    let frame = prompt_frame(&HostedTurn {
        conversation_id,
        prompt,
        model: model.unwrap_or_default(),
        effort: effort.unwrap_or_default(),
        permission: permission.unwrap_or_else(|| "ask".into()),
    })?;
    let bytes = resident_bytes(&project.remote_path, &frame, &token)?;
    let remote_path = project.remote_path.clone();
    let chat_id = frame_conversation(&frame);
    let cache_dir = state.data_dir.clone();
    let cache_workspace = workspace.clone();
    let pool = state.ssh_pool.clone();
    let sid = stream_id.clone();
    let app2 = app.clone();
    let machine_for_live = machine.clone();
    let already = chat_already_joined(&chat_id);
    let feed_pool = pool.clone();
    let feed_secret = secret.clone();
    let feed_machine = machine.clone();
    let feed_app = app2.clone();
    let feed_sid = sid.clone();
    let feed_path = remote_path.clone();
    remember_hosted_job(
        &chat_id,
        HostedJob {
            pool: pool.clone(),
            machine: machine.clone(),
            secret: secret.clone(),
            token: token.clone(),
            remote_path: remote_path.clone(),
        },
    );
    if !already {
        // This window opened the chat but has not joined yet. Join as the sender so tokens
        // are not stuck behind the SSH command. A chat that is already open keeps its own join.
        let stop = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = hosted_follows().lock() {
            map.insert(chat_id.clone(), FollowSlot { stream_id: sid.clone(), stop: stop.clone() });
        }
        tauri::async_runtime::spawn(async move {
            let _ = wake_live(pool.clone(), machine_for_live.clone(), secret.clone(), remote_path.clone()).await;
            let port = match open_live_tunnel(&machine_for_live).await {
                Ok(port) => port,
                Err(err) => {
                    emit_hosted(&app2, &sid, "error", Some(err.to_string()), None);
                    return;
                }
            };
            if let Err(err) = read_live_socket(&app2, &sid, port, &chat_id, &token, &stop, &cache_dir, &cache_workspace).await {
                emit_hosted(&app2, &sid, "error", Some(err.to_string()), None);
            }
        });
    }
    // The open chat is already joined to the live socket. This only hands the prompt over.
    // Stdout is the ack. Tokens arrive on `dev-chat` from the socket, not from this command.
    tauri::async_runtime::spawn_blocking(move || {
        let session = match feed_pool.fresh(&feed_machine, feed_secret.as_deref()) {
            Ok(session) => session,
            Err(err) => {
                emit_hosted(&feed_app, &feed_sid, "error", Some(err.to_string()), None);
                return;
            }
        };
        let sent = session.exec_with_stdin(
            &crate::remote::ssh::ExecRequest {
                cwd: "/".into(),
                command: serve_feed_command(),
                timeout_secs: 30,
            },
            &bytes,
            &mut |_| {},
        );
        let failed = match sent {
            Err(err) => Some(err.to_string()),
            Ok(result) if result.timed_out || result.exit_code.is_some_and(|code| code != 0) => {
                let detail = result.stderr.trim();
                Some(if detail.is_empty() {
                    format!("the server for {feed_path} did not take the prompt")
                } else {
                    detail.to_string()
                })
            }
            Ok(_) => None,
        };
        if let Some(detail) = failed {
            emit_hosted(&feed_app, &feed_sid, "error", Some(detail), None);
        }
    });
    let _ = token;
    Ok(())
}

/// Hand one frame to the resident process. Its stdin is a fifo, because an exec channel
/// closes stdin before a piped program can read it.
fn chat_already_joined(conversation_id: &str) -> bool {
    hosted_follows()
        .lock()
        .ok()
        .is_some_and(|map| map.contains_key(conversation_id))
}

fn frame_conversation(frame: &ClientFrame) -> String {
    match frame {
        ClientFrame::SubmitPrompt(request) => request.conversation_id.clone(),
        _ => String::new(),
    }
}

fn server_token(conn: &rusqlite::Connection, server_id: &str) -> Result<String> {
    if let Some(token) = crate::secrets::get_agent_token(server_id) {
        if token.trim().len() >= 32 {
            return Ok(token);
        }
    }
    // A server paired before the token moved to the keychain still has it in the row.
    let token: Option<String> = conn
        .query_row("SELECT token FROM agent_servers WHERE id = ?1", [server_id], |row| row.get(0))
        .map_err(|err| Error::Other(err.to_string()))?;
    let token = token
        .filter(|value| value.trim().len() >= 32)
        .ok_or_else(|| Error::Other("Pair this server before sending a message.".into()))?;
    let _ = crate::secrets::set_agent_token(server_id, &token);
    Ok(token)
}

fn serve_feed_command() -> String {
    "fifo=\"$HOME/.twanagent/serve.stdin\"; \
if [ ! -p \"$fifo\" ]; then echo 'the live server is not running' >&2; exit 1; fi; \
cat > \"$fifo\"".into()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_cancel(stream_id: String) {
    // The stream id is the conversation id for a hosted turn. The resident process kills the command.
    // The job stays so a late approval frame can still find it until the turn ends.
    if let Some(job) = hosted_job(&stream_id) {
        let frame = ClientFrame::CancelTurn { id: stream_id };
        std::thread::spawn(move || {
            let _ = feed_resident(&job.pool, &job.machine, job.secret.as_deref(), &job.token, &job.remote_path, &frame);
        });
    }
}

struct HostedJob {
    pool: std::sync::Arc<crate::remote::ssh::Pool>,
    machine: crate::remote::config::Machine,
    secret: Option<String>,
    token: String,
    remote_path: String,
}

fn hosted_jobs() -> &'static Mutex<std::collections::HashMap<String, HostedJob>> {
    static JOBS: OnceLock<Mutex<std::collections::HashMap<String, HostedJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn remember_hosted_job(id: &str, job: HostedJob) {
    if let Ok(mut map) = hosted_jobs().lock() {
        map.insert(id.to_string(), job);
    }
}

fn hosted_job(id: &str) -> Option<HostedJob> {
    hosted_jobs().lock().ok().and_then(|map| {
        map.get(id).map(|job| HostedJob {
            pool: job.pool.clone(),
            machine: job.machine.clone(),
            secret: job.secret.clone(),
            token: job.token.clone(),
            remote_path: job.remote_path.clone(),
        })
    })
}

fn feed_resident(
    pool: &crate::remote::ssh::Pool,
    machine: &crate::remote::config::Machine,
    secret: Option<&str>,
    token: &str,
    remote_path: &str,
    frame: &ClientFrame,
) -> Result<()> {
    let bytes = resident_bytes(remote_path, frame, token)?;
    let session = pool.fresh(machine, secret)?;
    let sent = session.exec_with_stdin(
        &crate::remote::ssh::ExecRequest {
            cwd: "/".into(),
            command: serve_feed_command(),
            timeout_secs: 30,
        },
        &bytes,
        &mut |_| {},
    )?;
    if sent.timed_out || sent.exit_code.is_some_and(|code| code != 0) {
        let detail = sent.stderr.trim();
        return Err(Error::Other(if detail.is_empty() {
            "the server did not take the frame".into()
        } else {
            detail.to_string()
        }));
    }
    Ok(())
}

struct FollowSlot {
    stream_id: String,
    stop: Arc<AtomicBool>,
}

fn hosted_follows() -> &'static Mutex<std::collections::HashMap<String, FollowSlot>> {
    static FOLLOWS: OnceLock<Mutex<std::collections::HashMap<String, FollowSlot>>> = OnceLock::new();
    FOLLOWS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

struct LiveTunnel {
    port: u16,
    child: std::sync::Mutex<Option<std::process::Child>>,
}

fn live_tunnels() -> &'static Mutex<std::collections::HashMap<String, Arc<LiveTunnel>>> {
    static TUNNELS: OnceLock<Mutex<std::collections::HashMap<String, Arc<LiveTunnel>>>> = OnceLock::new();
    TUNNELS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn hosted_command(encoded: &str) -> String {
    // `--call` still answers one store frame. The resident shape carries the token.
    // The one-shot binary reads the same `{project, token, frame}` body.
    format!(
        "$HOME/.twanagent/bin/twanagent-server --call --project / --data \"$HOME/.twanagent\" --frame {}",
        crate::remote::ssh::shell_single_quote(encoded),
    )
}

/// One frame for the resident server. The project is outside the client frame.
fn resident_bytes(project_path: &str, frame: &ClientFrame, token: &str) -> Result<Vec<u8>> {
    let inner = serde_json::to_value(frame).map_err(|err| Error::Other(err.to_string()))?;
    let wrapped = serde_json::json!({
        "project": project_path,
        "token": token,
        "frame": inner,
    });
    let body = serde_json::to_vec(&wrapped).map_err(|err| Error::Other(err.to_string()))?;
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    Ok(out)
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
    let token = server_token(&conn, &server.id)?;
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = hosted_follows().lock() {
        if let Some(previous) = map.insert(
            conversation_id.clone(),
            FollowSlot {
                stream_id: stream_id.clone(),
                stop: stop.clone(),
            },
        ) {
            previous.stop.store(true, Ordering::Relaxed);
        }
    }
    let pool = state.ssh_pool.clone();
    let sid = stream_id.clone();
    let chat_id = conversation_id.clone();
    let remote_path = project.remote_path.clone();
    let cache_dir = state.data_dir.clone();
    let cache_workspace = workspace.clone();
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
        if let Err(err) = read_live_socket(&app2, &sid, local, &chat_id, &token, &stop, &cache_dir, &cache_workspace).await {
            emit_hosted(&app2, &sid, "error", Some(err.to_string()), None);
        }
        emit_hosted(&app2, &sid, "idle", None, None);
        if let Ok(mut map) = hosted_follows().lock() {
            if map.get(&chat_id).is_some_and(|slot| slot.stream_id == sid) {
                map.remove(&chat_id);
            }
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
    let _ = remote_path;
    crate::state::run_blocking(move || {
        // `--serve` exits immediately when the socket is already taken, so this is safe to repeat.
        let _ = pool.exec(
            &machine,
            secret.as_deref(),
            &crate::remote::ssh::ExecRequest {
                cwd: "/".into(),
                command: "$HOME/.twanagent/bin/twanagent-server --serve --data \"$HOME/.twanagent\" >/dev/null 2>&1 &".into(),
                timeout_secs: 8,
            },
        );
        Ok(())
    })
    .await
}

fn tunnel_alive(tunnel: &LiveTunnel) -> bool {
    tunnel
        .child
        .lock()
        .ok()
        .and_then(|mut slot| {
            slot.as_mut().and_then(|child| match child.try_wait() {
                Ok(None) => Some(true),
                _ => Some(false),
            })
        })
        .unwrap_or(false)
}

async fn open_live_tunnel(machine: &crate::remote::config::Machine) -> Result<u16> {
    if let Ok(mut map) = live_tunnels().lock() {
        if let Some(existing) = map.get(&machine.id) {
            if tunnel_alive(existing) {
                return Ok(existing.port);
            }
        }
        map.remove(&machine.id);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| Error::Other(format!("could not open a local port: {err}")))?;
    let port = listener
        .local_addr()
        .map_err(|err| Error::Other(err.to_string()))?
        .port();
    drop(listener);
    let mut command = std::process::Command::new("ssh");
    command.hide_console_window();
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
    let child = command
        .spawn()
        .map_err(|err| Error::Other(format!("could not open the live tunnel: {err}")))?;
    let tunnel = Arc::new(LiveTunnel {
        port,
        child: std::sync::Mutex::new(Some(child)),
    });
    if let Ok(mut map) = live_tunnels().lock() {
        map.insert(machine.id.clone(), tunnel);
    }
    wait_for_port(port).await?;
    Ok(port)
}

async fn wait_for_port(port: u16) -> Result<()> {
    let started = std::time::Instant::now();
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        if started.elapsed() > std::time::Duration::from_secs(8) {
            return Err(Error::Other("the live tunnel did not open".into()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

async fn read_live_socket(
    app: &AppHandle,
    stream_id: &str,
    port: u16,
    conversation_id: &str,
    token: &str,
    stop: &AtomicBool,
    cache_dir: &std::path::Path,
    cache_workspace: &str,
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
    let hello = twanagent_service::subscribe_text_with(conversation_id, token);
    use futures_util::{SinkExt, StreamExt};
    emit_live_socket(app, stream_id, conversation_id, port, "out", &hello);
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
        emit_live_socket(app, stream_id, conversation_id, port, "in", text.as_str());
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text.as_str()) else {
            continue;
        };
        let kind = value.get("type").and_then(|item| item.as_str()).unwrap_or("");
        match kind {
            "delta" => emit_hosted(app, stream_id, "delta", value.get("text").and_then(|item| item.as_str()).map(str::to_string), None),
            "status" => emit_hosted(app, stream_id, "status", value.get("text").and_then(|item| item.as_str()).map(str::to_string), None),
            "done" => {
                // The chat stays open. The next turn on this conversation uses the same socket.
                // The saved conversation is also the copy the next launch paints.
                let conversation = value.get("conversation").cloned();
                if let Some(saved) = conversation.as_ref().filter(|row| !row.is_null()) {
                    remember_hosted_value(&cache_dir, &cache_workspace, saved);
                }
                emit_hosted(app, stream_id, "done", None, conversation);
                emit_hosted(app, stream_id, "idle", None, None);
            }
            "error" => {
                emit_hosted(app, stream_id, "error", value.get("message").and_then(|item| item.as_str()).map(str::to_string), None);
            }
            "shell_approval" => {
                let command = value.get("command").and_then(|item| item.as_str()).unwrap_or("").to_string();
                emit_hosted(app, stream_id, "shell_approval", Some(command), None);
            }
            _ => {}
        }
    }
    Ok(())
}

/// The user's answer to a shell prompt the resident server is waiting on.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_shell_answer(conversation_id: String, allow: bool) -> Result<()> {
    let Some(job) = hosted_job(&conversation_id) else {
        return Err(Error::Other("that chat is not waiting on a command".into()));
    };
    let frame = ClientFrame::ShellAnswer {
        id: conversation_id,
        allow,
    };
    feed_resident(&job.pool, &job.machine, job.secret.as_deref(), &job.token, &job.remote_path, &frame)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_unfollow(stream_id: String) {
    if let Ok(mut map) = hosted_follows().lock() {
        let found = map.iter().find(|(_, slot)| slot.stream_id == stream_id).map(|(id, _)| id.clone());
        if let Some(id) = found {
            if let Some(slot) = map.remove(&id) {
                slot.stop.store(true, Ordering::Relaxed);
            }
        }
    }
}

fn summary_from_hosted(row: &twanagent_service::ConversationSummary) -> crate::dev::ConversationSummary {
    crate::dev::ConversationSummary {
        id: row.id.clone(),
        title: row.title.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        kind: if row.kind.is_empty() { "chat".into() } else { row.kind.clone() },
        journey_id: row.journey_id.clone(),
        sort_order: row.sort_order,
        effort: row.effort.clone(),
        model: row.model.clone(),
        context_window: row.context_window,
        permission: row.permission.clone(),
        archived: row.archived,
    }
}

fn conversation_from_hosted(row: &twanagent_service::Conversation) -> crate::dev::Conversation {
    crate::dev::Conversation {
        id: row.id.clone(),
        title: row.title.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        kind: if row.kind.is_empty() { "chat".into() } else { row.kind.clone() },
        messages: row.messages.clone(),
        context_usage: row
            .context_usage
            .as_ref()
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        compaction: row
            .compaction
            .as_ref()
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        journey_id: row.journey_id.clone(),
        sort_order: row.sort_order,
        effort: row.effort.clone(),
        model: row.model.clone(),
        context_window: row.context_window,
        permission: row.permission.clone(),
        archived: row.archived,
    }
}

fn remember_hosted_value(data_dir: &std::path::Path, workspace: &str, value: &serde_json::Value) {
    let Ok(row) = serde_json::from_value::<twanagent_service::Conversation>(value.clone()) else {
        return;
    };
    remember_hosted_conversation(data_dir, workspace, &row);
}

/// Remember the server's chat list so the next launch paints it before SSH answers.
fn remember_hosted_list(data_dir: &std::path::Path, workspace: &str, rows: &[twanagent_service::ConversationSummary]) {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    let summaries: Vec<_> = rows.iter().map(summary_from_hosted).collect();
    let journeys = crate::appdb::sidebar_for(&conn, workspace).map(|(_, journeys)| journeys).unwrap_or_default();
    let _ = crate::appdb::replace_sidebar_source(&conn, workspace, &summaries, &journeys, true);
}

fn remember_hosted_conversation(data_dir: &std::path::Path, workspace: &str, row: &twanagent_service::Conversation) {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    let _ = crate::appdb::save_sidebar_transcript(&conn, workspace, &conversation_from_hosted(row));
}

/// The last server list and every saved transcript. Opening a chat paints from this, not from SSH.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_sidebar_cached(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<(Vec<crate::dev::ConversationSummary>, Vec<crate::dev::Journey>, Vec<crate::dev::Conversation>)> {
    let conn = crate::appdb::open(&state.data_dir)?;
    if !crate::appdb::sidebar_is_cloud(&conn, &workspace)? {
        return Ok((Vec::new(), Vec::new(), Vec::new()));
    }
    let (rows, journeys) = crate::appdb::sidebar_for(&conn, &workspace)?;
    let rows: Vec<_> = rows.into_iter().filter(|row| {
        let title = row.title.trim();
        !((title.is_empty() || title == "New chat") && row.kind != "terminal")
    }).collect();
    let keep: std::collections::HashSet<_> = rows.iter().map(|row| row.id.clone()).collect();
    let transcripts = crate::appdb::sidebar_transcripts(&conn, &workspace)?
        .into_iter()
        .filter(|row| keep.contains(&row.id))
        .collect();
    Ok((rows, journeys, transcripts))
}

/// The last transcript saved for one cloud chat. Null until that chat has been opened here.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_hosted_conversation_cached(
    state: State<'_, AppState>,
    workspace: String,
    id: String,
) -> Result<Option<crate::dev::Conversation>> {
    let conn = crate::appdb::open(&state.data_dir)?;
    crate::appdb::sidebar_transcript(&conn, &workspace, &id)
}

/// List, load, save, and delete chats on the paired server. The local mount is not the store.
/// A list or a loaded chat is also written into the app database, marked as a cloud copy.
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
    let token = server_token(&conn, &server.id)?;
    let value: serde_json::Value = serde_json::from_str(&frame_json).map_err(|err| Error::Other(err.to_string()))?;
    let frame: ClientFrame = serde_json::from_value(value).map_err(|err| Error::Other(err.to_string()))?;
    let bytes = resident_bytes(&project.remote_path, &frame, &token).map_err(|err| Error::Other(err.to_string()))?;
    let _ = encode_frame::<ClientFrame>;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    let command = hosted_command(&encoded);
    let secret = machine.secret_account.as_deref().and_then(crate::secrets::get_ssh_secret);
    let pool = state.ssh_pool.clone();
    let host = machine.host.clone();
    let data_dir = state.data_dir.clone();
    let remember_workspace = workspace.clone();
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
                remember_hosted_list(&data_dir, &remember_workspace, &rows);
                serde_json::to_string(&serde_json::json!({ "rows": rows })).map_err(Error::from)
            }
            ServerFrame::Conversation(conversation) | ServerFrame::Done { conversation } => {
                remember_hosted_conversation(&data_dir, &remember_workspace, &conversation);
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
        let text = String::from_utf8(bytes[4..].to_vec()).unwrap();
        assert!(text.contains("read the note"));
        assert!(!text.contains("read_file"));
        assert!(!text.contains("run_command"));
    }
}
