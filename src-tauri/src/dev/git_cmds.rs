//! Git commands. `GitTarget` is local or SSH. Command names stay `dev_git_*`.

use tauri::{AppHandle, Manager, State};

use crate::dev::{off_main, same_project_path};
use crate::dev::git::{
    git_branches, git_commit, git_create_branch, git_diff, git_discard, git_file_at, git_identity,
    git_label, git_log, git_pull_request_checkout, git_pull_requests, git_set_identity,
    git_show, git_stage, git_stash, git_status_with, git_switch, git_sync, git_unstage,
    git_worktree_add, git_worktree_remove, git_worktree_rename, git_worktrees,
    GitCommit, GitIdentity, GitPullRequest, GitRepoSummary, GitTarget, GitWorktree, GitWorktreeAdd,
};
use crate::dev::types::{GitBranches, GitChange};
use crate::dev::paths::{expand_folder_path, path_string};
use crate::error::{Error, Result};
use crate::state::AppState;

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
    off_main(move || git_label(&target)).await
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
pub async fn dev_git_worktrees(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Vec<GitWorktree>> {
    let target = git_target(&state, &workspace)?;
    off_main(move || git_worktrees(&target)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_pull_requests(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Vec<GitPullRequest>> {
    let target = git_target(&state, &workspace)?;
    let data_dir = state.data_dir.clone();
    off_main(move || {
        let rows = git_pull_requests(&target)?;
        if let Some(repo) = rows.first().map(|row| pull_request_repo(&row.url)).flatten() {
            if let Ok(conn) = crate::appdb::open(&data_dir) {
                if let Ok(payload) = serde_json::to_string(&rows) {
                    let _ = crate::appdb::set_pull_requests(&conn, &repo, &payload);
                }
            }
        }
        Ok(rows)
    })
    .await
}

/// The list saved after the last refresh. Empty until one has landed, or when this is not GitHub.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_pull_requests_cached(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Vec<GitPullRequest>> {
    let target = git_target(&state, &workspace)?;
    let data_dir = state.data_dir.clone();
    off_main(move || {
        let remote = match crate::dev::git::git_remote_url(&target) {
            Some(url) => url,
            None => return Ok(Vec::new()),
        };
        let Some(repo) = crate::dev::git::github_repo_slug(&remote) else {
            return Ok(Vec::new());
        };
        let Ok(conn) = crate::appdb::open(&data_dir) else {
            return Ok(Vec::new());
        };
        let Some(payload) = crate::appdb::get_pull_requests(&conn, &repo)? else {
            return Ok(Vec::new());
        };
        Ok(serde_json::from_str(&payload).unwrap_or_default())
    })
    .await
}

fn pull_request_repo(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_pull_request_checkout(
    app: AppHandle,
    workspace: String,
    number: u32,
) -> Result<GitWorktreeAdd> {
    let state = app.state::<AppState>();
    let target = git_target(&state, &workspace)?;
    let added = off_main(move || git_pull_request_checkout(&target, number)).await?;
    let root = expand_folder_path(&added.opened)?;
    let state = app.state::<AppState>();
    let canon = state.register_workspace(&app, &root)?;
    Ok(GitWorktreeAdd {
        worktrees: added.worktrees,
        opened: path_string(&canon),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_worktree_add(
    app: AppHandle,
    workspace: String,
    branch: String,
    create: Option<bool>,
) -> Result<GitWorktreeAdd> {
    let state = app.state::<AppState>();
    let target = git_target(&state, &workspace)?;
    let create = create.unwrap_or(true);
    let added = off_main(move || git_worktree_add(&target, &branch, create)).await?;
    let root = expand_folder_path(&added.opened)?;
    let state = app.state::<AppState>();
    // A linked checkout is a child of its repo, not another project in the sidebar.
    let canon = state.register_workspace(&app, &root)?;
    Ok(GitWorktreeAdd {
        worktrees: added.worktrees,
        opened: path_string(&canon),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_worktree_rename(
    app: AppHandle,
    workspace: String,
    path: String,
    branch: String,
) -> Result<GitWorktreeAdd> {
    let state = app.state::<AppState>();
    let target = git_target(&state, &workspace)?;
    let data_dir = state.data_dir.clone();
    let from = path.clone();
    let renamed = off_main(move || {
        let added = git_worktree_rename(&target, &from, &branch)?;
        crate::dev::project_location::relocate_project_records(&data_dir, &from, &added.opened)?;
        Ok(added)
    })
    .await?;
    if same_project_path(&path, &renamed.opened) {
        return Ok(renamed);
    }
    let state = app.state::<AppState>();
    if let Ok(root) = expand_folder_path(&path) {
        let _ = state.forget_workspace(&root);
    }
    if let Ok(conn) = crate::appdb::open(&state.data_dir) {
        let _ = crate::appdb::remove_project(&conn, &path);
    }
    let root = expand_folder_path(&renamed.opened)?;
    let canon = state.register_workspace(&app, &root)?;
    Ok(GitWorktreeAdd {
        worktrees: renamed.worktrees,
        opened: path_string(&canon),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_worktree_remove(
    app: AppHandle,
    workspace: String,
    path: String,
) -> Result<Vec<GitWorktree>> {
    let state = app.state::<AppState>();
    let target = git_target(&state, &workspace)?;
    let remove_path = path.clone();
    let rows = off_main(move || git_worktree_remove(&target, &remove_path)).await?;
    let state = app.state::<AppState>();
    if let Ok(root) = expand_folder_path(&path) {
        let _ = state.forget_workspace(&root);
    }
    // The folder is gone. Its chats must go too, or checking the branch out again
    // shows the conversations from the last time.
    let data_dir = state.data_dir.clone();
    let forgotten = path.clone();
    let _ = off_main(move || crate::dev::project_location::drop_project_chats(&data_dir, &forgotten)).await;
    Ok(rows)
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


/// Branch label for a sidebar row. Does not register the folder as an opened workspace.
/// One local `git status`. A cloud project's files are not on this mount.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_git_project_summary(state: State<'_, AppState>, path: String) -> Result<GitRepoSummary> {
    let root = crate::dev::paths::expand_folder_path(&path)?;
    if crate::remote::project_for_workspace(&state, &root)?.is_some() {
        return Ok(crate::dev::git::GitRepoSummary {
            repo: false,
            current: None,
            detached: false,
            commit: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            dirty: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicts: 0,
        });
    }
    let target = GitTarget::local(&root)?;
    off_main(move || git_label(&target)).await
}

fn git_target(state: &AppState, workspace: &str) -> Result<GitTarget> {
    let root = state.require_workspace(workspace)?;
    let Some(project) = crate::remote::project_for_workspace(state, &root)? else {
        return GitTarget::local_in(
            &root,
            &[state.projects_root.clone(), state.legacy_projects_root.clone()],
            &state.data_dir,
        );
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

