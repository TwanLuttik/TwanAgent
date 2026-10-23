//! Project engine shared by the TwanAgent app and `twanagent-server`.
//!
//! The app calls this in-process for a local project. The headless server calls the same
//! functions for a project that lives on another Mac or a Linux box. A turn is a prompt.
//! Tools run here, next to the files. The GUI only renders what comes back.

mod codec;
mod error;
mod files;
mod keys;
mod live;
mod model;
mod providers;
mod realtime;
mod search;
mod session;
mod store;
mod tools;
mod turn;

pub use providers::{anthropic, minimax, registry, xai};

pub use codec::{decode_frame, encode_frame, ClientFrame, ServerFrame, PROTOCOL_VERSION};
pub use error::{Error, Result};
pub use files::{numbered_lines, parse_line_int};
pub use live::LiveFrame;
pub use realtime::{ensure_started, subscribe_text, subscribe_text_with, LIVE_PORT};
pub use keys::{provider_keys_from_env, KeyFile, ProviderKeys};
pub use search::{glob_match, matches_glob, glob as search_glob, grep as search_grep, GlobQuery, GrepQuery};
pub use session::serve;
pub use store::{Conversation, ConversationSummary};
pub use turn::{ModelStep, ScriptedModel, TurnRequest};

/// `twanagent-server --version` prints this. It is the service crate version, not the app version.
/// Server binary updates can ship without a new GUI build, so the two numbers move separately.
/// A null keeps the next string in the binary from being read as part of the version.
pub const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "\0");

/// One line the GUI paints while a hosted turn runs. Tool results stay on the server.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEvent {
    Status(String),
    Delta(String),
    Done(Conversation),
    Error(String),
    /// Ask mode. The command has not run. The desktop answers on the fifo.
    ShellApproval { command: String, description: String },
}

use std::io::{Read, Write};
use std::path::Path;

pub struct ProjectService {
    pub project: std::path::PathBuf,
    /// This project's conversations. Not shared with another project on the same machine.
    pub store_dir: std::path::PathBuf,
    /// The machine data directory. Keys and the live tail stay here.
    pub data_dir: std::path::PathBuf,
}

impl ProjectService {
    pub fn open(project: impl AsRef<Path>, store_dir: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_data(project, store_dir.as_ref(), store_dir.as_ref().parent().unwrap_or(store_dir.as_ref()))
    }

    fn open_with_data(project: impl AsRef<Path>, store_dir: &Path, data_dir: &Path) -> Result<Self> {
        let project = project.as_ref().to_path_buf();
        let store_dir = store_dir.to_path_buf();
        let data_dir = data_dir.to_path_buf();
        std::fs::create_dir_all(&project)?;
        std::fs::create_dir_all(&store_dir)?;
        std::fs::create_dir_all(&data_dir)?;
        let _ = store::open(&store_dir)?;
        Ok(Self {
            project,
            store_dir,
            data_dir,
        })
    }

    pub fn list_conversations(&self) -> Result<Vec<store::ConversationSummary>> {
        store::with_conn(&self.store_dir, store::list_conversation_summaries)
    }

    pub fn get_conversation(&self, id: &str) -> Result<Conversation> {
        store::with_conn(&self.store_dir, |conn| store::get_conversation(conn, id))
    }

    pub fn save_conversation(&self, conversation: &Conversation) -> Result<()> {
        store::with_conn(&self.store_dir, |conn| store::save_conversation(conn, conversation))
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        store::with_conn(&self.store_dir, |conn| store::delete_conversation(conn, id))
    }

    pub fn reorder_conversations(&self, ids: &[String]) -> Result<Vec<store::ConversationSummary>> {
        store::with_conn(&self.store_dir, |conn| store::reorder_conversations(conn, ids))
    }

    pub fn set_archived(&self, id: &str, archived: bool) -> Result<()> {
        store::with_conn(&self.store_dir, |conn| store::set_archived(conn, id, archived))
    }

    /// Append the prompt, run the scripted model, and save the reply. No network.
    pub fn submit_prompt(&self, request: &TurnRequest, model: &dyn ScriptedModel) -> Result<Conversation> {
        let workspace = tools::LocalWorkspace {
            root: self.project.clone(),
        };
        turn::run_scripted_turn(self, request, &workspace, model)
    }
}

/// Conversations for one project. Two projects on the same machine do not share this directory.
/// The name is the project path, so a renamed folder is a different project.
pub fn project_store_dir(data_dir: &Path, project: &Path) -> std::path::PathBuf {
    data_dir.join("projects").join(project_store_key(project))
}

fn decode_call_frame(
    service: &ProjectService,
    keys: &KeyFile,
    bytes: &[u8],
) -> Result<(ClientFrame, ProjectService)> {
    let len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let body = bytes.get(4..4 + len).ok_or_else(|| Error::Other("frame body is short".into()))?;
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) {
        if value.get("frame").is_some() {
            let project = value.get("project").and_then(|item| item.as_str()).unwrap_or("").trim();
            let token = value.get("token").and_then(|item| item.as_str()).unwrap_or("");
            if !keys::token_matches(&keys.auth_token(), token) {
                return Err(Error::Other("the pairing token does not match".into()));
            }
            if project.is_empty() || project == "/" {
                return Err(Error::Other("project is empty".into()));
            }
            let opened = open_server(Path::new(project), &service.data_dir)?;
            let frame = serde_json::from_value(value.get("frame").cloned().unwrap_or(serde_json::Value::Null))?;
            return Ok((frame, opened));
        }
    }
    let (frame, _) = decode_frame(bytes)?;
    Ok((frame, ProjectService {
        project: service.project.clone(),
        store_dir: service.store_dir.clone(),
        data_dir: service.data_dir.clone(),
    }))
}

