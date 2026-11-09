use rusqlite::{params, Connection, OptionalExtension};

use super::schema::{now_iso, path_key};
use crate::error::{Error, Result};

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(Error::from)
}

/// Last account-usage snapshot for a provider. The sidebar paints this before the network refresh.
pub fn get_account_usage(conn: &Connection, provider: &str) -> Result<Option<String>> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT payload FROM account_usage WHERE provider = ?1",
        [provider],
        |row| row.get(0),
    )
    .optional()
    .map_err(Error::from)
}

/// The last pull-request list for one GitHub `owner/repo`. Null until one refresh has landed.
pub fn get_pull_requests(conn: &Connection, repo: &str) -> Result<Option<String>> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT payload FROM pull_requests WHERE repo = ?1",
        [repo],
        |row| row.get(0),
    )
    .optional()
    .map_err(Error::from)
}

/// The last Actions list for one GitHub `owner/repo`, and when it was saved.
pub fn get_actions(conn: &Connection, repo: &str) -> Result<Option<(String, String)>> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT payload, updated_at FROM action_runs WHERE repo = ?1",
        [repo],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(Error::from)
}

pub fn set_actions(conn: &Connection, repo: &str, payload: &str) -> Result<()> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err(Error::Other("actions repo is empty".into()));
    }
    conn.execute(
        "INSERT INTO action_runs (repo, payload, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(repo) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
        params![repo, payload, now_iso()],
    )?;
    Ok(())
}

pub fn set_pull_requests(conn: &Connection, repo: &str, payload: &str) -> Result<()> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err(Error::Other("pull request repo is empty".into()));
    }
    conn.execute(
        "INSERT INTO pull_requests (repo, payload, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(repo) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
        params![repo, payload, now_iso()],
    )?;
    Ok(())
}

pub fn set_account_usage(conn: &Connection, provider: &str, payload: &str) -> Result<()> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Err(Error::Other("account usage provider is empty".into()));
    }
    conn.execute(
        "INSERT INTO account_usage (provider, payload, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(provider) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
        params![provider, payload, now_iso()],
    )?;
    Ok(())
}

/// Old path to current path. A moved project keeps its `store.db` through this list.
pub fn project_path_moves(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT path, previous_paths FROM project_path_history")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (path, raw) = row?;
        let previous: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        for from in previous {
            if path_key(&from) != path_key(&path) {
                out.push((from, path.clone()));
            }
        }
    }
    Ok(out)
}

/// Paths a workspace used to live at, so its chat database can be found after a move.
pub fn previous_paths_for(conn: &Connection, path: &str) -> Result<Vec<String>> {
    let key = path_key(path);
    let mut stmt = conn.prepare("SELECT path, previous_paths FROM project_path_history")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (current, raw) = row?;
        let previous: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        if path_key(&current) == key {
            out.extend(previous);
            continue;
        }
        if previous.iter().any(|item| path_key(item) == key) {
            out.push(current);
        }
    }
    Ok(out)
}

pub fn remember_project_move(conn: &Connection, name: &str, to: &str, from: &str) -> Result<()> {
    if path_key(from) == path_key(to) {
        return Ok(());
    }
    let mut stmt = conn.prepare("SELECT path, name, previous_paths FROM project_path_history")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut match_path: Option<String> = None;
    let mut previous = Vec::new();
    for row in rows {
        let (path, _, raw) = row?;
        let stored: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        if path_key(&path) == path_key(to)
            || stored.iter().any(|item| path_key(item) == path_key(from))
        {
            match_path = Some(path);
            previous = stored;
            break;
        }
    }
    if !previous.iter().any(|item| path_key(item) == path_key(from)) {
        previous.push(from.to_string());
    }
    let encoded = serde_json::to_string(&previous)?;
    if let Some(old) = match_path {
        conn.execute("DELETE FROM project_path_history WHERE path = ?1", [&old])?;
    }
    conn.execute(
        "INSERT INTO project_path_history (path, name, previous_paths) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, previous_paths = excluded.previous_paths",
        params![to, name, encoded],
    )?;
    Ok(())
}

/// Drop a project and every path it used to have. Returns those paths so their chat stores can go too.
pub fn forget_project_paths(conn: &Connection, path: &str) -> Result<Vec<String>> {
    let key = path_key(path);
    let mut stmt = conn.prepare("SELECT path, previous_paths FROM project_path_history")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut related = vec![path.to_string()];
    let mut drop_paths = Vec::new();
    for row in rows {
        let (current, raw) = row?;
        let previous: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        let hit = path_key(&current) == key || previous.iter().any(|item| path_key(item) == key);
        if !hit {
            continue;
        }
        related.push(current.clone());
        related.extend(previous);
        drop_paths.push(current);
    }
    for item in drop_paths {
        conn.execute("DELETE FROM project_path_history WHERE path = ?1", [item])?;
    }
    Ok(related)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(Error::Other("setting key is empty".into()));
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
pub(super) fn list_settings(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
