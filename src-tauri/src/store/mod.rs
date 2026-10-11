use std::collections::HashMap;
use std::fs;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::dev::{Conversation, DevChatUsage};
use crate::error::Result;

const SCHEMA_VERSION: i64 = 10;

pub fn db_path(dir: &Path) -> PathBuf {
    dir.join("store.db")
}

fn json_path(dir: &Path) -> PathBuf {
    dir.join("conversations.json")
}

pub fn knowledge_path(dir: &Path, journey_id: &str) -> PathBuf {
    dir.join("journeys").join(format!("{journey_id}.md"))
}

type SharedConn = Arc<Mutex<Connection>>;

fn conn_cache() -> &'static Mutex<HashMap<PathBuf, SharedConn>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, SharedConn>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Process-wide lock held only while a database file is created or first migrated.
/// Later opens of an already-cached connection do not take it.
fn create_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn cache_key(dir: &Path) -> PathBuf {
    fs::canonicalize(dir).unwrap_or_else(|_| {
        if dir.is_absolute() {
            dir.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(dir))
                .unwrap_or_else(|_| dir.to_path_buf())
        }
    })
}

fn cached(dir: &Path) -> Option<SharedConn> {
    let key = cache_key(dir);
    let guard = conn_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.get(&key).cloned()
}

fn remember(dir: &Path, shared: SharedConn) -> SharedConn {
    let key = cache_key(dir);
    let mut guard = conn_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.entry(key).or_insert(shared).clone()
}

fn forget(dir: &Path) {
    let key = cache_key(dir);
    let mut guard = conn_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.remove(&key);
}

/// Run `f` against the cached connection for `dir`, locking only that database.
pub fn with_conn<T>(dir: &Path, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let conn = open(dir)?;
    f(&conn)
}

/// Cached connection for one synchronous caller. Derefs to [`Connection`].
///
/// Holds the per-database mutex for its lifetime. Poison after the schema
/// exists is recovered with `into_inner`. First-time migration never runs
/// twice: it finishes before the connection is cached, under the process-wide
/// create lock only.
pub struct Conn {
    // Drop order is reverse of declaration, so `guard` unlocks before `owner`.
    guard: MutexGuard<'static, Connection>,
    #[allow(dead_code)]
    owner: SharedConn,
}

impl Conn {
    fn lock(owner: SharedConn) -> Self {
        // `'static` only lets the guard sit beside the Arc that owns the mutex.
        // `owner` keeps that allocation alive and is dropped after `guard`.
        let guard = unsafe {
            let mutex: &'static Mutex<Connection> = &*Arc::as_ptr(&owner);
            std::mem::transmute::<MutexGuard<'_, Connection>, MutexGuard<'static, Connection>>(
                mutex.lock().unwrap_or_else(|e| e.into_inner()),
            )
        };
        Self { guard, owner }
    }
}

impl Deref for Conn {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.guard
    }
}

impl DerefMut for Conn {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.guard
    }
}

fn open_shared(dir: &Path) -> Result<SharedConn> {
    if let Some(shared) = cached(dir) {
        return Ok(shared);
    }
    // Only the first create/migration takes the process-wide lock. A poisoned
    // create lock is not recovered here: two racers must not both migrate.
    let _guard = create_lock().lock().map_err(|_| {
        crate::error::Error::Other("conversation store create lock poisoned".into())
    })?;
    if let Some(shared) = cached(dir) {
        return Ok(shared);
    }
    match open_new(dir) {
        Ok(conn) => Ok(remember(dir, Arc::new(Mutex::new(conn)))),
        Err(e) => {
            forget(dir);
            Err(e)
        }
    }
}

fn open_new(dir: &Path) -> Result<Connection> {
    fs::create_dir_all(dir)?;
    let db = db_path(dir);
    let json = json_path(dir);
    if db.exists() {
        return connect(&db);
    }
    if json.exists() {
        let tmp = dir.join("store.db.tmp");
        let _ = fs::remove_file(&tmp);
        if let Err(e) = migrate_json(&json, &tmp) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        fs::rename(&tmp, &db)?;
        return connect(&db);
    }
    connect(&db)
}

