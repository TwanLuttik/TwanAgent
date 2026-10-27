//! Worktrees and the disk they use. Checkout, rename, remove, and the removal sizes.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::super::projects;
use super::{
    git_branches, git_run, git_text, sanitize_git_branch, GitTarget, GitText, GitWorktree, WORKTREE_DIR,
    WORKTREE_EXCLUDE,
};
use crate::error::{Error, Result};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GitWorktreeAdd {
    pub worktrees: Vec<GitWorktree>,
    pub opened: String,
}

pub fn parse_worktree_list(text: &str) -> Vec<GitWorktree> {
    let mut rows = Vec::new();
    for block in text.split("\n\n") {
        let mut path = None;
        let mut head = None;
        let mut branch = None;
        let mut bare = false;
        let mut detached = false;
        let mut saw = false;
        for line in block.lines() {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            saw = true;
            if let Some(rest) = line.strip_prefix("worktree ") {
                let value = rest.trim();
                if !value.is_empty() {
                    path = Some(value.to_string());
                }
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                let value = rest.trim();
                if !value.is_empty() {
                    head = Some(value.to_string());
                }
            } else if let Some(rest) = line.strip_prefix("branch ") {
                branch = Some(worktree_branch_name(rest));
            } else if line == "bare" {
                bare = true;
            } else if line == "detached" {
                detached = true;
            }
        }
        if !saw {
            continue;
        }
        let Some(path) = path else { continue };
        rows.push(GitWorktree {
            path,
            head,
            branch,
            bare,
            detached,
            main: rows.is_empty(),
        });
    }
    rows
}

fn worktree_branch_name(raw: &str) -> String {
    raw.trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(raw.trim())
        .to_string()
}

pub fn git_worktrees(target: &GitTarget) -> Result<Vec<GitWorktree>> {
    match git_text(target, &["worktree", "list", "--porcelain"])? {
        GitText::NotRepo => Ok(Vec::new()),
        GitText::Output(text) => Ok(parse_worktree_list(&text)),
    }
}

/// Where a new worktree is checked out. `inside` is `<repo>/worktrees/<branch>` for a
/// project the app owns. `None` is a folder the user opened from somewhere else, so the
/// checkout goes under the app data directory and the project folder is left alone.
pub struct WorktreeHome {
    pub inside: bool,
    pub root: PathBuf,
}

/// `<root>/<branch>`, with `/` in the branch turned into `-`.
pub fn worktree_destination(home: &WorktreeHome, branch: &str) -> Result<PathBuf> {
    let branch = sanitize_git_branch(branch)?;
    let name = worktree_folder_name(&branch)?;
    if home.inside && name == WORKTREE_DIR {
        return Err(Error::Other("worktree folder would nest inside itself".into()));
    }
    Ok(home.root.join(name))
}

/// A project under the app projects folder keeps worktrees inside itself.
/// Anything else, including a folder opened from another location, uses app data.
pub fn worktree_home(main_path: &Path, app_roots: &[&Path], data_dir: &Path) -> WorktreeHome {
    // `git worktree list` returns the real path. On macOS that drops a `/var` -> `/private/var`
    // symlink, so compare the resolved folders rather than the path the app stored.
    let main_real = fs::canonicalize(main_path).unwrap_or_else(|_| main_path.to_path_buf());
    let owned = app_roots.iter().any(|root| {
        let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        crate::paths::is_under(&main_real, &root_real)
            && main_real.parent().is_some_and(|parent| crate::paths::same_dir(parent, &root_real))
    });
    if owned {
        return WorktreeHome {
            inside: true,
            root: main_path.join(WORKTREE_DIR),
        };
    }
    WorktreeHome {
        inside: false,
        root: external_worktree_root(data_dir, main_path),
    }
}

/// `<data>/worktrees/<project>-<id>`. Removing an external project deletes this folder.
pub fn external_worktree_root(data_dir: &Path, main_path: &Path) -> PathBuf {
    let name = main_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty() && name != "." && name != "..")
        .unwrap_or_else(|| "project".into());
    let folder = projects::sanitize_project_name(&name).unwrap_or_else(|_| "project".into());
    let id = crate::dev::paths::workspace_id(&crate::paths::native_source(&main_path.to_string_lossy()));
    data_dir.join(WORKTREE_DIR).join(format!("{folder}-{id}"))
}

