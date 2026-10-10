pub mod client;
pub mod discover;
pub mod commands;
pub mod config;
pub mod exec;
pub mod files;
pub mod git;
pub mod mount;
pub mod ssh;

use std::path::Path;

use crate::error::Result;
use crate::state::AppState;

pub use config::RemoteProject;

/// Look up a remote project whose mount path is this workspace. Local folders return None.
pub fn project_for_workspace(state: &AppState, workspace: &Path) -> Result<Option<RemoteProject>> {
    let conn = crate::appdb::open(&state.data_dir)?;
    config::remote_project_by_mount(&conn, workspace)
}