/// Open the project conversation store. One connection is cached per directory;
/// the returned guard locks only that database. A later `open` of the same dir
/// waits for this guard, then sees the same data. Schema migration runs once,
/// before the connection is cached, under the process-wide create lock.
pub fn open(dir: &Path) -> Result<Conn> {
    Ok(Conn::lock(open_shared(dir)?))
}

fn connect(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
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
        CREATE TABLE IF NOT EXISTS journeys (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            collapsed INTEGER NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'chat',
            journey_id TEXT REFERENCES journeys(id) ON DELETE SET NULL,
            sort_order INTEGER NOT NULL,
            context_usage TEXT,
            compaction TEXT,
            effort TEXT,
            model TEXT,
            context_window INTEGER,
            permission TEXT,
            archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            sort_order INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_calls TEXT,
            tool_call_id TEXT,
            images TEXT,
            reasoning TEXT,
            duration_ms INTEGER,
            finished_at TEXT
        );
        ",
    )?;
    let version: Option<i64> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    if version.unwrap_or(0) < 2 {
        let _ = conn.execute(
            "ALTER TABLE journeys ADD COLUMN color TEXT NOT NULL DEFAULT ''",
            [],
        );
    }
    if version.unwrap_or(0) < 3 {
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN images TEXT", []);
    }
    if version.unwrap_or(0) < 4 {
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN compaction TEXT", []);
    }
    if version.unwrap_or(0) < 5 {
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN reasoning TEXT", []);
    }
    if version.unwrap_or(0) < 6 {
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN duration_ms INTEGER", []);
    }
    if version.unwrap_or(0) < 7 {
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN effort TEXT", []);
    }
    if version.unwrap_or(0) < 8 {
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            [],
        );
    }
    if version.unwrap_or(0) < 9 {
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN model TEXT", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN context_window INTEGER", []);
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN permission TEXT", []);
    }
    if version.unwrap_or(0) < 10 {
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN finished_at TEXT", []);
    }
    if version != Some(SCHEMA_VERSION) {
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?1)",
            [SCHEMA_VERSION],
        )?;
    }
    Ok(())
}

fn migrate_json(json: &Path, db_path: &Path) -> Result<()> {
    let data = fs::read_to_string(json)?;
    let rows: Vec<Conversation> = if data.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&data)?
    };
    let conn = connect(db_path)?;
    for (i, row) in rows.iter().enumerate() {
        insert_conversation(&conn, row, i as i64)?;
    }
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn insert_conversation(conn: &Connection, conv: &Conversation, sort_order: i64) -> Result<()> {
    let usage = conv
        .context_usage
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let compaction = conv
        .compaction
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let effort = conv.effort.as_ref().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let model = conv.model.as_ref().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let permission = conv.permission.as_ref().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let context_window = conv.context_window.filter(|value| *value > 0);
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage, compaction, effort, model, context_window, permission, archived)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            conv.id,
            conv.title,
            conv.created_at,
            conv.updated_at,
            if conv.kind.is_empty() {
                "chat".to_string()
            } else {
                conv.kind.clone()
            },
            conv.journey_id,
            sort_order,
            usage,
            compaction,
            effort,
            model,
            context_window.map(|value| value as i64),
            permission,
            if conv.archived { 1 } else { 0 },
        ],
    )?;
    replace_messages(conn, &conv.id, &conv.messages)?;
    Ok(())
}

