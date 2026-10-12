//! One WebSocket per open cloud chat.
//!
//! The server listens on `127.0.0.1` only. The desktop app reaches it through an SSH tunnel,
//! so the socket is never on the public network. A turn pushes each display frame here.
//! Every socket that subscribed to that conversation receives it.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::error::{Error, Result};
use crate::live::LiveFrame;

pub const LIVE_PORT: u16 = 8731;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SocketMessage {
    Subscribe { id: String },
    Status { text: String },
    Delta { text: String },
    Done { conversation: serde_json::Value },
    Error { message: String },
}

struct Hub {
    next: u64,
    subs: HashMap<u64, (String, mpsc::UnboundedSender<String>)>,
}

impl Hub {
    fn new() -> Self {
        Self {
            next: 1,
            subs: HashMap::new(),
        }
    }
}

fn hub() -> &'static Mutex<Hub> {
    static HUB: OnceLock<Mutex<Hub>> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(Hub::new()))
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("twanagent-live")
            .build()
            .expect("live runtime")
    })
}

/// Accept sockets. Binding twice is not an error: the process that already holds the port stays.
pub fn ensure_started(data_dir: &Path) -> Result<SocketAddr> {
    let _ = data_dir;
    let addr: SocketAddr = format!("127.0.0.1:{LIVE_PORT}").parse().expect("live address");
    let listener = match std::net::TcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => return Ok(addr),
        Err(err) => return Err(Error::Io(err)),
    };
    listener.set_nonblocking(true).map_err(Error::Io)?;
    runtime().spawn(async move {
        let listener = match TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(_) => return,
        };
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(handle(stream));
        }
    });
    Ok(addr)
}

async fn handle(stream: tokio::net::TcpStream) {
    let Ok(socket) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut write, mut read) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = {
        let mut hub = hub().lock().unwrap_or_else(|err| err.into_inner());
        let id = hub.next;
        hub.next += 1;
        hub.subs.insert(id, (String::new(), tx));
        id
    };
    let outbound = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if write.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(message) = read.next().await {
        let Ok(message) = message else { break };
        if message.is_close() {
            break;
        }
        let Message::Text(text) = message else { continue };
        let Ok(SocketMessage::Subscribe { id: chat }) = serde_json::from_str(text.as_str()) else {
            continue;
        };
        let chat = chat.trim().to_string();
        if chat.is_empty() || chat.contains('/') || chat.contains('\\') || chat.contains("..") {
            continue;
        }
        if let Ok(mut hub) = hub().lock() {
            if let Some(row) = hub.subs.get_mut(&id) {
                row.0 = chat;
            }
        }
    }
    if let Ok(mut hub) = hub().lock() {
        hub.subs.remove(&id);
    }
    outbound.abort();
}

/// Hand one display frame to every socket watching this conversation.
pub fn publish(conversation_id: &str, frame: &LiveFrame) {
    let message = match frame {
        LiveFrame::Status { text } => SocketMessage::Status { text: text.clone() },
        LiveFrame::Delta { text } => SocketMessage::Delta { text: text.clone() },
        LiveFrame::Done { conversation } => SocketMessage::Done {
            conversation: serde_json::to_value(conversation).unwrap_or(serde_json::Value::Null),
        },
        LiveFrame::Error { message } => SocketMessage::Error {
            message: message.clone(),
        },
    };
    let Ok(text) = serde_json::to_string(&message) else {
        return;
    };
    let mut dead = Vec::new();
    if let Ok(hub) = hub().lock() {
        for (id, (chat, tx)) in &hub.subs {
            if chat == conversation_id && tx.send(text.clone()).is_err() {
                dead.push(*id);
            }
        }
    }
    if dead.is_empty() {
        return;
    }
    if let Ok(mut hub) = hub().lock() {
        for id in dead {
            hub.subs.remove(&id);
        }
    }
}

pub fn publish_server(conversation_id: &str, frame: &crate::codec::ServerFrame) {
    let Some(live) = Option::<LiveFrame>::from(frame) else {
        return;
    };
    publish(conversation_id, &live);
}

/// The JSON a client sends to start receiving one conversation.
pub fn subscribe_text(id: &str) -> String {
    serde_json::json!({ "type": "subscribe", "id": id }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribe_names_the_conversation() {
        let text = subscribe_text("c1");
        let message: SocketMessage = serde_json::from_str(&text).unwrap();
        assert_eq!(message, SocketMessage::Subscribe { id: "c1".into() });
    }
}
