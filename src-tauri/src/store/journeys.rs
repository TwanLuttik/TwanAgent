use std::collections::HashSet;
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::{
    get_conversation, knowledge_path, list_conversation_summaries, max_sort, now_iso,
};
use crate::dev::{Conversation, Journey, SidebarItem};
use crate::error::{Error, Result};

pub fn list_journeys(conn: &Connection) -> Result<Vec<Journey>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, sort_order, collapsed, color
         FROM journeys ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Journey {
            id: row.get(0)?,
            title: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            sort_order: row.get(4)?,
            collapsed: row.get::<_, i64>(5)? != 0,
            color: row.get::<_, String>(6).unwrap_or_default(),
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn create_journey(conn: &Connection, dir: &Path, conversation_id: &str) -> Result<Journey> {
    let conv = get_conversation(conn, conversation_id)?;
    if conv.journey_id.is_some() {
        return Err(Error::Other("conversation is already in a journey".into()));
    }
    let now = now_iso();
    let journey = Journey {
        id: uuid::Uuid::new_v4().to_string(),
        title: conv.title.clone(),
        created_at: now.clone(),
        updated_at: now,
        sort_order: conv.sort_order,
        collapsed: false,
        color: String::new(),
    };
    conn.execute(
        "INSERT INTO journeys (id, title, created_at, updated_at, sort_order, collapsed)
         VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        params![
            journey.id,
            journey.title,
            journey.created_at,
            journey.updated_at,
            journey.sort_order,
        ],
    )?;
    conn.execute(
        "UPDATE conversations SET journey_id = ?1, sort_order = 0 WHERE id = ?2",
        params![journey.id, conv.id],
    )?;
    let path = knowledge_path(dir, &journey.id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, "")?;
    Ok(journey)
}

pub fn rename_journey(conn: &Connection, id: &str, title: &str) -> Result<Journey> {
    let n = conn.execute(
        "UPDATE journeys SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, now_iso(), id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("journey not found".into()));
    }
    list_journeys(conn)?
        .into_iter()
        .find(|j| j.id == id)
        .ok_or_else(|| Error::NotFound("journey not found".into()))
}

pub fn delete_journey(conn: &Connection, dir: &Path, id: &str, delete_chats: bool) -> Result<()> {
    let exists: Option<String> = conn
        .query_row("SELECT id FROM journeys WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    if exists.is_none() {
        return Err(Error::NotFound("journey not found".into()));
    }
    if delete_chats {
        conn.execute("DELETE FROM conversations WHERE journey_id = ?1", [id])?;
    }
    conn.execute("DELETE FROM journeys WHERE id = ?1", [id])?;
    let path = knowledge_path(dir, id);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn set_journey_collapsed(conn: &Connection, id: &str, collapsed: bool) -> Result<()> {
    let n = conn.execute(
        "UPDATE journeys SET collapsed = ?1 WHERE id = ?2",
        params![if collapsed { 1 } else { 0 }, id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("journey not found".into()));
    }
    Ok(())
}

fn parse_journey_color(raw: &str) -> Result<String> {
    match raw.trim() {
        "" | "blue" | "green" | "amber" | "rose" | "violet" => Ok(raw.trim().to_string()),
        _ => Err(Error::Other("unknown journey color".into())),
    }
}

pub fn set_journey_color(conn: &Connection, id: &str, color: &str) -> Result<Journey> {
    let color = parse_journey_color(color)?;
    let n = conn.execute(
        "UPDATE journeys SET color = ?1, updated_at = ?2 WHERE id = ?3",
        params![color, now_iso(), id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("journey not found".into()));
    }
    list_journeys(conn)?
        .into_iter()
        .find(|j| j.id == id)
        .ok_or_else(|| Error::NotFound("journey not found".into()))
}

pub fn move_conversation(
    conn: &Connection,
    id: &str,
    journey_id: Option<&str>,
) -> Result<Conversation> {
    let conv = get_conversation(conn, id)?;
    if let Some(jid) = journey_id {
        let found: Option<String> = conn
            .query_row("SELECT id FROM journeys WHERE id = ?1", [jid], |row| {
                row.get(0)
            })
            .optional()?;
        if found.is_none() {
            return Err(Error::NotFound("journey not found".into()));
        }
    }
    let sort = max_sort(conn, journey_id)? + 1;
    conn.execute(
        "UPDATE conversations SET journey_id = ?1, sort_order = ?2 WHERE id = ?3",
        params![journey_id, sort, conv.id],
    )?;
    get_conversation(conn, id)
}

pub fn reorder_sidebar(conn: &Connection, items: &[SidebarItem]) -> Result<()> {
    let journeys = list_journeys(conn)?;
    let convs = list_conversation_summaries(conn)?;
    let top: Vec<_> = convs
        .iter()
        .filter(|c| c.journey_id.is_none())
        .cloned()
        .collect();
    let journey_ids: HashSet<_> = journeys.iter().map(|j| j.id.clone()).collect();
    let top_ids: HashSet<_> = top.iter().map(|c| c.id.clone()).collect();
    let mut used_j = HashSet::new();
    let mut used_c = HashSet::new();
    let mut order = 0i64;
    for item in items {
        match item.kind.as_str() {
            "journey" if journey_ids.contains(&item.id) && used_j.insert(item.id.clone()) => {
                conn.execute(
                    "UPDATE journeys SET sort_order = ?1 WHERE id = ?2",
                    params![order, item.id],
                )?;
                order += 1;
            }
            "conversation" if top_ids.contains(&item.id) && used_c.insert(item.id.clone()) => {
                conn.execute(
                    "UPDATE conversations SET sort_order = ?1 WHERE id = ?2",
                    params![order, item.id],
                )?;
                order += 1;
            }
            _ => {}
        }
    }
    let mut rest_j = journeys;
    rest_j.sort_by_key(|j| j.sort_order);
    for j in rest_j {
        if used_j.contains(&j.id) {
            continue;
        }
        conn.execute(
            "UPDATE journeys SET sort_order = ?1 WHERE id = ?2",
            params![order, j.id],
        )?;
        order += 1;
    }
    let mut rest_c = top;
    rest_c.sort_by_key(|c| c.sort_order);
    for c in rest_c {
        if used_c.contains(&c.id) {
            continue;
        }
        conn.execute(
            "UPDATE conversations SET sort_order = ?1 WHERE id = ?2",
            params![order, c.id],
        )?;
        order += 1;
    }
    Ok(())
}

pub fn get_knowledge(dir: &Path, conn: &Connection, journey_id: &str) -> Result<String> {
    journey_exists(conn, journey_id)?;
    let path = knowledge_path(dir, journey_id);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, "")?;
        return Ok(String::new());
    }
    Ok(fs::read_to_string(path)?)
}

