use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use super::files::{
    create_dir, delete_paths, edit_file, existing_files, file_preview, list_dir, move_path,
    read_file, rename_path, resolve_file, tree_snapshot, write_file,
};
use super::git::{
    git_branches, git_commit, git_create_branch, git_diff, git_discard, git_file_at, git_identity,
    git_log, git_set_identity, git_show, git_stage, git_stash, git_status_with, git_summary,
    git_switch, git_sync, git_unstage, GitCommit, GitIdentity, GitRepoSummary, GitTarget,
};
use super::paths::{expand_folder_path, path_string};
use super::project_location::ProjectsLocation;
use super::projects::FolderSuggestion;
use super::projects::{clone_repo, create_project, delete_project, list_projects, suggest_folders};
use super::types::{DevEntry, FilePreview, GitBranches, GitChange, TreeSnapshot};
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
    match crate::appdb::open(&state.data_dir).and_then(|conn| {
        let mut rows = crate::appdb::list_projects(&conn)?;
        if let Ok(remotes) = crate::remote::config::list_remote_projects(&conn) {
            for remote in remotes {
                if let Some(row) = rows.iter_mut().find(|row| row.path == remote.mount_path) {
                    if !remote.name.trim().is_empty() {
                        row.name = remote.name;
                    }
                }
            }
        }
        Ok(rows)
    }) {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("app database project list failed: {err}");
            list_projects(&project_roots(&state))
        }
    }
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

