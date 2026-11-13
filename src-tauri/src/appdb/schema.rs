use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};

const SCHEMA_VERSION: i64 = 3;
const DB_FILE: &str = "app.db";

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE)
}

pub fn open(data_dir: &Path) -> Result<Connection> {
    fs::create_dir_all(data_dir)?;
    let path = db_path(data_dir);
    let conn = Connection::open(&path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // Migrations are not free, and almost every command opens this file.
    // A fresh file still migrates. A file left at the current version does not.
    if !schema_ready(&conn)? {
        init_schema(&conn)?;
    } else {
        ensure_compat(&conn)?;
    }
    Ok(conn)
}

fn schema_ready(conn: &Connection) -> Result<bool> {
    let table: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if table.is_none() {
        return Ok(false);
    }
    let version: Option<i64> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    Ok(version == Some(SCHEMA_VERSION))
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS projects (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            added_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS account_usage (
            provider TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pull_requests (
            repo TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sidebar_projects (
            project_path TEXT PRIMARY KEY,
            refreshed_at TEXT NOT NULL,
            cloud INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sidebar_transcripts (
            project_path TEXT NOT NULL,
            id TEXT NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (project_path, id)
        );
        CREATE TABLE IF NOT EXISTS sidebar_conversations (
            project_path TEXT NOT NULL,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'chat',
            journey_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            effort TEXT,
            model TEXT,
            context_window INTEGER,
            permission TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            preview TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (project_path, id)
        );
        CREATE TABLE IF NOT EXISTS sidebar_journeys (
            project_path TEXT NOT NULL,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            collapsed INTEGER NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (project_path, id)
        );
        CREATE TABLE IF NOT EXISTS project_path_history (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            previous_paths TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS project_groups (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_group_members (
            group_path TEXT NOT NULL REFERENCES project_groups(path) ON DELETE CASCADE,
            project_path TEXT NOT NULL,
            alias TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (group_path, project_path)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS project_group_members_alias
            ON project_group_members (group_path, alias);
        CREATE UNIQUE INDEX IF NOT EXISTS project_group_members_project
            ON project_group_members (project_path);
        ",
    )?;
    ensure_compat(conn)?;
    let version: Option<i64> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    if version != Some(SCHEMA_VERSION) {
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?1)",
            [SCHEMA_VERSION],
        )?;
    }
    Ok(())
}

/// Tables and columns added after a database was already stamped at the current version.
/// `CREATE TABLE IF NOT EXISTS` plus the column probes. Safe to run on every open.
fn ensure_compat(conn: &Connection) -> Result<()> {
    migrate_remote_tables(conn)?;
    migrate_sidebar_cache(conn)?;
    migrate_project_groups(conn)?;
    migrate_action_runs(conn)?;
    migrate_account_usage_samples(conn)?;
    Ok(())
}

/// One row each time an allowance window is read. The usage page draws these as a line.
fn migrate_account_usage_samples(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS account_usage_samples (
            provider TEXT NOT NULL,
            window_id TEXT NOT NULL,
            resets_at TEXT NOT NULL,
            used_percent REAL NOT NULL,
            recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS account_usage_samples_lookup
            ON account_usage_samples (provider, window_id, resets_at, recorded_at);
        ",
    )?;
    Ok(())
}

/// The last Actions run list for a GitHub repo. One row per `owner/repo`.
fn migrate_action_runs(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS action_runs (
            repo TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        ",
    )?;
    Ok(())
}

/// A group project points at folders that stay where they are.
/// `CREATE TABLE IF NOT EXISTS` is enough for a database already stamped at version 3.
fn migrate_project_groups(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS project_groups (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_group_members (
            group_path TEXT NOT NULL REFERENCES project_groups(path) ON DELETE CASCADE,
            project_path TEXT NOT NULL,
            alias TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (group_path, project_path)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS project_group_members_alias
            ON project_group_members (group_path, alias);
        CREATE UNIQUE INDEX IF NOT EXISTS project_group_members_project
            ON project_group_members (project_path);
        ",
    )?;
    Ok(())
}

/// Older app databases created `sidebar_projects` without the cloud flag.
fn migrate_sidebar_cache(conn: &Connection) -> Result<()> {
    if !column_exists(conn, "sidebar_projects", "cloud")? {
        conn.execute(
            "ALTER TABLE sidebar_projects ADD COLUMN cloud INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !column_exists(conn, "sidebar_conversations", "preview")? {
        conn.execute(
            "ALTER TABLE sidebar_conversations ADD COLUMN preview TEXT NOT NULL DEFAULT ''",
            [],
        )?;
        // Local copies have no last line yet. Dropping the marker makes the next list
        // read each project store once and write the preview back.
        conn.execute("DELETE FROM sidebar_projects WHERE cloud = 0", [])?;
    }
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sidebar_transcripts (
            project_path TEXT NOT NULL,
            id TEXT NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (project_path, id)
        );
        ",
    )?;
    Ok(())
}

pub(super) fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in rows {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migrate_remote_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS machines (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            user TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            auth TEXT NOT NULL,
            key_path TEXT,
            secret_account TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS remote_projects (
            id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            remote_path TEXT NOT NULL,
            mount_path TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            user TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            machine_id TEXT,
            installed_at TEXT NOT NULL,
            token TEXT,
            provider_keys TEXT
        );
        CREATE TABLE IF NOT EXISTS provider_keys (
            provider TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;
    ensure_provider_keys(conn)?;
    Ok(())
}

/// An earlier build created `provider_keys` without `value`. `CREATE TABLE IF NOT EXISTS` leaves that
/// table in place, so saving a key fails. Recreate it when the column is missing. It held no secrets.
fn ensure_provider_keys(conn: &Connection) -> Result<()> {
    if provider_keys_has_value(conn)? {
        return Ok(());
    }
    conn.execute_batch(
        "
        DROP TABLE provider_keys;
        CREATE TABLE provider_keys (
            provider TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;
    Ok(())
}

fn provider_keys_has_value(conn: &Connection) -> Result<bool> {
    let mut stmt = conn.prepare("PRAGMA table_info(provider_keys)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in rows {
        if name? == "value" {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A model-provider API key saved in Settings. Not the settings table: that one is readable from the UI.
pub fn get_provider_key(conn: &Connection, provider: &str) -> Result<Option<String>> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT value FROM provider_keys WHERE provider = ?1",
        [provider],
        |row| row.get(0),
    )
    .optional()
    .map_err(Error::from)
}

pub fn set_provider_key(conn: &Connection, provider: &str, value: &str) -> Result<()> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Err(Error::Other("provider key name is empty".into()));
    }
    let value = value.trim();
    if value.is_empty() {
        return delete_provider_key(conn, provider);
    }
    conn.execute(
        "INSERT INTO provider_keys (provider, value) VALUES (?1, ?2)
         ON CONFLICT(provider) DO UPDATE SET value = excluded.value",
        params![provider, value],
    )?;
    Ok(())
}

pub fn delete_provider_key(conn: &Connection, provider: &str) -> Result<()> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Ok(());
    }
    conn.execute("DELETE FROM provider_keys WHERE provider = ?1", [provider])?;
    Ok(())
}

pub(super) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub(super) fn path_key(path: &str) -> String {
    crate::paths::native_source(path).to_ascii_lowercase()
}