/// Tell git to ignore `worktrees/` without touching a committed `.gitignore`.
/// Git refuses `worktree add` inside the working tree unless this path is excluded.
fn ensure_worktree_excluded(main_path: &Path) -> Result<()> {
    let git_dir = main_path.join(".git");
    if !git_dir.is_dir() {
        return Ok(());
    }
    let info = git_dir.join("info");
    fs::create_dir_all(&info)?;
    let exclude = info.join("exclude");
    let current = fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|line| line.trim() == WORKTREE_EXCLUDE) {
        return Ok(());
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(WORKTREE_EXCLUDE);
    next.push('\n');
    fs::write(&exclude, next)?;
    Ok(())
}

fn worktree_folder_name(branch: &str) -> Result<String> {
    let flat = branch.replace('/', "-");
    projects::sanitize_project_name(&flat)
}

fn same_checkout(left: &str, right: &Path) -> bool {
    let Ok(canon) = fs::canonicalize(right) else {
        return crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(
            &right.to_string_lossy(),
        ));
    };
    crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(
        &canon.to_string_lossy(),
    )) || crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(
        &right.to_string_lossy(),
    ))
}

fn main_worktree_path(rows: &[GitWorktree]) -> Result<PathBuf> {
    rows.iter()
        .find(|row| row.main)
        .map(|row| PathBuf::from(&row.path))
        .ok_or_else(|| Error::Other("not a git repository".into()))
}

/// Where this repository's new worktrees go. An existing checkout keeps its own folder.
fn home_for(target: &GitTarget, main: &Path) -> WorktreeHome {
    let (roots, data_dir) = target
        .worktree_place
        .clone()
        .unwrap_or_else(|| (Vec::new(), PathBuf::new()));
    let root_refs: Vec<&Path> = roots.iter().map(PathBuf::as_path).collect();
    worktree_home(main, &root_refs, &data_dir)
}

/// Check `branch` out in this project's worktree folder. `create` makes the branch from HEAD when it is new.
pub fn git_worktree_add(target: &GitTarget, branch: &str, create: bool) -> Result<GitWorktreeAdd> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "worktrees are only created for a project on this Mac".into(),
        ));
    }
    let branch = sanitize_git_branch(branch)?;
    let listed = git_worktrees(target)?;
    if listed.is_empty() {
        return Err(Error::Other("not a git repository".into()));
    }
    if listed.iter().any(|row| row.bare) {
        return Err(Error::Other("a bare repository cannot grow a worktree".into()));
    }
    if listed.iter().any(|row| row.branch.as_deref() == Some(branch.as_str())) {
        return Err(Error::Conflict(format!("{branch} is already checked out")));
    }
    let main = main_worktree_path(&listed)?;
    let home = home_for(target, &main);
    if home.inside {
        ensure_worktree_excluded(&main)?;
    }
    let dest = worktree_destination(&home, &branch)?;
    if dest.exists() {
        return Err(Error::Conflict(format!(
            "{} already exists",
            dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        )));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let dest_str = dest
        .to_str()
        .ok_or_else(|| Error::Other("worktree path is not valid".into()))?
        .to_string();
    let branch_exists = git_branches(target)?
        .branches
        .iter()
        .any(|name| name == &branch);
    let added = if create && !branch_exists {
        git_run(target, &["worktree", "add", "-b", &branch, &dest_str, "HEAD"])
    } else if branch_exists {
        git_run(target, &["worktree", "add", &dest_str, &branch])
    } else {
        Err(Error::Other(format!("branch {branch} does not exist")))
    };
    if let Err(err) = added {
        if dest.exists() && fs::read_dir(&dest).ok().is_some_and(|mut rows| rows.next().is_none()) {
            let _ = fs::remove_dir(&dest);
        }
        return Err(err);
    }
    let worktrees = git_worktrees(target)?;
    let opened = worktrees
        .iter()
        .find(|row| same_checkout(&row.path, &dest))
        .map(|row| row.path.clone())
        .unwrap_or(dest_str);
    Ok(GitWorktreeAdd { worktrees, opened })
}

