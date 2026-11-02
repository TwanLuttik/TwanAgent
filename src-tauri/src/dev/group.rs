//! A project group is a folder of links plus rows in `app.db`.
//!
//! Member folders stay where they are. File tools do not trust the link.
//! They trust the membership row, then reuse the single-folder checks inside that member.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::paths::path_string;
use super::projects::sanitize_project_name;
use crate::error::{Error, Result};
use crate::paths::{is_under, same_dir};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMember {
    pub alias: String,
    pub path: PathBuf,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupLayout {
    pub root: PathBuf,
    pub name: String,
    pub members: Vec<GroupMember>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupPath {
    Root,
    Member {
        alias: String,
        root: PathBuf,
        rest: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupMemberRow {
    pub path: String,
    pub alias: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupRow {
    pub path: String,
    pub name: String,
    pub members: Vec<GroupMemberRow>,
}

/// What a relative path means inside a group. `None` when `workspace` is not a group.
pub enum GroupHit {
    Root(GroupLayout),
    Member {
        root: PathBuf,
        rel: String,
        alias: String,
    },
}

struct Slot {
    data_dir_key: String,
    layout: GroupLayout,
}

fn cache() -> &'static Mutex<HashMap<String, Slot>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, Slot>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_cache() -> std::sync::MutexGuard<'static, HashMap<String, Slot>> {
    cache().lock().unwrap_or_else(|err| err.into_inner())
}

fn path_key(path: &str) -> String {
    crate::paths::native_source(path).to_ascii_lowercase()
}

fn data_key(data_dir: &Path) -> String {
    path_key(&path_string(data_dir))
}

fn canonical_dir(path: &Path) -> Result<PathBuf> {
    let canon = fs::canonicalize(path).map_err(|_| Error::Other("folder is missing".into()))?;
    if !canon.is_dir() {
        return Err(Error::Other("not a folder".into()));
    }
    Ok(canon)
}

pub fn layout(root: &Path) -> Option<GroupLayout> {
    let key = fs::canonicalize(root).ok().map(|path| path_key(&path_string(&path)))?;
    lock_cache().get(&key).map(|slot| slot.layout.clone())
}

pub fn hit(workspace: &Path, rel: &str) -> Result<Option<GroupHit>> {
    let Some(layout) = layout(workspace) else {
        return Ok(None);
    };
    match layout.split(rel)? {
        GroupPath::Root => Ok(Some(GroupHit::Root(layout))),
        GroupPath::Member { alias, root, rest } => Ok(Some(GroupHit::Member {
            root,
            rel: rest,
            alias,
        })),
    }
}

/// Both paths must stay inside one member. The returned strings are relative to that member.
pub fn same_member(layout: &GroupLayout, from: &str, to: &str) -> Result<(PathBuf, String, String, String)> {
    let from_hit = layout.split(from)?;
    let to_hit = layout.split(to)?;
    match (from_hit, to_hit) {
        (
            GroupPath::Member {
                alias: from_alias,
                root,
                rest: from_rest,
            },
            GroupPath::Member {
                alias: to_alias,
                rest: to_rest,
                ..
            },
        ) => {
            if !from_alias.eq_ignore_ascii_case(&to_alias) {
                return Err(Error::Other(
                    "cannot move a file into another repository".into(),
                ));
            }
            if from_rest.is_empty() || to_rest.is_empty() {
                return Err(Error::Other("cannot move a repository".into()));
            }
            Ok((root, from_rest, to_rest, from_alias))
        }
        _ => Err(Error::Other(
            "path must be inside a repository in the group".into(),
        )),
    }
}

impl GroupLayout {
    pub fn split(&self, rel: &str) -> Result<GroupPath> {
        let rel = lexical_rel(rel)?;
        if rel.is_empty() {
            return Ok(GroupPath::Root);
        }
        let (alias, rest) = match rel.split_once('/') {
            Some((alias, rest)) => (alias, rest.to_string()),
            None => (rel.as_str(), String::new()),
        };
        let member = self
            .members
            .iter()
            .find(|member| member.alias.eq_ignore_ascii_case(alias))
            .ok_or_else(|| Error::Other("path is outside the workspace".into()))?;
        Ok(GroupPath::Member {
            alias: member.alias.clone(),
            root: member.path.clone(),
            rest,
        })
    }
}

fn lexical_rel(rel: &str) -> Result<String> {
    if rel.contains('\0') {
        return Err(Error::Other("invalid path".into()));
    }
    let trimmed = rel.trim().trim_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed == "." {
        return Ok(String::new());
    }
    if trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || Path::new(trimmed).is_absolute()
        || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':')
    {
        return Err(Error::Other(
            "path must be relative to the workspace".into(),
        ));
    }
    let mut parts = Vec::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err(Error::Other("path is outside the workspace".into()));
                }
            }
            _ => {
                return Err(Error::Other(
                    "path must be relative to the workspace".into(),
                ))
            }
        }
    }
    Ok(parts.join("/"))
}