fn project_store_key(project: &Path) -> String {
    use sha2::{Digest, Sha256};
    // The same folder must reopen the same store. `~/proj` and its canonical path are one project.
    let canonical = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let text = canonical.to_string_lossy().replace('\\', "/");
    let trimmed = text.trim_end_matches('/');
    Sha256::digest(trimmed.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn open_server(project: &Path, data_dir: &Path) -> Result<ProjectService> {
    std::fs::create_dir_all(project)?;
    ProjectService::open_with_data(project, &project_store_dir(data_dir, project), data_dir)
}

pub fn key_file(data_dir: &Path) -> KeyFile {
    KeyFile::in_dir(data_dir)
}

/// Answer one frame the desktop already decoded. Used when SSH cannot deliver stdin.
/// A prompt is not run here. The resident server is the only process that publishes.
/// A resident body (`project`, `token`, `frame`) is accepted so a store call carries the token.
pub fn serve_frame(service: &ProjectService, keys: &KeyFile, bytes: &[u8]) -> Result<()> {
    if bytes.len() < 4 {
        return Err(Error::Other("frame header is short".into()));
    }
    let (frame, service) = decode_call_frame(service, keys, bytes)?;
    if matches!(frame, ClientFrame::SubmitPrompt(_)) {
        return Err(Error::Other("a turn is sent to the resident server".into()));
    }
    let response = session::handle_frame(&service, keys, frame, None);
    let mut output = std::io::stdout().lock();
    output.write_all(&encode_frame(&response)?)?;
    output.flush()?;
    Ok(())
}

/// One JSON frame on stdin, one JSON frame on stdout, then exit.
/// The desktop app starts this over SSH for each conversation call.
pub fn serve_once(service: &ProjectService, keys: &KeyFile) -> Result<()> {
    let mut input = std::io::stdin().lock();
    let mut header = [0u8; 4];
    if input.read(&mut header)? != 4 {
        return Err(Error::Other("frame header is short".into()));
    }
    let len = u32::from_be_bytes(header) as usize;
    if len > 8_000_000 {
        return Err(Error::Other("frame is too large".into()));
    }
    let mut body = vec![0u8; len];
    input.read_exact(&mut body)?;
    let frame: ClientFrame = serde_json::from_slice(&body)?;
    let response = session::handle_frame(service, keys, frame, None);
    let mut output = std::io::stdout().lock();
    output.write_all(&encode_frame(&response)?)?;
    output.flush()?;
    Ok(())
}

/// The resident server. Stdin frames name the project. Turns publish on the socket this process bound.
pub fn serve_resident(data_dir: &Path, keys: &KeyFile) -> Result<()> {
    let stdin = std::io::stdin();
    let mut input = std::io::BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    session::serve_projects(data_dir, keys, &mut input, &mut output)
}

/// Read frames from a fifo. A writer closing it is not the end. The next prompt opens it again.
pub fn serve_resident_fifo(data_dir: &Path, keys: &KeyFile, fifo: &Path) -> Result<()> {
    if !fifo.exists() {
        let made = std::process::Command::new("mkfifo").arg(fifo).status();
        if !made.map(|status| status.success()).unwrap_or(false) {
            return Err(Error::Other("could not create the live server fifo".into()));
        }
    }
    loop {
        let file = match std::fs::File::open(fifo) {
            Ok(file) => file,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(200));
                continue;
            }
        };
        let mut input = std::io::BufReader::new(file);
        let mut output = std::io::sink();
        // A writer that closes halfway through a frame is not the end of the server.
        // The next prompt opens the fifo again. Only a frame that is too large stops the loop.
        match session::serve_projects(data_dir, keys, &mut input, &mut output) {
            Ok(()) => {}
            Err(err) if err.to_string() == "frame is too large" => return Err(err),
            Err(_) => {}
        }
    }
}

/// Read prompt frames from stdin and write display frames to stdout.
pub fn serve_stdio(service: &ProjectService, keys: &KeyFile) -> Result<()> {
    let stdin = std::io::stdin();
    let mut input = std::io::BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    serve(service, keys, &mut input, &mut output, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, title: &str) -> Conversation {
        Conversation {
            id: id.into(),
            title: title.into(),
            created_at: "t".into(),
            updated_at: "t".into(),
            kind: "chat".into(),
            messages: Vec::new(),
            context_usage: None,
            compaction: None,
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        }
    }

    #[test]
    fn two_projects_on_one_machine_do_not_share_chats() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let first = open_server(&root.path().join("dev-test"), &data).unwrap();
        let second = open_server(&root.path().join("other"), &data).unwrap();
        assert_ne!(first.store_dir, second.store_dir);
        assert_ne!(first.store_dir, data.join("store"));
        first.save_conversation(&chat("c1", "what is the specs of this machine")).unwrap();
        assert!(second.list_conversations().unwrap().is_empty());
        assert_eq!(first.list_conversations().unwrap().len(), 1);
        // Keys stay on the machine, not inside either project store.
        assert_eq!(first.data_dir, data);
        assert_eq!(key_file(&data).path, data.join("provider-keys.json"));
    }

    #[test]
    fn the_same_project_path_reopens_its_own_store() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let path = root.path().join("dev-test");
        open_server(&path, &data)
            .unwrap()
            .save_conversation(&chat("c1", "kept"))
            .unwrap();
        let again = open_server(&path.join(""), &data).unwrap();
        assert_eq!(again.list_conversations().unwrap()[0].title, "kept");
    }
}