/// Rename a linked worktree's branch and move its folder to match. The main checkout stays put.
pub fn git_worktree_rename(target: &GitTarget, path: &str, branch: &str) -> Result<GitWorktreeAdd> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "worktrees are only renamed for a project on this Mac".into(),
        ));
    }
    let branch = sanitize_git_branch(branch)?;
    let listed = git_worktrees(target)?;
    let Some(row) = listed.iter().find(|row| same_checkout(&row.path, Path::new(path))) else {
        return Err(Error::Other("that worktree is not in this repository".into()));
    };
    if row.main {
        return Err(Error::Other("the main checkout cannot be renamed".into()));
    }
    if row.detached || row.branch.as_deref().is_none_or(str::is_empty) {
        return Err(Error::Other("a detached worktree has no branch to rename".into()));
    }
    let current = row.branch.clone().unwrap_or_default();
    let here = row.path.clone();
    let already_home = current == branch
        && same_checkout(
            &here,
            &worktree_destination(&home_for(target, &main_worktree_path(&listed)?), &branch)?,
        );
    if already_home {
        return Ok(GitWorktreeAdd {
            worktrees: listed,
            opened: here,
        });
    }
    if listed.iter().any(|item| item.path != row.path && item.branch.as_deref() == Some(branch.as_str())) {
        return Err(Error::Conflict(format!("{branch} is already checked out")));
    }
    let main = main_worktree_path(&listed)?;
    let repo = GitTarget::local(&main)?;
    let dest = worktree_destination(&home_for(target, &main), &branch)?;
    let moving = !same_checkout(&row.path, &dest);
    if moving && dest.exists() {
        return Err(Error::Conflict(format!(
            "{} already exists",
            dest.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        )));
    }
    if current != branch {
        let taken = git_branches(&repo)?
            .branches
            .iter()
            .any(|name| name == &branch);
        if taken {
            return Err(Error::Conflict(format!("{branch} already exists")));
        }
        // Running this in the main checkout would rename main. The branch lives here.
        let linked = GitTarget::local(Path::new(&here))?;
        git_run(&linked, &["branch", "-m", &branch])?;
    }
    let from = here;
    if moving {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let dest_str = dest
            .to_str()
            .ok_or_else(|| Error::Other("worktree path is not valid".into()))?
            .to_string();
        if let Err(err) = git_run(&repo, &["worktree", "move", &from, &dest_str]) {
            if current != branch {
                let linked = GitTarget::local(Path::new(&from))?;
                let _ = git_run(&linked, &["branch", "-m", &current]);
            }
            return Err(err);
        }
    }
    let worktrees = git_worktrees(target)?;
    let opened = worktrees
        .iter()
        .find(|item| item.branch.as_deref() == Some(branch.as_str()))
        .map(|item| item.path.clone())
        .unwrap_or_else(|| dest.to_string_lossy().into_owned());
    Ok(GitWorktreeAdd { worktrees, opened })
}

/// How much disk one remove choice would free. `project` is the main checkout.
/// `worktrees` is every linked checkout. `app` is the chats and other app data for those folders.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectRemoval {
    pub project: u64,
    pub worktrees: u64,
    pub app: u64,
    pub worktree_count: u32,
    pub app_managed: bool,
    /// One size per linked checkout, in the same order `git worktree list` returns them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worktree_sizes: Vec<WorktreeSize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeSize {
    pub path: String,
    pub bytes: u64,
}

/// One folder's size, remembered so the storage page does not walk it again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SizeCacheEntry {
    bytes: u64,
    /// Directory mtimes, deepest last. A change in any of them means the bytes are stale.
    stamps: Vec<(String, u64)>,
}

fn size_cache_key(path: &str) -> String {
    format!("dir-size.{}", crate::dev::paths::workspace_id(path))
}

fn read_size_cache(data_dir: &Path, path: &str) -> Option<SizeCacheEntry> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let raw = crate::appdb::get_setting(&conn, &size_cache_key(path)).ok()??;
    serde_json::from_str(&raw).ok()
}

fn write_size_cache(data_dir: &Path, path: &str, entry: &SizeCacheEntry) {
    let Ok(raw) = serde_json::to_string(entry) else {
        return;
    };
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    let _ = crate::appdb::set_setting(&conn, &size_cache_key(path), &raw);
}

