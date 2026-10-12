use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    Agent,
    PrivateKey,
    Password,
}

impl AuthMethod {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim() {
            "agent" => Ok(Self::Agent),
            "private_key" => Ok(Self::PrivateKey),
            "password" => Ok(Self::Password),
            _ => Err(Error::Other(
                "auth must be agent, private_key, or password".into(),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::PrivateKey => "private_key",
            Self::Password => "password",
        }
    }

    pub fn needs_secret(self) -> bool {
        matches!(self, Self::PrivateKey | Self::Password)
    }
}

/// A blank password is not a password login. Use the key on this Mac instead.
pub fn auth_without_secret(method: AuthMethod, key_path: Option<&str>) -> AuthMethod {
    let key_missing = key_path.unwrap_or("").trim().is_empty();
    match method {
        AuthMethod::Password if key_missing => AuthMethod::Agent,
        AuthMethod::Password => AuthMethod::PrivateKey,
        AuthMethod::PrivateKey if key_missing => AuthMethod::Agent,
        other => other,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
    pub secret_account: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteProject {
    pub id: String,
    pub machine_id: String,
    pub name: String,
    pub remote_path: String,
    pub mount_path: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct NewMachine {
    pub name: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
}

pub fn secret_account(machine_id: &str) -> String {
    format!("ssh-secret:{machine_id}")
}

pub fn validate_user(raw: &str) -> Result<String> {
    let user = raw.trim().to_string();
    if user.is_empty() || user.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Error::Other("SSH user is invalid".into()));
    }
    Ok(user)
}

pub fn validate_host(raw: &str) -> Result<String> {
    let host = raw.trim().to_string();
    // `<machine>@orb` is the OrbStack SSH login. `~/.orbstack/ssh/config` resolves it.
    // A raw address for that VM is on a bridge this Mac cannot route to.
    let orb = host.strip_suffix("@orb").map(str::trim).filter(|name| !name.is_empty());
    let check = orb.unwrap_or(host.as_str());
    if check.is_empty()
        || check.chars().any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '@')
    {
        return Err(Error::Other("SSH host is invalid".into()));
    }
    if orb.is_some() {
        return Ok(format!("{check}@orb"));
    }
    Ok(host)
}

/// `user` and `host` for the system `ssh` command. OrbStack wants `user@machine@orb`.
pub fn ssh_login(user: &str, host: &str) -> (String, String) {
    if let Some(machine) = host.strip_suffix("@orb") {
        return (format!("{user}@{machine}"), "orb".into());
    }
    (user.to_string(), host.to_string())
}

pub fn validate_port(port: u16) -> Result<u16> {
    if port == 0 {
        return Err(Error::Other("SSH port must be between 1 and 65535".into()));
    }
    Ok(port)
}

pub fn validate_name(raw: &str) -> Result<String> {
    let name = raw.trim().to_string();
    if name.is_empty() || name.chars().any(|c| c.is_control()) {
        return Err(Error::Other("name is empty".into()));
    }
    if name.chars().count() > 80 {
        return Err(Error::Other("name is too long".into()));
    }
    Ok(name)
}

/// Absolute remote directory. Rejects `..`, whitespace, and anything that is not a single path.
pub fn validate_remote_path(raw: &str) -> Result<String> {
    let path = raw.trim().replace('\\', "/");
    if path.is_empty() || !path.starts_with('/') {
        return Err(Error::Other("remote path must be absolute".into()));
    }
    if path.contains('\0') || path.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(Error::Other("remote path is invalid".into()));
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(Error::Other("remote path cannot contain ..".into()));
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err(Error::Other("remote path cannot be the server root".into()));
    }
    Ok(format!("/{}", parts.join("/")))
}

pub fn mount_point(data_dir: &Path, project_id: &str) -> PathBuf {
    data_dir.join("mounts").join(project_id)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn insert_machine(conn: &Connection, draft: NewMachine) -> Result<Machine> {
    let name = validate_name(&draft.name)?;
    let user = validate_user(&draft.user)?;
    let host = validate_host(&draft.host)?;
    let port = validate_port(draft.port)?;
    if machine_by_name(conn, &name)?.is_some() {
        return Err(Error::Conflict(format!("{name} already exists")));
    }
    if draft.auth == AuthMethod::PrivateKey {
        let key = draft.key_path.as_deref().unwrap_or("").trim();
        if key.is_empty() {
            return Err(Error::Other("private key path is required".into()));
        }
    }
    let id = Uuid::new_v4().to_string();
    let secret = if draft.auth.needs_secret() {
        Some(secret_account(&id))
    } else {
        None
    };
    let key_path = draft
        .key_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let created_at = now_iso();
    conn.execute(
        "INSERT INTO machines (id, name, user, host, port, auth, key_path, secret_account, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            name,
            user,
            host,
            port as i64,
            draft.auth.as_str(),
            key_path,
            secret,
            created_at
        ],
    )?;
    Ok(Machine {
        id,
        name,
        user,
        host,
        port,
        auth: draft.auth,
        key_path,
        secret_account: secret,
        created_at,
    })
}

