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
    /// Prompt tokens served from cache. Already inside `prompt_tokens`.
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    /// Non-empty when the row was copied from a paired server. Empty for a turn recorded here.
    #[serde(default)]
    pub source: String,
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
    /// Prompt tokens served from cache. Already inside `prompt_tokens`.
    #[serde(default)]
    pub cache_read_tokens: u64,
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

const USAGE_EVENT_COLUMNS: &str = "id, recorded_at, workspace_path, workspace_name, conversation_id, conversation_title,
                model, prompt_tokens, completion_tokens, total_tokens, duration_ms, cache_read_tokens, source";

fn read_usage_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageEvent> {
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
        cache_read_tokens: row.get::<_, i64>(11)?.max(0) as u64,
        duration_ms: row.get::<_, Option<i64>>(10)?.filter(|ms| *ms >= 0),
        source: row.get(12)?,
    })
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
    ensure_cache_column(&conn)?;
    Ok(conn)
}

fn ensure_cache_column(conn: &Connection) -> Result<()> {
    let _ = conn.execute(
        "ALTER TABLE usage_events ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // A row copied from a server. Empty for a turn recorded on this machine.
    let _ = conn.execute("ALTER TABLE usage_events ADD COLUMN source TEXT NOT NULL DEFAULT ''", []);
    Ok(())
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
            model, prompt_tokens, completion_tokens, total_tokens, duration_ms, cache_read_tokens
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
            rec.cache_read_tokens.min(rec.prompt_tokens) as i64,
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
        cache_read_tokens: rec.cache_read_tokens.min(rec.prompt_tokens),
        duration_ms: rec.duration_ms.filter(|ms| *ms >= 0),
        source: String::new(),
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
    ensure_cache_column(&conn)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {USAGE_EVENT_COLUMNS}
         FROM usage_events
         WHERE (?1 IS NULL OR recorded_at >= ?1)
         ORDER BY recorded_at ASC, id ASC",
    ))?;
    let rows = stmt.query_map([since], read_usage_event)?;
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
    ensure_cache_column(&conn)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {USAGE_EVENT_COLUMNS}
         FROM usage_events
         WHERE conversation_id = ?1
           AND (?2 = '' OR lower(rtrim(replace(workspace_path, '\\', '/'), '/')) = lower(?2))
         ORDER BY recorded_at ASC, id ASC",
    ))?;
    let rows = stmt.query_map(params![id, workspace], read_usage_event)?;
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

/// One cloud chat the desktop has already copied from the server.
/// The server keeps no usage log. `prompt_tokens` is the context of its latest turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudUsageChat {
    pub project_path: String,
    pub project_name: String,
    pub conversation_id: String,
    pub title: String,
    pub model: String,
    pub updated_at: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// One row copied from a server's usage log. `source` is what keeps a second sync from inserting it again.
#[derive(Debug, Clone)]
pub struct SyncedUsage {
    pub source: String,
    pub recorded_at: String,
    pub workspace_path: String,
    pub workspace_name: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_read_tokens: u64,
}

/// Insert server rows this machine has not copied yet. Returns how many were new.
pub fn merge_synced(data_dir: &Path, rows: &[SyncedUsage]) -> Result<usize> {
    if rows.is_empty() {
        return Ok(0);
    }
    let conn = open(data_dir)?;
    ensure_cache_column(&conn)?;
    let mut added = 0usize;
    for row in rows {
        let source = row.source.trim();
        if source.is_empty() {
            continue;
        }
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM usage_events WHERE source = ?1",
            [source],
            |found| found.get(0),
        )?;
        if exists > 0 {
            continue;
        }
        let path = normalize_workspace(&row.workspace_path);
        if path.is_empty() {
            continue;
        }
        let total = row.prompt_tokens.saturating_add(row.completion_tokens);
        conn.execute(
            "INSERT INTO usage_events (
                recorded_at, workspace_path, workspace_name, conversation_id, conversation_title,
                model, prompt_tokens, completion_tokens, total_tokens, duration_ms, cache_read_tokens, source
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11)",
            params![
                row.recorded_at,
                path,
                row.workspace_name,
                row.conversation_id,
                row.conversation_title,
                row.model,
                row.prompt_tokens as i64,
                row.completion_tokens as i64,
                total as i64,
                row.cache_read_tokens.min(row.prompt_tokens) as i64,
                source,
            ],
        )?;
        added += 1;
    }
    Ok(added)
}

