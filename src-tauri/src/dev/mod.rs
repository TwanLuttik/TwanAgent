pub mod chat;
pub(crate) mod cmd;
pub mod commands;
pub mod conv;
mod files;
mod git;
pub mod keys;
mod mcp;
mod mcp_oauth;
pub(crate) mod paths;
pub(crate) mod project_location;
mod projects;
mod skills;
mod types;

pub use types::{
    Conversation, ConversationSummary, DevChatUsage, DevCompaction, Journey, SidebarItem,
};

pub(crate) use mcp::open_path;
pub(crate) use paths::{expand_folder_path, path_string};
pub(crate) use projects::FolderSuggestion;
