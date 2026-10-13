//! A TwanAgent server is an SSH login plus an installed `twanagent-server` and a shared token.
//! The token is stored beside the server row so a reload still shows Paired. It is not sent to the UI.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::config::{validate_host, validate_port, validate_user};
use crate::error::{Error, Result};

pub const TOKEN_PREFIX: &str = "agent-token:";
pub const BINARY_PATH: &str = "$HOME/.twanagent/bin/twanagent-server";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerInstallStatus {
    pub installed: bool,
    pub version: String,
    pub path: String,
    /// SSH port answered. False when the machine is off or unreachable, before any program check.
    pub online: bool,
    /// This Mac has a newer `twanagent-server` than the one on that machine.
    #[serde(default)]
    pub update: bool,
    /// The version this Mac would copy. Empty when no newer build is ready.
    #[serde(default)]
    pub available: String,
    /// `~/.twanagent/auth-token` is a pairing token. The token itself stays on the machine.
    #[serde(default)]
    pub paired: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentServer {
    pub id: String,
    pub name: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub machine_id: Option<String>,
    pub installed_at: String,
    /// True when this client has a token for the server. The token itself is never sent to the UI.
    pub paired: bool,
}

#[derive(Debug, Clone)]
pub struct NewAgentServer {
    pub name: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub machine_id: Option<String>,
}

pub fn token_account(server_id: &str) -> String {
    format!("{TOKEN_PREFIX}{server_id}")
}

/// 32 random bytes, hex. Long enough that a guess is not the threat. SSH still has to land the install.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("token entropy");
    hex::encode(bytes)
}

/// Ask the remote machine which binary it can run before the copy starts.
pub fn target_probe_script() -> String {
    "uname -m; uname -s".into()
}

/// The version string baked into a built `twanagent-server`, or empty when it cannot be read.
/// The binary also contains "twanagent-server live", which is not a version. A digit has to follow.
pub fn binary_version(bytes: &[u8]) -> String {
    let marker = b"twanagent-server ";
    let mut from = 0;
    while let Some(at) = bytes[from..].windows(marker.len()).position(|window| window == marker) {
        let start = from + at + marker.len();
        let rest = &bytes[start..];
        let end = rest
            .iter()
            .position(|byte| !(byte.is_ascii_alphanumeric() || *byte == b'.' || *byte == b'-'))
            .unwrap_or(rest.len());
        let text = String::from_utf8_lossy(&rest[..end]).trim_matches('-').trim().to_string();
        if text.starts_with(|ch: char| ch.is_ascii_digit()) {
            return text;
        }
        from = start;
        if from >= bytes.len() {
            break;
        }
    }
    String::new()
}

/// macOS builds cannot run on the Linux machine. Pick the binary that matches `uname`.
pub fn binary_for_target(arch: &str, os: &str) -> Result<std::path::PathBuf> {
    let os = os.trim().to_ascii_lowercase();
    let arch = arch.trim();
    if os.contains("darwin") || os == "macos" {
        let found = newest_binary(&[
            candidate_path(&["target", "debug", "twanagent-server"]),
            candidate_path(&["target", "release", "twanagent-server"]),
        ]);
        if let Some(path) = found {
            return Ok(path);
        }
        return Err(Error::Other(
            "twanagent-server is not built on this Mac yet. Build it, then install.".into(),
        ));
    }
    if !os.contains("linux") {
        return Err(Error::Other(format!(
            "this machine is {os} {arch}. Install supports macOS and Linux."
        )));
    }
    let triple = match arch {
        "aarch64" | "arm64" => "aarch64-unknown-linux-gnu",
        "x86_64" | "amd64" => "x86_64-unknown-linux-gnu",
        other => {
            return Err(Error::Other(format!(
                "this machine is Linux {other}. Install supports arm64 and x86_64."
            )))
        }
    };
    // Cargo only honours `target-dir` from the workspace root. A build that missed that
    // config wrote the binary under the service crate instead, so check both.
    let found = newest_binary(&[
        candidate_path(&["target", triple, "release", "twanagent-server"]),
        candidate_path(&["service", "target", triple, "release", "twanagent-server"]),
        candidate_path(&["target", triple, "debug", "twanagent-server"]),
        candidate_path(&["service", "target", triple, "debug", "twanagent-server"]),
    ]);
    if let Some(path) = found {
        return Ok(path);
    }
    Err(Error::Other(format!(
        "the Linux server program is not built yet. Build twanagent-server for {triple}, then install."
    )))
}