fn message_columns(msg: &Value) -> Result<MessageColumns> {
    let role = msg
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user")
        .to_string();
    let content = msg.get("content").cloned();
    let content_text = match content {
        Some(Value::String(s)) => Some(s),
        Some(other) => Some(other.to_string()),
        None => None,
    };
    let tool_calls = msg
        .get("tool_calls")
        .map(|v| serde_json::to_string(v))
        .transpose()?;
    let tool_call_id = msg
        .get("tool_call_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let images = msg
        .get("images")
        .filter(|v| !v.is_null())
        .map(serde_json::to_string)
        .transpose()?;
    let reasoning = msg
        .get("reasoning")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty());
    let duration_ms = msg
        .get("durationMs")
        .and_then(Value::as_i64)
        .filter(|ms| *ms >= 0);
    let finished_at = msg
        .get("finishedAt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    Ok(MessageColumns {
        role,
        content_text,
        tool_calls,
        tool_call_id,
        images,
        reasoning,
        duration_ms,
        finished_at,
    })
}

struct MessageColumns {
    role: String,
    content_text: Option<String>,
    tool_calls: Option<String>,
    tool_call_id: Option<String>,
    images: Option<String>,
    reasoning: Option<String>,
    duration_ms: Option<i64>,
    finished_at: Option<String>,
}

fn insert_message(
    stmt: &mut rusqlite::Statement<'_>,
    conversation_id: &str,
    sort_order: i64,
    msg: &Value,
) -> Result<()> {
    let cols = message_columns(msg)?;
    stmt.execute(params![
        conversation_id,
        sort_order,
        cols.role,
        cols.content_text,
        cols.tool_calls,
        cols.tool_call_id,
        cols.images,
        cols.reasoning,
        cols.duration_ms,
        cols.finished_at,
    ])?;
    Ok(())
}

fn replace_messages(conn: &Connection, conversation_id: &str, messages: &[Value]) -> Result<()> {
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        [conversation_id],
    )?;
    let mut stmt = conn.prepare(
        "INSERT INTO messages (conversation_id, sort_order, role, content, tool_calls, tool_call_id, images, reasoning, duration_ms, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for (i, msg) in messages.iter().enumerate() {
        insert_message(&mut stmt, conversation_id, i as i64, msg)?;
    }
    Ok(())
}

/// Keep messages that already match the stored prefix. Rewrite from the first difference.
fn sync_messages(conn: &Connection, conversation_id: &str, messages: &[Value]) -> Result<()> {
    let stored = load_messages(conn, conversation_id)?;
    let mut prefix = 0;
    while prefix < stored.len() && prefix < messages.len() && stored[prefix] == messages[prefix] {
        prefix += 1;
    }
    if prefix == stored.len() && prefix == messages.len() {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1 AND sort_order >= ?2",
        params![conversation_id, prefix as i64],
    )?;
    if prefix >= messages.len() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "INSERT INTO messages (conversation_id, sort_order, role, content, tool_calls, tool_call_id, images, reasoning, duration_ms, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for (i, msg) in messages.iter().enumerate().skip(prefix) {
        insert_message(&mut stmt, conversation_id, i as i64, msg)?;
    }
    Ok(())
}

