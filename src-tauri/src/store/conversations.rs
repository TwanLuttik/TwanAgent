use rusqlite::{params, Connection, OptionalExtension};

use super::{
    insert_conversation, load_messages, load_messages_tail, next_sort, replace_messages_from,
    row_to_conversation, sync_messages,
};
use crate::dev::{Conversation, ConversationSummary, DevChatUsage, DevCompaction};
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
    model: Option<String>,
    context_window: Option<i64>,
    permission: Option<String>,
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
        model: row.get(10)?,
        context_window: row.get(11)?,
        permission: row.get(12)?,
        archived: row.get::<_, i64>(13)? != 0,
    })
}

const HEAD_SQL: &str = "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage, compaction, effort, model, context_window, permission, archived
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
        model: head.model.filter(|value| !value.trim().is_empty()),
        context_window: head
            .context_window
            .and_then(|value| u64::try_from(value).ok())
            .filter(|value| *value > 0),
        permission: head.permission.filter(|value| !value.trim().is_empty()),
        archived: head.archived,
        preview: String::new(),
    }
}

/// One sidebar line. Newlines and extra spaces collapse, and a long line is cut.
pub(crate) fn clip_sidebar_line(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 96;
    let mut chars = flat.chars();
    let head: String = chars.by_ref().take(MAX).collect();
    if chars.next().is_none() {
        head
    } else {
        let mut cut: String = head.chars().take(MAX - 1).collect();
        cut.push('…');
        cut
    }
}

fn last_message_line(conn: &Connection, id: &str) -> Result<String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT content FROM messages
             WHERE conversation_id = ?1 AND role IN ('user', 'assistant')
               AND content IS NOT NULL AND length(trim(content)) > 0
             ORDER BY sort_order DESC, id DESC LIMIT 1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(text
        .map(|value| clip_sidebar_line(&value))
        .unwrap_or_default())
}

fn last_message_lines(conn: &Connection) -> Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare(
        "SELECT conversation_id, content FROM (
            SELECT conversation_id, content,
                   ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY sort_order DESC, id DESC) AS n
            FROM messages
            WHERE role IN ('user', 'assistant') AND content IS NOT NULL AND length(trim(content)) > 0
         ) WHERE n = 1",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = std::collections::HashMap::new();
    for row in rows {
        let (id, content) = row?;
        out.insert(id, clip_sidebar_line(&content));
    }
    Ok(out)
}

/// One sidebar row. Messages stay in the database.
pub fn conversation_summary(conn: &Connection, id: &str) -> Result<ConversationSummary> {
    let head = conn
        .query_row(&format!("{HEAD_SQL} WHERE id = ?1"), [id], map_head)
        .optional()?;
    let Some(head) = head else {
        return Err(Error::NotFound("conversation not found".into()));
    };
    let mut summary = summary_from_head(head);
    summary.preview = last_message_line(conn, id)?;
    Ok(summary)
}

/// Sidebar rows. Messages stay in the database until a chat is opened.
pub fn list_conversation_summaries(conn: &Connection) -> Result<Vec<ConversationSummary>> {
    let previews = last_message_lines(conn)?;
    let mut stmt = conn.prepare(&format!("{HEAD_SQL} ORDER BY sort_order ASC, id ASC"))?;
    let rows = stmt.query_map([], map_head)?;
    let mut out = Vec::new();
    for row in rows {
        let mut summary = summary_from_head(row?);
        if let Some(line) = previews.get(&summary.id) {
            summary.preview = line.clone();
        }
        out.push(summary);
    }
    Ok(out)
}

#[cfg(test)]
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
            head.model,
            head.context_window,
            head.permission,
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
    conversation_from_head(head, messages)
}

/// The head row plus only the last `message_limit` messages. The full read can follow.
pub fn get_conversation_tail(
    conn: &Connection,
    id: &str,
    message_limit: u32,
) -> Result<Conversation> {
    let head = conn
        .query_row(&format!("{HEAD_SQL} WHERE id = ?1"), [id], map_head)
        .optional()?;
    let Some(head) = head else {
        return Err(Error::NotFound("conversation not found".into()));
    };
    let messages = load_messages_tail(conn, &head.id, message_limit)?;
    conversation_from_head(head, messages)
}

fn conversation_from_head(
    head: ConvHead,
    messages: Vec<serde_json::Value>,
) -> Result<Conversation> {
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
        head.model,
        head.context_window,
        head.permission,
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

/// Write `messages[from_index..]` and bump `updated_at`. Does not read the row or any message body.
/// `from_index` is the first sort_order to replace. Earlier rows stay as they are.
/// `context_usage` is the last model round. Leave it `None` to keep the stored snapshot.
pub fn save_conversation_suffix_with_usage(
    conn: &Connection,
    id: &str,
    updated_at: &str,
    messages: &[serde_json::Value],
    from_index: usize,
    context_usage: Option<&DevChatUsage>,
) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        let usage = context_usage.map(serde_json::to_string).transpose()?;
        let n = if usage.is_some() {
            conn.execute(
                "UPDATE conversations SET updated_at = ?1, context_usage = ?2 WHERE id = ?3",
                params![updated_at, usage, id],
            )?
        } else {
            conn.execute(
                "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
                params![updated_at, id],
            )?
        };
        if n == 0 {
            return Err(Error::NotFound("conversation not found".into()));
        }
        replace_messages_from(conn, id, messages, from_index)
    })();
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
    let model = conv
        .model
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let permission = conv
        .permission
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let context_window = conv.context_window.filter(|value| *value > 0);
    if existing.is_some() {
        // Journey, order, and archived live on their own commands. A turn save
        // must not put a moved or archived chat back where it started.
        conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2, kind = ?3,
             context_usage = COALESCE(?4, context_usage),
             compaction = COALESCE(?5, compaction),
             effort = COALESCE(?6, effort),
             model = COALESCE(?7, model),
             context_window = COALESCE(?8, context_window),
             permission = COALESCE(?9, permission)
             WHERE id = ?10",
            params![
                conv.title,
                conv.updated_at,
                kind,
                usage,
                compaction,
                effort,
                model,
                context_window.map(|value| value as i64),
                permission,
                conv.id
            ],
        )?;
        sync_messages(conn, &conv.id, &conv.messages)?;
        return Ok(());
    }
    let sort = next_sort(conn, conv.journey_id.as_deref())?;
    insert_conversation(conn, conv, sort)
}

pub fn set_conversation_compaction(
    conn: &Connection,
    id: &str,
    compaction: &DevCompaction,
) -> Result<()> {
    let raw = serde_json::to_string(compaction)?;
    let n = conn.execute(
        "UPDATE conversations SET compaction = ?1 WHERE id = ?2",
        params![raw, id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("conversation not found".into()));
    }
    Ok(())
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

pub fn reorder_conversations(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<ConversationSummary>> {
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