fn candidate_path(parts: &[&str]) -> std::path::PathBuf {
    parts.iter().fold(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        |path, part| path.join(part),
    )
}

/// Prefer the highest baked version, then the newest file. A release build of the current
/// version must beat an older one left behind in the other target folder.
fn newest_binary(paths: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    let mut found: Vec<&std::path::PathBuf> = paths.iter().filter(|path| path.is_file()).collect();
    found.sort_by(|left, right| binary_rank(right).cmp(&binary_rank(left)));
    found.first().map(|path| (*path).clone())
}

fn binary_rank(path: &std::path::Path) -> (Vec<u64>, u8, u64, bool, std::time::SystemTime) {
    let version = std::fs::read(path).map(|bytes| binary_version(&bytes)).unwrap_or_default();
    let (numbers, pre) = split_version(&version);
    // A release with no prerelease tag is newer than any beta of the same numbers.
    let (pre_rank, pre_num) = match pre {
        Some(num) => (0u8, num),
        None if version.is_empty() => (0u8, 0),
        None => (1u8, 0),
    };
    let release = path.components().any(|part| part.as_os_str() == "release");
    let modified = path.metadata().and_then(|meta| meta.modified()).unwrap_or(std::time::UNIX_EPOCH);
    (numbers, pre_rank, pre_num, release, modified)
}

/// The program this Mac would copy. `twanagent-server --version` prints `twanagent-server <this>`.
/// This is the service crate version, not the desktop app version.
/// The trailing null keeps the next string in the binary from being read as part of the version.
/// It is not part of the version, so a comparison has to drop it or the installed copy looks older.
pub const SERVER_VERSION: &str = twanagent_service::VERSION;

pub fn server_version() -> &'static str {
    SERVER_VERSION.trim_end_matches('\0')
}

/// `installed` is the text from `--version`, such as `twanagent-server 1.0.0-beta.1`.
pub fn server_update_available(installed: &str) -> bool {
    let installed = installed.trim().strip_prefix("twanagent-server").unwrap_or(installed).trim();
    if installed.is_empty() || installed == "unknown" {
        return false;
    }
    version_is_older(installed, server_version())
}

/// Numeric pieces, then the prerelease tag. `1.0.0-beta.1` is older than `1.0.0-beta.2`.
fn version_is_older(installed: &str, current: &str) -> bool {
    let (installed_num, installed_pre) = split_version(installed);
    let (current_num, current_pre) = split_version(current);
    let len = installed_num.len().max(current_num.len());
    for i in 0..len {
        let left = installed_num.get(i).copied().unwrap_or(0);
        let right = current_num.get(i).copied().unwrap_or(0);
        if left != right {
            return left < right;
        }
    }
    match (installed_pre, current_pre) {
        (Some(left), Some(right)) => left < right,
        (Some(_), None) => true,
        _ => false,
    }
}

fn split_version(raw: &str) -> (Vec<u64>, Option<u64>) {
    let (head, tail) = raw.split_once('-').unwrap_or((raw, ""));
    let numbers = head
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect();
    let pre = tail
        .rsplit(|ch: char| !ch.is_ascii_digit())
        .next()
        .filter(|part| !part.is_empty())
        .and_then(|part| part.parse().ok());
    (numbers, pre)
}

/// Ask the remote shell whether `twanagent-server` is on disk, what version it prints,
/// and whether a pairing token is already there.
/// A file that exists but is not marked executable still counts. The copy step sets the bit.
/// `-x` alone hid a real install when the bit was missing or the shell could not see it.
/// Put the program on `PATH` as `twanagent-server`. Silent, and a failure here does not fail the check.
/// `~/.local/bin` is the usual per-user bin. The shell files are updated only when they do not mention it yet.
pub fn path_setup_script() -> &'static str {
    "mkdir -p \"$HOME/.local/bin\" && ln -sfn \"$HOME/.twanagent/bin/twanagent-server\" \"$HOME/.local/bin/twanagent-server\"; \
path_line='export PATH=\"$HOME/.local/bin:$PATH\"'; \
for rc in \"$HOME/.bashrc\" \"$HOME/.profile\"; do \
  if [ -f \"$rc\" ] && grep -Fqs '.local/bin' \"$rc\"; then continue; fi; \
  printf '\\n%s\\n' \"$path_line\" >> \"$rc\"; \
done; \
if [ -f \"$HOME/.zshrc\" ] && ! grep -Fqs '.local/bin' \"$HOME/.zshrc\"; then printf '\\n%s\\n' \"$path_line\" >> \"$HOME/.zshrc\"; fi"
}

