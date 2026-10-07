use rusqlite::{params, Connection, OptionalExtension};

use super::{insert_conversation, load_messages, next_sort, replace_messages, row_to_conversation};
use crate::dev::Conversation;
use crate::error::{Error, Result};

pub fn list_conversations(conn: &Connection) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage, compaction, effort
         FROM conversations ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<String>>(9)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, created_at, updated_at, kind, journey_id, sort_order, usage, compaction, effort) = row?;
        let messages = load_messages(conn, &id)?;
        out.push(row_to_conversation(
            id, title, created_at, updated_at, kind, journey_id, sort_order, usage, compaction, effort, messages,
        )?);
    }
    Ok(out)
}

pub fn get_conversation(conn: &Connection, id: &str) -> Result<Conversation> {
    list_conversations(conn)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| Error::NotFound("conversation not found".into()))
}

pub fn save_conversation(conn: &Connection, conv: &Conversation) -> Result<()> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM conversations WHERE id = ?1",
            [&conv.id],
            |row| row.get(0),
        )
        .optional()?;
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
    let kind = if conv.kind.is_empty() {
        "chat".to_string()
    } else {
        conv.kind.clone()
    };
    let effort = conv
        .effort
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if existing.is_some() {
        conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2, kind = ?3,
             context_usage = COALESCE(?4, context_usage),
             compaction = COALESCE(?5, compaction),
             effort = COALESCE(?6, effort)
             WHERE id = ?7",
            params![conv.title, conv.updated_at, kind, usage, compaction, effort, conv.id],
        )?;
    } else {
        let sort = next_sort(conn, conv.journey_id.as_deref())?;
        insert_conversation(conn, conv, sort)?;
        return Ok(());
    }
    replace_messages(conn, &conv.id, &conv.messages)?;
    Ok(())
}

pub fn delete_conversation(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM conversations WHERE id = ?1", [id])?;
    Ok(())
}

pub fn reorder_conversations(conn: &Connection, ids: &[String]) -> Result<Vec<Conversation>> {
    if ids.is_empty() {
        return list_conversations(conn);
    }
    let all = list_conversations(conn)?;
    let mut listed = Vec::new();
    for id in ids {
        if let Some(row) = all.iter().find(|c| c.id == *id) {
            listed.push(row);
        }
    }
    if listed.is_empty() {
        return Ok(all);
    }
    let journey = listed[0].journey_id.clone();
    if listed.iter().any(|c| c.journey_id != journey) {
        return Err(Error::Other("mixed journeys".into()));
    }
    for (i, row) in listed.iter().enumerate() {
        conn.execute(
            "UPDATE conversations SET sort_order = ?1 WHERE id = ?2",
            params![i as i64, row.id],
        )?;
    }
    list_conversations(conn)
}
