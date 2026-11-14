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
    // A bad sample must not throw away the snapshot the sidebar just saved.
    let _ = record_account_usage_samples(conn, provider, payload);
    Ok(())
}

/// How long a flat reading waits before another point is stored.
const SAMPLE_GAP_SECS: i64 = 15 * 60;
/// Readings older than this are dropped. A weekly window fits inside it.
const SAMPLE_KEEP_DAYS: i64 = 21;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AccountUsageSample {
    pub provider: String,
    pub window_id: String,
    pub resets_at: String,
    pub used_percent: f64,
    pub recorded_at: String,
}

/// Append one point per allowance window. An unchanged reading inside the gap is skipped.
pub fn record_account_usage_samples(
    conn: &Connection,
    provider: &str,
    payload: &str,
) -> Result<()> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(());
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Ok(());
    };
    let Some(windows) = value.get("windows").and_then(|item| item.as_array()) else {
        return Ok(());
    };
    let now = now_iso();
    for window in windows {
        let id = window
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .trim();
        let resets = window
            .get("resets_at")
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .trim();
        let used = window.get("used_percent").and_then(|item| item.as_f64());
        if id.is_empty() || resets.is_empty() {
            continue;
        }
        let Some(used) = used else { continue };
        if !used.is_finite() || used < 0.0 {
            continue;
        }
        let used = used.clamp(0.0, 100.0);
        if !sample_is_new(conn, provider, id, resets, used)? {
            continue;
        }
        conn.execute(
            "INSERT INTO account_usage_samples (provider, window_id, resets_at, used_percent, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![provider, id, resets, used, now],
        )?;
    }
    let cutoff = chrono::Utc::now() - chrono::Duration::days(SAMPLE_KEEP_DAYS);
    conn.execute(
        "DELETE FROM account_usage_samples WHERE recorded_at < ?1",
        [cutoff.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)],
    )?;
    Ok(())
}

fn sample_is_new(
    conn: &Connection,
    provider: &str,
    window_id: &str,
    resets_at: &str,
    used: f64,
) -> Result<bool> {
    let previous: Option<(f64, String)> = conn
        .query_row(
            "SELECT used_percent, recorded_at FROM account_usage_samples
             WHERE provider = ?1 AND window_id = ?2 AND resets_at = ?3
             ORDER BY recorded_at DESC LIMIT 1",
            params![provider, window_id, resets_at],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((last_used, last_at)) = previous else {
        return Ok(true);
    };
    if (last_used - used).abs() >= 0.2 {
        return Ok(true);
    }
    let Ok(last) = chrono::DateTime::parse_from_rfc3339(&last_at) else {
        return Ok(true);
    };
    let age = chrono::Utc::now().signed_duration_since(last.with_timezone(&chrono::Utc));
    Ok(age.num_seconds() >= SAMPLE_GAP_SECS)
}

/// Allowance readings new enough to draw. Oldest first.
pub fn list_account_usage_samples(conn: &Connection) -> Result<Vec<AccountUsageSample>> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(SAMPLE_KEEP_DAYS);
    let mut stmt = conn.prepare(
        "SELECT provider, window_id, resets_at, used_percent, recorded_at
         FROM account_usage_samples
         WHERE recorded_at >= ?1
         ORDER BY recorded_at ASC
         LIMIT 4000",
    )?;
    let rows = stmt.query_map(
        [cutoff.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)],
        |row| {
            Ok(AccountUsageSample {
                provider: row.get(0)?,
                window_id: row.get(1)?,
                resets_at: row.get(2)?,
                used_percent: row.get(3)?,
                recorded_at: row.get(4)?,
            })
        },
    )?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Error::from)
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
