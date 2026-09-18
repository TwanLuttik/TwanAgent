use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::dev::{Conversation, DevChatUsage, Journey, SidebarItem};
use crate::error::{Error, Result};

const SCHEMA_VERSION: i64 = 2;

pub fn db_path(dir: &Path) -> PathBuf {
    dir.join("store.db")
}

fn json_path(dir: &Path) -> PathBuf {
    dir.join("conversations.json")
}

pub fn knowledge_path(dir: &Path, journey_id: &str) -> PathBuf {
    dir.join("journeys").join(format!("{journey_id}.md"))
}

fn open_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn open(dir: &Path) -> Result<Connection> {
    let _guard = open_lock().lock().unwrap_or_else(|e| e.into_inner());
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
            context_usage TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            sort_order INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_calls TEXT,
            tool_call_id TEXT
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
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
        ],
    )?;
    replace_messages(conn, &conv.id, &conv.messages)?;
    Ok(())
}

fn replace_messages(conn: &Connection, conversation_id: &str, messages: &[Value]) -> Result<()> {
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        [conversation_id],
    )?;
    for (i, msg) in messages.iter().enumerate() {
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
        conn.execute(
            "INSERT INTO messages (conversation_id, sort_order, role, content, tool_calls, tool_call_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                conversation_id,
                i as i64,
                role,
                content_text,
                tool_calls,
                tool_call_id,
            ],
        )?;
    }
    Ok(())
}

