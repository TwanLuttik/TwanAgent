use rusqlite::{params, Connection, OptionalExtension};

use super::projects::{list_projects, project_key};
use super::schema::now_iso;
use crate::error::Result;

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
            effort, model, context_window, permission, archived, preview
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
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
            archived = excluded.archived,
            preview = excluded.preview",
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
            row.preview,
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
                effort, model, context_window, permission, archived, preview
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
                row.preview,
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
        "SELECT project_path, id, title, created_at, updated_at, kind, journey_id, sort_order, effort, model, context_window, permission, archived, preview
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
            preview: row.get(13)?,
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
        "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, effort, model, context_window, permission, archived, preview
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
            preview: row.get(12)?,
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
