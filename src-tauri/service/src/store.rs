//! Conversation rows the headless server saves.
//!
//! A server project keeps this database on the server. The columns match the desktop
//! store, so journeys, order, archive, and usage survive a sync.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journey_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

fn default_kind() -> String {
    "chat".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journey_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

pub fn db_path(dir: &Path) -> PathBuf {
    dir.join("store.db")
}

pub fn open(dir: &Path) -> Result<Connection> {
    fs::create_dir_all(dir)?;
    let conn = Connection::open(db_path(dir))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // One writer at a time. A turn and a sidebar save must not delete each other's rows.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "
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
            journey_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
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
            body TEXT NOT NULL
        );
        ",
    )?;
    Ok(conn)
}

pub fn with_conn<T>(dir: &Path, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    f(&open(dir)?)
}

pub fn list_conversation_summaries(conn: &Connection) -> Result<Vec<ConversationSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, effort, model, context_window, permission, archived
         FROM conversations ORDER BY sort_order ASC, updated_at DESC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let window: Option<i64> = row.get(9)?;
        Ok(ConversationSummary {
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
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_conversation(conn: &Connection, id: &str) -> Result<Conversation> {
    let head = conn
        .query_row(
            "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage, compaction, effort, model, context_window, permission, archived
             FROM conversations WHERE id = ?1",
            [id],
            |row| {
                let window: Option<i64> = row.get(11)?;
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    kind: row.get(4)?,
                    messages: Vec::new(),
                    context_usage: row.get::<_, Option<String>>(7)?.and_then(|raw| serde_json::from_str(&raw).ok()),
                    compaction: row.get::<_, Option<String>>(8)?.and_then(|raw| serde_json::from_str(&raw).ok()),
                    journey_id: row.get(5)?,
                    sort_order: row.get(6)?,
                    effort: row.get(9)?,
                    model: row.get(10)?,
                    context_window: window.and_then(|value| u64::try_from(value).ok()),
                    permission: row.get(12)?,
                    archived: row.get::<_, i64>(13)? != 0,
                })
            },
        )
        .optional()?;
    let Some(mut conversation) = head else {
        return Err(Error::NotFound("conversation not found".into()));
    };
    conversation.messages = load_messages(conn, id)?;
    Ok(conversation)
}

pub fn save_conversation(conn: &Connection, conversation: &Conversation) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let saved = save_conversation_in(conn, conversation);
    match saved {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

fn save_conversation_in(conn: &Connection, conversation: &Conversation) -> Result<()> {
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage, compaction, effort, model, context_window, permission, archived)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            updated_at = excluded.updated_at,
            kind = excluded.kind,
            journey_id = excluded.journey_id,
            sort_order = excluded.sort_order,
            context_usage = excluded.context_usage,
            compaction = excluded.compaction,
            effort = excluded.effort,
            model = excluded.model,
            context_window = excluded.context_window,
            permission = excluded.permission,
            archived = excluded.archived",
        params![
            conversation.id,
            conversation.title,
            conversation.created_at,
            conversation.updated_at,
            if conversation.kind.is_empty() { "chat".to_string() } else { conversation.kind.clone() },
            conversation.journey_id,
            conversation.sort_order,
            conversation.context_usage.as_ref().map(|value| value.to_string()),
            conversation.compaction.as_ref().map(|value| value.to_string()),
            conversation.effort,
            conversation.model,
            conversation.context_window.map(|value| value as i64),
            conversation.permission,
            if conversation.archived { 1 } else { 0 },
        ],
    )?;
    conn.execute("DELETE FROM messages WHERE conversation_id = ?1", [&conversation.id])?;
    let mut stmt = conn.prepare(
        "INSERT INTO messages (conversation_id, sort_order, body) VALUES (?1, ?2, ?3)",
    )?;
    for (index, message) in conversation.messages.iter().enumerate() {
        stmt.execute(params![conversation.id, index as i64, message.to_string()])?;
    }
    Ok(())
}

pub fn delete_conversation(conn: &Connection, id: &str) -> Result<()> {
    let n = conn.execute("DELETE FROM conversations WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(Error::NotFound("conversation not found".into()));
    }
    Ok(())
}

pub fn set_archived(conn: &Connection, id: &str, archived: bool) -> Result<()> {
    let n = conn.execute(
        "UPDATE conversations SET archived = ?1, updated_at = ?2 WHERE id = ?3",
        params![if archived { 1 } else { 0 }, now_iso(), id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("conversation not found".into()));
    }
    Ok(())
}

pub fn reorder_conversations(conn: &Connection, ids: &[String]) -> Result<Vec<ConversationSummary>> {
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE conversations SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )?;
    }
    list_conversation_summaries(conn)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn load_messages(conn: &Connection, id: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT body FROM messages WHERE conversation_id = ?1 ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = stmt.query_map([id], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(serde_json::from_str(&row?)?);
    }
    Ok(out)
}