fn remember_project(state: &AppState, root: &Path) {
    let Ok(conn) = crate::appdb::open(&state.data_dir) else {
        return;
    };
    if let Err(err) = crate::appdb::add_project(&conn, root) {
        eprintln!("could not save project: {err}");
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_open_folder(app: AppHandle, path: String) -> Result<String> {
    let root = expand_folder_path(&path)?;
    let state = app.state::<AppState>();
    let canon = state.register_workspace(&app, &root)?;
    remember_project(&state, &canon);
    Ok(path_string(&canon))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_suggest_folders(path: String) -> Vec<FolderSuggestion> {
    suggest_folders(&path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_create_project(app: AppHandle, name: String) -> Result<String> {
    let state = app.state::<AppState>();
    let root = create_project(&state.projects_root, &name)?;
    let canon = state.register_workspace(&app, &root)?;
    remember_project(&state, &canon);
    Ok(path_string(&canon))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_clone_repo(app: AppHandle, url: String, name: Option<String>) -> Result<String> {
    crate::state::run_blocking(move || {
        let state = app.state::<AppState>();
        let root = clone_repo(&state.projects_root, &url, name.as_deref())?;
        let canon = state.register_workspace(&app, &root)?;
        remember_project(&state, &canon);
        Ok(path_string(&canon))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_delete_project(state: State<'_, AppState>, path: String) -> Result<()> {
    if let Ok(conn) = crate::appdb::open(&state.data_dir) {
        let _ = crate::appdb::remove_project(&conn, &path);
    }
    if let Ok(root) = expand_folder_path(&path) {
        let _ = state.forget_workspace(&root);
    }
    // Only folders inside the app projects directory are deleted from disk.
    // A project added from somewhere else is only removed from the app database.
    let dest = match delete_project(&project_roots(&state), &path) {
        Ok(dest) => dest,
        Err(_) => return Ok(()),
    };
    let mut wipe = super::project_location::forget_project(&state.data_dir, &path);
    wipe.push(path_string(&dest));
    for item in wipe {
        let _ = std::fs::remove_dir_all(super::conv::conv_dir(&state.data_dir, &item));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_tree_signature(state: State<'_, AppState>, workspace: String) -> Result<TreeSnapshot> {
    let root = state.require_workspace(&workspace)?;
    let remote = remote_files(&state, &root)?;
    off_main(move || {
        if let Some(remote) = remote {
            return remote.tree_snapshot();
        }
        tree_snapshot(&root)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_list_dir(
    state: State<'_, AppState>,
    workspace: String,
    path: Option<String>,
) -> Result<Vec<DevEntry>> {
    let root = state.require_workspace(&workspace)?;
    let remote = remote_files(&state, &root)?;
    let rel = path.unwrap_or_default();
    off_main(move || {
        if let Some(remote) = remote {
            return remote.list(&rel);
        }
        list_dir(&root, &rel)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_read_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let remote = remote_files(&state, &root)?;
    off_main(move || {
        if let Some(remote) = remote {
            return remote.read(&path);
        }
        read_file(&root, &path)
    })
    .await
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
pub async fn dev_mcp_sign_in(name: String) -> Result<()> {
    let server = name.trim().to_string();
    off_main(move || super::mcp_oauth::mcp_sign_in(&server)).await
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
pub async fn dev_rename_path(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    name: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let remote = remote_files(&state, &root)?;
    off_main(move || {
        if let Some(remote) = remote {
            return remote.rename(&path, &name);
        }
        rename_path(&root, &path, &name)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_move_paths(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
    dest: String,
) -> Result<Vec<String>> {
    let root = state.require_workspace(&workspace)?;
    let remote = remote_files(&state, &root)?;
    off_main(move || {
        let mut moved = Vec::new();
        for path in &paths {
            let name = std::path::Path::new(path.trim_matches('/'))
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or_else(|| Error::Other("invalid path".into()))?;
            let to = if dest.trim_matches('/').is_empty() {
                name
            } else {
                format!("{}/{}", dest.trim_matches('/'), name)
            };
            if let Some(remote) = &remote {
                moved.push(remote.move_path(path, &to)?);
            } else {
                moved.push(move_path(&root, path, &to)?);
            }
        }
        Ok(moved)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_delete_paths(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
) -> Result<()> {
    let root = state.require_workspace(&workspace)?;
    let remote = remote_files(&state, &root)?;
    off_main(move || {
        if let Some(remote) = remote {
            return remote.delete(&paths);
        }
        delete_paths(&root, &paths)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_create_dir(
    state: State<'_, AppState>,
    workspace: String,
    parent: String,
    name: String,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let remote = remote_files(&state, &root)?;
    off_main(move || {
        if let Some(remote) = remote {
            return remote.create_dir(&parent, &name);
        }
        create_dir(&root, &parent, &name)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_write_file(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    contents: String,
) -> Result<()> {
    let root = state.require_workspace(&workspace)?;
    let remote = remote_files(&state, &root)?;
    off_main(move || {
        if let Some(remote) = remote {
            return remote.write(&path, &contents);
        }
        write_file(&root, &path, &contents)
    })
    .await
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
    let remote = remote_files(&state, &root)?;
    off_main(move || {
        if let Some(remote) = remote {
            return remote.edit(&path, &old_string, &new_string);
        }
        edit_file(&root, &path, &old_string, &new_string)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_status(
    state: State<'_, AppState>,
    workspace: String,
    stats: Option<bool>,
) -> Result<Vec<GitChange>> {
    let target = git_target(&state, &workspace)?;
    let with_stats = stats.unwrap_or(true);
    off_main(move || git_status_with(&target, with_stats)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_diff(
    state: State<'_, AppState>,
    workspace: String,
    path: Option<String>,
) -> Result<String> {
    let target = git_target(&state, &workspace)?;
    let rel = path.unwrap_or_default();
    off_main(move || git_diff(&target, &rel)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_branches(state: State<'_, AppState>, workspace: String) -> Result<GitBranches> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_branches(&target)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_summary(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<GitRepoSummary> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_summary(&target)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_switch(
    state: State<'_, AppState>,
    workspace: String,
    name: String,
) -> Result<GitBranches> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_switch(&target, &name)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_create_branch(
    state: State<'_, AppState>,
    workspace: String,
    name: String,
    checkout: Option<bool>,
) -> Result<GitBranches> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_create_branch(&target, &name, checkout.unwrap_or(true))).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_stage(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
) -> Result<Vec<GitChange>> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_stage(&target, &paths)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_unstage(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
) -> Result<Vec<GitChange>> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_unstage(&target, &paths)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_discard(
    state: State<'_, AppState>,
    workspace: String,
    paths: Vec<String>,
) -> Result<Vec<GitChange>> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_discard(&target, &paths)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_commit(
    state: State<'_, AppState>,
    workspace: String,
    message: String,
) -> Result<String> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_commit(&target, &message)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_identity(state: State<'_, AppState>, workspace: String) -> Result<GitIdentity> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_identity(&target)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_set_identity(
    state: State<'_, AppState>,
    workspace: String,
    name: String,
    email: String,
) -> Result<GitIdentity> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_set_identity(&target, &name, &email)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_sync(
    state: State<'_, AppState>,
    workspace: String,
    action: String,
) -> Result<String> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_sync(&target, &action)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_stash(
    state: State<'_, AppState>,
    workspace: String,
    action: String,
    message: Option<String>,
) -> Result<String> {
    let target = git_target(&state, &workspace)?;
    let message = message.unwrap_or_default();
    off_main(move || git_stash(&target, &action, &message)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_log(
    state: State<'_, AppState>,
    workspace: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommit>> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_log(&target, limit.unwrap_or(40))).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_show(
    state: State<'_, AppState>,
    workspace: String,
    hash: String,
) -> Result<String> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_show(&target, &hash)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_file_at(
    state: State<'_, AppState>,
    workspace: String,
    path: String,
    revision: Option<String>,
) -> Result<String> {
    let target = git_target(&state, &workspace)?;
    let revision = revision.unwrap_or_else(|| "HEAD".into());
    off_main(move || git_file_at(&target, &path, &revision)).await
}

struct RemoteFiles {
    machine: crate::remote::config::Machine,
    project: crate::remote::config::RemoteProject,
    pool: std::sync::Arc<crate::remote::ssh::Pool>,
    secret: Option<String>,
}

impl RemoteFiles {
    fn exec(&self, command: &str) -> Result<String> {
        self.exec_at(&self.project.remote_path, command)
    }

    fn exec_at(&self, cwd: &str, command: &str) -> Result<String> {
        let out = self.pool.exec(
            &self.machine,
            self.secret.as_deref(),
            &crate::remote::ssh::ExecRequest {
                cwd: cwd.to_string(),
                command: command.to_string(),
                timeout_secs: 60,
            },
        )?;
        if out.exit_code.is_some_and(|code| code != 0) {
            let err = if out.stderr.is_empty() { out.stdout } else { out.stderr };
            return Err(Error::Other(err.trim().chars().take(300).collect()));
        }
        Ok(out.stdout)
    }

    fn read(&self, rel: &str) -> Result<String> {
        let command = crate::remote::files::remote_read_command(&self.project.remote_path, rel)?;
        self.exec(&command)
    }

    fn write(&self, rel: &str, contents: &str) -> Result<()> {
        if contents.len() > 2_000_000 {
            return Err(Error::Other("write is larger than 2000000 bytes".into()));
        }
        let script = crate::remote::files::remote_write_script(&self.project.remote_path, rel)?;
        // File bytes stay base64 inside single quotes. They are not interpolated into the shell.
        self.exec(&crate::remote::files::remote_write_shell(contents, &script))?;
        Ok(())
    }

    fn edit(&self, rel: &str, old: &str, new: &str) -> Result<()> {
        if old.is_empty() {
            return Err(Error::Other("old_string is empty".into()));
        }
        let current = self.read(rel)?;
        let matches = current.matches(old).count();
        if matches == 0 {
            return Err(Error::Other("old_string was not found".into()));
        }
        if matches > 1 {
            return Err(Error::Other(format!(
                "old_string matched {matches} times — make it unique"
            )));
        }
        self.write(rel, &current.replacen(old, new, 1))
    }

    fn tree_snapshot(&self) -> Result<super::types::TreeSnapshot> {
        let command = crate::remote::files::remote_tree_command(&self.project.remote_path)?;
        let text = self.exec_at("/", &command)?;
        let rows = crate::remote::files::parse_remote_tree(&text);
        let mut hasher = sha2::Sha256::new();
        use sha2::Digest;
        let mut dirs = Vec::new();
        for (path, dir) in &rows {
            hasher.update(if *dir { b"d\t" } else { b"f\t" });
            hasher.update(path.as_bytes());
            hasher.update(b"\n");
            if *dir {
                dirs.push(path.clone());
            }
        }
        Ok(super::types::TreeSnapshot {
            signature: hex::encode(hasher.finalize()),
            dirs,
            files: rows
                .iter()
                .filter(|(_, dir)| !dir)
                .map(|(path, _)| path.clone())
                .collect(),
        })
    }

    fn rename(&self, rel: &str, name: &str) -> Result<String> {
        let (command, dest) =
            crate::remote::files::remote_rename_command(&self.project.remote_path, rel, name)?;
        if !command.is_empty() {
            self.exec(&command)?;
        }
        Ok(dest)
    }

    fn move_path(&self, from: &str, to: &str) -> Result<String> {
        let (command, dest) =
            crate::remote::files::remote_move_command(&self.project.remote_path, from, to)?;
        if !command.is_empty() {
            self.exec(&command)?;
        }
        Ok(dest)
    }

    fn delete(&self, rels: &[String]) -> Result<()> {
        let command = crate::remote::files::remote_delete_command(&self.project.remote_path, rels)?;
        self.exec(&command)?;
        Ok(())
    }

    fn create_dir(&self, parent: &str, name: &str) -> Result<String> {
        let (command, rel) =
            crate::remote::files::remote_mkdir_command(&self.project.remote_path, parent, name)?;
        self.exec(&command)?;
        Ok(rel)
    }

    fn list(&self, rel: &str) -> Result<Vec<DevEntry>> {
        let command = crate::remote::files::remote_list_command(&self.project.remote_path, rel)?;
        // The command already names the remote folder. Don't cd into it first: a missing folder would fail the cd.
        let text = self.exec_at("/", &command)?;
        Ok(crate::remote::files::parse_remote_list(&text, rel)
            .into_iter()
            .map(|(path, dir)| {
                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone());
                DevEntry {
                    name,
                    path,
                    kind: if dir { "dir" } else { "file" }.into(),
                    size: None,
                }
            })
            .collect())
    }
}

fn remote_files(state: &AppState, root: &Path) -> Result<Option<RemoteFiles>> {
    let Some(project) = crate::remote::project_for_workspace(state, root)? else {
        return Ok(None);
    };
    let conn = crate::appdb::open(&state.data_dir)?;
    let machine = crate::remote::config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    Ok(Some(RemoteFiles {
        machine,
        project,
        pool: state.ssh_pool.clone(),
        secret,
    }))
}

/// Branch label for a sidebar row. Does not register the folder as an opened workspace.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_project_summary(path: String) -> Result<GitRepoSummary> {
    let root = super::paths::expand_folder_path(&path)?;
    let target = GitTarget::local(&root)?;
    off_main(move || git_summary(&target)).await
}

fn git_target(state: &AppState, workspace: &str) -> Result<GitTarget> {
    let root = state.require_workspace(workspace)?;
    let Some(project) = crate::remote::project_for_workspace(state, &root)? else {
        return GitTarget::local(&root);
    };
    let conn = crate::appdb::open(&state.data_dir)?;
    let machine = crate::remote::config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    GitTarget::remote(&root, machine, project, state.ssh_pool.clone(), secret)
}

/// http(s) only. `open` would also launch local files and custom URL schemes.
fn browser_url(raw: &str) -> Result<String> {
    let url = raw.trim();
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| Error::Other("only http and https links can be opened".into()))?;
    if rest.is_empty() || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(Error::Other("that link cannot be opened".into()));
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod url_tests {
    use super::browser_url;

    #[test]
    fn browser_links_are_http_only() {
        assert_eq!(
            browser_url(" https://example.com/a ").unwrap(),
            "https://example.com/a"
        );
        assert!(browser_url("http://localhost:1430").is_ok());
        assert!(browser_url("file:///etc/passwd").is_err());
        assert!(browser_url("javascript:alert(1)").is_err());
        assert!(browser_url("https://evil.test\nopen").is_err());
        assert!(browser_url("notaurl").is_err());
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_reveal_folder(state: State<'_, AppState>, path: String) -> Result<()> {
    let root = state.require_workspace(&path)?;
    if crate::remote::project_for_workspace(&state, &root)?.is_some() {
        return Err(Error::Other("this project lives on a server".into()));
    }
    super::open_path(&root)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_open_url(url: String) -> Result<()> {
    let url = browser_url(&url)?;
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&url).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(&url).status()
    };
    match status {
        Ok(code) if code.success() => Ok(()),
        Ok(_) => Err(Error::Other("could not open the link".into())),
        Err(err) => Err(Error::Other(format!("could not open the link: {err}"))),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_stop_command(id: String) -> Result<()> {
    super::cmd::stop_command(&id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_run_command(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace: String,
    command: String,
    stream_id: Option<String>,
) -> Result<String> {
    let root = state.require_workspace(&workspace)?;
    let remote = crate::remote::project_for_workspace(&state, &root)?;
    let data_dir = state.data_dir.clone();
    let pool = state.ssh_pool.clone();
    let stream = stream_id.unwrap_or_default();
    off_main(move || {
        let emit = |kind: &str, text: Option<String>, exit_code: Option<i32>| {
            if stream.is_empty() {
                return;
            }
            let _ = app.emit(
                "dev-command",
                super::types::DevCommandEvent {
                    stream_id: stream.clone(),
                    kind: kind.into(),
                    text,
                    exit_code,
                },
            );
        };
        emit("start", None, None);
        let Some(project) = remote else {
            let text = super::cmd::run_command_streaming(&root, &command, &stream, |chunk| {
                emit("data", Some(chunk.to_string()), None);
            })?;
            emit("exit", None, None);
            return Ok(text);
        };
        let conn = crate::appdb::open(&data_dir)?;
        let machine = crate::remote::config::machine_by_id(&conn, &project.machine_id)?
            .ok_or_else(|| Error::NotFound("machine not found".into()))?;
        let secret = machine
            .secret_account
            .as_deref()
            .and_then(crate::secrets::get_ssh_secret);
        let out = crate::remote::exec::run_workspace_command(
            &root,
            &command,
            Some((&machine, &project, secret.as_deref())),
            pool.as_ref(),
        )?;
        if !out.text.is_empty() && out.text != "(no output)" {
            emit("data", Some(out.text.clone()), None);
        }
        emit("exit", None, out.exit_code);
        Ok(out.text)
    })
    .await
}
