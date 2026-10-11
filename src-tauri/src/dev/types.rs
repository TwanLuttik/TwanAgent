use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeSnapshot {
    pub signature: String,
    pub dirs: Vec<String>,
    /// Workspace-relative file paths from the same walk. Omitted by older snapshots.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

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
    /// Source path of a rename or copy. Empty for every other status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    pub status: String,
    pub staged: bool,
    /// True when the worktree side still differs from the index.
    #[serde(default)]
    pub unstaged: bool,
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranches {
    pub current: Option<String>,
    pub branches: Vec<String>,
    /// False when the folder is not a git repository. An empty repo still has a branch.
    #[serde(default = "git_repo_present")]
    pub repo: bool,
}

fn git_repo_present() -> bool {
    true
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
    /// Model chosen for this chat. Empty means the app default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Context size chosen for this chat. Empty means the app default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Permission mode chosen for this chat. Empty means the app default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<String>,
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
    /// Signed Claude thinking blocks for the next request. Not used by Grok.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Vec<crate::model_providers::ThinkingBlock>>,
}

/// One chunk of a shell command the agent is running now.
#[derive(Debug, Clone, Serialize)]
pub struct DevCommandEvent {
    pub stream_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// One website found while a web search is still running.
#[derive(Debug, Clone, Serialize)]
pub struct DevWebSearchEvent {
    pub stream_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}
