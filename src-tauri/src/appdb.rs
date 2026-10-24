use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use tauri::{AppHandle, Manager, State};

use crate::dev::{expand_folder_path, path_string, FolderSuggestion};
use crate::error::{Error, Result};
use crate::state::AppState;

const SCHEMA_VERSION: i64 = 3;
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
        CREATE TABLE IF NOT EXISTS account_usage (
            provider TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pull_requests (
            repo TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sidebar_projects (
            project_path TEXT PRIMARY KEY,
            refreshed_at TEXT NOT NULL,
            cloud INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sidebar_transcripts (
            project_path TEXT NOT NULL,
            id TEXT NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (project_path, id)
        );
        CREATE TABLE IF NOT EXISTS sidebar_conversations (
            project_path TEXT NOT NULL,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'chat',
            journey_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            effort TEXT,
            model TEXT,
            context_window INTEGER,
            permission TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (project_path, id)
        );
        CREATE TABLE IF NOT EXISTS sidebar_journeys (
            project_path TEXT NOT NULL,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            collapsed INTEGER NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (project_path, id)
        );
        CREATE TABLE IF NOT EXISTS project_path_history (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            previous_paths TEXT NOT NULL DEFAULT '[]'
        );
        ",
    )?;
    migrate_remote_tables(conn)?;
    migrate_sidebar_cache(conn)?;
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

/// Older app databases created `sidebar_projects` without the cloud flag.
fn migrate_sidebar_cache(conn: &Connection) -> Result<()> {
    if !column_exists(conn, "sidebar_projects", "cloud")? {
        conn.execute(
            "ALTER TABLE sidebar_projects ADD COLUMN cloud INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sidebar_transcripts (
            project_path TEXT NOT NULL,
            id TEXT NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (project_path, id)
        );
        ",
    )?;
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in rows {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
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
        CREATE TABLE IF NOT EXISTS agent_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            user TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            machine_id TEXT,
            installed_at TEXT NOT NULL,
            token TEXT,
            provider_keys TEXT
        );
        CREATE TABLE IF NOT EXISTS provider_keys (
            provider TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;
    ensure_provider_keys(conn)?;
    Ok(())
}

/// An earlier build created `provider_keys` without `value`. `CREATE TABLE IF NOT EXISTS` leaves that
/// table in place, so saving a key fails. Recreate it when the column is missing. It held no secrets.
fn ensure_provider_keys(conn: &Connection) -> Result<()> {
    if provider_keys_has_value(conn)? {
        return Ok(());
    }
    conn.execute_batch(
        "
        DROP TABLE provider_keys;
        CREATE TABLE provider_keys (
            provider TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;
    Ok(())
}

fn provider_keys_has_value(conn: &Connection) -> Result<bool> {
    let mut stmt = conn.prepare("PRAGMA table_info(provider_keys)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in rows {
        if name? == "value" {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A model-provider API key saved in Settings. Not the settings table: that one is readable from the UI.
pub fn get_provider_key(conn: &Connection, provider: &str) -> Result<Option<String>> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT value FROM provider_keys WHERE provider = ?1",
        [provider],
        |row| row.get(0),
    )
    .optional()
    .map_err(Error::from)
}

pub fn set_provider_key(conn: &Connection, provider: &str, value: &str) -> Result<()> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Err(Error::Other("provider key name is empty".into()));
    }
    let value = value.trim();
    if value.is_empty() {
        return delete_provider_key(conn, provider);
    }
    conn.execute(
        "INSERT INTO provider_keys (provider, value) VALUES (?1, ?2)
         ON CONFLICT(provider) DO UPDATE SET value = excluded.value",
        params![provider, value],
    )?;
    Ok(())
}

pub fn delete_provider_key(conn: &Connection, provider: &str) -> Result<()> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(());
    }
    conn.execute("DELETE FROM provider_keys WHERE provider = ?1", [provider])?;
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
    let sort: i64 = conn.query_row("SELECT COALESCE(MIN(sort_order), 1) FROM projects", [], |row| {
        row.get(0)
    })?;
    conn.execute(
        "INSERT INTO projects (path, name, added_at, sort_order) VALUES (?1, ?2, ?3, ?4)",
        params![stored, name, now_iso(), sort - 1],
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

/// Write the sidebar order. Unknown paths are skipped. Known paths not in the list keep their relative order after it.
pub fn reorder_projects(conn: &Connection, paths: &[String]) -> Result<Vec<FolderSuggestion>> {
    let existing = list_projects(conn)?;
    if existing.is_empty() || paths.is_empty() {
        return Ok(existing);
    }
    let mut ordered = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let Some(row) = existing.iter().find(|row| path_key(&row.path) == path_key(path)) else {
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

fn project_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

/// The same key the sidebar index stores, so a caller outside this module can match a row.
pub fn project_key_public(path: &str) -> String {
    project_key(path)
}

/// True once this project's sidebar rows have been copied into the index.
pub fn sidebar_cached(conn: &Connection, project: &str) -> Result<bool> {
    let found: Option<String> = conn
        .query_row(
            "SELECT project_path FROM sidebar_projects WHERE project_path = ?1",
            [project_key(project)],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// Replace one project's sidebar rows. `cloud` marks a copy of the server list, not the local mount.
pub fn replace_sidebar(
    conn: &Connection,
    project: &str,
    conversations: &[crate::dev::ConversationSummary],
    journeys: &[crate::dev::Journey],
) -> Result<()> {
    replace_sidebar_source(conn, project, conversations, journeys, false)
}

/// Insert or update one conversation in a sidebar that is already cached.
/// Does not touch other chats, journeys, or the `sidebar_projects` marker.
/// A project that was never fully replaced stays uncached, so one row cannot hide the rest.
pub fn upsert_sidebar_conversation(
    conn: &Connection,
    project: &str,
    row: &crate::dev::ConversationSummary,
) -> Result<()> {
    let key = project_key(project);
    conn.execute(
        "INSERT INTO sidebar_conversations (
            project_path, id, title, created_at, updated_at, kind, journey_id, sort_order,
            effort, model, context_window, permission, archived
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(project_path, id) DO UPDATE SET
            title = excluded.title,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            kind = excluded.kind,
            journey_id = excluded.journey_id,
            sort_order = excluded.sort_order,
            effort = excluded.effort,
            model = excluded.model,
            context_window = excluded.context_window,
            permission = excluded.permission,
            archived = excluded.archived",
        params![
            key,
            row.id,
            row.title,
            row.created_at,
            row.updated_at,
            if row.kind.is_empty() { "chat".to_string() } else { row.kind.clone() },
            row.journey_id,
            row.sort_order,
            row.effort,
            row.model,
            row.context_window.map(|value| value as i64),
            row.permission,
            if row.archived { 1 } else { 0 },
        ],
    )?;
    Ok(())
}

pub fn replace_sidebar_source(
    conn: &Connection,
    project: &str,
    conversations: &[crate::dev::ConversationSummary],
    journeys: &[crate::dev::Journey],
    cloud: bool,
) -> Result<()> {
    let key = project_key(project);
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM sidebar_conversations WHERE project_path = ?1", [&key])?;
    tx.execute("DELETE FROM sidebar_journeys WHERE project_path = ?1", [&key])?;
    for row in conversations {
        tx.execute(
            "INSERT INTO sidebar_conversations (
                project_path, id, title, created_at, updated_at, kind, journey_id, sort_order,
                effort, model, context_window, permission, archived
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                key,
                row.id,
                row.title,
                row.created_at,
                row.updated_at,
                if row.kind.is_empty() { "chat".to_string() } else { row.kind.clone() },
                row.journey_id,
                row.sort_order,
                row.effort,
                row.model,
                row.context_window.map(|value| value as i64),
                row.permission,
                if row.archived { 1 } else { 0 },
            ],
        )?;
    }
    for row in journeys {
        tx.execute(
            "INSERT INTO sidebar_journeys (
                project_path, id, title, created_at, updated_at, sort_order, collapsed, color
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                key,
                row.id,
                row.title,
                row.created_at,
                row.updated_at,
                row.sort_order,
                if row.collapsed { 1 } else { 0 },
                row.color,
            ],
        )?;
    }
    tx.execute(
        "INSERT INTO sidebar_projects (project_path, refreshed_at, cloud) VALUES (?1, ?2, ?3)
         ON CONFLICT(project_path) DO UPDATE SET refreshed_at = excluded.refreshed_at, cloud = excluded.cloud",
        params![key, now_iso(), if cloud { 1 } else { 0 }],
    )?;
    tx.commit()?;
    Ok(())
}

/// True when the cached sidebar rows came from the paired server, not the local mount.
pub fn sidebar_is_cloud(conn: &Connection, project: &str) -> Result<bool> {
    let cloud: Option<i64> = conn
        .query_row(
            "SELECT cloud FROM sidebar_projects WHERE project_path = ?1",
            [project_key(project)],
            |row| row.get(0),
        )
        .optional()?;
    Ok(cloud == Some(1))
}

/// A cloud transcript by conversation id. The id is enough: these ids are not reused across projects.
pub fn sidebar_transcript_by_id(conn: &Connection, id: &str) -> Result<Option<crate::dev::Conversation>> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    let body: Option<String> = conn
        .query_row(
            "SELECT body FROM sidebar_transcripts WHERE id = ?1 LIMIT 1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(body) = body else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_str(&body)?))
}

/// The last transcript the GUI loaded for a cloud chat. Empty when this chat was never opened here.
pub fn sidebar_transcript(conn: &Connection, project: &str, id: &str) -> Result<Option<crate::dev::Conversation>> {
    let body: Option<String> = conn
        .query_row(
            "SELECT body FROM sidebar_transcripts WHERE project_path = ?1 AND id = ?2",
            params![project_key(project), id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(body) = body else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_str(&body)?))
}

pub fn save_sidebar_transcript(conn: &Connection, project: &str, conversation: &crate::dev::Conversation) -> Result<()> {
    let body = serde_json::to_string(conversation)?;
    conn.execute(
        "INSERT INTO sidebar_transcripts (project_path, id, body) VALUES (?1, ?2, ?3)
         ON CONFLICT(project_path, id) DO UPDATE SET body = excluded.body",
        params![project_key(project), conversation.id, body],
    )?;
    Ok(())
}

/// Every saved transcript for one project, keyed by chat id. Used to paint a cloud chat on click.
pub fn sidebar_transcripts(conn: &Connection, project: &str) -> Result<Vec<crate::dev::Conversation>> {
    let key = project_key(project);
    let mut stmt = conn.prepare("SELECT body FROM sidebar_transcripts WHERE project_path = ?1")?;
    let rows = stmt.query_map([&key], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(serde_json::from_str(&row?)?);
    }
    Ok(out)
}

/// Every indexed project, in sidebar order, with the chats and journeys already copied into app.db.
/// A project that has never been indexed is left out. The caller still reads that project's store.
pub fn sidebar_snapshot(conn: &Connection) -> Result<Vec<crate::dev::SidebarProject>> {
    let projects = list_projects(conn)?;
    let mut chats = conn.prepare(
        "SELECT project_path, id, title, created_at, updated_at, kind, journey_id, sort_order, effort, model, context_window, permission, archived
         FROM sidebar_conversations ORDER BY project_path ASC, sort_order ASC, id ASC",
    )?;
    let chat_rows = chats.query_map([], conversation_summary_row)?;
    let mut by_chat: std::collections::HashMap<String, Vec<crate::dev::ConversationSummary>> = std::collections::HashMap::new();
    for row in chat_rows {
        let (key, summary) = row?;
        by_chat.entry(key).or_default().push(summary);
    }
    let mut journeys_stmt = conn.prepare(
        "SELECT project_path, id, title, created_at, updated_at, sort_order, collapsed, color
         FROM sidebar_journeys ORDER BY project_path ASC, sort_order ASC, id ASC",
    )?;
    let journey_rows = journeys_stmt.query_map([], journey_row)?;
    let mut by_journey: std::collections::HashMap<String, Vec<crate::dev::Journey>> = std::collections::HashMap::new();
    for row in journey_rows {
        let (key, journey) = row?;
        by_journey.entry(key).or_default().push(journey);
    }
    let mut cached = conn.prepare("SELECT project_path, cloud FROM sidebar_projects")?;
    let cached_rows = cached.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? == 1)))?;
    let mut cloud_by_path = std::collections::HashMap::new();
    for row in cached_rows {
        let (key, cloud) = row?;
        cloud_by_path.insert(key, cloud);
    }
    let mut out = Vec::new();
    for project in projects {
        let key = project_key(&project.path);
        let Some(cloud) = cloud_by_path.get(&key).copied() else {
            continue;
        };
        let mut conversations = by_chat.remove(&key).unwrap_or_default();
        if cloud {
            conversations.retain(|row| !is_local_cloud_draft(row));
        }
        out.push(crate::dev::SidebarProject {
            path: project.path,
            name: project.name,
            remote: cloud,
            conversations,
            journeys: by_journey.remove(&key).unwrap_or_default(),
        });
    }
    Ok(out)
}

fn is_local_cloud_draft(row: &crate::dev::ConversationSummary) -> bool {
    let title = row.title.trim();
    (title.is_empty() || title == "New chat") && row.kind != "terminal"
}

fn conversation_summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, crate::dev::ConversationSummary)> {
    let window: Option<i64> = row.get(10)?;
    Ok((
        row.get(0)?,
        crate::dev::ConversationSummary {
            id: row.get(1)?,
            title: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            kind: row.get(5)?,
            journey_id: row.get(6)?,
            sort_order: row.get(7)?,
            effort: row.get(8)?,
            model: row.get(9)?,
            context_window: window.and_then(|value| u64::try_from(value).ok()),
            permission: row.get(11)?,
            archived: row.get::<_, i64>(12)? != 0,
        },
    ))
}

fn journey_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, crate::dev::Journey)> {
    Ok((
        row.get(0)?,
        crate::dev::Journey {
            id: row.get(1)?,
            title: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            sort_order: row.get(5)?,
            collapsed: row.get::<_, i64>(6)? != 0,
            color: row.get(7)?,
        },
    ))
}

pub fn sidebar_for(
    conn: &Connection,
    project: &str,
) -> Result<(Vec<crate::dev::ConversationSummary>, Vec<crate::dev::Journey>)> {
    let key = project_key(project);
    let mut chats = conn.prepare(
        "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, effort, model, context_window, permission, archived
         FROM sidebar_conversations WHERE project_path = ?1 ORDER BY sort_order ASC, id ASC",
    )?;
    let chat_rows = chats.query_map([&key], |row| {
        let window: Option<i64> = row.get(9)?;
        Ok(crate::dev::ConversationSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            kind: row.get(4)?,
            journey_id: row.get(5)?,
            sort_order: row.get(6)?,
            effort: row.get(7)?,
            model: row.get(8)?,
            context_window: window.and_then(|value| u64::try_from(value).ok()),
            permission: row.get(10)?,
            archived: row.get::<_, i64>(11)? != 0,
        })
    })?;
    let mut conversations = Vec::new();
    for row in chat_rows {
        conversations.push(row?);
    }
    let mut journeys_stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, sort_order, collapsed, color
         FROM sidebar_journeys WHERE project_path = ?1 ORDER BY sort_order ASC, id ASC",
    )?;
    let journey_rows = journeys_stmt.query_map([&key], |row| {
        Ok(crate::dev::Journey {
            id: row.get(0)?,
            title: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            sort_order: row.get(4)?,
            collapsed: row.get::<_, i64>(5)? != 0,
            color: row.get(6)?,
        })
    })?;
    let mut journeys = Vec::new();
    for row in journey_rows {
        journeys.push(row?);
    }
    Ok((conversations, journeys))
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

