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
pub async fn dev_runtime(state: State<'_, AppState>) -> Result<grok_cli::DevRuntime> {
    let mut status = grok_cli::runtime(&state.data_dir);
    status.models = crate::model_providers::registry::list_models(&state.data_dir).await;
    let claude_ready = crate::anthropic::resolve_claude_auth_fresh().await.is_some();
    let minimax_ready = crate::minimax::resolve_minimax_auth_fresh().await.is_some();
    status.providers = vec![
        grok_cli::ProviderStatus {
            id: "xai".into(),
            ready: status.ready,
            hint: status.hint.clone(),
        },
        grok_cli::ProviderStatus {
            id: "anthropic".into(),
            ready: claude_ready,
            hint: if claude_ready {
                "Using Claude".into()
            } else {
                crate::anthropic::SIGN_IN_ERROR.into()
            },
        },
        grok_cli::ProviderStatus {
            id: "minimax".into(),
            ready: minimax_ready,
            hint: if minimax_ready {
                "Using MiniMax".into()
            } else {
                crate::minimax::SIGN_IN_ERROR.into()
            },
        },
    ];
    Ok(status)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_cli_info(state: State<'_, AppState>) -> grok_cli::GrokCliInfo {
    grok_cli::cli_info(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_claude_cli_info() -> crate::anthropic::ClaudeCliInfo {
    crate::anthropic::claude_cli_info()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_minimax_cli_info() -> crate::minimax::MinimaxCliInfo {
    crate::minimax::minimax_cli_info()
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

#[tauri::command(rename_all = "snake_case")]
pub fn dev_anthropic_key_status() -> KeyStatus {
    KeyStatus {
        saved: secrets::get_anthropic_key().is_some(),
        env: std::env::var("ANTHROPIC_API_KEY")
            .ok()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_anthropic_key(key: String) -> Result<KeyStatus> {
    secrets::set_anthropic_key(&key)?;
    Ok(dev_anthropic_key_status())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_clear_anthropic_key() -> Result<KeyStatus> {
    secrets::delete_anthropic_key()?;
    Ok(dev_anthropic_key_status())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_minimax_key_status() -> KeyStatus {
    KeyStatus {
        saved: secrets::get_minimax_key().is_some(),
        env: std::env::var("MINIMAX_API_KEY")
            .ok()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_minimax_key(key: String) -> Result<KeyStatus> {
    secrets::set_minimax_key(&key)?;
    Ok(dev_minimax_key_status())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_clear_minimax_key() -> Result<KeyStatus> {
    secrets::delete_minimax_key()?;
    Ok(dev_minimax_key_status())
}