fn mtime_secs(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    Some(modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs())
}

/// Directory mtimes under `path`. A nested path in `skip` is left out, matching the size walk.
fn dir_stamps(path: &Path, skip: &[&str]) -> Vec<(String, u64)> {
    fn walk(path: &Path, skip: &[&str], out: &mut Vec<(String, u64)>) {
        if path.file_name().is_some_and(|name| name == ".git") {
            return;
        }
        let canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let text = crate::paths::native_source(&canon.to_string_lossy());
        if skip.iter().any(|item| crate::paths::native_source(item).eq_ignore_ascii_case(&text)) {
            return;
        }
        let Some(stamp) = mtime_secs(path) else {
            return;
        };
        out.push((text, stamp));
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            if child.symlink_metadata().ok().is_some_and(|meta| meta.is_dir() && !meta.file_type().is_symlink()) {
                walk(&child, skip, out);
            }
        }
    }
    let mut out = Vec::new();
    if path.is_dir() {
        walk(path, skip, &mut out);
    }
    out
}

fn stamps_match(saved: &[(String, u64)], fresh: &[(String, u64)]) -> bool {
    saved.len() == fresh.len()
        && saved.iter().zip(fresh).all(|(left, right)| left.0.eq_ignore_ascii_case(&right.0) && left.1 == right.1)
}

/// The cached size when every directory mtime still matches. Otherwise walk once and remember it.
fn cached_dir_size(data_dir: &Path, path: &Path, skip: &[&str]) -> u64 {
    let key = path.to_string_lossy().into_owned();
    let fresh = dir_stamps(path, skip);
    if let Some(saved) = read_size_cache(data_dir, &key) {
        if stamps_match(&saved.stamps, &fresh) {
            return saved.bytes;
        }
    }
    let bytes = dir_size_except(path, skip);
    write_size_cache(data_dir, &key, &SizeCacheEntry { bytes, stamps: fresh });
    bytes
}

/// Bytes the main checkout, its linked worktrees, and their app data take.
/// A folder that is not a git repo reports no worktrees.
/// Sizes are remembered until a directory inside the folder changes.
pub fn project_removal(target: &GitTarget, data_dir: &Path, app_roots: &[&Path]) -> ProjectRemoval {
    let here = fs::canonicalize(&target.root).unwrap_or_else(|_| target.root.clone());
    let app_managed = app_roots.iter().any(|root| {
        let root_real = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        crate::paths::is_under(&here, &root_real)
            && here.parent().is_some_and(|parent| crate::paths::same_dir(parent, &root_real))
    });
    let listed = git_worktrees(target).unwrap_or_default();
    let linked: Vec<&GitWorktree> = listed.iter().filter(|row| !row.main && !row.bare).collect();
    let main = listed.iter().find(|row| row.main);
    let skip = linked
        .iter()
        .map(|row| {
            fs::canonicalize(&row.path)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| row.path.clone())
        })
        .collect::<Vec<_>>();
    let skip_refs = skip.iter().map(String::as_str).collect::<Vec<_>>();
    let project = main
        .map(|row| cached_dir_size(data_dir, Path::new(&row.path), &skip_refs))
        .unwrap_or_else(|| cached_dir_size(data_dir, &target.root, &skip_refs));
    let mut worktrees = 0u64;
    let mut worktree_sizes = Vec::with_capacity(linked.len());
    let mut app = app_data_size(data_dir, &target.root);
    for row in &linked {
        let bytes = cached_dir_size(data_dir, Path::new(&row.path), &[]);
        worktrees += bytes;
        worktree_sizes.push(WorktreeSize {
            path: row.path.clone(),
            bytes,
        });
        app += app_data_size(data_dir, Path::new(&row.path));
    }
    // External checkouts live together under one app-data folder. Count that once
    // when git has not listed the children yet.
    if linked.is_empty() && !app_managed {
        let home = external_worktree_root(data_dir, &target.root);
        if home.is_dir() {
            worktrees += dir_size(&home);
        }
    }
    ProjectRemoval {
        project,
        worktrees,
        app,
        worktree_count: linked.len() as u32,
        app_managed,
        worktree_sizes,
    }
}

