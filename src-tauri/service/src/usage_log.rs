//! Token rows for one hosted project.
//!
//! A turn on the server writes one row per model round. A client that can reach
//! the server reads the rows back and keeps its own copy. The log stays in this
//! project's store, so two projects on the same machine do not share it.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::store;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageRow {
    pub id: i64,
    pub recorded_at: String,
    pub conversation_id: String,
    pub conversation_title: String,
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_read_tokens: u64,
}

pub fn record(
    conn: &Connection,
    conversation_id: &str,
    conversation_title: &str,
    model: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
    cache_read_tokens: u64,
) -> Result<i64> {
    if prompt_tokens == 0 && completion_tokens == 0 {
        return Ok(0);
    }
    ensure(conn)?;
    let recorded_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "INSERT INTO usage_events (
            recorded_at, conversation_id, conversation_title, model,
            prompt_tokens, completion_tokens, cache_read_tokens
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            recorded_at,
            conversation_id,
            conversation_title,
            model,
            prompt_tokens as i64,
            completion_tokens as i64,
            cache_read_tokens.min(prompt_tokens) as i64,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Rows written after `since_id`, oldest first. Zero reads the whole log.
pub fn list_since(conn: &Connection, since_id: i64) -> Result<Vec<UsageRow>> {
    ensure(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, recorded_at, conversation_id, conversation_title, model,
                prompt_tokens, completion_tokens, cache_read_tokens
         FROM usage_events
         WHERE id > ?1
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([since_id], |row| {
        Ok(UsageRow {
            id: row.get(0)?,
            recorded_at: row.get(1)?,
            conversation_id: row.get(2)?,
            conversation_title: row.get(3)?,
            model: row.get(4)?,
            prompt_tokens: row.get::<_, i64>(5)?.max(0) as u64,
            completion_tokens: row.get::<_, i64>(6)?.max(0) as u64,
            cache_read_tokens: row.get::<_, i64>(7)?.max(0) as u64,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn ensure(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at TEXT NOT NULL,
            conversation_id TEXT NOT NULL DEFAULT '',
            conversation_title TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            prompt_tokens INTEGER NOT NULL,
            completion_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS usage_events_id ON usage_events(id);
        ",
    )?;
    Ok(())
}

/// Open the project store and append one round. A failure here must not fail the turn.
pub fn record_in_store(
    store_dir: &std::path::Path,
    conversation_id: &str,
    conversation_title: &str,
    model: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
    cache_read_tokens: u64,
) -> Result<i64> {
    store::with_conn(store_dir, |conn| {
        record(conn, conversation_id, conversation_title, model, prompt_tokens, completion_tokens, cache_read_tokens)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_round_is_readable_after_its_id() {
        let root = tempfile::tempdir().unwrap();
        let conn = store::open(root.path()).unwrap();
        assert!(list_since(&conn, 0).unwrap().is_empty());
        let first = record(&conn, "c1", "Hello", "grok-4.6", 100, 20, 40).unwrap();
        let second = record(&conn, "c1", "Hello", "grok-4.6", 140, 10, 0).unwrap();
        assert!(second > first);
        let all = list_since(&conn, 0).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].prompt_tokens, 100);
        assert_eq!(all[0].cache_read_tokens, 40);
        let tail = list_since(&conn, first).unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].id, second);
        assert_eq!(record(&conn, "c1", "Hello", "grok-4.6", 0, 0, 0).unwrap(), 0);
    }

}