/// A hosted project. `chats` is empty when none of its conversations have been opened here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudUsageProject {
    pub project_path: String,
    pub project_name: String,
    pub chats: Vec<CloudUsageChat>,
}

/// Cloud projects, and the hosted chats cached on this machine.
/// A chat that was never opened here has no row, so its tokens are not counted.
pub fn cloud_usage(data_dir: &Path) -> Result<Vec<CloudUsageProject>> {
    if !crate::appdb::db_path(data_dir).exists() {
        return Ok(Vec::new());
    }
    let conn = crate::appdb::open(data_dir)?;
    let projects = cloud_project_names(&conn)?;
    let mut grouped: std::collections::BTreeMap<String, CloudUsageProject> = projects
        .iter()
        .filter(|(_, (_, cloud))| *cloud)
        .map(|(path, (name, _))| {
            (
                path.clone(),
                CloudUsageProject {
                    project_path: path.clone(),
                    project_name: name.clone(),
                    chats: Vec::new(),
                },
            )
        })
        .collect();
    let mut stmt = conn.prepare(
        "SELECT project_path, id, body FROM sidebar_transcripts ORDER BY project_path ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (project_path, conversation_id, body) = row?;
        let Some(project) = grouped.get_mut(&project_path) else {
            continue;
        };
        let Ok(conversation) = serde_json::from_str::<crate::dev::Conversation>(&body) else {
            continue;
        };
        let Some(usage) = conversation.context_usage else {
            continue;
        };
        if usage.prompt_tokens == 0 && usage.completion_tokens == 0 {
            continue;
        }
        project.chats.push(CloudUsageChat {
            project_path,
            project_name: project.project_name.clone(),
            conversation_id: if conversation.id.is_empty() { conversation_id } else { conversation.id },
            title: conversation.title,
            model: conversation.model.unwrap_or_default(),
            updated_at: conversation.updated_at,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
        });
    }
    let mut out: Vec<_> = grouped.into_values().collect();
    out.sort_by(|a, b| b.chats.len().cmp(&a.chats.len()).then_with(|| a.project_name.cmp(&b.project_name)));
    Ok(out)
}

fn cloud_project_names(conn: &rusqlite::Connection) -> Result<std::collections::HashMap<String, (String, bool)>> {
    let mut names = std::collections::HashMap::new();
    let mut projects = conn.prepare("SELECT path, name FROM projects")?;
    let project_rows = projects.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for row in project_rows {
        let (path, name) = row?;
        names.insert(crate::appdb::project_key_public(&path), name);
    }
    let remotes = crate::remote::config::list_remote_projects(conn).unwrap_or_default();
    for remote in remotes {
        let name = remote.name.trim();
        if name.is_empty() {
            continue;
        }
        names.insert(crate::appdb::project_key_public(&remote.mount_path), name.to_string());
    }
    let mut clouds = conn.prepare("SELECT project_path, cloud FROM sidebar_projects")?;
    let cloud_rows = clouds.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    let mut out = std::collections::HashMap::new();
    for row in cloud_rows {
        let (path, cloud) = row?;
        let name = names.get(&path).cloned().unwrap_or_else(|| folder_name(&path));
        out.insert(path, (name, cloud == 1));
    }
    Ok(out)
}