pub fn list_machines(conn: &Connection) -> Result<Vec<Machine>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, user, host, port, auth, key_path, secret_account, created_at
         FROM machines ORDER BY name COLLATE NOCASE ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| Ok(read_machine(row)?))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn machine_by_id(conn: &Connection, id: &str) -> Result<Option<Machine>> {
    conn.query_row(
        "SELECT id, name, user, host, port, auth, key_path, secret_account, created_at
         FROM machines WHERE id = ?1",
        [id],
        |row| read_machine(row),
    )
    .optional()
    .map_err(Error::from)
}

pub fn machine_by_host(conn: &Connection, host: &str, port: u16) -> Result<Option<Machine>> {
    conn.query_row(
        "SELECT id, name, user, host, port, auth, key_path, secret_account, created_at
         FROM machines WHERE host = ?1 COLLATE NOCASE AND port = ?2",
        params![host, port as i64],
        |row| read_machine(row),
    )
    .optional()
    .map_err(Error::from)
}

pub fn upsert_machine(conn: &Connection, draft: NewMachine) -> Result<Machine> {
    let host = validate_host(&draft.host)?;
    let port = validate_port(draft.port)?;
    if let Some(existing) = machine_by_host(conn, &host, port)? {
        return update_machine(conn, &existing, draft);
    }
    if let Some(existing) = machine_by_name(conn, &draft.name)? {
        return update_machine(conn, &existing, draft);
    }
    insert_machine(conn, draft)
}

fn update_machine(conn: &Connection, existing: &Machine, draft: NewMachine) -> Result<Machine> {
    let name = validate_name(&draft.name)?;
    let user = validate_user(&draft.user)?;
    let host = validate_host(&draft.host)?;
    let port = validate_port(draft.port)?;
    if let Some(other) = machine_by_name(conn, &name)? {
        if other.id != existing.id {
            return Err(Error::Conflict(format!("{name} already exists")));
        }
    }
    if draft.auth == AuthMethod::PrivateKey {
        let key = draft.key_path.as_deref().unwrap_or("").trim();
        if key.is_empty() && existing.key_path.as_deref().unwrap_or("").is_empty() {
            return Err(Error::Other("private key path is required".into()));
        }
    }
    let key_path = draft
        .key_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .or_else(|| existing.key_path.clone());
    let secret = if draft.auth.needs_secret() {
        Some(
            existing
                .secret_account
                .clone()
                .unwrap_or_else(|| secret_account(&existing.id)),
        )
    } else {
        None
    };
    conn.execute(
        "UPDATE machines
         SET name = ?1, user = ?2, host = ?3, port = ?4, auth = ?5, key_path = ?6, secret_account = ?7
         WHERE id = ?8",
        params![
            name,
            user,
            host,
            port as i64,
            draft.auth.as_str(),
            key_path,
            secret,
            existing.id
        ],
    )?;
    Ok(Machine {
        id: existing.id.clone(),
        name,
        user,
        host,
        port,
        auth: draft.auth,
        key_path,
        secret_account: secret,
        created_at: existing.created_at.clone(),
    })
}

pub fn machine_by_name(conn: &Connection, name: &str) -> Result<Option<Machine>> {
    conn.query_row(
        "SELECT id, name, user, host, port, auth, key_path, secret_account, created_at
         FROM machines WHERE name = ?1 COLLATE NOCASE",
        [name],
        |row| read_machine(row),
    )
    .optional()
    .map_err(Error::from)
}

fn read_machine(row: &rusqlite::Row<'_>) -> rusqlite::Result<Machine> {
    let port: i64 = row.get(4)?;
    let auth: String = row.get(5)?;
    Ok(Machine {
        id: row.get(0)?,
        name: row.get(1)?,
        user: row.get(2)?,
        host: row.get(3)?,
        port: port.clamp(0, u16::MAX as i64) as u16,
        auth: AuthMethod::parse(&auth).unwrap_or(AuthMethod::Agent),
        key_path: row.get(6)?,
        secret_account: row.get(7)?,
        created_at: row.get(8)?,
    })
}

