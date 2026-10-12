use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{Manager, Runtime};

use crate::appdb;
use crate::error::{Error, Result};
use crate::remote::client::LiveConnector;
use crate::remote::ssh::Pool;
use crate::speech::SpeechEngine;
use crate::workspace::OpenedRoots;

pub struct AppState {
    pub data_dir: PathBuf,
    pub projects_root: PathBuf,
    pub legacy_projects_root: PathBuf,
    opened: Mutex<OpenedRoots>,
    pub ssh_pool: Arc<Pool>,
    pub speech: SpeechEngine,
}

static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The data directory set when the app starts. Empty until then, including in tests
/// that never load `AppState`. Saved provider keys are read from here.
pub fn app_data_dir() -> PathBuf {
    APP_DATA_DIR.get().cloned().unwrap_or_default()
}

impl AppState {
    pub fn load(data_dir: PathBuf) -> Self {
        let _ = APP_DATA_DIR.set(data_dir.clone());
        let location = crate::dev::project_location::prepare(&data_dir);
        let opened = OpenedRoots::load(&data_dir, location.root.clone());
        if let Ok(conn) = appdb::open(&data_dir) {
            let opened_paths: Vec<String> = opened
                .list()
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            if let Err(err) = appdb::import_legacy_projects(
                &conn,
                &[location.root.as_path(), location.legacy.as_path()],
                &opened_paths,
            ) {
                eprintln!("app database project import failed: {err}");
            }
        }
        Self {
            data_dir,
            projects_root: location.root,
            legacy_projects_root: location.legacy,
            opened: Mutex::new(opened),
            ssh_pool: Arc::new(Pool::new(Arc::new(LiveConnector))),
            speech: SpeechEngine::new(),
        }
    }

    pub fn require_workspace(&self, workspace: &str) -> Result<PathBuf> {
        self.opened
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .require(workspace)
    }

    pub fn register_workspace<R: Runtime, M: Manager<R>>(
        &self,
        app: &M,
        root: &Path,
    ) -> Result<PathBuf> {
        let mut opened = self.opened.lock().unwrap_or_else(|e| e.into_inner());
        let canon = opened.register(root)?;
        let _ = opened.persist(&self.data_dir);
        let _ = app.asset_protocol_scope().allow_directory(&canon, true);
        Ok(canon)
    }

    pub fn opened_workspaces(&self) -> Vec<PathBuf> {
        self.opened
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .list()
    }

    pub fn forget_workspace(&self, root: &Path) -> Result<bool> {
        let mut opened = self.opened.lock().unwrap_or_else(|e| e.into_inner());
        let removed = opened.forget(root);
        if removed {
            let _ = opened.persist(&self.data_dir);
        }
        Ok(removed)
    }

    pub fn allow_persisted_assets<R: Runtime, M: Manager<R>>(&self, app: &M) {
        let opened = self.opened.lock().unwrap_or_else(|e| e.into_inner());
        for root in opened.iter() {
            let _ = app.asset_protocol_scope().allow_directory(root, true);
        }
    }
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
