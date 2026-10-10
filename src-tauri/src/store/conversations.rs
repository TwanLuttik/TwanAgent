use rusqlite::{params, Connection, OptionalExtension};

use super::{
    insert_conversation, load_messages, next_sort, row_to_conversation, sync_messages,
};
use crate::dev::{Conversation, ConversationSummary};
use crate::error::{Error, Result};

struct ConvHead {
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
    archived: bool,
}

fn map_head(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConvHead> {
    Ok(ConvHead {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        kind: row.get(4)?,
        journey_id: row.get(5)?,
        sort_order: row.get(6)?,
        usage: row.get(7)?,
        compaction: row.get(8)?,
        effort: row.get(9)?,
        archived: row.get::<_, i64>(10)? != 0,
    })
}

const HEAD_SQL: &str = "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage, compaction, effort, archived
         FROM conversations";

fn summary_from_head(head: ConvHead) -> ConversationSummary {
    ConversationSummary {
        id: head.id,
        title: head.title,
        created_at: head.created_at,
        updated_at: head.updated_at,
        kind: if head.kind.is_empty() {
            "chat".into()
        } else {
            head.kind
        },
        journey_id: head.journey_id,
        sort_order: head.sort_order,
        effort: head.effort.filter(|value| !value.trim().is_empty()),
        archived: head.archived,
    }
}

/// Sidebar rows. Messages stay in the database until a chat is opened.
pub fn list_conversation_summaries(conn: &Connection) -> Result<Vec<ConversationSummary>> {
    let mut stmt = conn.prepare(&format!("{HEAD_SQL} ORDER BY sort_order ASC, id ASC"))?;
    let rows = stmt.query_map([], map_head)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(summary_from_head(row?));
    }
    Ok(out)
}

pub fn list_conversations(conn: &Connection) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(&format!("{HEAD_SQL} ORDER BY sort_order ASC, id ASC"))?;
    let heads = stmt.query_map([], map_head)?;
    let mut out = Vec::new();
    for head in heads {
        let head = head?;
        let messages = load_messages(conn, &head.id)?;
        out.push(row_to_conversation(
            head.id,
            head.title,
            head.created_at,
            head.updated_at,
            head.kind,
            head.journey_id,
            head.sort_order,
            head.usage,
            head.compaction,
            head.effort,
            head.archived,
            messages,
        )?);
    }
    Ok(out)
}

pub fn get_conversation(conn: &Connection, id: &str) -> Result<Conversation> {
    let head = conn
        .query_row(&format!("{HEAD_SQL} WHERE id = ?1"), [id], map_head)
        .optional()?;
    let Some(head) = head else {
        return Err(Error::NotFound("conversation not found".into()));
    };
    let messages = load_messages(conn, &head.id)?;
    row_to_conversation(
        head.id,
        head.title,
        head.created_at,
        head.updated_at,
        head.kind,
        head.journey_id,
        head.sort_order,
        head.usage,
        head.compaction,
        head.effort,
        head.archived,
        messages,
    )
}

pub fn save_conversation(conn: &Connection, conv: &Conversation) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = save_conversation_in_tx(conn, conv);
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(_) => {
            let _ = conn.execute_batch("ROLLBACK");
        }
    }
    result
}

fn save_conversation_in_tx(conn: &Connection, conv: &Conversation) -> Result<()> {
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
        // Journey, order, and archived live on their own commands. A turn save
        // must not put a moved or archived chat back where it started.
        conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2, kind = ?3,
             context_usage = COALESCE(?4, context_usage),
             compaction = COALESCE(?5, compaction),
             effort = COALESCE(?6, effort)
             WHERE id = ?7",
            params![conv.title, conv.updated_at, kind, usage, compaction, effort, conv.id],
        )?;
        sync_messages(conn, &conv.id, &conv.messages)?;
        return Ok(());
    }
    let sort = next_sort(conn, conv.journey_id.as_deref())?;
    insert_conversation(conn, conv, sort)
}

pub fn set_conversation_archived(conn: &Connection, id: &str, archived: bool) -> Result<()> {
    let n = conn.execute(
        "UPDATE conversations SET archived = ?1 WHERE id = ?2",
        params![if archived { 1 } else { 0 }, id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("conversation not found".into()));
    }
    Ok(())
}

pub fn delete_conversation(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM conversations WHERE id = ?1", [id])?;
    Ok(())
}

pub fn reorder_conversations(conn: &Connection, ids: &[String]) -> Result<Vec<ConversationSummary>> {
    if ids.is_empty() {
        return list_conversation_summaries(conn);
    }
    let all = list_conversation_summaries(conn)?;
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
    list_conversation_summaries(conn)
}