pub fn save_knowledge(
    dir: &Path,
    conn: &Connection,
    journey_id: &str,
    contents: &str,
) -> Result<()> {
    journey_exists(conn, journey_id)?;
    let path = knowledge_path(dir, journey_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

pub fn update_knowledge(
    dir: &Path,
    conn: &Connection,
    journey_id: &str,
    mode: &str,
    contents: Option<&str>,
    old_string: Option<&str>,
    new_string: Option<&str>,
) -> Result<String> {
    match mode {
        "replace" => {
            let text = contents.ok_or_else(|| Error::Other("contents is required".into()))?;
            save_knowledge(dir, conn, journey_id, text)?;
            Ok(text.to_string())
        }
        "edit" => {
            let old = old_string.ok_or_else(|| Error::Other("old_string is required".into()))?;
            let new = new_string.ok_or_else(|| Error::Other("new_string is required".into()))?;
            if old.is_empty() {
                return Err(Error::Other("old_string is empty".into()));
            }
            let current = get_knowledge(dir, conn, journey_id)?;
            let matches = current.matches(old).count();
            if matches == 0 {
                return Err(Error::Other("old_string was not found".into()));
            }
            if matches > 1 {
                return Err(Error::Other(format!(
                    "old_string matched {matches} times — make it unique"
                )));
            }
            let next = current.replacen(old, new, 1);
            save_knowledge(dir, conn, journey_id, &next)?;
            Ok(next)
        }
        _ => Err(Error::Other("unknown mode".into())),
    }
}

fn journey_exists(conn: &Connection, id: &str) -> Result<()> {
    let found: Option<String> = conn
        .query_row("SELECT id FROM journeys WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    if found.is_none() {
        return Err(Error::NotFound("journey not found".into()));
    }
    Ok(())
}