/// Drop the copied chat list for one folder. The list is what the sidebar paints,
/// so leaving it brings the conversations back after the folder is created again.
pub fn clear_sidebar(conn: &Connection, path: &str) -> Result<()> {
    let key = project_key(path);
    conn.execute("DELETE FROM sidebar_conversations WHERE project_path = ?1", [&key])?;
    conn.execute("DELETE FROM sidebar_journeys WHERE project_path = ?1", [&key])?;
    conn.execute("DELETE FROM sidebar_transcripts WHERE project_path = ?1", [&key])?;
    conn.execute("DELETE FROM sidebar_projects WHERE project_path = ?1", [&key])?;
    Ok(())
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

/// Last account-usage snapshot for a provider. The sidebar paints this before the network refresh.
pub fn get_account_usage(conn: &Connection, provider: &str) -> Result<Option<String>> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT payload FROM account_usage WHERE provider = ?1",
        [provider],
        |row| row.get(0),
    )
    .optional()
    .map_err(Error::from)
}

/// The last pull-request list for one GitHub `owner/repo`. Null until one refresh has landed.
pub fn get_pull_requests(conn: &Connection, repo: &str) -> Result<Option<String>> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT payload FROM pull_requests WHERE repo = ?1",
        [repo],
        |row| row.get(0),
    )
    .optional()
    .map_err(Error::from)
}