/// Remove every linked worktree and the app data stored for those folders.
/// The main checkout and its branch stay. A dirty worktree is left in place.
pub fn remove_project_worktrees(target: &GitTarget, data_dir: &Path) -> Result<Vec<String>> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "worktrees are only removed for a project on this Mac".into(),
        ));
    }
    let listed = git_worktrees(target)?;
    let mut removed = Vec::new();
    let mut blocked = Vec::new();
    for row in listed.iter().filter(|row| !row.main && !row.bare) {
        match git_run(target, &["worktree", "remove", "--", &row.path]) {
            Ok(_) => {
                let _ = crate::dev::project_location::drop_project_chats(data_dir, &row.path);
                removed.push(row.path.clone());
            }
            Err(_) => blocked.push(row.path.clone()),
        }
    }
    if let Some(main) = listed.iter().find(|row| row.main) {
        let home = external_worktree_root(data_dir, Path::new(&main.path));
        if home.is_dir() {
            let _ = fs::remove_dir_all(&home);
        }
    }
    if removed.is_empty() && !blocked.is_empty() {
        return Err(Error::Other(
            "worktrees still have uncommitted changes, so nothing was removed".into(),
        ));
    }
    Ok(removed)
}

/// Disk space a folder occupies, following the same files `du` would. A missing folder is zero.
fn dir_size(path: &Path) -> u64 {
    dir_size_except(path, &[])
}

/// Like `dir_size`, but a nested path in `skip` is left out. Linked worktrees live inside the
/// main checkout, and their space belongs to the worktree choice, not the project choice.
fn dir_size_except(path: &Path, skip: &[&str]) -> u64 {
    fn walk(path: &Path, skip: &[&str], seen: &mut HashSet<u64>, total: &mut u64) {
        let Ok(meta) = fs::symlink_metadata(path) else {
            return;
        };
        if meta.file_type().is_symlink() {
            return;
        }
        if meta.is_dir() {
            if path.file_name().is_some_and(|name| name == ".git") {
                return;
            }
            let canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            let text = crate::paths::native_source(&canon.to_string_lossy());
            if skip.iter().any(|item| crate::paths::native_source(item).eq_ignore_ascii_case(&text)) {
                return;
            }
        }
        // A second hard link must not be counted twice. Windows has no inode,
        // so the same bytes can be counted again there.
        if let Some(id) = file_identity(&meta) {
            if !seen.insert(id) {
                return;
            }
        }
        *total = total.saturating_add(occupied_bytes(&meta));
        if !meta.is_dir() {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            walk(&entry.path(), skip, seen, total);
        }
    }
    let mut total = 0u64;
    walk(path, skip, &mut HashSet::new(), &mut total);
    total
}

/// Allocated blocks on Unix. The file length elsewhere, which is what Windows metadata can report.
fn occupied_bytes(meta: &fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.blocks().saturating_mul(512)
    }
    #[cfg(not(unix))]
    {
        meta.len()
    }
}

/// An inode when this file has another hard link. `None` means count it every time it is seen.
fn file_identity(meta: &fs::Metadata) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            Some(meta.ino())
        } else {
            None
        }
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

fn app_data_size(data_dir: &Path, workspace: &Path) -> u64 {
    let id = crate::dev::paths::workspace_id(&crate::paths::native_source(&workspace.to_string_lossy()));
    dir_size(&data_dir.join("dev").join(id))
}

/// Remove a linked worktree. Refuses the main checkout, the open folder, and a dirty tree.
pub fn git_worktree_remove(target: &GitTarget, path: &str) -> Result<Vec<GitWorktree>> {
    if target.remote.is_some() {
        return Err(Error::Other(
            "worktrees are only removed for a project on this Mac".into(),
        ));
    }
    let listed = git_worktrees(target)?;
    let Some(row) = listed.iter().find(|row| same_checkout(&row.path, Path::new(path))) else {
        return Err(Error::Other("that worktree is not in this repository".into()));
    };
    if row.main {
        return Err(Error::Other("the main checkout cannot be removed".into()));
    }
    if same_checkout(&row.path, &target.root) {
        return Err(Error::Other("switch away from this worktree before removing it".into()));
    }
    let remove_path = row.path.clone();
    git_run(target, &["worktree", "remove", "--", &remove_path])?;
    git_worktrees(target)
}