pub fn version_check_script() -> String {
    format!(
        "{{ {setup}; }} >/dev/null 2>&1 || true; \
bin={BINARY_PATH}; \
if [ -f \"$bin\" ] || [ -x \"$bin\" ]; then \
  if [ ! -x \"$bin\" ]; then chmod 755 \"$bin\" 2>/dev/null || true; fi; \
  bytes=$(wc -c < \"$bin\" 2>/dev/null | tr -d '[:space:]'); \
  case \"$bytes\" in ''|*[!0-9]*) bytes=0 ;; esac; \
  if [ \"$bytes\" -lt 5000000 ]; then \
    printf 'status broken\\n'; \
  else \
    ver=$(tr -cd '0-9A-Za-z.-\\n' < \"$bin.version\" 2>/dev/null | head -n 1 | tr -d '[:space:]'); \
    if [ -z \"$ver\" ]; then ver=$(\"$bin\" --version 2>/dev/null | tr -d '\\n' || true); fi; \
    case \"$ver\" in \
      twanagent-server*) printf 'status installed %s\\n' \"$ver\" ;; \
      '') printf 'status installed unknown\\n' ;; \
      *) printf 'status installed twanagent-server %s\\n' \"$ver\" ;; \
    esac; \
  fi; \
else printf 'status missing\\n'; fi; \
token=\"$HOME/.twanagent/auth-token\"; \
if [ -f \"$token\" ]; then \
  tok=$(tr -d '[:space:]' < \"$token\"); \
  case \"$tok\" in \
    *[!0-9A-Fa-f]*|'') printf 'paired no\\n' ;; \
    ????????????????????????????????*) printf 'paired yes\\n' ;; \
    *) printf 'paired no\\n' ;; \
  esac; \
else printf 'paired no\\n'; fi; \
exit 0",
        setup = path_setup_script(),
    )
}

pub fn parse_version_check(stdout: &str) -> ServerInstallStatus {
    let path = "~/.twanagent/bin/twanagent-server".into();
    let status = stdout
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("status "))
        .unwrap_or("")
        .trim();
    let paired = stdout.lines().any(|line| {
        let line = line.trim();
        line == "paired yes" || line == "token yes"
    });
    if let Some(rest) = status.strip_prefix("installed") {
        let version = rest.trim().to_string();
        let update = server_update_available(&version);
        return ServerInstallStatus {
            installed: true,
            available: if update { server_version().into() } else { String::new() },
            update,
            version,
            path,
            online: true,
            paired,
        };
    }
    ServerInstallStatus {
        installed: false,
        version: String::new(),
        available: String::new(),
        path,
        online: true,
        update: false,
        paired,
    }
}

/// Read the version out of the file without starting it. A running copy keeps the old bytes in memory,
/// so `--version` would still print the version from before the file was replaced.
/// The marker is written on its own line at the end of the copy, so this does not scan the program.
pub fn file_version_script() -> String {
    format!("tail -c 80 {BINARY_PATH}.version 2>/dev/null || true")
}

/// Stop the running program, then decode one base64 stream into a new file and swap it into place.
/// The old file stays until the new one is complete. A failed copy does not leave a half-written program.
/// Hundreds of separate SSH commands dropped the copy when the server was busy, so the version never changed.
///
/// `base64 -d` exits 0 when the stream ends early. A short file still loads, then segfaults on
/// `--version`. The byte count is the decoded length, so a cut-off copy is refused before it replaces
/// the program that is already there.
///
/// `version` is the string baked into the file being copied, not the crate version compiled into
/// this app. A Linux binary built before the crate moved to a newer beta still prints the old one.
/// Writing the crate version beside that file made the check say the copy had the wrong version.
pub fn binary_install_command(bytes: u64, version: &str) -> String {
    let version = version
        .trim()
        .trim_end_matches('\0')
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '.' || *ch == '-')
        .collect::<String>();
    format!(
        "pkill -x twanagent-server >/dev/null 2>&1 || true; \
mkdir -p \"$HOME/.twanagent/bin\" && \
base64 -d > {BINARY_PATH}.tmp && \
got=$(wc -c < {BINARY_PATH}.tmp | tr -d '[:space:]') && \
if [ \"$got\" != '{bytes}' ]; then echo \"copied $got of {bytes} bytes\" >&2; rm -f {BINARY_PATH}.tmp; exit 1; fi && \
mv {BINARY_PATH}.tmp {BINARY_PATH} && chmod 755 {BINARY_PATH} && \
printf 'twanagent-server {version}\\n' > {BINARY_PATH}.version && \
echo installed"
    )
}

