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
    // Chats that share a sort_order used to jump by updated_at. Freeze the order they have now
    // so a later reply does not move them. Rows that already have their own place are left alone.
    freeze_tied_orders(&conn)?;
    Ok(conn)
}

pub fn with_conn<T>(dir: &Path, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    f(&open(dir)?)
}

pub fn list_conversation_summaries(conn: &Connection) -> Result<Vec<ConversationSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, effort, model, context_window, permission, archived
         FROM conversations ORDER BY sort_order ASC, id ASC",
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
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM conversations WHERE id = ?1",
            [&conversation.id],
            |row| row.get(0),
        )
        .optional()?;
    let kind = if conversation.kind.is_empty() {
        "chat".to_string()
    } else {
        conversation.kind.clone()
    };
    let usage = conversation.context_usage.as_ref().map(|value| value.to_string());
    let compaction = conversation.compaction.as_ref().map(|value| value.to_string());
    let window = conversation.context_window.map(|value| value as i64);
    if exists.is_some() {
        // Place, journey, and archive have their own commands. A finished turn must not
        // put the chat back at sort_order 0, which is what made it jump up the list.
        conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2, kind = ?3,
             context_usage = ?4, compaction = ?5, effort = ?6, model = ?7,
             context_window = ?8, permission = ?9
             WHERE id = ?10",
            params![
                conversation.title,
                conversation.updated_at,
                kind,
                usage,
                compaction,
                conversation.effort,
                conversation.model,
                window,
                conversation.permission,
                conversation.id,
            ],
        )?;
    } else {
        let sort = next_sort(conn, conversation.journey_id.as_deref())?;
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage, compaction, effort, model, context_window, permission, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                conversation.id,
                conversation.title,
                conversation.created_at,
                conversation.updated_at,
                kind,
                conversation.journey_id,
                sort,
                usage,
                compaction,
                conversation.effort,
                conversation.model,
                window,
                conversation.permission,
                if conversation.archived { 1 } else { 0 },
            ],
        )?;
    }
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

/// One less than the current top, so a new chat sorts above the list without renumbering it.
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
        let journey_min: Option<i64> = conn.query_row("SELECT MIN(sort_order) FROM journeys", [], |row| row.get(0))?;
        match (conv_min, journey_min) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
    };
    Ok(min.map(|n| n - 1).unwrap_or(0))
}

/// Give tied rows the order a reader used to see (`sort_order`, then newest `updated_at`).
/// After this, listing by `sort_order` alone no longer moves a chat when it is saved.
fn freeze_tied_orders(conn: &Connection) -> Result<()> {
    let tied: Option<i64> = conn
        .query_row(
            "SELECT sort_order FROM conversations GROUP BY sort_order HAVING COUNT(*) > 1 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if tied.is_none() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT id FROM conversations ORDER BY sort_order ASC, updated_at DESC, id ASC",
    )?;
    let ids = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut ordered = Vec::new();
    for id in ids {
        ordered.push(id?);
    }
    drop(stmt);
    for (index, id) in ordered.iter().enumerate() {
        conn.execute(
            "UPDATE conversations SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn chat(id: &str, updated_at: &str) -> Conversation {
        Conversation {
            id: id.into(),
            title: id.into(),
            created_at: "t".into(),
            updated_at: updated_at.into(),
            kind: "chat".into(),
            messages: vec![],
            context_usage: None,
            compaction: None,
            journey_id: None,
            sort_order: 0,
            effort: None,
            model: None,
            context_window: None,
            permission: None,
            archived: false,
        }
    }

    fn ids(conn: &Connection) -> Vec<String> {
        list_conversation_summaries(conn)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect()
    }

    #[test]
    fn finishing_a_chat_does_not_move_it() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at, kind, sort_order, archived)
             VALUES ('old', 'old', 't', '2026-01-01T00:00:00Z', 'chat', 0, 0),
                    ('new', 'new', 't', '2026-02-01T00:00:00Z', 'chat', 0, 0)",
            [],
        )
        .unwrap();
        drop(conn);
        let conn = open(dir.path()).unwrap();
        assert_eq!(ids(&conn), ["new", "old"]);
        save_conversation(&conn, &chat("old", "2026-03-01T00:00:00Z")).unwrap();
        assert_eq!(ids(&conn), ["new", "old"]);
    }

    #[test]
    fn a_new_chat_goes_to_the_top_and_leaves_the_rest() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        save_conversation(&conn, &chat("first", "2026-01-01T00:00:00Z")).unwrap();
        save_conversation(&conn, &chat("second", "2026-01-02T00:00:00Z")).unwrap();
        save_conversation(&conn, &chat("first", "2026-04-01T00:00:00Z")).unwrap();
        save_conversation(&conn, &chat("third", "2026-05-01T00:00:00Z")).unwrap();
        assert_eq!(ids(&conn), ["third", "second", "first"]);
    }
}
