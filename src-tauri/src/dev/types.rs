use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePreview {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranches {
    pub current: Option<String>,
    pub branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_conversation_kind")]
    pub kind: String,
    #[serde(default)]
    pub messages: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<DevChatUsage>,
    /// CLI-style compaction: one summary covering messages before `through`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<DevCompaction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journey_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    /// Thinking level chosen for this chat. Empty means the app default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Hidden from the normal sidebar until the project archive is opened.
    #[serde(default)]
    pub archived: bool,
}

pub(crate) fn default_conversation_kind() -> String {
    "chat".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_conversation_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journey_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journey {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i64,
    pub collapsed: bool,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarItem {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStatus {
    pub saved: bool,
    pub env: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevCompaction {
    pub summary: String,
    pub through: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevChatUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DevChatEvent {
    pub stream_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<DevToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<DevChatUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}