/// Write `~/.twanagent/provider-keys.json` from the chosen providers. Unchecked providers are cleared.
/// The values travel inside the SSH command. The reply is only `copied`, never the keys.
pub fn provider_keys_script(keys: &twanagent_service::ProviderKeys) -> Result<String> {
    let body = serde_json::to_vec_pretty(&keys.trimmed()).map_err(|err| Error::Other(err.to_string()))?;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, body);
    Ok(format!(
        "mkdir -p \"$HOME/.twanagent\" && umask 077 && printf %s {} | base64 -d > \"$HOME/.twanagent/provider-keys.json\" && chmod 600 \"$HOME/.twanagent/provider-keys.json\" && echo copied",
        super::ssh::shell_single_quote(&encoded)
    ))
}

pub fn install_script(token: &str) -> Result<String> {
    let token = token.trim();
    if token.len() < 32 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Other("agent token is invalid".into()));
    }
    let quoted = super::ssh::shell_single_quote(token);
    Ok(format!(
        "mkdir -p \"$HOME/.twanagent\" && umask 077 && printf '%s\\n' {quoted} > \"$HOME/.twanagent/auth-token\" && chmod 600 \"$HOME/.twanagent/auth-token\" && echo installed"
    ))
}

pub fn insert_server(conn: &Connection, draft: NewAgentServer) -> Result<AgentServer> {
    let name = draft.name.trim();
    if name.is_empty() || name.chars().any(|c| c.is_control()) {
        return Err(Error::Other("server name is empty".into()));
    }
    let user = validate_user(&draft.user)?;
    let host = validate_host(&draft.host)?;
    let port = validate_port(draft.port)?;
    if server_by_host(conn, &host, port)?.is_some() {
        return Err(Error::Conflict(format!("{host} is already a TwanAgent server")));
    }
    let id = Uuid::new_v4().to_string();
    let installed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    conn.execute(
        "INSERT INTO agent_servers (id, name, user, host, port, machine_id, installed_at, token)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
        params![id, name, user, host, port as i64, draft.machine_id, installed_at],
    )?;
    Ok(AgentServer {
        id,
        name: name.to_string(),
        user,
        host,
        port,
        machine_id: draft.machine_id,
        installed_at,
        paired: true,
    })
}

pub fn list_servers(conn: &Connection, paired: impl Fn(&str) -> bool) -> Result<Vec<AgentServer>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, user, host, port, machine_id, installed_at, token
         FROM agent_servers ORDER BY name COLLATE NOCASE ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let port: i64 = row.get(4)?;
        let token: Option<String> = row.get(7)?;
        Ok((
            AgentServer {
                id: row.get(0)?,
                name: row.get(1)?,
                user: row.get(2)?,
                host: row.get(3)?,
                port: port.clamp(0, u16::MAX as i64) as u16,
                machine_id: row.get(5)?,
                installed_at: row.get(6)?,
                paired: false,
            },
            token,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (mut server, token) = row?;
        let stored = token.filter(|value| !value.trim().is_empty());
        server.paired = stored.is_some() || paired(&token_account(&server.id));
        out.push(server);
    }
    Ok(out)
}

/// Save the pairing token next to the server. A reload reads this, not the keychain.
pub fn set_server_token(conn: &Connection, id: &str, token: &str) -> Result<()> {
    let token = token.trim();
    if token.len() < 32 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Other("agent token is invalid".into()));
    }
    let changed = conn.execute(
        "UPDATE agent_servers SET token = ?1 WHERE id = ?2",
        params![token, id],
    )?;
    if changed == 0 {
        return Err(Error::NotFound("server not found".into()));
    }
    Ok(())
}

pub fn server_by_host(conn: &Connection, host: &str, port: u16) -> Result<Option<AgentServer>> {
    conn.query_row(
        "SELECT id, name, user, host, port, machine_id, installed_at, token
         FROM agent_servers WHERE host = ?1 COLLATE NOCASE AND port = ?2",
        params![host, port as i64],
        |row| {
            let stored_port: i64 = row.get(4)?;
            let token: Option<String> = row.get(7)?;
            Ok(AgentServer {
                id: row.get(0)?,
                name: row.get(1)?,
                user: row.get(2)?,
                host: row.get(3)?,
                port: stored_port.clamp(0, u16::MAX as i64) as u16,
                machine_id: row.get(5)?,
                installed_at: row.get(6)?,
                paired: token.is_some_and(|value| !value.trim().is_empty()),
            })
        },
    )
    .optional()
    .map_err(Error::from)
}

