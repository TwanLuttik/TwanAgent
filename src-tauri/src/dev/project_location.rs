use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::paths::{home_dir, path_string, workspace_id};
use crate::error::Result;
use crate::paths::same_dir;

const LOCATION_FILE: &str = "projects-location.json";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectPathMove {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectsLocation {
    pub root: String,
    pub legacy_root: String,
    pub moves: Vec<ProjectPathMove>,
}

#[derive(Debug, Clone)]
pub struct PreparedLocation {
    pub root: PathBuf,
    pub legacy: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LocationFile {
    version: u32,
    root: String,
    #[serde(default)]
    projects: Vec<TrackedProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrackedProject {
    name: String,
    path: String,
    #[serde(default)]
    previous_paths: Vec<String>,
}

pub fn user_projects_root(data_dir: &Path) -> PathBuf {
    // Debug builds use a sibling folder so project files stay out of the release tree.
    let folder = if cfg!(debug_assertions) {
        "twanagent-dev"
    } else {
        "twanagent"
    };
    match home_dir() {
        Some(home) => home.join(folder).join("projects"),
        None => data_dir.join("projects"),
    }
}

pub fn prepare(data_dir: &Path) -> PreparedLocation {
    let legacy = canonical_dir(&data_dir.join("projects"));
    let preferred = user_projects_root(data_dir);
    if fs::create_dir_all(&preferred).is_err() {
        let _ = fs::create_dir_all(&legacy);
        return PreparedLocation {
            root: legacy.clone(),
            legacy,
        };
    }
    let root = canonical_dir(&preferred);
    if let Err(err) = migrate(data_dir, &root) {
        eprintln!("project location migration failed: {err}");
    }
    PreparedLocation { root, legacy }
}

pub fn published_location(data_dir: &Path, root: &Path, legacy: &Path) -> ProjectsLocation {
    ProjectsLocation {
        root: path_string(root),
        legacy_root: path_string(legacy),
        moves: load_moves(data_dir)
            .into_iter()
            .map(|(from, to)| ProjectPathMove { from, to })
            .collect(),
    }
}

pub fn migrate(data_dir: &Path, new_root: &Path) -> Result<ProjectsLocation> {
    fs::create_dir_all(new_root)?;
    let new_root = canonical_dir(new_root);
    let legacy = data_dir.join("projects");
    import_location_json(data_dir);

    let mut remember = Vec::new();
    if legacy.is_dir() && !same_dir(&legacy, &new_root) {
        for name in child_dir_names(&legacy) {
            match migrate_child(data_dir, &legacy, &new_root, &name) {
                Ok(Some(path)) => remember.push(path),
                Ok(None) => {}
                Err(err) => eprintln!("left project {name} in place: {err}"),
            }
        }
    }
    heal_moved_projects(data_dir, &legacy, &new_root);
    for name in child_dir_names(&new_root) {
        let path = new_root.join(name);
        if path.is_dir() {
            remember.push(path);
        }
    }
    let _ = crate::usage::replace_workspace_paths(data_dir, &load_moves(data_dir));
    let _ = crate::workspace::remember_roots(data_dir, &new_root, &remember);
    Ok(published_location(
        data_dir,
        &new_root,
        &canonical_dir(&legacy),
    ))
}

/// Delete the chat database, the sidebar copy, and usage rows for one folder.
/// A removed worktree must not bring its conversations back when the folder is created again.
pub fn drop_project_chats(data_dir: &Path, path: &str) -> Result<()> {
    let related = forget_project(data_dir, path);
    for item in &related {
        let _ = fs::remove_dir_all(conv_dir(data_dir, item));
    }
    if let Ok(conn) = crate::appdb::open(data_dir) {
        for item in &related {
            let _ = crate::appdb::remove_project(&conn, item);
            // The sidebar copy is keyed by the path, not by a saved project row.
            // A worktree has no project row, so removing the project alone leaves its chats.
            let _ = crate::appdb::clear_sidebar(&conn, item);
        }
    }
    let _ = crate::usage::forget_workspace_paths(data_dir, &related);
    Ok(())
}

pub fn forget_project(data_dir: &Path, path: &str) -> Vec<String> {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return vec![path.to_string()];
    };
    crate::appdb::forget_project_paths(&conn, path).unwrap_or_else(|_| vec![path.to_string()])
}

pub fn resolve_conv_dir(data_dir: &Path, workspace: &str) -> PathBuf {
    let primary = conv_dir(data_dir, workspace);
    if store_present(&primary) {
        return primary;
    }
    for (alias, adopt) in store_aliases(data_dir, workspace) {
        let dir = conv_dir(data_dir, &alias);
        if !store_present(&dir) {
            continue;
        }
        if adopt
            && !primary.exists()
            && fs::rename(&dir, &primary).is_ok()
            && store_present(&primary)
        {
            return primary;
        }
        return dir;
    }
    primary
}

fn migrate_child(
    data_dir: &Path,
    legacy: &Path,
    new_root: &Path,
    name: &str,
) -> Result<Option<PathBuf>> {
    let src = legacy.join(name);
    let dest = new_root.join(name);
    if same_dir(&src, &dest) {
        return Ok(None);
    }
    if dest.exists() {
        let kept = [src];
        let _ = crate::workspace::remember_roots(data_dir, new_root, &kept);
        return Ok(None);
    }
    let froms = candidate_paths(&src);
    move_dir(&src, &dest)?;
    let to = display_path(&dest);
    for from in &froms {
        relocate_store(data_dir, from, &to);
        remember_move(data_dir, name, &to, from);
    }
    Ok(Some(dest))
}

fn heal_moved_projects(data_dir: &Path, legacy: &Path, new_root: &Path) {
    if same_dir(legacy, new_root) {
        return;
    }
    for name in child_dir_names(new_root) {
        let src = legacy.join(&name);
        if src.exists() {
            continue;
        }
        let dest = new_root.join(&name);
        let to = display_path(&dest);
        for from in candidate_paths(&src) {
            let old_store = conv_dir(data_dir, &from);
            let new_store = conv_dir(data_dir, &to);
            if !store_present(&old_store) || store_present(&new_store) {
                continue;
            }
            relocate_store(data_dir, &from, &to);
            remember_move(data_dir, &name, &to, &from);
        }
    }
}

fn remember_move(data_dir: &Path, name: &str, to: &str, from: &str) {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    let _ = crate::appdb::remember_project_move(&conn, name, to, from);
}

fn store_aliases(data_dir: &Path, workspace: &str) -> Vec<(String, bool)> {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return Vec::new();
    };
    let Ok(previous) = crate::appdb::previous_paths_for(&conn, workspace) else {
        return Vec::new();
    };
    let key = path_key(workspace);
    previous
        .into_iter()
        .map(|path| {
            let adopt = path_key(&path) != key;
            (path, adopt)
        })
        .collect()
}

/// Point chats, the sidebar cache, and usage at a worktree after its folder moves.
pub fn relocate_project_records(data_dir: &Path, from: &str, to: &str) -> Result<()> {
    if path_key(from) == path_key(to) {
        return Ok(());
    }
    relocate_store(data_dir, from, to);
    let name = Path::new(to)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "worktree".into());
    remember_move(data_dir, &name, to, from);
    if let Ok(conn) = crate::appdb::open(data_dir) {
        let _ = crate::appdb::rename_project_path(&conn, from, to);
    }
    let _ = crate::usage::replace_workspace_paths(data_dir, &[(from.to_string(), to.to_string())]);
    Ok(())
}