pub fn load(data_dir: &Path) -> Result<()> {
    let rows = read_groups(data_dir)?;
    let key = data_key(data_dir);
    let mut cache = lock_cache();
    cache.retain(|_, slot| slot.data_dir_key != key);
    for layout in rows {
        cache.insert(
            path_key(&path_string(&layout.root)),
            Slot {
                data_dir_key: key.clone(),
                layout,
            },
        );
    }
    Ok(())
}

fn remember(data_dir: &Path, layout: &GroupLayout) {
    let mut cache = lock_cache();
    cache.insert(
        path_key(&path_string(&layout.root)),
        Slot {
            data_dir_key: data_key(data_dir),
            layout: layout.clone(),
        },
    );
}

fn forget_cached(root: &Path) {
    if let Ok(canon) = fs::canonicalize(root) {
        lock_cache().remove(&path_key(&path_string(&canon)));
    }
}

pub fn list_groups(data_dir: &Path) -> Result<Vec<GroupRow>> {
    let conn = crate::appdb::open(data_dir)?;
    let layouts = layouts_from(&conn)?;
    Ok(layouts.into_iter().map(row_from_layout).collect())
}

pub fn create_group(data_dir: &Path, projects_root: &Path, name: &str, paths: &[PathBuf]) -> Result<GroupRow> {
    if paths.len() < 2 {
        return Err(Error::Other("pick at least two projects".into()));
    }
    let name = sanitize_project_name(name)?;
    let mut canon = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let folder = canonical_dir(path)?;
        let key = path_key(&path_string(&folder));
        if !seen.insert(key) {
            return Err(Error::Other("pick different folders".into()));
        }
        canon.push(folder);
    }
    for (index, path) in canon.iter().enumerate() {
        for other in canon.iter().skip(index + 1) {
            if is_under(path, other) || is_under(other, path) {
                return Err(Error::Other("one folder is inside another".into()));
            }
        }
    }
    fs::create_dir_all(projects_root)?;
    let dest = projects_root.join(&name);
    if dest.exists() {
        return Err(Error::Conflict(format!("{name} already exists")));
    }
    for path in &canon {
        if same_dir(&dest, path) || is_under(&dest, path) || is_under(path, &dest) {
            return Err(Error::Other("the group folder would overlap a project".into()));
        }
    }
    fs::create_dir(&dest)?;
    let built = (|| -> Result<GroupLayout> {
        let conn = crate::appdb::open(data_dir)?;
        for path in &canon {
            if find_group_path(&conn, path)?.is_some() {
                return Err(Error::Other("a group cannot contain another group".into()));
            }
            if find_member_group(&conn, path)?.is_some() {
                return Err(Error::Other("already in a group".into()));
            }
        }
        let root = canonical_dir(&dest)?;
        crate::appdb::add_project(&conn, &root)?;
        let stored = path_string(&root);
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO project_groups (path, name, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![stored, name, now_iso()],
        )?;
        let mut used = HashSet::new();
        let mut members = Vec::new();
        for (position, path) in canon.iter().enumerate() {
            let alias = next_alias(&folder_name(path), &mut used);
            let member_path = path_string(path);
            let member_name = project_name(&tx, path);
            tx.execute(
                "INSERT INTO project_group_members (group_path, project_path, alias, position)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![stored, member_path, alias, position as i64],
            )?;
            members.push(GroupMember {
                alias,
                path: path.clone(),
                name: member_name,
            });
        }
        tx.commit()?;
        Ok(GroupLayout {
            root,
            name,
            members,
        })
    })();
    let layout = match built {
        Ok(layout) => layout,
        Err(err) => {
            let _ = remove_group_dir(&dest);
            let _ = remove_db_group(data_dir, &dest);
            return Err(err);
        }
    };
    if let Err(err) = repair_links(&layout) {
        let _ = delete_group(data_dir, &layout.root);
        return Err(err);
    }
    remember(data_dir, &layout);
    Ok(row_from_layout(layout))
}

