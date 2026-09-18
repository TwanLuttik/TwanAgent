use tauri::{AppHandle, Manager, State};

use super::cmd::run_command;
use super::files::{
    edit_file, existing_files, file_preview, list_dir, read_file, resolve_file, write_file,
};
use super::git::{git_branches, git_diff, git_status, git_switch};
use super::paths::{expand_folder_path, path_string, projects_dir};
use super::projects::FolderSuggestion;
use super::projects::{clone_repo, create_project, list_projects, suggest_folders};
use super::types::{DevEntry, FilePreview, GitBranches, GitChange};
use crate::error::Result;
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub fn dev_projects_root(state: State<'_, AppState>) -> String {
    path_string(&projects_dir(&state.data_dir))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_projects(state: State<'_, AppState>) -> Vec<FolderSuggestion> {
    list_projects(&state.data_dir)
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
    let root = create_project(&state.data_dir, &name)?;
    Ok(path_string(&state.register_workspace(&app, &root)?))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_clone_repo(app: AppHandle, url: String, name: Option<String>) -> Result<String> {
    crate::state::run_blocking(move || {
        let state = app.state::<AppState>();
        let root = clone_repo(&state.data_dir, &url, name.as_deref())?;
        Ok(path_string(&state.register_workspace(&app, &root)?))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_dir(
    state: State<'_, AppState>,
    workspace: String,
    path: Option<String>,
) -> Result<Vec<DevEntry>> {
    let root = state.require_workspace(&workspace)?;
    list_dir(&root, path.as_deref().unwrap_or(""))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_read_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    read_file(&root, &path)
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
pub fn dev_existing_files(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
) -> Result<Vec<String>> {
    let root = state.require_workspace(&workspace)?;
    Ok(existing_files(&root, &paths))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_file_preview(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<FilePreview> {
    let root = state.require_workspace(&workspace)?;
    file_preview(&root, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_write_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    contents: String,
) -> Result<()> {
    let root = state.require_workspace(&workspace)?;
    write_file(&root, &path, &contents)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_edit_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    old_string: String,
    new_string: String,
) -> Result<()> {
    let root = state.require_workspace(&workspace)?;
    edit_file(&root, &path, &old_string, &new_string)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_git_status(state: State<'_, AppState>, workspace: String) -> Result<Vec<GitChange>> {
    let root = state.require_workspace(&workspace)?;
    git_status(&root)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_git_diff(
    state: State<'_, AppState>,
    workspace: String,
    path: Option<String>,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    git_diff(&root, path.as_deref().unwrap_or(""))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_git_branches(state: State<'_, AppState>, workspace: String) -> Result<GitBranches> {
    let root = state.require_workspace(&workspace)?;
    git_branches(&root)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_git_switch(
    state: State<'_, AppState>,
    workspace: String,
    name: String,
) -> Result<GitBranches> {
    let root = state.require_workspace(&workspace)?;
    git_switch(&root, &name)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_run_command(
    state: State<'_, AppState>,
    workspace: String,
    command: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    run_command(&root, &command)
}
