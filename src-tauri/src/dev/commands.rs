//! Shared command helpers, plus the project, file, git, and shell command modules.
//!
//! IPC names such as `dev_list_dir` do not change when a command moves between these files.
//! `lib.rs` lists every command, and `command_surface` checks that list still matches.

#[path = "file_cmds.rs"]
pub mod file_cmds;
#[path = "git_cmds.rs"]
pub mod git_cmds;
#[path = "project_cmds.rs"]
pub mod project_cmds;
#[path = "shell_cmds.rs"]
pub mod shell_cmds;

pub use project_cmds::same_project_path;
#[cfg(test)]
pub use project_cmds::named_project_rows;

/// Git and file reads block. Run them off the webview thread so a refresh does not freeze the UI.
pub(crate) async fn off_main<T: Send + 'static>(
    work: impl FnOnce() -> crate::error::Result<T> + Send + 'static,
) -> crate::error::Result<T> {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(err) => Err(crate::error::Error::Other(format!(
            "background task failed: {err}"
        ))),
    }
}