/// Which provider keys were copied to this server. The key text is not stored here.
pub fn server_provider_keys(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let raw: Option<String> = conn
        .query_row("SELECT provider_keys FROM agent_servers WHERE id = ?1", [id], |row| row.get(0))
        .optional()?
        .flatten();
    Ok(parse_provider_keys(raw.as_deref()))
}

pub fn set_server_provider_keys(conn: &Connection, id: &str, providers: &[String]) -> Result<Vec<String>> {
    let names = normalize_provider_keys(providers);
    let stored = if names.is_empty() { None } else { Some(names.join(",")) };
    let changed = conn.execute(
        "UPDATE agent_servers SET provider_keys = ?1 WHERE id = ?2",
        params![stored, id],
    )?;
    if changed == 0 {
        return Err(Error::NotFound("server not found".into()));
    }
    Ok(names)
}

pub fn parse_provider_keys(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else { return Vec::new() };
    normalize_provider_keys(&raw.split(',').map(str::to_string).collect::<Vec<_>>())
}

fn normalize_provider_keys(providers: &[String]) -> Vec<String> {
    const ORDER: &[&str] = &["xai", "anthropic", "minimax"];
    let wanted: std::collections::HashSet<&str> = providers.iter().map(|name| name.trim()).collect();
    ORDER
        .iter()
        .filter(|name| wanted.contains(**name))
        .map(|name| (*name).to_string())
        .collect()
}

pub fn delete_server(conn: &Connection, id: &str) -> Result<Option<String>> {
    let existing = conn
        .query_row("SELECT id FROM agent_servers WHERE id = ?1", [id], |row| row.get::<_, String>(0))
        .optional()?;
    let Some(id) = existing else {
        return Ok(None);
    };
    conn.execute("DELETE FROM agent_servers WHERE id = ?1", [&id])?;
    Ok(Some(token_account(&id)))
}