pub fn add_member(data_dir: &Path, group: &Path, path: &Path) -> Result<GroupMemberRow> {
    let root = canonical_dir(group)?;
    let folder = canonical_dir(path)?;
    let conn = crate::appdb::open(data_dir)?;
    let Some(stored_group) = find_group_path(&conn, &root)? else {
        return Err(Error::Other("not a group".into()));
    };
    if find_group_path(&conn, &folder)?.is_some() {
        return Err(Error::Other("a group cannot contain another group".into()));
    }
    if find_member_group(&conn, &folder)?.is_some() {
        return Err(Error::Other("already in a group".into()));
    }
    let existing = members_of(&conn, &stored_group)?;
    for member in &existing {
        let member_path = PathBuf::from(&member.path);
        if is_under(&folder, &member_path) || is_under(&member_path, &folder) || same_dir(&folder, &member_path) {
            return Err(Error::Other("one folder is inside another".into()));
        }
    }
    if is_under(&root, &folder) || is_under(&folder, &root) {
        return Err(Error::Other("the group folder would overlap a project".into()));
    }
    let mut used: HashSet<String> = existing.iter().map(|member| member.alias.clone()).collect();
    let alias = next_alias(&folder_name(&folder), &mut used);
    let position = existing.len() as i64;
    let member_path = path_string(&folder);
    let member_name = project_name(&conn, &folder);
    conn.execute(
        "INSERT INTO project_group_members (group_path, project_path, alias, position)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![stored_group, member_path, alias, position],
    )?;
    let _ = crate::appdb::add_project(&conn, &folder);
    let layout = reload_one(data_dir, &root)?;
    repair_links(&layout)?;
    remember(data_dir, &layout);
    Ok(GroupMemberRow {
        path: member_path,
        alias,
        name: member_name,
    })
}

pub fn remove_member(data_dir: &Path, group: &Path, path: &Path) -> Result<()> {
    let root = canonical_dir(group)?;
    let folder = canonical_dir(path)?;
    let conn = crate::appdb::open(data_dir)?;
    let Some(stored_group) = find_group_path(&conn, &root)? else {
        return Err(Error::Other("not a group".into()));
    };
    let existing = members_of(&conn, &stored_group)?;
    if existing.len() <= 2 {
        return Err(Error::Other(
            "a group needs at least two projects. Remove the group instead.".into(),
        ));
    }
    let key = path_key(&path_string(&folder));
    let Some(member) = existing.iter().find(|member| path_key(&member.path) == key) else {
        return Err(Error::Other("that project is not in this group".into()));
    };
    let link = root.join(&member.alias);
    if link.symlink_metadata().is_ok() {
        remove_entry_nofollow(&link)?;
    }
    conn.execute(
        "DELETE FROM project_group_members
         WHERE group_path = ?1
           AND lower(rtrim(replace(project_path, '\\', '/'), '/')) = lower(rtrim(replace(?2, '\\', '/'), '/'))",
        rusqlite::params![stored_group, path_key(&path_string(&folder))],
    )?;
    let layout = reload_one(data_dir, &root)?;
    remember(data_dir, &layout);
    Ok(())
}

