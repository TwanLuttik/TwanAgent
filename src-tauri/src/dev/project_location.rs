use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::paths::{home_dir, path_string, workspace_id};
use crate::error::Result;
use crate::paths::same_dir;

const LOCATION_FILE: &str = "projects-location.json";
const LOCATION_VERSION: u32 = 1;

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
        moves: moves_of(&load_file(data_dir)),
    }
}

pub fn migrate(data_dir: &Path, new_root: &Path) -> Result<ProjectsLocation> {
    fs::create_dir_all(new_root)?;
    let new_root = canonical_dir(new_root);
    let legacy = data_dir.join("projects");
    let mut file = load_file(data_dir);
    file.version = LOCATION_VERSION;
    file.root = path_string(&new_root);

    let mut remember = Vec::new();
    if legacy.is_dir() && !same_dir(&legacy, &new_root) {
        for name in child_dir_names(&legacy) {
            match migrate_child(data_dir, &legacy, &new_root, &name, &mut file) {
                Ok(Some(path)) => remember.push(path),
                Ok(None) => {}
                Err(err) => eprintln!("left project {name} in place: {err}"),
            }
        }
    }
    heal_moved_projects(data_dir, &legacy, &new_root, &mut file);
    for name in child_dir_names(&new_root) {
        let path = new_root.join(name);
        if path.is_dir() {
            remember.push(path);
        }
    }
    save_file(data_dir, &file)?;
    let _ = crate::usage::replace_workspace_paths(data_dir, &move_pairs(&file));
    let _ = crate::workspace::remember_roots(data_dir, &new_root, &remember);
    Ok(published_location(
        data_dir,
        &new_root,
        &canonical_dir(&legacy),
    ))
}

pub fn forget_project(data_dir: &Path, path: &str) -> Vec<String> {
    let mut file = load_file(data_dir);
    let key = path_key(path);
    let mut related = vec![path.to_string()];
    file.projects.retain(|project| {
        let hit = path_key(&project.path) == key
            || project
                .previous_paths
                .iter()
                .any(|prev| path_key(prev) == key);
        if hit {
            related.push(project.path.clone());
            related.extend(project.previous_paths.iter().cloned());
        }
        !hit
    });
    let _ = save_file(data_dir, &file);
    related
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
    file: &mut LocationFile,
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
        remember_move(file, name, &to, from);
    }
    Ok(Some(dest))
}

fn heal_moved_projects(data_dir: &Path, legacy: &Path, new_root: &Path, file: &mut LocationFile) {
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
            remember_move(file, &name, &to, &from);
        }
    }
}

fn remember_move(file: &mut LocationFile, name: &str, to: &str, from: &str) {
    if path_key(from) == path_key(to) {
        return;
    }
    if let Some(row) = file.projects.iter_mut().find(|project| {
        path_key(&project.path) == path_key(to)
            || project
                .previous_paths
                .iter()
                .any(|prev| path_key(prev) == path_key(from))
    }) {
        row.name = name.to_string();
        row.path = to.to_string();
        if !row
            .previous_paths
            .iter()
            .any(|prev| path_key(prev) == path_key(from))
        {
            row.previous_paths.push(from.to_string());
        }
        return;
    }
    file.projects.push(TrackedProject {
        name: name.to_string(),
        path: to.to_string(),
        previous_paths: vec![from.to_string()],
    });
}

fn store_aliases(data_dir: &Path, workspace: &str) -> Vec<(String, bool)> {
    let key = path_key(workspace);
    let mut out = Vec::new();
    for project in load_file(data_dir).projects {
        if path_key(&project.path) == key {
            for prev in project.previous_paths {
                out.push((prev, true));
            }
        } else if project
            .previous_paths
            .iter()
            .any(|prev| path_key(prev) == key)
        {
            out.push((project.path, false));
        }
    }
    out
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

fn moves_of(file: &LocationFile) -> Vec<ProjectPathMove> {
    let mut moves = Vec::new();
    for project in &file.projects {
        for from in &project.previous_paths {
            if path_key(from) == path_key(&project.path) {
                continue;
            }
            moves.push(ProjectPathMove {
                from: from.clone(),
                to: project.path.clone(),
            });
        }
    }
    moves
}

fn move_pairs(file: &LocationFile) -> Vec<(String, String)> {
    moves_of(file)
        .into_iter()
        .map(|item| (item.from, item.to))
        .collect()
}

fn location_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LOCATION_FILE)
}

fn load_file(data_dir: &Path) -> LocationFile {
    let Ok(raw) = fs::read_to_string(location_path(data_dir)) else {
        return LocationFile::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_file(data_dir: &Path, file: &LocationFile) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join("projects-location.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(file)?)?;
    #[cfg(windows)]
    {
        let dest = location_path(data_dir);
        if dest.exists() {
            fs::remove_file(&dest)?;
        }
    }
    fs::rename(tmp, location_path(data_dir))?;
    Ok(())
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
