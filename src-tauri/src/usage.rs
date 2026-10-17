use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::Result;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageEvent {
    pub id: i64,
    pub recorded_at: String,
    pub workspace_path: String,
    pub workspace_name: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsageRecord {
    pub workspace_path: String,
    pub workspace_name: String,
    #[serde(default)]
    pub conversation_id: String,
    #[serde(default)]
    pub conversation_title: String,
    #[serde(default)]
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("usage.db")
}

pub fn db_folder(data_dir: &Path) -> PathBuf {
    db_path(data_dir)
        .parent()
        .unwrap_or(data_dir)
        .to_path_buf()
}

pub fn open_db_folder(data_dir: &Path) -> Result<()> {
    let folder = db_folder(data_dir);
    std::fs::create_dir_all(&folder)?;
    crate::dev::open_path(&folder)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageDbInfo {
    pub path: String,
    pub bytes: u64,
    pub exists: bool,
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| format!("{}{suffix}", name.to_string_lossy()))
        .unwrap_or_else(|| format!("usage.db{suffix}"));
    path.with_file_name(name)
}

pub fn db_info(data_dir: &Path) -> UsageDbInfo {
    let path = db_path(data_dir);
    let bytes = file_len(&path) + file_len(&sidecar(&path, "-wal")) + file_len(&sidecar(&path, "-shm"));
    UsageDbInfo {
        path: path.display().to_string(),
        bytes,
        exists: path.is_file(),
    }
}

pub fn reset_db(data_dir: &Path) -> Result<UsageDbInfo> {
    let path = db_path(data_dir);
    for file in [path.clone(), sidecar(&path, "-wal"), sidecar(&path, "-shm")] {
        if file.exists() {
            std::fs::remove_file(file)?;
        }
    }
    Ok(db_info(data_dir))
}

fn open(data_dir: &Path) -> Result<Connection> {
    std::fs::create_dir_all(data_dir)?;
    let conn = Connection::open(db_path(data_dir))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            workspace_name TEXT NOT NULL,
            conversation_id TEXT NOT NULL DEFAULT '',
            conversation_title TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            prompt_tokens INTEGER NOT NULL,
            completion_tokens INTEGER NOT NULL,
            total_tokens INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS usage_events_recorded_at ON usage_events(recorded_at);
        CREATE INDEX IF NOT EXISTS usage_events_workspace ON usage_events(workspace_path);
        CREATE INDEX IF NOT EXISTS usage_events_conversation ON usage_events(conversation_id);
        ",
    )?;
    let _ = conn.execute("ALTER TABLE usage_events ADD COLUMN duration_ms INTEGER", []);
    Ok(conn)
}

