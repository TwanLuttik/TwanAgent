use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use tauri::{AppHandle, Manager, State};

use crate::dev::{expand_folder_path, path_string, FolderSuggestion};
use crate::error::{Error, Result};
use crate::state::AppState;

const SCHEMA_VERSION: i64 = 2;
const DB_FILE: &str = "app.db";
const LEGACY_IMPORTED_KEY: &str = "projects.legacy_imported";

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE)
}

pub fn open(data_dir: &Path) -> Result<Connection> {
    fs::create_dir_all(data_dir)?;
    let conn = Connection::open(db_path(data_dir))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS projects (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            added_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;
    migrate_remote_tables(conn)?;
    let version: Option<i64> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    if version != Some(SCHEMA_VERSION) {
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?1)",
            [SCHEMA_VERSION],
        )?;
    }
    Ok(())
}

fn migrate_remote_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS machines (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            user TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            auth TEXT NOT NULL,
            key_path TEXT,
            secret_account TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS remote_projects (
            id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            remote_path TEXT NOT NULL,
            mount_path TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        ",
    )?;
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn path_key(path: &str) -> String {
    crate::paths::native_source(path).to_ascii_lowercase()
}

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
pub fn add_project_named(conn: &Connection, path: &Path, display_name: Option<&str>) -> Result<FolderSuggestion> {
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
    let sort: i64 = conn.query_row("SELECT COALESCE(MAX(sort_order), -1) FROM projects", [], |row| {
        row.get(0)
    })?;
    conn.execute(
        "INSERT INTO projects (path, name, added_at, sort_order) VALUES (?1, ?2, ?3, ?4)",
        params![stored, name, now_iso(), sort + 1],
    )?;
    Ok(FolderSuggestion {
        path: stored,
        name,
    })
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

pub fn remove_project(conn: &Connection, path: &str) -> Result<bool> {
    let Some(existing) = find_project(conn, path)? else {
        return Ok(false);
    };
    let n = conn.execute("DELETE FROM projects WHERE path = ?1", [&existing.path])?;
    Ok(n > 0)
}

/// One-time import of folders that used to define the sidebar, so nothing already added disappears.
/// Later deletes stay deleted: the default folder is scanned only until this flag is set.
pub fn import_legacy_projects(conn: &Connection, roots: &[&Path], opened: &[String]) -> Result<usize> {
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

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(Error::from)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(Error::Other("setting key is empty".into()));
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSetting {
    pub key: String,
    pub value: String,
}

pub fn list_settings(conn: &Connection) -> Result<Vec<AppSetting>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(AppSetting {
            key: row.get(0)?,
            value: row.get(1)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_list_projects(state: State<'_, AppState>) -> Result<Vec<FolderSuggestion>> {
    let conn = open(&state.data_dir)?;
    list_projects(&conn)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_add_project(app: AppHandle, path: String) -> Result<FolderSuggestion> {
    let root = expand_folder_path(&path)?;
    let state = app.state::<AppState>();
    let canon = state.register_workspace(&app, &root)?;
    let conn = open(&state.data_dir)?;
    add_project(&conn, &canon)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_remove_project(state: State<'_, AppState>, path: String) -> Result<bool> {
    let conn = open(&state.data_dir)?;
    remove_project(&conn, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    let conn = open(&state.data_dir)?;
    get_setting(&conn, key.trim())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_app_set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    let conn = open(&state.data_dir)?;
    set_setting(&conn, &key, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn projects_roundtrip_and_are_unique_by_path() {
        let data = tempdir().unwrap();
        let folder = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let added = add_project(&conn, folder.path()).unwrap();
        assert!(added.path.ends_with(folder.path().file_name().unwrap().to_str().unwrap()) || !added.path.is_empty());
        let again = add_project(&conn, folder.path()).unwrap();
        assert_eq!(again.path, added.path);
        let rows = list_projects(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, folder.path().file_name().unwrap().to_string_lossy());
        assert!(remove_project(&conn, &added.path).unwrap());
        assert!(list_projects(&conn).unwrap().is_empty());
        assert!(!remove_project(&conn, &added.path).unwrap());
    }

    #[test]
    fn import_keeps_default_children_and_opened_folders() {
        let data = tempdir().unwrap();
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("Alpha")).unwrap();
        fs::create_dir_all(root.path().join(".hidden")).unwrap();
        let outside = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let n = import_legacy_projects(
            &conn,
            &[root.path()],
            &[outside.path().to_string_lossy().into_owned()],
        )
        .unwrap();
        assert_eq!(n, 2);
        let names: Vec<_> = list_projects(&conn).unwrap().into_iter().map(|row| row.name).collect();
        assert!(names.iter().any(|name| name == "Alpha"));
        assert!(!names.iter().any(|name| name == ".hidden"));
        let again = import_legacy_projects(&conn, &[root.path()], &[]).unwrap();
        assert_eq!(again, 0);
        assert_eq!(list_projects(&conn).unwrap().len(), 2);
        fs::create_dir_all(root.path().join("Later")).unwrap();
        let after_flag = import_legacy_projects(&conn, &[root.path()], &[]).unwrap();
        assert_eq!(after_flag, 0);
        assert!(!list_projects(&conn)
            .unwrap()
            .iter()
            .any(|row| row.name == "Later"));
    }

    #[test]
    fn settings_upsert() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        assert!(get_setting(&conn, "theme").unwrap().is_none());
        set_setting(&conn, "theme", r#"{"id":"finder"}"#).unwrap();
        set_setting(&conn, "theme", r#"{"id":"midnight"}"#).unwrap();
        assert_eq!(
            get_setting(&conn, "theme").unwrap().as_deref(),
            Some(r#"{"id":"midnight"}"#)
        );
        assert_eq!(list_settings(&conn).unwrap().len(), 1);
        assert!(set_setting(&conn, "  ", "x").is_err());
    }
}
