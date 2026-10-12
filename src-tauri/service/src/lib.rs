//! Project engine shared by the TwanAgent app and `twanagent-server`.
//!
//! The app calls this in-process for a local project. The headless server calls the same
//! functions for a project that lives on another Mac or a Linux box. A turn is a prompt.
//! Tools run here, next to the files. The GUI only renders what comes back.

mod codec;
mod error;
mod files;
mod keys;
mod model;
mod session;
mod store;
mod tools;
mod turn;

pub use codec::{decode_frame, encode_frame, ClientFrame, ServerFrame, PROTOCOL_VERSION};
pub use error::{Error, Result};
pub use keys::{provider_keys_from_env, KeyFile, ProviderKeys};
pub use session::serve;
pub use store::{Conversation, ConversationSummary};
pub use turn::{ModelStep, ScriptedModel, TurnRequest};

/// One line the GUI paints while a hosted turn runs. Tool results stay on the server.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEvent {
    Status(String),
    Delta(String),
    Done(Conversation),
    Error(String),
}

use std::io::{Read, Write};
use std::path::Path;

pub struct ProjectService {
    pub project: std::path::PathBuf,
    pub store_dir: std::path::PathBuf,
}

impl ProjectService {
    pub fn open(project: impl AsRef<Path>, store_dir: impl AsRef<Path>) -> Result<Self> {
        let project = project.as_ref().to_path_buf();
        let store_dir = store_dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&project)?;
        std::fs::create_dir_all(&store_dir)?;
        let _ = store::open(&store_dir)?;
        Ok(Self { project, store_dir })
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

pub fn open_server(project: &Path, data_dir: &Path) -> Result<ProjectService> {
    ProjectService::open(project, data_dir.join("store"))
}

pub fn key_file(data_dir: &Path) -> KeyFile {
    KeyFile::in_dir(data_dir)
}

/// Answer one frame the desktop already decoded. Used when SSH cannot deliver stdin.
pub fn serve_frame(service: &ProjectService, keys: &KeyFile, bytes: &[u8]) -> Result<()> {
    if bytes.len() < 4 {
        return Err(Error::Other("frame header is short".into()));
    }
    let (frame, _) = decode_frame(bytes)?;
    if let ClientFrame::SubmitPrompt(request) = frame {
        let mut output = std::io::stdout().lock();
        return session::submit_streaming(service, keys, request, &mut output);
    }
    let response = session::handle_frame(service, keys, frame, None);
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

/// Read prompt frames from stdin and write display frames to stdout.
pub fn serve_stdio(service: &ProjectService, keys: &KeyFile) -> Result<()> {
    let stdin = std::io::stdin();
    let mut input = std::io::BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    serve(service, keys, &mut input, &mut output, None)
}
