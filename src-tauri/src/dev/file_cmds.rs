//! File, MCP, and skill commands.
//! Local and remote projects share `WorkspaceFiles`. Command names stay `dev_*`.

use tauri::State;

use crate::dev::off_main;
use crate::dev::types::{DevEntry, FilePreview, TreeSnapshot};
use crate::dev::workspace_fs::WorkspaceFiles;
use crate::error::Result;
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_tree_signature(state: State<'_, AppState>, workspace: String) -> Result<TreeSnapshot> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.tree()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_list_dir(
    state: State<'_, AppState>,
    workspace: String,
    path: Option<String>,
) -> Result<Vec<DevEntry>> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    let rel = path.unwrap_or_default();
    off_main(move || files.list(&rel)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_grep(
    state: State<'_, AppState>,
    workspace: String,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
) -> Result<String> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    let rel = path.unwrap_or_default();
    let glob = glob.unwrap_or_default();
    off_main(move || files.grep(&pattern, &rel, &glob)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_glob(
    state: State<'_, AppState>,
    workspace: String,
    pattern: String,
    path: Option<String>,
) -> Result<String> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    let rel = path.unwrap_or_default();
    off_main(move || files.glob(&pattern, &rel)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_read_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<String> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || {
        let text = files.read(&path)?;
        twanagent_service::numbered_lines(&text, offset, limit).map_err(crate::error::Error::from)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_read_pdf(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<String> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.read_pdf(&path)).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_read_user_mcp(path: String) -> Result<String> {
    crate::dev::mcp::read_user_mcp(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_write_user_mcp(path: String, contents: String) -> Result<()> {
    crate::dev::mcp::write_user_mcp(&path, &contents)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_open_user_mcp(path: String) -> Result<()> {
    crate::dev::mcp::open_user_mcp(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_mcp_auth_names() -> Result<Vec<String>> {
    crate::dev::mcp::mcp_auth_names()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_mcp_clear_auth(name: String) -> Result<()> {
    crate::dev::mcp::mcp_clear_auth(&name)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_mcp_sign_in(name: String) -> Result<()> {
    let server = name.trim().to_string();
    off_main(move || crate::dev::mcp_oauth::mcp_sign_in(&server)).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_skill_files(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Vec<crate::dev::skills::SkillFileRow>> {
    let root = match workspace
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => Some(state.require_workspace(path)?),
        None => None,
    };
    crate::dev::skills::list_skill_files(root.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_load_skill(state: State<'_, AppState>, workspace: String, name: String) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let home = crate::dev::paths::home_dir().unwrap_or_default();
    Ok(twanagent_service::capabilities::load_skill_at(&root, &home, &name))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_read_user_skill(path: String) -> Result<String> {
    crate::dev::skills::read_user_skill(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_write_user_skill(path: String, contents: String) -> Result<()> {
    crate::dev::skills::write_user_skill(&path, &contents)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_resolve_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<String> {
    WorkspaceFiles::open(&state, &workspace)?.resolve(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_existing_files(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
) -> Result<Vec<String>> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.existing(&paths)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_file_preview(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<FilePreview> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.preview(&path)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_rename_path(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    name: String,
) -> Result<String> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.rename(&path, &name)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_move_paths(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
    dest: String,
) -> Result<Vec<String>> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.move_paths(&paths, &dest)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_delete_paths(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
) -> Result<()> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.delete(&paths)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_create_dir(
    state: State<'_, AppState>,
    workspace: String,
    parent: String,
    name: String,
) -> Result<String> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.create_dir(&parent, &name)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_write_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    contents: String,
) -> Result<()> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.write(&path, &contents)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_edit_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    old_string: String,
    new_string: String,
) -> Result<()> {
    let files = WorkspaceFiles::open(&state, &workspace)?;
    off_main(move || files.edit(&path, &old_string, &new_string)).await
}