pub fn delete_group(data_dir: &Path, group: &Path) -> Result<()> {
    let conn = crate::appdb::open(data_dir)?;
    let root = fs::canonicalize(group).unwrap_or_else(|_| group.to_path_buf());
    let stored = find_group_path(&conn, &root)?.or_else(|| {
        group
            .exists()
            .then(|| path_string(&root))
            .filter(|path| !path.is_empty())
    });
    if root.exists() {
        remove_group_dir(&root)?;
    }
    if let Some(stored) = stored.as_deref() {
        let _ = fs::remove_dir_all(super::conv::conv_store_dir(data_dir, stored));
        conn.execute("DELETE FROM project_groups WHERE path = ?1", [stored])?;
        let _ = crate::appdb::remove_project(&conn, stored);
        let _ = crate::appdb::clear_sidebar(&conn, stored);
    }
    forget_cached(&root);
    Ok(())
}

pub fn is_group(data_dir: &Path, path: &str) -> bool {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return false;
    };
    let Ok(folder) = fs::canonicalize(path) else {
        return find_group_path(&conn, Path::new(path)).ok().flatten().is_some();
    };
    find_group_path(&conn, &folder).ok().flatten().is_some()
}

pub fn member_of(data_dir: &Path, path: &str) -> Option<String> {
    let conn = crate::appdb::open(data_dir).ok()?;
    let folder = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    find_member_group(&conn, &folder).ok().flatten()
}

pub fn repair_links(layout: &GroupLayout) -> Result<()> {
    fs::create_dir_all(&layout.root)?;
    for member in &layout.members {
        let link = layout.root.join(&member.alias);
        place_link(&link, &member.path)?;
    }
    Ok(())
}

fn place_link(link: &Path, target: &Path) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(link) {
        let file_type = meta.file_type();
        if file_type.is_symlink() || !meta.is_dir() {
            remove_entry_nofollow(link)?;
        } else if dir_is_empty(link) {
            fs::remove_dir(link)?;
        } else {
            return Err(Error::Other(format!(
                "{} is in the way of a project link",
                link.display()
            )));
        }
    }
    link_dir(link, target)
}

fn remove_group_dir(root: &Path) -> Result<()> {
    if !root.exists() && fs::symlink_metadata(root).is_err() {
        return Ok(());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        remove_entry_nofollow(&path)?;
    }
    match fs::remove_dir(root) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(Error::Other(
            "group folder is not empty, so it was left in place".into(),
        )),
    }
}

fn remove_entry_nofollow(path: &Path) -> Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        fs::remove_file(path)?;
        return Ok(());
    }
    if meta.is_dir() {
        // A real directory is removed only when it is empty. A Windows junction is empty
        // from this side, so this drops the junction and leaves the target alone.
        fs::remove_dir(path).map_err(|_| {
            Error::Other("group folder is not empty, so it was left in place".into())
        })?;
        return Ok(());
    }
    fs::remove_file(path)?;
    Ok(())
}

#[cfg(unix)]
fn link_dir(link: &Path, target: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}

#[cfg(windows)]
fn link_dir(link: &Path, target: &Path) -> Result<()> {
    use std::process::Command;
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &link.to_string_lossy(),
            &target.to_string_lossy(),
        ])
        .status()
        .map_err(|_| Error::Other("could not link the project folder".into()))?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Other("could not link the project folder".into()))
    }
}

fn dir_is_empty(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty() && name != "." && name != "..")
        .unwrap_or_else(|| "repo".into())
}

