use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::keys::ProviderKeys;
use crate::store::{Conversation, ConversationSummary};
use crate::turn::TurnRequest;

pub const PROTOCOL_VERSION: u32 = 1;

/// The same number, written into the binary so a status check can read it without starting the program.
pub const PROTOCOL_MARK: &str = "protocol-version 1\0";

/// Frames the GUI sends. A turn is a prompt. Tool calls are not a frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Hello { version: u32 },
    ListConversations,
    GetConversation { id: String },
    /// Frames written since `cursor` for a turn that is still running.
    Follow { id: String, cursor: u64 },
    SaveConversation(Conversation),
    DeleteConversation { id: String },
    ReorderConversations { ids: Vec<String> },
    SetArchived { id: String, archived: bool },
    SubmitPrompt(TurnRequest),
    /// The user's answer to a shell prompt the server is waiting on.
    ShellAnswer { id: String, allow: bool },
    /// Stop the turn for this conversation. A command it started is killed.
    CancelTurn { id: String },
    CopyKeys(ProviderKeys),
    RemoveKeys,
    /// Usage rows written after `since_id`. Zero reads the whole log.
    UsageSince { since_id: i64 },
}

/// Frames the server sends. `status` is display text. The tool already ran on the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Hello { version: u32 },
    Conversations { rows: Vec<ConversationSummary> },
    Conversation(Conversation),
    /// `active` is true while the turn has not written done or error.
    Live {
        cursor: u64,
        active: bool,
        frames: Vec<crate::live::LiveFrame>,
    },
    Ok,
    Status { text: String },
    Delta { text: String },
    Done { conversation: Conversation },
    Keys { present: bool },
    /// Ask mode is waiting. The command has not run.
    ShellApproval {
        conversation_id: String,
        command: String,
        description: String,
    },
    Error { message: String },
    Usage { rows: Vec<crate::usage_log::UsageRow> },
}

pub fn encode_frame<T: Serialize>(frame: &T) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(frame)?;
    if body.len() > u32::MAX as usize {
        return Err(Error::Other("frame is too large".into()));
    }
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    Ok(out)
}

pub fn decode_frame<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<(T, usize)> {
    if bytes.len() < 4 {
        return Err(Error::Other("frame header is short".into()));
    }
    let len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if bytes.len() < 4 + len {
        return Err(Error::Other("frame body is short".into()));
    }
    Ok((serde_json::from_slice(&bytes[4..4 + len])?, 4 + len))
}

pub fn version_ok(version: u32) -> Result<()> {
    if version == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(Error::Other(format!(
            "TwanAgent server speaks protocol {PROTOCOL_VERSION}, not {version}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_frame_roundtrips_without_a_tool_call() {
        let frame = ClientFrame::SubmitPrompt(TurnRequest {
            conversation_id: "c1".into(),
            prompt: "read the note".into(),
            model: "grok-4".into(),
            effort: "low".into(),
            permission: "ask".into(),
            project: String::new(),
            context_window: None,
        });
        let bytes = encode_frame(&frame).unwrap();
        let (decoded, used): (ClientFrame, usize) = decode_frame(&bytes).unwrap();
        assert_eq!(used, bytes.len());
        assert_eq!(decoded, frame);
        let text = String::from_utf8(bytes[4..].to_vec()).unwrap();
        assert!(!text.contains("read_file"));
        assert!(text.contains("read the note"));
    }

    #[test]
    fn a_version_mismatch_is_not_a_turn() {
        assert!(version_ok(99).unwrap_err().to_string().contains("protocol"));
    }
}