pub fn set_pull_requests(conn: &Connection, repo: &str, payload: &str) -> Result<()> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err(Error::Other("pull request repo is empty".into()));
    }
    conn.execute(
        "INSERT INTO pull_requests (repo, payload, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(repo) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
        params![repo, payload, now_iso()],
    )?;
    Ok(())
}

pub fn set_account_usage(conn: &Connection, provider: &str, payload: &str) -> Result<()> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Err(Error::Other("account usage provider is empty".into()));
    }
    conn.execute(
        "INSERT INTO account_usage (provider, payload, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(provider) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
        params![provider, payload, now_iso()],
    )?;
    Ok(())
}

/// Old path to current path. A moved project keeps its `store.db` through this list.
pub fn project_path_moves(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT path, previous_paths FROM project_path_history")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (path, raw) = row?;
        let previous: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        for from in previous {
            if path_key(&from) != path_key(&path) {
                out.push((from, path.clone()));
            }
        }
    }
    Ok(out)
}

/// Paths a workspace used to live at, so its chat database can be found after a move.
pub fn previous_paths_for(conn: &Connection, path: &str) -> Result<Vec<String>> {
    let key = path_key(path);
    let mut stmt = conn.prepare("SELECT path, previous_paths FROM project_path_history")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (current, raw) = row?;
        let previous: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        if path_key(&current) == key {
            out.extend(previous);
            continue;
        }
        if previous.iter().any(|item| path_key(item) == key) {
            out.push(current);
        }
    }
    Ok(out)
}