/// A frame is accepted only when the token matches. Empty and wrong tokens fail the same way.
#[cfg_attr(not(test), allow(dead_code))]
pub fn token_matches(stored: Option<&str>, presented: &str) -> bool {
    let Some(stored) = stored.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let presented = presented.trim();
    if stored.len() != presented.len() {
        return false;
    }
    stored.bytes().zip(presented.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appdb;

    #[test]
    fn version_check_tells_missing_from_installed() {
        let script = version_check_script();
        assert!(script.contains("$HOME/.local/bin/twanagent-server"));
        assert!(script.contains("$HOME/.twanagent/bin/twanagent-server"));
        assert!(!parse_version_check("status missing\n").installed);
        // A cut-off copy is a few megabytes and segfaults. It must not count as installed.
        let broken = parse_version_check("status broken\npaired yes\n");
        assert!(!broken.installed);
        assert!(broken.paired);
        assert!(broken.online);
        let found = parse_version_check(" status installed twanagent-server 1.0.0-beta.1\npaired no\n");
        assert!(found.installed);
        assert!(found.online);
        assert!(!found.paired);
        assert_eq!(found.version, "twanagent-server 1.0.0-beta.1");
        let paired = parse_version_check("status installed twanagent-server 1.0.0-beta.3\npaired yes\n");
        assert!(paired.installed);
        assert!(paired.paired);
        let token_only = parse_version_check("status missing\npaired yes\n");
        assert!(!token_only.installed);
        assert!(token_only.paired);
        // The raw `--version` line is not a status. It must not be shown as an error or a version.
        let leaked = parse_version_check("installed twanagent-server 1.0.0-beta.3\ntoken yes\n");
        assert!(!leaked.installed);
        assert!(leaked.paired);
        assert_eq!(
            binary_version(b"prefix twanagent-server 1.0.0-beta.2\0tail"),
            "1.0.0-beta.2"
        );
        assert_eq!(
            binary_version(b"twanagent-server live on 127.0.0.1 twanagent-server 1.0.0-beta.4\0"),
            "1.0.0-beta.4"
        );
        assert!(binary_version(b"twanagent-server live").is_empty());
        assert!(server_update_available("twanagent-server 1.0.0-beta.1"));
        assert!(!server_update_available(&format!("twanagent-server {}", server_version())));
        assert!(!server_version().contains('\0'));
        let current = parse_version_check(&format!("status installed twanagent-server {}\n", server_version()));
        assert!(!current.update);
        assert!(current.available.is_empty());
        assert_ne!(SERVER_VERSION, env!("CARGO_PKG_VERSION"));
        assert!(!server_update_available("unknown"));
        assert!(!version_is_older("1.0.0", "1.0.0-beta.2"));
        let missing = parse_version_check("status missing\n");
        assert!(!missing.installed);
        assert!(missing.online);
    }

    #[test]
    fn linux_arm_does_not_ask_for_the_mac_binary() {
        let err = binary_for_target("i686", "Linux").unwrap_err().to_string();
        assert!(err.contains("arm64 and x86_64"));
        let other = binary_for_target("aarch64", "FreeBSD").unwrap_err().to_string();
        assert!(other.contains("macOS and Linux"));
    }

    #[test]
    fn binary_install_decodes_onto_the_server_path() {
        let script = binary_install_command(6171176, "1.0.0-beta.3");
        assert!(script.contains("pkill -x twanagent-server"));
        assert!(!script.contains("pkill -f"));
        assert!(script.contains("base64 -d"));
        assert!(script.contains("chmod 755"));
        assert!(script.contains("$HOME/.twanagent/bin/twanagent-server"));
        assert!(script.contains(".version"));
        assert!(script.contains("6171176"));
        assert!(script.contains("twanagent-server 1.0.0-beta.3"));
        assert!(!script.contains("beta.5"));
        assert!(script.contains("rm -f"));
        let read = file_version_script();
        assert!(read.contains(".version"));
        assert!(!read.contains("grep"));
    }

    #[test]
    fn install_writes_a_private_token_file() {
        let token = new_token();
        let script = install_script(&token).unwrap();
        assert!(script.contains("mkdir -p \"$HOME/.twanagent\""));
        assert!(script.contains("chmod 600"));
        assert!(script.contains(&token));
        assert!(install_script("short").is_err());
        assert!(install_script(&"z".repeat(32)).is_err());
    }

    #[test]
    fn a_saved_token_stays_paired_after_reload() {
        let dir = tempfile::tempdir().unwrap();
        let conn = appdb::open(dir.path()).unwrap();
        let saved = insert_server(
            &conn,
            NewAgentServer {
                name: "Office Mac".into(),
                user: "twan".into(),
                host: "10.0.0.219".into(),
                port: 22,
                machine_id: Some("machine-1".into()),
            },
        )
        .unwrap();
        assert!(saved.paired);
        set_server_token(&conn, &saved.id, &new_token()).unwrap();
        let listed = list_servers(&conn, |_| false).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].paired);
        let found = server_by_host(&conn, "10.0.0.219", 22).unwrap().unwrap();
        assert!(found.paired);
        let wire = serde_json::to_string(&listed[0]).unwrap();
        assert!(!wire.contains("token"));
        let again = insert_server(
            &conn,
            NewAgentServer {
                name: "Again".into(),
                user: "twan".into(),
                host: "10.0.0.219".into(),
                port: 22,
                machine_id: None,
            },
        );
        assert!(again.is_err());
        let account = delete_server(&conn, &saved.id).unwrap().unwrap();
        assert_eq!(account, token_account(&saved.id));
        assert!(list_servers(&conn, |_| true).unwrap().is_empty());
    }

    #[test]
    fn provider_keys_record_presence_and_drop_unknown_names() {
        let dir = tempfile::tempdir().unwrap();
        let conn = appdb::open(dir.path()).unwrap();
        let saved = insert_server(
            &conn,
            NewAgentServer {
                name: "Box".into(),
                user: "twan".into(),
                host: "10.0.0.8".into(),
                port: 22,
                machine_id: None,
            },
        )
        .unwrap();
        assert!(server_provider_keys(&conn, &saved.id).unwrap().is_empty());
        let stored = set_server_provider_keys(
            &conn,
            &saved.id,
            &["minimax".into(), "nope".into(), "xai".into(), "xai".into()],
        )
        .unwrap();
        assert_eq!(stored, vec!["xai", "minimax"]);
        assert_eq!(server_provider_keys(&conn, &saved.id).unwrap(), vec!["xai", "minimax"]);
        assert_eq!(parse_provider_keys(Some("anthropic,ssh")), vec!["anthropic"]);
    }

    #[test]
    fn the_wrong_token_does_not_match() {
        let token = new_token();
        assert!(token_matches(Some(&token), &token));
        assert!(!token_matches(Some(&token), &new_token()));
        assert!(!token_matches(None, &token));
        assert!(!token_matches(Some(""), &token));
    }
}