fn load_messages(conn: &Connection, conversation_id: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT role, content, tool_calls, tool_call_id FROM messages
         WHERE conversation_id = ?1 ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = stmt.query_map([conversation_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (role, content, tool_calls, tool_call_id) = row?;
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

fn row_to_conversation(
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    kind: String,
    journey_id: Option<String>,
    sort_order: i64,
    usage: Option<String>,
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
        journey_id,
        sort_order,
    })
}

pub fn list_conversations(conn: &Connection) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, kind, journey_id, sort_order, context_usage
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
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, created_at, updated_at, kind, journey_id, sort_order, usage) = row?;
        let messages = load_messages(conn, &id)?;
        out.push(row_to_conversation(
            id, title, created_at, updated_at, kind, journey_id, sort_order, usage, messages,
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
    if existing.is_some() {
        if let Some(usage) = usage {
            conn.execute(
                "UPDATE conversations SET title = ?1, updated_at = ?2, kind = ?3, context_usage = ?4
                 WHERE id = ?5",
                params![
                    conv.title,
                    conv.updated_at,
                    if conv.kind.is_empty() {
                        "chat".to_string()
                    } else {
                        conv.kind.clone()
                    },
                    usage,
                    conv.id,
                ],
            )?;
        } else {
            conn.execute(
                "UPDATE conversations SET title = ?1, updated_at = ?2, kind = ?3 WHERE id = ?4",
                params![
                    conv.title,
                    conv.updated_at,
                    if conv.kind.is_empty() {
                        "chat".to_string()
                    } else {
                        conv.kind.clone()
                    },
                    conv.id,
                ],
            )?;
        }
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
    let convs = list_conversations(conn)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn conv(id: &str, title: &str, messages: Vec<Value>) -> Conversation {
        Conversation {
            id: id.into(),
            title: title.into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            kind: "chat".into(),
            messages,
            context_usage: None,
            journey_id: None,
            sort_order: 0,
        }
    }

    #[test]
    fn empty_project_creates_store_db() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        assert!(db_path(dir.path()).exists());
        assert!(list_conversations(&conn).unwrap().is_empty());
        assert!(list_journeys(&conn).unwrap().is_empty());
    }

    #[test]
    fn imports_conversations_json_once() {
        let dir = tempdir().unwrap();
        fs::write(
            json_path(dir.path()),
            r#"[{
                "id":"c1",
                "title":"Hello",
                "created_at":"t0",
                "updated_at":"t1",
                "kind":"terminal",
                "messages":[
                    {"role":"user","content":"hi"},
                    {"role":"tool","content":"ok","tool_call_id":"t1"}
                ],
                "context_usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}
            }]"#,
        )
        .unwrap();
        let conn = open(dir.path()).unwrap();
        let rows = list_conversations(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Hello");
        assert_eq!(rows[0].kind, "terminal");
        assert_eq!(rows[0].messages.len(), 2);
        assert_eq!(rows[0].context_usage.as_ref().unwrap().prompt_tokens, 10);
        assert!(json_path(dir.path()).exists());
        fs::write(
            json_path(dir.path()),
            r#"[{"id":"other","title":"Nope","created_at":"t","updated_at":"t","messages":[]}]"#,
        )
        .unwrap();
        let again = open(dir.path()).unwrap();
        let rows = list_conversations(&again).unwrap();
        assert_eq!(rows[0].id, "c1");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn save_without_usage_keeps_stored_context_usage() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        let mut row = conv("c1", "Hello", vec![json!({"role":"user","content":"hi"})]);
        row.context_usage = Some(DevChatUsage {
            prompt_tokens: 138000,
            completion_tokens: 20,
            total_tokens: 138020,
        });
        save_conversation(&conn, &row).unwrap();
        row.context_usage = None;
        row.title = "Hello again".into();
        save_conversation(&conn, &row).unwrap();
        let loaded = get_conversation(&conn, "c1").unwrap();
        assert_eq!(loaded.title, "Hello again");
        assert_eq!(loaded.context_usage.as_ref().unwrap().prompt_tokens, 138000);
    }

    #[test]
    fn failed_import_leaves_no_db() {
        let dir = tempdir().unwrap();
        fs::write(json_path(dir.path()), "not-json").unwrap();
        assert!(open(dir.path()).is_err());
        assert!(!db_path(dir.path()).exists());
        assert!(!dir.path().join("store.db.tmp").exists());
        assert!(json_path(dir.path()).exists());
    }

    #[test]
    fn create_journey_moves_seed_and_writes_empty_markdown() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        save_conversation(
            &conn,
            &conv(
                "c1",
                "Marketing",
                vec![json!({"role":"user","content":"ideas"})],
            ),
        )
        .unwrap();
        let journey = create_journey(&conn, dir.path(), "c1").unwrap();
        assert_eq!(journey.title, "Marketing");
        assert!(!journey.collapsed);
        let seed = get_conversation(&conn, "c1").unwrap();
        assert_eq!(seed.journey_id.as_deref(), Some(journey.id.as_str()));
        assert_eq!(seed.sort_order, 0);
        let md = knowledge_path(dir.path(), &journey.id);
        assert_eq!(fs::read_to_string(md).unwrap(), "");
        assert!(create_journey(&conn, dir.path(), "c1").is_err());
    }

    #[test]
    fn delete_journey_keep_vs_delete_chats() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        save_conversation(&conn, &conv("a", "A", vec![])).unwrap();
        save_conversation(&conn, &conv("b", "B", vec![])).unwrap();
        let keep = create_journey(&conn, dir.path(), "a").unwrap();
        delete_journey(&conn, dir.path(), &keep.id, false).unwrap();
        let a = get_conversation(&conn, "a").unwrap();
        assert_eq!(a.journey_id, None);
        assert!(!knowledge_path(dir.path(), &keep.id).exists());

        let gone = create_journey(&conn, dir.path(), "b").unwrap();
        delete_journey(&conn, dir.path(), &gone.id, true).unwrap();
        assert!(get_conversation(&conn, "b").is_err());
        assert!(list_journeys(&conn).unwrap().is_empty());
    }

    #[test]
    fn move_and_reorder() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        save_conversation(&conn, &conv("a", "A", vec![])).unwrap();
        save_conversation(&conn, &conv("b", "B", vec![])).unwrap();
        save_conversation(&conn, &conv("c", "C", vec![])).unwrap();
        let journey = create_journey(&conn, dir.path(), "a").unwrap();
        move_conversation(&conn, "b", Some(&journey.id)).unwrap();
        let kids = list_conversations(&conn)
            .unwrap()
            .into_iter()
            .filter(|c| c.journey_id.as_deref() == Some(journey.id.as_str()))
            .map(|c| c.id)
            .collect::<Vec<_>>();
        assert_eq!(kids, ["a", "b"]);
        reorder_conversations(&conn, &["b".into(), "a".into()]).unwrap();
        let kids = list_conversations(&conn)
            .unwrap()
            .into_iter()
            .filter(|c| c.journey_id.as_deref() == Some(journey.id.as_str()))
            .map(|c| c.id)
            .collect::<Vec<_>>();
        assert_eq!(kids, ["b", "a"]);
        assert!(reorder_conversations(&conn, &["c".into(), "b".into()]).is_err());
        reorder_sidebar(
            &conn,
            &[
                SidebarItem {
                    kind: "conversation".into(),
                    id: "c".into(),
                },
                SidebarItem {
                    kind: "journey".into(),
                    id: journey.id.clone(),
                },
            ],
        )
        .unwrap();
        let c = get_conversation(&conn, "c").unwrap();
        let j = list_journeys(&conn).unwrap().into_iter().next().unwrap();
        assert!(c.sort_order < j.sort_order);
        move_conversation(&conn, "b", None).unwrap();
        assert_eq!(get_conversation(&conn, "b").unwrap().journey_id, None);
    }

    #[test]
    fn knowledge_get_save_and_update() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        save_conversation(&conn, &conv("a", "A", vec![])).unwrap();
        let journey = create_journey(&conn, dir.path(), "a").unwrap();
        fs::remove_file(knowledge_path(dir.path(), &journey.id)).unwrap();
        assert_eq!(get_knowledge(dir.path(), &conn, &journey.id).unwrap(), "");
        assert!(knowledge_path(dir.path(), &journey.id).exists());
        save_knowledge(dir.path(), &conn, &journey.id, "alpha beta").unwrap();
        let replaced = update_knowledge(
            dir.path(),
            &conn,
            &journey.id,
            "replace",
            Some("one two"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(replaced, "one two");
        let edited = update_knowledge(
            dir.path(),
            &conn,
            &journey.id,
            "edit",
            None,
            Some("two"),
            Some("three"),
        )
        .unwrap();
        assert_eq!(edited, "one three");
        let err = update_knowledge(
            dir.path(),
            &conn,
            &journey.id,
            "edit",
            None,
            Some("missing"),
            Some("x"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("not found"));
        save_knowledge(dir.path(), &conn, &journey.id, "foo foo").unwrap();
        let err = update_knowledge(
            dir.path(),
            &conn,
            &journey.id,
            "edit",
            None,
            Some("foo"),
            Some("bar"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("2 times"));
        let _ = err;
    }

    #[test]
    fn set_journey_color_persists_and_rejects_unknown() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        save_conversation(&conn, &conv("a", "A", vec![])).unwrap();
        let journey = create_journey(&conn, dir.path(), "a").unwrap();
        assert_eq!(journey.color, "");
        let next = set_journey_color(&conn, &journey.id, "blue").unwrap();
        assert_eq!(next.color, "blue");
        assert_eq!(list_journeys(&conn).unwrap()[0].color, "blue");
        assert!(set_journey_color(&conn, &journey.id, "neon").is_err());
        let cleared = set_journey_color(&conn, &journey.id, "").unwrap();
        assert_eq!(cleared.color, "");
    }
}