/// Removes the machine and its project rows. Returns secret accounts the caller should delete.
pub fn delete_machine(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let Some(machine) = machine_by_id(conn, id)? else {
        return Ok(Vec::new());
    };
    let mut secrets = Vec::new();
    if let Some(account) = machine.secret_account {
        secrets.push(account);
    }
    conn.execute("DELETE FROM remote_projects WHERE machine_id = ?1", [id])?;
    conn.execute("DELETE FROM machines WHERE id = ?1", [id])?;
    Ok(secrets)
}

pub fn insert_remote_project(
    conn: &Connection,
    machine_id: &str,
    name: &str,
    remote_path: &str,
    mount_path: &Path,
) -> Result<RemoteProject> {
    if machine_by_id(conn, machine_id)?.is_none() {
        return Err(Error::NotFound("machine not found".into()));
    }
    let name = validate_name(name)?;
    let remote_path = validate_remote_path(remote_path)?;
    let mount = mount_path.to_string_lossy().to_string();
    if mount.trim().is_empty() {
        return Err(Error::Other("mount path is empty".into()));
    }
    let id = Uuid::new_v4().to_string();
    let created_at = now_iso();
    conn.execute(
        "INSERT INTO remote_projects (id, machine_id, name, remote_path, mount_path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, machine_id, name, remote_path, mount, created_at],
    )?;
    Ok(RemoteProject {
        id,
        machine_id: machine_id.to_string(),
        name,
        remote_path,
        mount_path: mount,
        created_at,
    })
}

pub fn list_remote_projects(conn: &Connection) -> Result<Vec<RemoteProject>> {
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, name, remote_path, mount_path, created_at
         FROM remote_projects ORDER BY name COLLATE NOCASE ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| Ok(read_project(row)?))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[allow(dead_code)]
pub fn remote_project_by_id(conn: &Connection, id: &str) -> Result<Option<RemoteProject>> {
    conn.query_row(
        "SELECT id, machine_id, name, remote_path, mount_path, created_at
         FROM remote_projects WHERE id = ?1",
        [id],
        |row| read_project(row),
    )
    .optional()
    .map_err(Error::from)
}

pub fn remote_project_by_mount(conn: &Connection, mount: &Path) -> Result<Option<RemoteProject>> {
    let key = crate::paths::native_source(&mount.to_string_lossy());
    conn.query_row(
        "SELECT id, machine_id, name, remote_path, mount_path, created_at
         FROM remote_projects
         WHERE lower(rtrim(replace(mount_path, '\\', '/'), '/')) = lower(rtrim(replace(?1, '\\', '/'), '/'))",
        [key],
        |row| read_project(row),
    )
    .optional()
    .map_err(Error::from)
}

#[allow(dead_code)]
pub fn delete_remote_project(conn: &Connection, id: &str) -> Result<Option<RemoteProject>> {
    let existing = remote_project_by_id(conn, id)?;
    if existing.is_some() {
        conn.execute("DELETE FROM remote_projects WHERE id = ?1", [id])?;
    }
    Ok(existing)
}

