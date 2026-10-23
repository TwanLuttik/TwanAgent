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

const RUNTIME_CACHE_KEY: &str = "runtime.snapshot";

/// Last runtime the composer painted. Empty until one probe has finished.
pub fn cached_runtime(data_dir: &std::path::Path) -> Option<grok_cli::DevRuntime> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let raw = crate::appdb::get_setting(&conn, RUNTIME_CACHE_KEY).ok()??;
    serde_json::from_str(&raw).ok()
}

fn store_runtime(data_dir: &std::path::Path, status: &grok_cli::DevRuntime) {
    let Ok(raw) = serde_json::to_string(status) else {
        return;
    };
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    let _ = crate::appdb::set_setting(&conn, RUNTIME_CACHE_KEY, &raw);
}

/// The snapshot from the last launch, with no CLI or network. Null until one probe has finished.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_runtime_cached(state: State<'_, AppState>) -> Option<grok_cli::DevRuntime> {
    cached_runtime(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_runtime(state: State<'_, AppState>) -> Result<grok_cli::DevRuntime> {
    let data_dir = state.data_dir.clone();
    // CLI probes and the model list block. Keep them off the thread that answers clicks.
    let status = crate::state::run_blocking(move || {
        let mut status = grok_cli::runtime(&data_dir);
        let models = tauri::async_runtime::block_on(crate::model_providers::registry::list_models(&data_dir));
        status.models = models;
        let claude_ready =
            tauri::async_runtime::block_on(crate::anthropic::resolve_claude_auth_fresh_in(&data_dir))
                .is_some();
        let minimax_ready =
            tauri::async_runtime::block_on(crate::minimax::resolve_minimax_auth_fresh_in(&data_dir))
                .is_some();
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
        store_runtime(&data_dir, &status);
        Ok(status)
    })
    .await?;
    Ok(status)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_cli_info(state: State<'_, AppState>) -> Result<grok_cli::GrokCliInfo> {
    let data_dir = state.data_dir.clone();
    let mut info = crate::state::run_blocking({
        let data_dir = data_dir.clone();
        move || Ok(grok_cli::cli_info(&data_dir))
    })
    .await?;
    info.update = cli_update_version(crate::model_providers::cli_update::grok_update(
        &data_dir,
        info.version.as_deref(),
    ))
    .await;
    Ok(info)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_claude_cli_info(state: State<'_, AppState>) -> Result<crate::anthropic::ClaudeCliInfo> {
    let data_dir = state.data_dir.clone();
    let mut info = crate::state::run_blocking(|| Ok(crate::anthropic::claude_cli_info())).await?;
    info.update = cli_update_version(crate::model_providers::cli_update::claude_update(
        &data_dir,
        info.version.as_deref(),
    ))
    .await;
    Ok(info)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_minimax_cli_info(state: State<'_, AppState>) -> Result<crate::minimax::MinimaxCliInfo> {
    let data_dir = state.data_dir.clone();
    let mut info = crate::state::run_blocking(|| Ok(crate::minimax::minimax_cli_info())).await?;
    info.update = cli_update_version(crate::model_providers::cli_update::minimax_update(
        &data_dir,
        info.version.as_deref(),
    ))
    .await;
    Ok(info)
}

/// The newer version, or empty. A check that fails does not fail the CLI row.
async fn cli_update_version(
    check: impl std::future::Future<Output = Option<crate::model_providers::cli_update::CliUpdate>>,
) -> String {
    check.await.map(|row| row.available).unwrap_or_default()
}

/// Install the newer CLI with that CLI's own updater, then read the version that is now on disk.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_cli_update(state: State<'_, AppState>, provider: String) -> Result<grok_cli::GrokCliInfo> {
    let data_dir = state.data_dir.clone();
    let provider = provider.trim().to_string();
    match provider.as_str() {
        "xai" | "anthropic" | "minimax" => {}
        _ => return Err(crate::error::Error::Other(format!("{provider} has no CLI to update."))),
    }
    let id = provider.clone();
    crate::state::run_blocking(move || install_cli_update(&id)).await?;
    cli_info_after_update(&data_dir, &provider).await
}

fn install_cli_update(provider: &str) -> Result<()> {
    let failed = |err: String| crate::error::Error::Other(err);
    match provider {
        "xai" => {
            let bin = crate::grok_cli::grok_bin().ok_or_else(|| failed("Grok CLI is not installed.".into()))?;
            crate::model_providers::cli_update::run_cli_update(&bin, &["update"]).map_err(failed)?;
            crate::grok_cli::forget_cli_version();
        }
        "anthropic" => {
            let bin = crate::anthropic::claude_bin().ok_or_else(|| failed("Claude CLI is not installed.".into()))?;
            crate::model_providers::cli_update::run_cli_update(&bin, &["update"]).map_err(failed)?;
            crate::anthropic::forget_claude_version();
        }
        "minimax" => {
            let bin = crate::minimax::mmx_bin().ok_or_else(|| failed("MiniMax CLI is not installed.".into()))?;
            crate::model_providers::cli_update::run_cli_update(&bin, &["update", "--non-interactive"]).map_err(failed)?;
            crate::minimax::forget_mmx_version();
        }
        _ => return Err(failed(format!("{provider} has no CLI to update."))),
    }
    Ok(())
}

/// The CLI row after an install. The saved update check is dropped so the badge does not stay stale.
/// Every provider shares the same fields, so the settings page can store whichever one came back.
async fn cli_info_after_update(data_dir: &std::path::Path, provider: &str) -> Result<grok_cli::GrokCliInfo> {
    match provider {
        "xai" => {
            crate::model_providers::cli_update::forget_cache(data_dir, "grok");
            let dir = data_dir.to_path_buf();
            let mut info = crate::state::run_blocking({
                let dir = dir.clone();
                move || Ok(crate::grok_cli::cli_info(&dir))
            })
            .await?;
            info.update = cli_update_version(crate::model_providers::cli_update::grok_update(
                &dir,
                info.version.as_deref(),
            ))
            .await;
            Ok(info)
        }
        "anthropic" => {
            crate::model_providers::cli_update::forget_cache(data_dir, "claude");
            let mut info = crate::state::run_blocking(|| Ok(crate::anthropic::claude_cli_info())).await?;
            info.update = cli_update_version(crate::model_providers::cli_update::claude_update(
                data_dir,
                info.version.as_deref(),
            ))
            .await;
            Ok(cli_info_fields(info.installed, info.path, info.version, info.logged_in, info.email, info.update))
        }
        "minimax" => {
            crate::model_providers::cli_update::forget_cache(data_dir, "minimax");
            let mut info = crate::state::run_blocking(|| Ok(crate::minimax::minimax_cli_info())).await?;
            info.update = cli_update_version(crate::model_providers::cli_update::minimax_update(
                data_dir,
                info.version.as_deref(),
            ))
            .await;
            Ok(cli_info_fields(info.installed, info.path, info.version, info.logged_in, info.email, info.update))
        }
        _ => Err(crate::error::Error::Other(format!("{provider} has no CLI to update."))),
    }
}

fn cli_info_fields(
    installed: bool,
    path: String,
    version: Option<String>,
    logged_in: bool,
    email: Option<String>,
    update: String,
) -> grok_cli::GrokCliInfo {
    grok_cli::GrokCliInfo {
        installed,
        path,
        version,
        logged_in,
        email,
        update,
    }
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
pub fn dev_anthropic_key_status(state: State<'_, AppState>) -> KeyStatus {
    KeyStatus {
        saved: secrets::get_anthropic_key(&state.data_dir).is_some(),
        env: std::env::var("ANTHROPIC_API_KEY")
            .ok()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_anthropic_key(state: State<'_, AppState>, key: String) -> Result<KeyStatus> {
    secrets::set_anthropic_key(&state.data_dir, &key)?;
    Ok(dev_anthropic_key_status(state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_clear_anthropic_key(state: State<'_, AppState>) -> Result<KeyStatus> {
    secrets::delete_anthropic_key(&state.data_dir)?;
    Ok(dev_anthropic_key_status(state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_minimax_key_status(state: State<'_, AppState>) -> KeyStatus {
    KeyStatus {
        saved: secrets::get_minimax_key(&state.data_dir).is_some(),
        env: std::env::var("MINIMAX_API_KEY")
            .ok()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_set_minimax_key(state: State<'_, AppState>, key: String) -> Result<KeyStatus> {
    secrets::set_minimax_key(&state.data_dir, &key)?;
    Ok(dev_minimax_key_status(state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_clear_minimax_key(state: State<'_, AppState>) -> Result<KeyStatus> {
    secrets::delete_minimax_key(&state.data_dir)?;
    Ok(dev_minimax_key_status(state))
}