fn relocate_store(data_dir: &Path, from: &str, to: &str) {
    if path_key(from) == path_key(to) {
        return;
    }
    let src = conv_dir(data_dir, from);
    let dest = conv_dir(data_dir, to);
    if !src.exists() || src == dest {
        return;
    }
    if !dest.exists() {
        let _ = fs::rename(&src, &dest);
        return;
    }
    if store_present(&dest) || !store_present(&src) {
        return;
    }
    if fs::remove_dir_all(&dest).is_ok() {
        let _ = fs::rename(&src, &dest);
    }
}

fn conv_dir(data_dir: &Path, workspace: &str) -> PathBuf {
    data_dir.join("dev").join(workspace_id(workspace))
}

fn store_present(dir: &Path) -> bool {
    dir.join("store.db").is_file()
        || dir.join("conversations.json").is_file()
        || dir.join("journeys").is_dir()
}

fn move_dir(src: &Path, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(err) if is_cross_device(&err) => {
            if let Err(copy_err) = copy_dir_all(src, dest) {
                let _ = fs::remove_dir_all(dest);
                return Err(copy_err.into());
            }
            fs::remove_dir_all(src)?;
            Ok(())
        }
        Err(err) => Err(err.into()),
    }
}

fn is_cross_device(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::CrossesDevices || err.raw_os_error() == Some(18)
}