fn normalize_workspace(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    trimmed.trim_end_matches('/').to_string()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn record(data_dir: &Path, rec: UsageRecord) -> Result<Option<UsageEvent>> {
    if rec.prompt_tokens == 0 && rec.completion_tokens == 0 {
        return Ok(None);
    }
    let path = normalize_workspace(&rec.workspace_path);
    if path.is_empty() {
        return Ok(None);
    }
    let total = if rec.total_tokens > 0 {
        rec.total_tokens
    } else {
        rec.prompt_tokens + rec.completion_tokens
    };
    let recorded_at = now_iso();
    let conn = open(data_dir)?;
    conn.execute(
        "INSERT INTO usage_events (
            recorded_at, workspace_path, workspace_name, conversation_id, conversation_title,
            model, prompt_tokens, completion_tokens, total_tokens, duration_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            recorded_at,
            path,
            rec.workspace_name,
            rec.conversation_id,
            rec.conversation_title,
            rec.model,
            rec.prompt_tokens as i64,
            rec.completion_tokens as i64,
            total as i64,
            rec.duration_ms.filter(|ms| *ms >= 0),
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Some(UsageEvent {
        id,
        recorded_at,
        workspace_path: path,
        workspace_name: rec.workspace_name,
        conversation_id: rec.conversation_id,
        conversation_title: rec.conversation_title,
        model: rec.model,
        prompt_tokens: rec.prompt_tokens,
        completion_tokens: rec.completion_tokens,
        total_tokens: total,
        duration_ms: rec.duration_ms.filter(|ms| *ms >= 0),
    }))
}

/// Drop usage rows that belong to a folder that no longer exists. A worktree's chats go with it.
pub fn forget_workspace_paths(data_dir: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() || !db_path(data_dir).exists() {
        return Ok(());
    }
    let conn = open(data_dir)?;
    for path in paths {
        let key = normalize_workspace(path);
        if key.is_empty() {
            continue;
        }
        conn.execute(
            "DELETE FROM usage_events
             WHERE lower(rtrim(replace(workspace_path, '\\', '/'), '/')) = lower(?1)",
            [key],
        )?;
    }
    Ok(())
}

pub fn replace_workspace_paths(data_dir: &Path, moves: &[(String, String)]) -> Result<()> {
    if moves.is_empty() || !db_path(data_dir).exists() {
        return Ok(());
    }
    let conn = open(data_dir)?;
    for (from, to) in moves {
        conn.execute(
            "UPDATE usage_events
             SET workspace_path = ?1
             WHERE lower(rtrim(replace(workspace_path, '\\', '/'), '/'))
                 = lower(rtrim(replace(?2, '\\', '/'), '/'))",
            params![to, from],
        )?;
    }
    Ok(())
}

pub fn list_since(data_dir: &Path, since: Option<&str>) -> Result<Vec<UsageEvent>> {
    let conn = open(data_dir)?;
    let mut stmt = conn.prepare(
        "SELECT id, recorded_at, workspace_path, workspace_name, conversation_id, conversation_title,
                model, prompt_tokens, completion_tokens, total_tokens, duration_ms
         FROM usage_events
         WHERE (?1 IS NULL OR recorded_at >= ?1)
         ORDER BY recorded_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([since], |row| {
        Ok(UsageEvent {
            id: row.get(0)?,
            recorded_at: row.get(1)?,
            workspace_path: row.get(2)?,
            workspace_name: row.get(3)?,
            conversation_id: row.get(4)?,
            conversation_title: row.get(5)?,
            model: row.get(6)?,
            prompt_tokens: row.get::<_, i64>(7)? as u64,
            completion_tokens: row.get::<_, i64>(8)? as u64,
            total_tokens: row.get::<_, i64>(9)? as u64,
            duration_ms: row.get::<_, Option<i64>>(10)?.filter(|ms| *ms >= 0),
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Finish stamps for one conversation. Opening a chat only needs these rows,
/// not the whole usage history.
pub fn list_for_conversation(
    data_dir: &Path,
    conversation_id: &str,
    workspace_path: &str,
) -> Result<Vec<UsageEvent>> {
    let id = conversation_id.trim();
    if id.is_empty() {
        return Ok(Vec::new());
    }
    let workspace = normalize_workspace(workspace_path);
    let conn = open(data_dir)?;
    let mut stmt = conn.prepare(
        "SELECT id, recorded_at, workspace_path, workspace_name, conversation_id, conversation_title,
                model, prompt_tokens, completion_tokens, total_tokens, duration_ms
         FROM usage_events
         WHERE conversation_id = ?1
           AND (?2 = '' OR lower(rtrim(replace(workspace_path, '\\', '/'), '/')) = lower(?2))
         ORDER BY recorded_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![id, workspace], |row| {
        Ok(UsageEvent {
            id: row.get(0)?,
            recorded_at: row.get(1)?,
            workspace_path: row.get(2)?,
            workspace_name: row.get(3)?,
            conversation_id: row.get(4)?,
            conversation_title: row.get(5)?,
            model: row.get(6)?,
            prompt_tokens: row.get::<_, i64>(7)? as u64,
            completion_tokens: row.get::<_, i64>(8)? as u64,
            total_tokens: row.get::<_, i64>(9)? as u64,
            duration_ms: row.get::<_, Option<i64>>(10)?.filter(|ms| *ms >= 0),
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_usage_record(
    state: State<'_, AppState>,
    event: UsageRecord,
) -> Result<Option<UsageEvent>> {
    record(&state.data_dir, event)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_usage_list(
    state: State<'_, AppState>,
    since: Option<String>,
) -> Result<Vec<UsageEvent>> {
    list_since(&state.data_dir, since.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_usage_for_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    workspace: String,
) -> Result<Vec<UsageEvent>> {
    let data_dir = state.data_dir.clone();
    crate::state::run_blocking(move || {
        list_for_conversation(&data_dir, &conversation_id, &workspace)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_usage_db_info(state: State<'_, AppState>) -> UsageDbInfo {
    db_info(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_usage_db_reset(state: State<'_, AppState>) -> Result<UsageDbInfo> {
    reset_db(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_usage_db_open(state: State<'_, AppState>) -> Result<()> {
    open_db_folder(&state.data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn rec(path: &str, prompt: u64, completion: u64) -> UsageRecord {
        UsageRecord {
            workspace_path: path.into(),
            workspace_name: "alpha".into(),
            conversation_id: "c1".into(),
            conversation_title: "Chat".into(),
            model: "grok-4.6".into(),
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            duration_ms: None,
        }
    }

    #[test]
    fn records_and_lists_events() {
        let dir = tempdir().unwrap();
        let saved = record(dir.path(), rec("/proj/alpha/", 100, 20))
            .unwrap()
            .unwrap();
        assert_eq!(saved.workspace_path, "/proj/alpha");
        assert_eq!(saved.prompt_tokens, 100);
        let rows = list_since(dir.path(), None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].completion_tokens, 20);
    }

    #[test]
    fn skips_empty_usage() {
        let dir = tempdir().unwrap();
        assert!(record(dir.path(), rec("/proj/alpha", 0, 0))
            .unwrap()
            .is_none());
        assert!(list_since(dir.path(), None).unwrap().is_empty());
    }

    #[test]
    fn reports_path_and_size_then_resets() {
        let dir = tempdir().unwrap();
        let before = db_info(dir.path());
        assert!(!before.exists);
        assert_eq!(before.bytes, 0);
        assert!(before.path.ends_with("usage.db"));
        assert_eq!(db_folder(dir.path()), dir.path());
        record(dir.path(), rec("/proj/alpha", 10, 1)).unwrap();
        let saved = db_info(dir.path());
        assert!(saved.exists);
        assert!(saved.bytes > 0);
        let cleared = reset_db(dir.path()).unwrap();
        assert!(!cleared.exists);
        assert_eq!(cleared.bytes, 0);
        assert!(list_since(dir.path(), None).unwrap().is_empty());
    }

    #[test]
    fn lists_one_conversation_without_the_rest_of_the_history() {
        let dir = tempdir().unwrap();
        record(dir.path(), rec("/proj/alpha/", 10, 1)).unwrap();
        let mut other = rec("/proj/alpha", 30, 3);
        other.conversation_id = "c2".into();
        record(dir.path(), other).unwrap();
        record(dir.path(), rec("/proj/beta", 40, 4)).unwrap();
        let rows = list_for_conversation(dir.path(), "c1", "/proj/alpha").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].conversation_id, "c1");
        assert_eq!(rows[0].prompt_tokens, 10);
        assert!(list_for_conversation(dir.path(), "missing", "/proj/alpha")
            .unwrap()
            .is_empty());
        assert!(list_for_conversation(dir.path(), "  ", "/proj/alpha")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn persists_across_reopen_and_filters_by_time() {
        let dir = tempdir().unwrap();
        record(dir.path(), rec("/proj/alpha", 10, 1)).unwrap();
        record(dir.path(), rec("/proj/beta", 20, 2)).unwrap();
        let again = list_since(dir.path(), None).unwrap();
        assert_eq!(again.len(), 2);
        let future = list_since(dir.path(), Some("2099-01-01T00:00:00Z")).unwrap();
        assert!(future.is_empty());
    }
}
