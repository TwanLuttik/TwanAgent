use std::path::Path;

use tauri::{AppHandle, Manager, State};

use super::cmd::run_command;
use super::files::{
    edit_file, existing_files, file_preview, list_dir, read_file, resolve_file, write_file,
};
use super::git::{git_branches, git_diff, git_status, git_switch};
use super::paths::{expand_folder_path, path_string};
use super::project_location::ProjectsLocation;
use super::projects::FolderSuggestion;
use super::projects::{clone_repo, create_project, delete_project, list_projects, suggest_folders};
use super::types::{DevEntry, FilePreview, GitBranches, GitChange};
use crate::error::{Error, Result};
use crate::state::AppState;

/// Git and file reads block. Run them off the webview thread so a refresh does not freeze the UI.
async fn off_main<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(err) => Err(Error::Other(format!("background task failed: {err}"))),
    }
}

fn project_roots(state: &AppState) -> [&Path; 2] {
    [
        state.projects_root.as_path(),
        state.legacy_projects_root.as_path(),
    ]
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_projects_root(state: State<'_, AppState>) -> String {
    path_string(&state.projects_root)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_projects_location(state: State<'_, AppState>) -> ProjectsLocation {
    super::project_location::published_location(
        &state.data_dir,
        &state.projects_root,
        &state.legacy_projects_root,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_projects(state: State<'_, AppState>) -> Vec<FolderSuggestion> {
    list_projects(&project_roots(&state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_opened_workspaces(state: State<'_, AppState>) -> Vec<String> {
    state
        .opened_workspaces()
        .iter()
        .map(|path| path_string(path))
        .collect()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_forget_workspace(state: State<'_, AppState>, path: String) -> Result<bool> {
    let root = expand_folder_path(&path)?;
    state.forget_workspace(&root)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_open_folder(app: AppHandle, path: String) -> Result<String> {
    let root = expand_folder_path(&path)?;
    let state = app.state::<AppState>();
    Ok(path_string(&state.register_workspace(&app, &root)?))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_suggest_folders(path: String) -> Vec<FolderSuggestion> {
    suggest_folders(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_create_project(app: AppHandle, name: String) -> Result<String> {
    let state = app.state::<AppState>();
    let root = create_project(&state.projects_root, &name)?;
    Ok(path_string(&state.register_workspace(&app, &root)?))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_clone_repo(app: AppHandle, url: String, name: Option<String>) -> Result<String> {
    crate::state::run_blocking(move || {
        let state = app.state::<AppState>();
        let root = clone_repo(&state.projects_root, &url, name.as_deref())?;
        Ok(path_string(&state.register_workspace(&app, &root)?))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_delete_project(state: State<'_, AppState>, path: String) -> Result<()> {
    let dest = delete_project(&project_roots(&state), &path)?;
    let mut wipe = super::project_location::forget_project(&state.data_dir, &path);
    wipe.push(path_string(&dest));
    for item in wipe {
        let _ = std::fs::remove_dir_all(super::conv::conv_dir(&state.data_dir, &item));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_list_dir(
    state: State<'_, AppState>,
    workspace: String,
    path: Option<String>,
) -> Result<Vec<DevEntry>> {
    let root = state.require_workspace(&workspace)?;
    let rel = path.unwrap_or_default();
    off_main(move || list_dir(&root, &rel)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_read_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || read_file(&root, &path)).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_read_user_mcp(path: String) -> Result<String> {
    super::mcp::read_user_mcp(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_write_user_mcp(path: String, contents: String) -> Result<()> {
    super::mcp::write_user_mcp(&path, &contents)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_open_user_mcp(path: String) -> Result<()> {
    super::mcp::open_user_mcp(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_mcp_auth_names() -> Result<Vec<String>> {
    super::mcp::mcp_auth_names()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_mcp_clear_auth(name: String) -> Result<()> {
    super::mcp::mcp_clear_auth(&name)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_skill_files(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Vec<super::skills::SkillFileRow>> {
    let root = match workspace
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => Some(state.require_workspace(path)?),
        None => None,
    };
    super::skills::list_skill_files(root.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_read_user_skill(path: String) -> Result<String> {
    super::skills::read_user_skill(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_open_user_skill(path: String) -> Result<()> {
    super::skills::open_user_skill(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_resolve_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    resolve_file(&root, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_existing_files(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
) -> Result<Vec<String>> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || Ok(existing_files(&root, &paths))).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_file_preview(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<FilePreview> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || file_preview(&root, &path)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_write_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    contents: String,
) -> Result<()> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || write_file(&root, &path, &contents)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_edit_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    old_string: String,
    new_string: String,
) -> Result<()> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || edit_file(&root, &path, &old_string, &new_string)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_status(state: State<'_, AppState>, workspace: String) -> Result<Vec<GitChange>> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || git_status(&root)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_diff(
    state: State<'_, AppState>,
    workspace: String,
    path: Option<String>,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let rel = path.unwrap_or_default();
    off_main(move || git_diff(&root, &rel)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_branches(state: State<'_, AppState>, workspace: String) -> Result<GitBranches> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || git_branches(&root)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_switch(
    state: State<'_, AppState>,
    workspace: String,
    name: String,
) -> Result<GitBranches> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || git_switch(&root, &name)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_run_command(
    state: State<'_, AppState>,
    workspace: String,
    command: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    off_main(move || run_command(&root, &command)).await
}