fn copy_dir_all(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

fn child_dir_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "." || name == ".." {
            continue;
        }
        names.push(name);
    }
    names.sort();
    names
}

fn candidate_paths(path: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<String>, value: String| {
        if !out.iter().any(|item| path_key(item) == path_key(&value)) {
            out.push(value);
        }
    };
    if path.exists() {
        push(&mut out, display_path(path));
    }
    push(&mut out, path_string(path));
    if let Some(parent) = path.parent() {
        if let (Ok(parent), Some(name)) = (fs::canonicalize(parent), path.file_name()) {
            push(&mut out, path_string(&parent.join(name)));
        }
    }
    out
}

fn display_path(path: &Path) -> String {
    match fs::canonicalize(path) {
        Ok(canon) => path_string(&canon),
        Err(_) => path_string(path),
    }
}

fn canonical_dir(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_key(path: &str) -> String {
    crate::paths::native_source(path).to_ascii_lowercase()
}

fn load_moves(data_dir: &Path) -> Vec<(String, String)> {
    crate::appdb::open(data_dir)
        .and_then(|conn| crate::appdb::project_path_moves(&conn))
        .unwrap_or_default()
}

fn location_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LOCATION_FILE)
}

/// Copy `projects-location.json` into `app.db` once, then remove the file.
fn import_location_json(data_dir: &Path) {
    let path = location_path(data_dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let file: LocationFile = serde_json::from_str(&raw).unwrap_or_default();
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return;
    };
    let mut copied = true;
    for project in &file.projects {
        for from in &project.previous_paths {
            if crate::appdb::remember_project_move(&conn, &project.name, &project.path, from).is_err() {
                copied = false;
            }
        }
    }
    if copied {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(data_dir.join("projects-location.json.tmp"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::conv::load_conversations;
    use std::fs;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_legacy_conv(data: &Path, project: &Path, body: &str) {
        let path = display_path(project);
        let file = conv_dir(data, &path).join("conversations.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, body).unwrap();
    }

    #[test]
    fn dev_projects_root_does_not_use_the_release_folder() {
        let prev = std::env::var_os("HOME");
        let home = temp_dir();
        unsafe { std::env::set_var("HOME", home.path()) };
        let root = user_projects_root(Path::new("/unused"));
        let expected = if cfg!(debug_assertions) {
            home.path().join("twanagent-dev/projects")
        } else {
            home.path().join("twanagent/projects")
        };
        assert_eq!(root, expected);
        if cfg!(debug_assertions) {
            assert_ne!(root, home.path().join("twanagent/projects"));
        }
        match prev {
            Some(value) => unsafe { std::env::set_var("HOME", value) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }

    #[test]
    fn migrate_moves_the_folder_and_keeps_conversations() {
        let data = temp_dir();
        let dest = temp_dir();
        let legacy = data.path().join("projects/Demo");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("README.md"), "hi").unwrap();
        write_legacy_conv(
            data.path(),
            &legacy,
            r#"[{"id":"c1","title":"Kept","created_at":"t","updated_at":"t","messages":[]}]"#,
        );
        let old = display_path(&legacy);
        fs::write(
            data.path().join("opened-workspaces.json"),
            serde_json::to_vec(&vec![old.clone()]).unwrap(),
        )
        .unwrap();
        crate::usage::record(
            data.path(),
            crate::usage::UsageRecord {
                workspace_path: old.clone(),
                workspace_name: "Demo".into(),
                conversation_id: "c1".into(),
                conversation_title: "Kept".into(),
                model: "grok".into(),
                prompt_tokens: 3,
                completion_tokens: 1,
                total_tokens: 4,
                duration_ms: None,
            },
        )
        .unwrap();

        let location = migrate(data.path(), dest.path()).unwrap();
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(dest.path().join("Demo/README.md")).unwrap(),
            "hi"
        );
        let moved = location
            .moves
            .iter()
            .find(|item| path_key(&item.from) == path_key(&old))
            .unwrap();
        let loaded = load_conversations(data.path(), &moved.to).unwrap();
        assert_eq!(loaded[0].title, "Kept");
        let loaded_old = load_conversations(data.path(), &old).unwrap();
        assert_eq!(loaded_old[0].title, "Kept");

        let opened: Vec<String> = serde_json::from_str(
            &fs::read_to_string(data.path().join("opened-workspaces.json")).unwrap(),
        )
        .unwrap();
        assert!(opened
            .iter()
            .any(|path| path_key(path) == path_key(&moved.to)));
        assert!(!opened.iter().any(|path| path_key(path) == path_key(&old)));
        let usage = crate::usage::list_since(data.path(), None).unwrap();
        assert_eq!(usage[0].workspace_path, moved.to);

        assert!(
            !data.path().join("projects-location.json").exists(),
            "the location json should be imported into app.db"
        );
        let again = migrate(data.path(), dest.path()).unwrap();
        assert!(again
            .moves
            .iter()
            .any(|item| path_key(&item.from) == path_key(&old)));
        assert_eq!(
            load_conversations(data.path(), &moved.to).unwrap()[0].title,
            "Kept"
        );
    }

    #[test]
    fn migrate_leaves_a_project_when_the_destination_exists() {
        let data = temp_dir();
        let dest = temp_dir();
        let legacy = data.path().join("projects/Demo");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("old.txt"), "old").unwrap();
        let existing = dest.path().join("Demo");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("keep.txt"), "new").unwrap();

        let location = migrate(data.path(), dest.path()).unwrap();
        assert_eq!(fs::read_to_string(legacy.join("old.txt")).unwrap(), "old");
        assert_eq!(
            fs::read_to_string(existing.join("keep.txt")).unwrap(),
            "new"
        );
        assert!(location.moves.is_empty());
    }

    #[test]
    fn migrate_heals_a_folder_moved_before_its_conversations() {
        let data = temp_dir();
        let dest = temp_dir();
        let legacy = data.path().join("projects/Demo");
        fs::create_dir_all(&legacy).unwrap();
        write_legacy_conv(
            data.path(),
            &legacy,
            r#"[{"id":"c1","title":"Healed","created_at":"t","updated_at":"t","messages":[]}]"#,
        );
        let old = display_path(&legacy);
        let dest_project = dest.path().join("Demo");
        fs::create_dir_all(dest.path()).unwrap();
        fs::rename(&legacy, &dest_project).unwrap();

        let location = migrate(data.path(), dest.path()).unwrap();
        assert!(location
            .moves
            .iter()
            .any(|item| path_key(&item.from) == path_key(&old)));
        let loaded = load_conversations(data.path(), &display_path(&dest_project)).unwrap();
        assert_eq!(loaded[0].title, "Healed");
    }

    #[test]
    fn relocate_project_records_keeps_the_chats_under_the_new_path() {
        let data = temp_dir();
        let from = temp_dir();
        let to = temp_dir();
        write_legacy_conv(
            data.path(),
            from.path(),
            r#"[{"id":"c1","title":"Moved","created_at":"t","updated_at":"t","messages":[]}]"#,
        );
        let old = display_path(from.path());
        let next = display_path(to.path());
        let conn = crate::appdb::open(data.path()).unwrap();
        crate::appdb::add_project(&conn, from.path()).unwrap();
        drop(conn);
        crate::usage::record(
            data.path(),
            crate::usage::UsageRecord {
                workspace_path: old.clone(),
                workspace_name: "wip".into(),
                conversation_id: "c1".into(),
                conversation_title: "Moved".into(),
                model: "grok".into(),
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3,
                duration_ms: None,
            },
        )
        .unwrap();
        relocate_project_records(data.path(), &old, &next).unwrap();
        assert_eq!(load_conversations(data.path(), &next).unwrap()[0].title, "Moved");
        assert_eq!(load_conversations(data.path(), &old).unwrap()[0].title, "Moved");
        let conn = crate::appdb::open(data.path()).unwrap();
        let rows = crate::appdb::list_projects(&conn).unwrap();
        assert!(rows.iter().any(|row| path_key(&row.path) == path_key(&next)));
        assert!(!rows.iter().any(|row| path_key(&row.path) == path_key(&old)));
        let usage = crate::usage::list_since(data.path(), None).unwrap();
        assert_eq!(usage[0].workspace_path, next);
    }

    #[test]
    fn drop_project_chats_removes_the_store_the_sidebar_and_usage() {
        let data = temp_dir();
        let project = temp_dir();
        write_legacy_conv(
            data.path(),
            project.path(),
            r#"[{"id":"c1","title":"Gone","created_at":"t","updated_at":"t","messages":[]}]"#,
        );
        let path = display_path(project.path());
        let conn = crate::appdb::open(data.path()).unwrap();
        crate::appdb::add_project(&conn, project.path()).unwrap();
        let chat = crate::dev::ConversationSummary {
            id: "c1".into(),
            title: "Gone".into(),
            created_at: "t".into(),
            updated_at: "t".into(),
            kind: "chat".into(),
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        };
        crate::appdb::replace_sidebar(&conn, &path, &[chat.clone()], &[]).unwrap();
        // The sidebar reads a second copy stored under the lowercased path, with no project row.
        // That is the copy a deleted worktree kept showing.
        crate::appdb::replace_sidebar(&conn, &path.to_ascii_lowercase(), &[chat], &[]).unwrap();
        drop(conn);
        crate::usage::record(
            data.path(),
            crate::usage::UsageRecord {
                workspace_path: path.clone(),
                workspace_name: "pr-5".into(),
                conversation_id: "c1".into(),
                conversation_title: "Gone".into(),
                model: "grok".into(),
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3,
                duration_ms: None,
            },
        )
        .unwrap();
        drop_project_chats(data.path(), &path).unwrap();
        assert!(load_conversations(data.path(), &path).unwrap().is_empty());
        let conn = crate::appdb::open(data.path()).unwrap();
        assert!(crate::appdb::sidebar_for(&conn, &path).unwrap().0.is_empty());
        assert!(crate::appdb::sidebar_for(&conn, &path.to_ascii_lowercase()).unwrap().0.is_empty());
        assert!(!crate::appdb::sidebar_cached(&conn, &path).unwrap());
        assert!(!crate::appdb::sidebar_cached(&conn, &path.to_ascii_lowercase()).unwrap());
        assert!(crate::appdb::list_projects(&conn).unwrap().is_empty());
        assert!(crate::usage::list_since(data.path(), None).unwrap().is_empty());
    }

    #[test]
    fn forget_project_drops_the_tracked_path() {
        let data = temp_dir();
        let dest = temp_dir();
        let legacy = data.path().join("projects/Demo");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("README.md"), "hi").unwrap();
        migrate(data.path(), dest.path()).unwrap();
        let current = display_path(&dest.path().join("Demo"));
        let related = forget_project(data.path(), &current);
        assert!(related
            .iter()
            .any(|path| path_key(path) == path_key(&current)));
        assert!(
            published_location(data.path(), dest.path(), &data.path().join("projects"))
                .moves
                .is_empty()
        );
    }
}
