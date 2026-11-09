use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::schema::{now_iso, path_key};
use super::settings::{get_setting, set_setting};
use super::sidebar::clear_sidebar;
use crate::dev::{expand_folder_path, path_string, FolderSuggestion};
use crate::error::{Error, Result};

const LEGACY_IMPORTED_KEY: &str = "projects.legacy_imported";

pub fn list_projects(conn: &Connection) -> Result<Vec<FolderSuggestion>> {
    let mut stmt = conn.prepare(
        "SELECT path, name FROM projects ORDER BY sort_order ASC, name COLLATE NOCASE ASC, path ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(FolderSuggestion {
            path: row.get(0)?,
            name: row.get(1)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Remember a folder. Returns the stored path. Existing rows keep their place and only refresh the name.
pub fn add_project(conn: &Connection, path: &Path) -> Result<FolderSuggestion> {
    add_project_named(conn, path, None)
}

/// Like `add_project`, but a remote project keeps the name the user typed instead of the mount id.
pub fn add_project_named(
    conn: &Connection,
    path: &Path,
    display_name: Option<&str>,
) -> Result<FolderSuggestion> {
    let canon = fs::canonicalize(path).map_err(|_| Error::Other("folder is missing".into()))?;
    if !canon.is_dir() {
        return Err(Error::Other("not a folder".into()));
    }
    let stored = path_string(&canon);
    let folder_name = canon
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty() && n != "." && n != "..")
        .unwrap_or_else(|| stored.clone());
    let name = display_name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&folder_name)
        .to_string();
    if let Some(existing) = find_project(conn, &stored)? {
        if existing.name != name {
            conn.execute(
                "UPDATE projects SET name = ?1 WHERE path = ?2",
                params![name, existing.path],
            )?;
        }
        return Ok(FolderSuggestion {
            path: existing.path,
            name,
        });
    }
    let sort: i64 = conn.query_row(
        "SELECT COALESCE(MIN(sort_order), 1) FROM projects",
        [],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO projects (path, name, added_at, sort_order) VALUES (?1, ?2, ?3, ?4)",
        params![stored, name, now_iso(), sort - 1],
    )?;
    Ok(FolderSuggestion { path: stored, name })
}

fn find_project(conn: &Connection, path: &str) -> Result<Option<FolderSuggestion>> {
    conn.query_row(
        "SELECT path, name FROM projects
         WHERE lower(rtrim(replace(path, '\\', '/'), '/')) = lower(rtrim(replace(?1, '\\', '/'), '/'))",
        [path_key(path)],
        |row| {
            Ok(FolderSuggestion {
                path: row.get(0)?,
                name: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(Error::from)
}

/// Write the sidebar order. Unknown paths are skipped. Known paths not in the list keep their relative order after it.
pub fn reorder_projects(conn: &Connection, paths: &[String]) -> Result<Vec<FolderSuggestion>> {
    let existing = list_projects(conn)?;
    if existing.is_empty() || paths.is_empty() {
        return Ok(existing);
    }
    let mut ordered = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let Some(row) = existing
            .iter()
            .find(|row| path_key(&row.path) == path_key(path))
        else {
            continue;
        };
        if seen.insert(path_key(&row.path)) {
            ordered.push(row.path.clone());
        }
    }
    for row in &existing {
        if seen.insert(path_key(&row.path)) {
            ordered.push(row.path.clone());
        }
    }
    let tx = conn.unchecked_transaction()?;
    for (index, path) in ordered.iter().enumerate() {
        tx.execute(
            "UPDATE projects SET sort_order = ?1 WHERE path = ?2",
            params![index as i64, path],
        )?;
    }
    tx.commit()?;
    list_projects(conn)
}

pub(super) fn project_key(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

/// The same key the sidebar index stores, so a caller outside this module can match a row.
pub fn project_key_public(path: &str) -> String {
    project_key(path)
}

/// Keep a project's sidebar place when its folder path changes. The cache moves with it.
pub fn rename_project_path(conn: &Connection, from: &str, to: &str) -> Result<bool> {
    if path_key(from) == path_key(to) {
        return Ok(false);
    }
    let Some(existing) = find_project(conn, from)? else {
        return Ok(false);
    };
    let name = Path::new(to)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| existing.name.clone());
    if find_project(conn, to)?.is_some() {
        let _ = remove_project(conn, &existing.path);
        return Ok(false);
    }
    conn.execute(
        "UPDATE projects SET path = ?1, name = ?2 WHERE path = ?3",
        params![to, name, existing.path],
    )?;
    let from_key = project_key(&existing.path);
    let to_key = project_key(to);
    for table in [
        "sidebar_projects",
        "sidebar_transcripts",
        "sidebar_conversations",
        "sidebar_journeys",
    ] {
        conn.execute(
            &format!("UPDATE {table} SET project_path = ?1 WHERE project_path = ?2"),
            params![to_key, from_key],
        )?;
    }
    Ok(true)
}

pub fn remove_project(conn: &Connection, path: &str) -> Result<bool> {
    let Some(existing) = find_project(conn, path)? else {
        // A worktree is not a saved project, but its chats are still copied here.
        clear_sidebar(conn, path)?;
        return Ok(false);
    };
    let n = conn.execute("DELETE FROM projects WHERE path = ?1", [&existing.path])?;
    clear_sidebar(conn, &existing.path)?;
    Ok(n > 0)
}

/// One-time import of folders that used to define the sidebar, so nothing already added disappears.
/// Later deletes stay deleted: the default folder is scanned only until this flag is set.
pub fn import_legacy_projects(
    conn: &Connection,
    roots: &[&Path],
    opened: &[String],
) -> Result<usize> {
    if get_setting(conn, LEGACY_IMPORTED_KEY)?.as_deref() == Some("1") {
        return Ok(0);
    }
    let mut added = 0;
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
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
            let before = list_count(conn)?;
            let _ = add_project(conn, &entry.path())?;
            if list_count(conn)? > before {
                added += 1;
            }
        }
    }
    for raw in opened {
        let Ok(path) = expand_folder_path(raw) else {
            continue;
        };
        let before = list_count(conn)?;
        let _ = add_project(conn, &path)?;
        if list_count(conn)? > before {
            added += 1;
        }
    }
    set_setting(conn, LEGACY_IMPORTED_KEY, "1")?;
    Ok(added)
}

fn list_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?)
}
