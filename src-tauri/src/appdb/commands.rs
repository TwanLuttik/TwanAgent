//! App-database commands. The IPC names stay `dev_app_*`. React calls those strings.

use tauri::{AppHandle, Manager, State};

use super::{add_project, get_setting, list_projects, open, remove_project, reorder_projects, set_setting};
use crate::dev::{expand_folder_path, FolderSuggestion};
use crate::error::Result;
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_list_projects(state: State<'_, AppState>) -> Result<Vec<FolderSuggestion>> {
    let conn = open(&state.data_dir)?;
    list_projects(&conn)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_add_project(app: AppHandle, path: String) -> Result<FolderSuggestion> {
    let root = expand_folder_path(&path)?;
    let state = app.state::<AppState>();
    let canon = state.register_workspace(&app, &root)?;
    let conn = open(&state.data_dir)?;
    add_project(&conn, &canon)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_reorder_projects(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<FolderSuggestion>> {
    let conn = open(&state.data_dir)?;
    reorder_projects(&conn, &paths)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_remove_project(state: State<'_, AppState>, path: String) -> Result<bool> {
    let conn = open(&state.data_dir)?;
    remove_project(&conn, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    let conn = open(&state.data_dir)?;
    get_setting(&conn, key.trim())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    let conn = open(&state.data_dir)?;
    set_setting(&conn, &key, &value)
}