pub fn remember_project_move(conn: &Connection, name: &str, to: &str, from: &str) -> Result<()> {
    if path_key(from) == path_key(to) {
        return Ok(());
    }
    let mut stmt = conn.prepare("SELECT path, name, previous_paths FROM project_path_history")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut match_path: Option<String> = None;
    let mut previous = Vec::new();
    for row in rows {
        let (path, _, raw) = row?;
        let stored: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        if path_key(&path) == path_key(to) || stored.iter().any(|item| path_key(item) == path_key(from)) {
            match_path = Some(path);
            previous = stored;
            break;
        }
    }
    if !previous.iter().any(|item| path_key(item) == path_key(from)) {
        previous.push(from.to_string());
    }
    let encoded = serde_json::to_string(&previous)?;
    if let Some(old) = match_path {
        conn.execute("DELETE FROM project_path_history WHERE path = ?1", [&old])?;
    }
    conn.execute(
        "INSERT INTO project_path_history (path, name, previous_paths) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, previous_paths = excluded.previous_paths",
        params![to, name, encoded],
    )?;
    Ok(())
}

/// Drop a project and every path it used to have. Returns those paths so their chat stores can go too.
pub fn forget_project_paths(conn: &Connection, path: &str) -> Result<Vec<String>> {
    let key = path_key(path);
    let mut stmt = conn.prepare("SELECT path, previous_paths FROM project_path_history")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut related = vec![path.to_string()];
    let mut drop_paths = Vec::new();
    for row in rows {
        let (current, raw) = row?;
        let previous: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        let hit = path_key(&current) == key || previous.iter().any(|item| path_key(item) == key);
        if !hit {
            continue;
        }
        related.push(current.clone());
        related.extend(previous);
        drop_paths.push(current);
    }
    for item in drop_paths {
        conn.execute("DELETE FROM project_path_history WHERE path = ?1", [item])?;
    }
    Ok(related)
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

#[cfg(test)]
fn list_settings(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
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
pub fn dev_app_reorder_projects(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<FolderSuggestion>> {
    let conn = open(&state.data_dir)?;
    reorder_projects(&conn, &paths)
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
    fn rename_project_path_keeps_the_sidebar_place_and_cache() {
        let data = tempdir().unwrap();
        let from = tempdir().unwrap();
        let to = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let added = add_project(&conn, from.path()).unwrap();
        let chat = crate::dev::ConversationSummary {
            id: "c1".into(),
            title: "Hello".into(),
            created_at: "t0".into(),
            updated_at: "t1".into(),
            kind: "chat".into(),
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        };
        replace_sidebar(&conn, &added.path, &[chat], &[]).unwrap();
        let next = path_string(to.path());
        assert!(rename_project_path(&conn, &added.path, &next).unwrap());
        let rows = list_projects(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, next);
        let (chats, _) = sidebar_for(&conn, &next).unwrap();
        assert_eq!(chats[0].title, "Hello");
        assert!(sidebar_for(&conn, &added.path).unwrap().0.is_empty());
        assert!(!rename_project_path(&conn, "/missing", &next).unwrap());
    }

    #[test]
    fn reorder_projects_keeps_unknown_rows_and_skips_missing_paths() {
        let data = tempdir().unwrap();
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let c = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let first = add_project(&conn, a.path()).unwrap();
        let second = add_project(&conn, b.path()).unwrap();
        let third = add_project(&conn, c.path()).unwrap();
        let third_path = third.path.clone();
        let rows = reorder_projects(&conn, &[third.path, first.path.clone(), "/missing".into()]).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.path.clone()).collect::<Vec<_>>(),
            vec![third_path.clone(), first.path, second.path]
        );
        let again = list_projects(&conn).unwrap();
        assert_eq!(again[0].path, third_path);
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

    #[test]
    fn sidebar_index_replaces_one_project_and_keeps_the_other() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let chat = crate::dev::ConversationSummary {
            id: "c1".into(),
            title: "Hello".into(),
            created_at: "t0".into(),
            updated_at: "t1".into(),
            kind: "chat".into(),
            journey_id: None,
            sort_order: 2,
            effort: Some("low".into()),
            model: Some("grok-4".into()),
            context_window: Some(256_000),
            permission: None,
            archived: false,
        };
        let journey = crate::dev::Journey {
            id: "j1".into(),
            title: "Work".into(),
            created_at: "t0".into(),
            updated_at: "t1".into(),
            sort_order: 1,
            collapsed: true,
            color: "blue".into(),
        };
        assert!(!sidebar_cached(&conn, "/app/Alpha").unwrap());
        replace_sidebar(&conn, "/app/Alpha/", &[chat.clone()], &[journey]).unwrap();
        replace_sidebar(&conn, "/app/beta", &[], &[]).unwrap();
        let (chats, journeys) = sidebar_for(&conn, "/app/alpha").unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0].title, "Hello");
        assert_eq!(chats[0].sort_order, 2);
        assert_eq!(journeys[0].collapsed, true);
        assert!(sidebar_cached(&conn, "/app/alpha").unwrap());
        assert!(!sidebar_is_cloud(&conn, "/app/alpha").unwrap());
        replace_sidebar_source(&conn, "/app/alpha", &[chat.clone()], &[], true).unwrap();
        assert!(sidebar_is_cloud(&conn, "/app/alpha").unwrap());
        let transcript = crate::dev::Conversation {
            id: chat.id.clone(),
            title: chat.title.clone(),
            created_at: chat.created_at.clone(),
            updated_at: chat.updated_at.clone(),
            kind: chat.kind.clone(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            context_usage: None,
            compaction: None,
            journey_id: None,
            sort_order: chat.sort_order,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        };
        save_sidebar_transcript(&conn, "/app/alpha", &transcript).unwrap();
        let loaded = sidebar_transcript(&conn, "/app/Alpha/", &chat.id).unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);
        replace_sidebar(&conn, "/app/alpha", &[], &[]).unwrap();
        let (chats, journeys) = sidebar_for(&conn, "/app/alpha").unwrap();
        assert!(chats.is_empty() && journeys.is_empty());
        assert!(!sidebar_is_cloud(&conn, "/app/alpha").unwrap());
        assert!(sidebar_transcript(&conn, "/app/alpha", "c1").unwrap().is_some());
        assert!(sidebar_cached(&conn, "/app/beta").unwrap());
    }

    fn chat(id: &str, title: &str, updated_at: &str) -> crate::dev::ConversationSummary {
        crate::dev::ConversationSummary {
            id: id.into(),
            title: title.into(),
            created_at: "t0".into(),
            updated_at: updated_at.into(),
            kind: "chat".into(),
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        }
    }

    #[test]
    fn upsert_sidebar_conversation_updates_one_row_and_does_not_mark_uncached() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        let journey = crate::dev::Journey {
            id: "j1".into(),
            title: "Work".into(),
            created_at: "t0".into(),
            updated_at: "t1".into(),
            sort_order: 1,
            collapsed: true,
            color: "blue".into(),
        };
        replace_sidebar(
            &conn,
            "/app/alpha",
            &[chat("c1", "Hello", "t1"), chat("c2", "Other", "t2")],
            &[journey.clone()],
        )
        .unwrap();
        let mut updated = chat("c1", "Renamed", "t9");
        updated.sort_order = 4;
        updated.effort = Some("high".into());
        upsert_sidebar_conversation(&conn, "/app/Alpha/", &updated).unwrap();

        let (chats, journeys) = sidebar_for(&conn, "/app/alpha").unwrap();
        assert_eq!(chats.len(), 2);
        let c1 = chats.iter().find(|row| row.id == "c1").unwrap();
        let c2 = chats.iter().find(|row| row.id == "c2").unwrap();
        assert_eq!(c1.title, "Renamed");
        assert_eq!(c1.updated_at, "t9");
        assert_eq!(c1.sort_order, 4);
        assert_eq!(c1.effort.as_deref(), Some("high"));
        assert_eq!(c2.title, "Other");
        assert_eq!(c2.updated_at, "t2");
        assert_eq!(c2.sort_order, 0);
        assert_eq!(journeys.len(), 1);
        assert_eq!(journeys[0].id, journey.id);
        assert_eq!(journeys[0].title, journey.title);
        assert_eq!(journeys[0].collapsed, journey.collapsed);
        assert!(sidebar_cached(&conn, "/app/alpha").unwrap());

        upsert_sidebar_conversation(&conn, "/app/new", &chat("c9", "Fresh", "t3")).unwrap();
        assert!(!sidebar_cached(&conn, "/app/new").unwrap());
        let (fresh, fresh_journeys) = sidebar_for(&conn, "/app/new").unwrap();
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].title, "Fresh");
        assert!(fresh_journeys.is_empty());
        let (chats, _) = sidebar_for(&conn, "/app/alpha").unwrap();
        assert_eq!(chats.len(), 2);
    }

    #[test]
    fn an_old_sidebar_projects_table_gains_the_cloud_column() {
        let data = tempdir().unwrap();
        let path = data.path().join("app.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sidebar_projects (
                    project_path TEXT PRIMARY KEY,
                    refreshed_at TEXT NOT NULL
                );",
            )
            .unwrap();
        }
        let conn = open(data.path()).unwrap();
        replace_sidebar_source(&conn, "/mounts/cloud", &[], &[], true).unwrap();
        assert!(sidebar_is_cloud(&conn, "/mounts/cloud").unwrap());
    }

    #[test]
    fn an_old_provider_keys_table_gains_the_value_column() {
        let data = tempdir().unwrap();
        let path = data.path().join("app.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE provider_keys (provider TEXT PRIMARY KEY);")
                .unwrap();
        }
        let conn = open(data.path()).unwrap();
        set_provider_key(&conn, "xai", "xai-secret").unwrap();
        assert_eq!(get_provider_key(&conn, "xai").unwrap().as_deref(), Some("xai-secret"));
    }

    #[test]
    fn provider_keys_roundtrip_and_stay_out_of_settings() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        assert!(get_provider_key(&conn, "xai").unwrap().is_none());
        set_provider_key(&conn, "xai", " xai-secret ").unwrap();
        set_provider_key(&conn, "anthropic", "anthropic-secret").unwrap();
        assert_eq!(get_provider_key(&conn, "xai").unwrap().as_deref(), Some("xai-secret"));
        set_provider_key(&conn, "xai", "").unwrap();
        assert!(get_provider_key(&conn, "xai").unwrap().is_none());
        assert_eq!(
            get_provider_key(&conn, "anthropic").unwrap().as_deref(),
            Some("anthropic-secret")
        );
        delete_provider_key(&conn, "anthropic").unwrap();
        assert!(get_provider_key(&conn, "anthropic").unwrap().is_none());
        assert!(list_settings(&conn).unwrap().is_empty());
        assert!(set_provider_key(&conn, "  ", "nope").is_err());
    }

    #[test]
    fn pull_request_cache_roundtrip() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        assert!(get_pull_requests(&conn, "TwanLuttik/TwanAgent").unwrap().is_none());
        set_pull_requests(&conn, "TwanLuttik/TwanAgent", r#"[{"number":5}]"#).unwrap();
        set_pull_requests(&conn, "TwanLuttik/TwanAgent", r#"[{"number":6}]"#).unwrap();
        set_pull_requests(&conn, "other/repo", "[]").unwrap();
        assert_eq!(
            get_pull_requests(&conn, "TwanLuttik/TwanAgent").unwrap().as_deref(),
            Some(r#"[{"number":6}]"#)
        );
        assert!(set_pull_requests(&conn, "  ", "[]").is_err());
    }

    #[test]
    fn account_usage_cache_roundtrip() {
        let data = tempdir().unwrap();
        let conn = open(data.path()).unwrap();
        assert!(get_account_usage(&conn, "anthropic").unwrap().is_none());
        set_account_usage(&conn, "anthropic", r#"{"connected":true}"#).unwrap();
        set_account_usage(&conn, "anthropic", r#"{"connected":false}"#).unwrap();
        set_account_usage(&conn, "minimax", r#"{"connected":true}"#).unwrap();
        assert_eq!(
            get_account_usage(&conn, "anthropic").unwrap().as_deref(),
            Some(r#"{"connected":false}"#)
        );
        assert_eq!(
            get_account_usage(&conn, "minimax").unwrap().as_deref(),
            Some(r#"{"connected":true}"#)
        );
        assert!(set_account_usage(&conn, "  ", "{}").is_err());
    }
}