fn next_alias(name: &str, used: &mut HashSet<String>) -> String {
    let base = name.trim();
    let base = if base.is_empty() || base == "." || base == ".." {
        "repo"
    } else {
        base
    };
    let mut candidate = base.to_string();
    let mut n = 2;
    while used.iter().any(|row| row.eq_ignore_ascii_case(&candidate)) {
        candidate = format!("{base}-{n}");
        n += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn project_name(conn: &rusqlite::Connection, path: &Path) -> String {
    if let Ok(Some(row)) = crate::appdb::list_projects(conn).map(|rows| {
        let key = path_key(&path_string(path));
        rows.into_iter().find(|row| path_key(&row.path) == key)
    }) {
        return row.name;
    }
    folder_name(path)
}

fn row_from_layout(layout: GroupLayout) -> GroupRow {
    GroupRow {
        path: path_string(&layout.root),
        name: layout.name,
        members: layout
            .members
            .into_iter()
            .map(|member| GroupMemberRow {
                path: path_string(&member.path),
                alias: member.alias,
                name: member.name,
            })
            .collect(),
    }
}

fn read_groups(data_dir: &Path) -> Result<Vec<GroupLayout>> {
    let conn = crate::appdb::open(data_dir)?;
    layouts_from(&conn)
}

fn layouts_from(conn: &rusqlite::Connection) -> Result<Vec<GroupLayout>> {
    let mut stmt = conn.prepare(
        "SELECT path, name FROM project_groups ORDER BY created_at ASC, path ASC",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (path, name) = row?;
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            continue;
        }
        let members = member_layouts(conn, &path)?;
        out.push(GroupLayout { root, name, members });
    }
    Ok(out)
}

fn reload_one(data_dir: &Path, root: &Path) -> Result<GroupLayout> {
    let conn = crate::appdb::open(data_dir)?;
    let Some(stored) = find_group_path(&conn, root)? else {
        return Err(Error::Other("not a group".into()));
    };
    let name: String = conn.query_row(
        "SELECT name FROM project_groups WHERE path = ?1",
        [&stored],
        |row| row.get(0),
    )?;
    let members = member_layouts(&conn, &stored)?;
    Ok(GroupLayout {
        root: canonical_dir(root)?,
        name,
        members,
    })
}

fn member_layouts(conn: &rusqlite::Connection, group_path: &str) -> Result<Vec<GroupMember>> {
    let mut stmt = conn.prepare(
        "SELECT project_path, alias FROM project_group_members
         WHERE group_path = ?1 ORDER BY position ASC, alias ASC",
    )?;
    let rows = stmt.query_map([group_path], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut members = Vec::new();
    for row in rows {
        let (path, alias) = row?;
        let folder = PathBuf::from(&path);
        if !folder.is_dir() {
            continue;
        }
        members.push(GroupMember {
            name: project_name(conn, &folder),
            alias,
            path: folder,
        });
    }
    Ok(members)
}

fn members_of(conn: &rusqlite::Connection, group_path: &str) -> Result<Vec<GroupMemberRow>> {
    Ok(member_layouts(conn, group_path)?
        .into_iter()
        .map(|member| GroupMemberRow {
            path: path_string(&member.path),
            alias: member.alias,
            name: member.name,
        })
        .collect())
}

fn find_group_path(conn: &rusqlite::Connection, path: &Path) -> Result<Option<String>> {
    let stored = path_string(path);
    conn.query_row(
        "SELECT path FROM project_groups
         WHERE lower(rtrim(replace(path, '\\', '/'), '/')) = lower(rtrim(replace(?1, '\\', '/'), '/'))",
        [path_key(&stored)],
        |row| row.get(0),
    )
    .optional_err()
}

fn find_member_group(conn: &rusqlite::Connection, path: &Path) -> Result<Option<String>> {
    let stored = path_string(path);
    conn.query_row(
        "SELECT group_path FROM project_group_members
         WHERE lower(rtrim(replace(project_path, '\\', '/'), '/')) = lower(rtrim(replace(?1, '\\', '/'), '/'))",
        [path_key(&stored)],
        |row| row.get(0),
    )
    .optional_err()
}

fn remove_db_group(data_dir: &Path, group: &Path) -> Result<()> {
    let Ok(conn) = crate::appdb::open(data_dir) else {
        return Ok(());
    };
    let Some(stored) = find_group_path(&conn, group).ok().flatten() else {
        let fallback = path_string(group);
        let _ = conn.execute("DELETE FROM project_groups WHERE path = ?1", [&fallback]);
        let _ = crate::appdb::remove_project(&conn, &fallback);
        return Ok(());
    };
    conn.execute("DELETE FROM project_groups WHERE path = ?1", [&stored])?;
    let _ = crate::appdb::remove_project(&conn, &stored);
    Ok(())
}

trait OptionalQuery {
    fn optional_err(self) -> Result<Option<String>>;
}

impl OptionalQuery for std::result::Result<String, rusqlite::Error> {
    fn optional_err(self) -> Result<Option<String>> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn layout_with(api: &Path, web: &Path) -> GroupLayout {
        GroupLayout {
            root: PathBuf::from("/group"),
            name: "apps".into(),
            members: vec![
                GroupMember {
                    alias: "api".into(),
                    path: api.to_path_buf(),
                    name: "api".into(),
                },
                GroupMember {
                    alias: "web".into(),
                    path: web.to_path_buf(),
                    name: "web".into(),
                },
            ],
        }
    }

    #[test]
    fn split_normalizes_parent_segments_and_rejects_escape() {
        let api = PathBuf::from("/repos/api");
        let web = PathBuf::from("/repos/web");
        let layout = layout_with(&api, &web);
        assert_eq!(layout.split("").unwrap(), GroupPath::Root);
        match layout.split("api/src/lib.rs").unwrap() {
            GroupPath::Member { alias, rest, .. } => {
                assert_eq!(alias, "api");
                assert_eq!(rest, "src/lib.rs");
            }
            GroupPath::Root => panic!("expected a member"),
        }
        match layout.split("api/../web/file").unwrap() {
            GroupPath::Member { alias, rest, .. } => {
                assert_eq!(alias, "web");
                assert_eq!(rest, "file");
            }
            GroupPath::Root => panic!("expected web"),
        }
        assert!(layout.split("../secret").unwrap_err().to_string().contains("outside"));
        assert!(layout.split("notes.txt").is_err());
    }

    #[test]
    fn create_rejects_one_path_a_nested_pair_and_a_second_group() {
        let data = temp_dir();
        let projects = temp_dir();
        let left = temp_dir();
        let right = temp_dir();
        let err = create_group(data.path(), projects.path(), "apps", &[left.path().to_path_buf()]).unwrap_err();
        assert!(err.to_string().contains("two"));

        let parent = temp_dir();
        let child = parent.path().join("child");
        fs::create_dir(&child).unwrap();
        let err = create_group(
            data.path(),
            projects.path(),
            "apps",
            &[parent.path().to_path_buf(), child],
        )
        .unwrap_err();
        assert!(err.to_string().contains("inside"));

        let api_a = left.path().join("api");
        let api_b = right.path().join("api");
        fs::create_dir(&api_a).unwrap();
        fs::create_dir(&api_b).unwrap();
        let created = create_group(
            data.path(),
            projects.path(),
            "apps",
            &[api_a.clone(), api_b.clone()],
        )
        .unwrap();
        assert_eq!(
            created.members.iter().map(|member| member.alias.as_str()).collect::<Vec<_>>(),
            ["api", "api-2"]
        );
        let err = create_group(
            data.path(),
            projects.path(),
            "other",
            &[api_a.clone(), api_b],
        )
        .unwrap_err();
        assert!(err.to_string().contains("already in a group"));
        assert!(remove_member(data.path(), Path::new(&created.path), &api_a).is_err());
    }

    #[test]
    fn delete_removes_the_group_directory_and_leaves_members() {
        let data = temp_dir();
        let projects = temp_dir();
        let api_root = temp_dir();
        let web_root = temp_dir();
        let api = api_root.path().join("api");
        let web = web_root.path().join("web");
        fs::create_dir(&api).unwrap();
        fs::create_dir(&web).unwrap();
        fs::write(api.join("keep.txt"), "safe").unwrap();
        let created = create_group(
            data.path(),
            projects.path(),
            "apps",
            &[api.clone(), web.clone()],
        )
        .unwrap();
        let group = PathBuf::from(&created.path);
        assert!(group.join("api").symlink_metadata().unwrap().file_type().is_symlink());
        delete_group(data.path(), &group).unwrap();
        assert!(!group.exists());
        assert_eq!(fs::read_to_string(api.join("keep.txt")).unwrap(), "safe");
        assert!(web.is_dir());
        assert!(list_groups(data.path()).unwrap().is_empty());
    }
}