fn load_messages(conn: &Connection, conversation_id: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT role, content, tool_calls, tool_call_id, images, reasoning, duration_ms, finished_at FROM messages
         WHERE conversation_id = ?1 ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = stmt.query_map([conversation_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<String>>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (role, content, tool_calls, tool_call_id, images, reasoning, duration_ms, finished_at) = row?;
        let mut obj = serde_json::Map::new();
        obj.insert("role".into(), Value::String(role));
        if let Some(text) = content {
            obj.insert("content".into(), Value::String(text));
        }
        if let Some(raw) = tool_calls {
            obj.insert("tool_calls".into(), serde_json::from_str(&raw)?);
        }
        if let Some(id) = tool_call_id {
            obj.insert("tool_call_id".into(), Value::String(id));
        }
        if let Some(raw) = images {
            if !raw.trim().is_empty() {
                obj.insert("images".into(), serde_json::from_str(&raw)?);
            }
        }
        if let Some(text) = reasoning.filter(|value| !value.trim().is_empty()) {
            obj.insert("reasoning".into(), Value::String(text));
        }
        if let Some(ms) = duration_ms.filter(|value| *value >= 0) {
            obj.insert("durationMs".into(), Value::from(ms));
        }
        if let Some(text) = finished_at.filter(|value| !value.trim().is_empty()) {
            obj.insert("finishedAt".into(), Value::String(text));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

fn parse_usage(raw: Option<String>) -> Result<Option<DevChatUsage>> {
    match raw {
        Some(text) if !text.trim().is_empty() => Ok(Some(serde_json::from_str(&text)?)),
        _ => Ok(None),
    }
}

fn parse_compaction(raw: Option<String>) -> Result<Option<crate::dev::DevCompaction>> {
    match raw {
        Some(text) if !text.trim().is_empty() => Ok(Some(serde_json::from_str(&text)?)),
        _ => Ok(None),
    }
}

fn row_to_conversation(
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    kind: String,
    journey_id: Option<String>,
    sort_order: i64,
    usage: Option<String>,
    compaction: Option<String>,
    effort: Option<String>,
    model: Option<String>,
    context_window: Option<i64>,
    permission: Option<String>,
    archived: bool,
    messages: Vec<Value>,
) -> Result<Conversation> {
    Ok(Conversation {
        id,
        title,
        created_at,
        updated_at,
        kind: if kind.is_empty() { "chat".into() } else { kind },
        messages,
        context_usage: parse_usage(usage)?,
        compaction: parse_compaction(compaction)?,
        journey_id,
        sort_order,
        effort: effort.filter(|value| !value.trim().is_empty()),
        model: model.filter(|value| !value.trim().is_empty()),
        context_window: context_window.and_then(|value| u64::try_from(value).ok()).filter(|value| *value > 0),
        permission: permission.filter(|value| !value.trim().is_empty()),
        archived,
    })
}

fn next_sort(conn: &Connection, journey_id: Option<&str>) -> Result<i64> {
    let min: Option<i64> = if let Some(jid) = journey_id {
        conn.query_row(
            "SELECT MIN(sort_order) FROM conversations WHERE journey_id = ?1",
            [jid],
            |row| row.get(0),
        )?
    } else {
        let conv_min: Option<i64> = conn.query_row(
            "SELECT MIN(sort_order) FROM conversations WHERE journey_id IS NULL",
            [],
            |row| row.get(0),
        )?;
        let journey_min: Option<i64> =
            conn.query_row("SELECT MIN(sort_order) FROM journeys", [], |row| row.get(0))?;
        match (conv_min, journey_min) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
    };
    Ok(min.map(|n| n - 1).unwrap_or(0))
}

fn max_sort(conn: &Connection, journey_id: Option<&str>) -> Result<i64> {
    let max: Option<i64> = if let Some(jid) = journey_id {
        conn.query_row(
            "SELECT MAX(sort_order) FROM conversations WHERE journey_id = ?1",
            [jid],
            |row| row.get(0),
        )?
    } else {
        let conv_max: Option<i64> = conn.query_row(
            "SELECT MAX(sort_order) FROM conversations WHERE journey_id IS NULL",
            [],
            |row| row.get(0),
        )?;
        let journey_max: Option<i64> =
            conn.query_row("SELECT MAX(sort_order) FROM journeys", [], |row| row.get(0))?;
        match (conv_max, journey_max) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
    };
    Ok(max.unwrap_or(-1))
}

mod conversations;
mod journeys;

pub use conversations::{
    delete_conversation, get_conversation, list_conversation_summaries, reorder_conversations,
    save_conversation, set_conversation_archived,
};
#[cfg(test)]
pub use conversations::list_conversations;
pub use journeys::{
    create_journey, delete_journey, get_knowledge, list_journeys, move_conversation,
    rename_journey, reorder_sidebar, save_knowledge, set_journey_collapsed, set_journey_color,
    update_knowledge,
};

#[cfg(test)]
mod tests;
