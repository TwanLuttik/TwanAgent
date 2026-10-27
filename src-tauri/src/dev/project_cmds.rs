//! Project list, open folder, create, clone, and delete.
//! Command names stay `dev_*`. The React client calls those strings.

use std::path::Path;

use tauri::{AppHandle, Manager, State};

use crate::dev::off_main;
use crate::dev::git::{
    project_removal, remove_project_worktrees, GitTarget,
    ProjectRemoval,
};
use crate::dev::paths::{expand_folder_path, path_string};
use crate::dev::project_location::ProjectsLocation;
use crate::dev::projects::{
    clone_repo, create_project, delete_project, list_projects, suggest_folders, FolderSuggestion,
};
use crate::error::Result;
use crate::state::AppState;

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
    crate::dev::project_location::published_location(
        &state.data_dir,
        &state.projects_root,
        &state.legacy_projects_root,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_list_projects(state: State<'_, AppState>) -> Result<Vec<FolderSuggestion>> {
    let data_dir = state.data_dir.clone();
    let roots = [state.projects_root.clone(), state.legacy_projects_root.clone()];
    off_main(move || Ok(list_projects_from(&data_dir, &roots))).await
}

/// Sidebar labels for the saved projects. A server project is a mount folder whose name is an id.
/// The name the user typed is on the remote row, so that is what the sidebar shows.
pub fn named_project_rows(
    rows: Vec<FolderSuggestion>,
    remotes: &[crate::remote::config::RemoteProject],
) -> Vec<FolderSuggestion> {
    let mut rows = rows;
    for remote in remotes {
        let name = remote.name.trim();
        if name.is_empty() {
            continue;
        }
        let Some(row) = rows.iter_mut().find(|row| same_project_path(&row.path, &remote.mount_path)) else {
            continue;
        };
        row.name = name.to_string();
    }
    rows
}

fn list_projects_from(data_dir: &std::path::Path, roots: &[std::path::PathBuf; 2]) -> Vec<FolderSuggestion> {
    match crate::appdb::open(data_dir).and_then(|conn| {
        let rows = crate::appdb::list_projects(&conn)?;
        let remotes = crate::remote::config::list_remote_projects(&conn).unwrap_or_default();
        Ok(named_project_rows(rows, &remotes))
    }) {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("app database project list failed: {err}");
            list_projects(&[roots[0].as_path(), roots[1].as_path()])
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

pub fn same_project_path(left: &str, right: &str) -> bool {
    crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(right))
}

fn is_linked_worktree(root: &Path) -> bool {
    let Ok(target) = crate::dev::git::GitTarget::local(root) else {
        return false;
    };
    let Ok(rows) = crate::dev::git::git_worktrees(&target) else {
        return false;
    };
    let Ok(canon) = std::fs::canonicalize(root) else {
        return false;
    };
    rows.iter().any(|row| {
        !row.main
            && !row.bare
            && std::fs::canonicalize(&row.path).ok().as_ref() == Some(&canon)
    })
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
pub async fn dev_open_folder(app: AppHandle, path: String) -> Result<String> {
    off_main(move || {
        let root = expand_folder_path(&path)?;
        let state = app.state::<AppState>();
        let canon = state.register_workspace(&app, &root)?;
        // A linked checkout stays under its repo. Saving it here puts the folder back at the top.
        if !is_linked_worktree(&canon) {
            remember_project(&state, &canon);
        }
        Ok(path_string(&canon))
    })
    .await
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
pub async fn dev_project_removal(state: State<'_, AppState>, path: String) -> Result<ProjectRemoval> {
    let data_dir = state.data_dir.clone();
    let roots = [state.projects_root.clone(), state.legacy_projects_root.clone()];
    off_main(move || {
        let root = expand_folder_path(&path)?;
        let target = GitTarget::local_in(&root, &[roots[0].clone(), roots[1].clone()], &data_dir)?;
        Ok(project_removal(
            &target,
            &data_dir,
            &[&roots[0], &roots[1]],
        ))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_delete_project_worktrees(state: State<'_, AppState>, path: String) -> Result<Vec<String>> {
    let data_dir = state.data_dir.clone();
    let roots = [state.projects_root.clone(), state.legacy_projects_root.clone()];
    off_main(move || {
        let root = expand_folder_path(&path)?;
        let target = GitTarget::local_in(&root, &[roots[0].clone(), roots[1].clone()], &data_dir)?;
        remove_project_worktrees(&target, &data_dir)
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
    // App projects are deleted by the projects helper, which refuses anything outside
    // that folder. An added project asked to be deleted too, so its folder goes directly.
    let external = expand_folder_path(&path).ok();
    let dest = match delete_project(&project_roots(&state), &path) {
        Ok(dest) => dest,
        Err(_) => {
            if let Some(root) = external.as_deref() {
                let _ = std::fs::remove_dir_all(crate::dev::git::external_worktree_root(&state.data_dir, root));
                if root.is_dir() {
                    std::fs::remove_dir_all(root)?;
                }
            }
            return Ok(());
        }
    };
    let mut wipe = crate::dev::project_location::forget_project(&state.data_dir, &path);
    wipe.push(path_string(&dest));
    for item in wipe {
        let _ = std::fs::remove_dir_all(crate::dev::conv::conv_dir(&state.data_dir, &item));
    }
    Ok(())
}

