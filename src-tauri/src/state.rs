use std::path::PathBuf;

use crate::error::{Error, Result};

pub struct AppState {
    pub data_dir: PathBuf,
}

pub async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(Error::Other(e.to_string())))
}

#[tauri::command(rename_all = "snake_case")]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