fn folder_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_usage_cloud(state: State<'_, AppState>) -> Result<Vec<CloudUsageProject>> {
    cloud_usage(&state.data_dir)
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
            cache_read_tokens: 0,
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
        assert_eq!(saved.cache_read_tokens, 0);
        let rows = list_since(dir.path(), None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].completion_tokens, 20);
    }

    #[test]
    fn keeps_cached_prompt_tokens_inside_the_prompt() {
        let dir = tempdir().unwrap();
        let mut row = rec("/proj/alpha", 1000, 20);
        row.cache_read_tokens = 800;
        let saved = record(dir.path(), row).unwrap().unwrap();
        assert_eq!(saved.prompt_tokens, 1000);
        assert_eq!(saved.cache_read_tokens, 800);
        let listed = list_since(dir.path(), None).unwrap();
        assert_eq!(listed[0].cache_read_tokens, 800);
        let one = list_for_conversation(dir.path(), "c1", "/proj/alpha").unwrap();
        assert_eq!(one[0].cache_read_tokens, 800);
        let mut over = rec("/proj/alpha", 100, 5);
        over.conversation_id = "c2".into();
        over.cache_read_tokens = 9_000;
        assert_eq!(record(dir.path(), over).unwrap().unwrap().cache_read_tokens, 100);
    }

    #[test]
    fn lists_rows_written_before_cache_was_stored() {
        let dir = tempdir().unwrap();
        let conn = Connection::open(db_path(dir.path())).unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recorded_at TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                workspace_name TEXT NOT NULL,
                conversation_id TEXT NOT NULL DEFAULT '',
                conversation_title TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                prompt_tokens INTEGER NOT NULL,
                completion_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                duration_ms INTEGER
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_events (
                recorded_at, workspace_path, workspace_name, conversation_id, conversation_title,
                model, prompt_tokens, completion_tokens, total_tokens, duration_ms
            ) VALUES ('2026-10-01T00:00:00.000Z', '/proj/alpha', 'alpha', 'c1', 'Chat', 'grok-4.7', 10, 2, 12, NULL)",
            [],
        )
        .unwrap();
        drop(conn);
        let rows = list_since(dir.path(), None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].prompt_tokens, 10);
        assert_eq!(rows[0].cache_read_tokens, 0);
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
        assert_eq!(again[0].source, "");
        let future = list_since(dir.path(), Some("2099-01-01T00:00:00Z")).unwrap();
        assert!(future.is_empty());
    }

    #[test]
    fn lists_the_server_source_of_a_copied_row() {
        let dir = tempdir().unwrap();
        record(dir.path(), rec("/proj/alpha", 10, 1)).unwrap();
        let added = merge_synced(
            dir.path(),
            &[SyncedUsage {
                source: "server:hello:4".into(),
                recorded_at: "2026-10-02T00:00:00.000Z".into(),
                workspace_path: "/proj/hello".into(),
                workspace_name: "Hello-world".into(),
                conversation_id: "c9".into(),
                conversation_title: "On the server".into(),
                model: "minimax-m3".into(),
                prompt_tokens: 80,
                completion_tokens: 20,
                cache_read_tokens: 0,
            }],
        )
        .unwrap();
        assert_eq!(added, 1);
        let rows = list_since(dir.path(), None).unwrap();
        assert_eq!(rows.len(), 2);
        let local = rows.iter().find(|row| row.conversation_id == "c1").unwrap();
        assert_eq!(local.source, "");
        let copied = rows.iter().find(|row| row.conversation_id == "c9").unwrap();
        assert_eq!(copied.source, "server:hello:4");
        assert_eq!(copied.total_tokens, 100);
        let again = merge_synced(
            dir.path(),
            &[SyncedUsage {
                source: "server:hello:4".into(),
                recorded_at: "2026-10-02T00:00:00.000Z".into(),
                workspace_path: "/proj/hello".into(),
                workspace_name: "Hello-world".into(),
                conversation_id: "c9".into(),
                conversation_title: "On the server".into(),
                model: "minimax-m3".into(),
                prompt_tokens: 80,
                completion_tokens: 20,
                cache_read_tokens: 0,
            }],
        )
        .unwrap();
        assert_eq!(again, 0);
        assert_eq!(list_since(dir.path(), None).unwrap().len(), 2);
    }
}
