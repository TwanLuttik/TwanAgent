//! The live tail of a turn.
//!
//! A turn writes each display frame here before it reaches the window that started it.
//! Another window follows the same file, so it sees the text as it is written.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::codec::{decode_frame, encode_frame, ServerFrame};
use crate::error::{Error, Result};
use crate::store::Conversation;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LiveFrame {
    Status { text: String },
    Delta { text: String },
    Done { conversation: Conversation },
    Error { message: String },
    /// Ask mode is waiting on the desktop. The command has not run.
    ShellApproval { command: String, description: String },
}

impl From<&ServerFrame> for Option<LiveFrame> {
    fn from(frame: &ServerFrame) -> Self {
        match frame {
            ServerFrame::Status { text } => Some(LiveFrame::Status { text: text.clone() }),
            ServerFrame::Delta { text } => Some(LiveFrame::Delta { text: text.clone() }),
            ServerFrame::Done { conversation } => Some(LiveFrame::Done {
                conversation: conversation.clone(),
            }),
            ServerFrame::Error { message } => Some(LiveFrame::Error {
                message: message.clone(),
            }),
            ServerFrame::ShellApproval { command, description, .. } => Some(LiveFrame::ShellApproval {
                command: command.clone(),
                description: description.clone(),
            }),
            _ => None,
        }
    }
}

pub fn live_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("live")
}

fn safe_id(id: &str) -> Result<&str> {
    let id = id.trim();
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(Error::Other("conversation id is invalid".into()));
    }
    Ok(id)
}

pub fn live_path(data_dir: &Path, id: &str) -> Result<PathBuf> {
    Ok(live_dir(data_dir).join(format!("{}.frames", safe_id(id)?)))
}

/// Start a turn. The previous tail is removed so a follower does not replay it.
pub fn begin(data_dir: &Path, id: &str) -> Result<()> {
    let path = live_path(data_dir, id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_file(&path);
    File::create(&path)?;
    Ok(())
}

pub fn append(data_dir: &Path, id: &str, frame: &LiveFrame) -> Result<()> {
    let path = live_path(data_dir, id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(&encode_frame(frame)?)?;
    file.flush()?;
    Ok(())
}

pub fn append_server(data_dir: &Path, id: &str, frame: &ServerFrame) -> Result<()> {
    let Some(live) = Option::<LiveFrame>::from(frame) else {
        return Ok(());
    };
    append(data_dir, id, &live)
}

/// Read every complete frame at or after `from`. A partial frame stays for the next read.
pub fn read_since(data_dir: &Path, id: &str, from: u64) -> Result<(Vec<LiveFrame>, u64)> {
    let path = live_path(data_dir, id)?;
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), from)),
        Err(err) => return Err(err.into()),
    };
    let len = file.metadata()?.len();
    if from > len {
        return Ok((Vec::new(), len));
    }
    file.seek(SeekFrom::Start(from))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let mut frames = Vec::new();
    let mut used = 0usize;
    while used < buf.len() {
        match decode_frame::<LiveFrame>(&buf[used..]) {
            Ok((frame, size)) => {
                frames.push(frame);
                used += size;
            }
            Err(_) => break,
        }
    }
    Ok((frames, from + used as u64))
}

/// True when the tail was written recently and has not finished.
pub fn active(data_dir: &Path, id: &str, fresh_for: Duration) -> Result<bool> {
    let path = live_path(data_dir, id)?;
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err.into()),
    };
    if meta.len() == 0 {
        return Ok(false);
    }
    let fresh = meta.modified().ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age <= fresh_for);
    if !fresh {
        return Ok(false);
    }
    let (frames, _) = read_since(data_dir, id, 0)?;
    Ok(!frames.iter().any(finished))
}

fn finished(frame: &LiveFrame) -> bool {
    matches!(frame, LiveFrame::Done { .. } | LiveFrame::Error { .. })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(text: &str) -> Conversation {
        Conversation {
            id: "c1".into(),
            title: "Hi".into(),
            created_at: "t".into(),
            updated_at: "t".into(),
            kind: "chat".into(),
            messages: vec![serde_json::json!({ "role": "assistant", "content": text })],
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
    fn a_second_reader_sees_frames_written_after_it_started() {
        let root = tempfile::tempdir().unwrap();
        begin(root.path(), "c1").unwrap();
        append(root.path(), "c1", &LiveFrame::Delta { text: "Hel".into() }).unwrap();
        let (first, cursor) = read_since(root.path(), "c1", 0).unwrap();
        assert_eq!(first, vec![LiveFrame::Delta { text: "Hel".into() }]);
        append(root.path(), "c1", &LiveFrame::Delta { text: "lo".into() }).unwrap();
        append(
            root.path(),
            "c1",
            &LiveFrame::Done { conversation: chat("Hello") },
        )
        .unwrap();
        let (rest, _) = read_since(root.path(), "c1", cursor).unwrap();
        assert_eq!(rest[0], LiveFrame::Delta { text: "lo".into() });
        assert!(matches!(rest[1], LiveFrame::Done { .. }));
        assert!(!active(root.path(), "c1", Duration::from_secs(30)).unwrap());
    }

    #[test]
    fn a_partial_frame_is_not_returned() {
        let root = tempfile::tempdir().unwrap();
        begin(root.path(), "c1").unwrap();
        let path = live_path(root.path(), "c1").unwrap();
        fs::write(&path, [0, 0, 0, 20]).unwrap();
        let (frames, cursor) = read_since(root.path(), "c1", 0).unwrap();
        assert!(frames.is_empty());
        assert_eq!(cursor, 0);
    }

    #[test]
    fn begin_drops_the_previous_tail() {
        let root = tempfile::tempdir().unwrap();
        append(root.path(), "c1", &LiveFrame::Delta { text: "old".into() }).unwrap();
        begin(root.path(), "c1").unwrap();
        let (frames, _) = read_since(root.path(), "c1", 0).unwrap();
        assert!(frames.is_empty());
    }
}
