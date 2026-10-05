use tauri::State;

use super::types::KeyStatus;
use crate::error::Result;
use crate::grok_cli;
use crate::secrets;
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub fn dev_key_status(state: State<'_, AppState>) -> KeyStatus {
    KeyStatus {
        saved: secrets::get_xai_key(&state.data_dir).is_some(),
        env: std::env::var("XAI_API_KEY")
            .ok()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_runtime(state: State<'_, AppState>) -> grok_cli::DevRuntime {
    grok_cli::runtime(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_cli_info(state: State<'_, AppState>) -> grok_cli::GrokCliInfo {
    grok_cli::cli_info(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_key(state: State<'_, AppState>, key: String) -> Result<KeyStatus> {
    secrets::set_xai_key(&state.data_dir, &key)?;
    Ok(dev_key_status(state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_clear_key(state: State<'_, AppState>) -> Result<KeyStatus> {
    secrets::delete_xai_key(&state.data_dir)?;
    Ok(dev_key_status(state))
}