fn read_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteProject> {
    Ok(RemoteProject {
        id: row.get(0)?,
        machine_id: row.get(1)?,
        name: row.get(2)?,
        remote_path: row.get(3)?,
        mount_path: row.get(4)?,
        created_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appdb;

    fn conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = appdb::open(dir.path()).unwrap();
        (dir, conn)
    }

    fn machine(name: &str) -> NewMachine {
        NewMachine {
            name: name.into(),
            user: "dev".into(),
            host: "example.com".into(),
            port: 22,
            auth: AuthMethod::Agent,
            key_path: None,
        }
    }

    #[test]
    fn rejects_bad_machine_fields() {
        assert!(validate_user("ada").is_ok());
        assert!(validate_user("ada lovelace").is_err());
        assert!(validate_host("").is_err());
        assert!(validate_host("bad host").is_err());
        assert!(validate_host("user@host").is_err());
        assert_eq!(validate_host("devbox@orb").unwrap(), "devbox@orb");
        assert!(validate_host("@orb").is_err());
        assert!(validate_host("bad name@orb").is_err());
        assert_eq!(
            ssh_login("dev", "devbox@orb"),
            ("dev@devbox".into(), "orb".into())
        );
        assert_eq!(ssh_login("dev", "10.0.0.2"), ("dev".into(), "10.0.0.2".into()));
        assert!(validate_port(0).is_err());
        assert_eq!(validate_port(2222).unwrap(), 2222);
        assert!(validate_remote_path("relative").is_err());
        assert!(validate_remote_path("/srv/../etc").is_err());
        assert!(validate_remote_path("/").is_err());
        assert_eq!(
            validate_remote_path("/srv/apps/billing/").unwrap(),
            "/srv/apps/billing"
        );
    }

    #[test]
    fn insert_list_and_reject_duplicate_name() {
        let (_dir, conn) = conn();
        let saved = insert_machine(&conn, machine("Build")).unwrap();
        assert_eq!(saved.name, "Build");
        assert_eq!(saved.port, 22);
        assert!(saved.secret_account.is_none());
        let err = insert_machine(&conn, machine("build")).unwrap_err();
        assert!(err.to_string().contains("already exists"));
        assert_eq!(list_machines(&conn).unwrap().len(), 1);
    }

    #[test]
    fn connecting_again_updates_the_same_host() {
        let (_dir, conn) = conn();
        let mut draft = machine("10.0.0.219");
        draft.host = "10.0.0.219".into();
        draft.auth = AuthMethod::PrivateKey;
        draft.key_path = Some("/Users/me/.ssh/id_ed25519".into());
        let first = upsert_machine(&conn, draft.clone()).unwrap();
        draft.user = "ada".into();
        let again = upsert_machine(&conn, draft).unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.user, "ada");
        assert_eq!(list_machines(&conn).unwrap().len(), 1);
    }

    #[test]
    fn blank_password_uses_the_saved_key() {
        assert_eq!(
            auth_without_secret(AuthMethod::Password, Some("/Users/me/.ssh/id_ed25519")),
            AuthMethod::PrivateKey
        );
        assert_eq!(
            auth_without_secret(AuthMethod::Password, None),
            AuthMethod::Agent
        );
        assert_eq!(
            auth_without_secret(AuthMethod::Password, Some("  ")),
            AuthMethod::Agent
        );
        assert_eq!(
            auth_without_secret(AuthMethod::PrivateKey, None),
            AuthMethod::Agent
        );
        assert_eq!(
            auth_without_secret(AuthMethod::Agent, None),
            AuthMethod::Agent
        );
    }

    #[test]
    fn private_key_requires_a_path_and_gets_a_secret_account() {
        let (_dir, conn) = conn();
        let mut draft = machine("Key");
        draft.auth = AuthMethod::PrivateKey;
        assert!(insert_machine(&conn, draft.clone()).is_err());
        draft.key_path = Some("/Users/me/.ssh/id_ed25519".into());
        let saved = insert_machine(&conn, draft).unwrap();
        assert_eq!(
            saved.secret_account.as_deref(),
            Some(secret_account(&saved.id).as_str())
        );
    }

    #[test]
    fn delete_machine_removes_projects_and_returns_the_secret() {
        let dir = tempfile::tempdir().unwrap();
        let conn = appdb::open(dir.path()).unwrap();
        let mut draft = machine("Box");
        draft.auth = AuthMethod::Password;
        let saved = insert_machine(&conn, draft).unwrap();
        let mount = dir.path().join("mounts").join("proj");
        insert_remote_project(&conn, &saved.id, "billing", "/srv/billing", &mount).unwrap();
        let secrets = delete_machine(&conn, &saved.id).unwrap();
        assert_eq!(secrets, vec![secret_account(&saved.id)]);
        assert!(list_machines(&conn).unwrap().is_empty());
        assert!(list_remote_projects(&conn).unwrap().is_empty());
        assert!(delete_machine(&conn, &saved.id).unwrap().is_empty());
    }

    #[test]
    fn remote_project_roundtrip_by_mount() {
        let dir = tempfile::tempdir().unwrap();
        let conn = appdb::open(dir.path()).unwrap();
        let saved = insert_machine(&conn, machine("Box")).unwrap();
        let mount = dir.path().join("mounts").join("proj");
        let project =
            insert_remote_project(&conn, &saved.id, "billing", "/srv/apps/billing/", &mount)
                .unwrap();
        assert_eq!(project.remote_path, "/srv/apps/billing");
        let found = remote_project_by_mount(&conn, &mount).unwrap().unwrap();
        assert_eq!(found.id, project.id);
        assert!(remote_project_by_mount(&conn, dir.path()).unwrap().is_none());
        assert!(insert_remote_project(&conn, "missing", "x", "/srv/x", &mount).is_err());
    }
}
