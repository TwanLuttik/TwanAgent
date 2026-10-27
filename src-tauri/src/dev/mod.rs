pub mod chat;
pub(crate) mod cmd;
mod compact;
pub mod commands;
pub mod conv;
mod files;
mod git;
pub mod keys;
pub mod local_turn;
pub mod mcp;
pub mod mcp_oauth;
pub(crate) mod paths;
pub(crate) mod project_location;
pub(crate) mod projects;
pub mod skills;
mod tool_schema;
pub(crate) mod types;
mod workspace_fs;

pub use types::{
    Conversation, ConversationSummary, DevChatUsage, DevCompaction, Journey, SidebarItem, SidebarProject,
};

pub(crate) use mcp::open_path;
pub(crate) use commands::off_main;
pub(crate) use commands::same_project_path;

pub(crate) use paths::{expand_folder_path, path_string};
pub(crate) use projects::FolderSuggestion;
