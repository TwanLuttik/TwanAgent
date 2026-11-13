use rusqlite::OptionalExtension;
use tauri::{AppHandle, Emitter, Manager, State};

use super::super::config::{self, AuthMethod, Machine, NewMachine};
use super::super::ssh::KnownHosts;
use super::ServerWork;
use crate::error::{Error, Result};
use crate::state::AppState;

/// Run a command and give it bytes on stdin. The bytes are not part of the command line.
fn require_stdin(
    work: &ServerWork,
    machine: &Machine,
    command: &str,
    stdin: &[u8],
    timeout_secs: u64,
) -> Result<String> {
    let secret = super::machine_secret(machine);
    let session = work.ssh_pool.session(machine, secret.as_deref())?;
    let made = session.exec_with_stdin(
        &super::super::ssh::ExecRequest {
            cwd: "/".into(),
            command: command.to_string(),
            timeout_secs,
        },
        stdin,
        &mut |_| {},
    )?;
    if made.timed_out {
        return Err(Error::Other(format!(
            "timed out talking to {}",
            machine.host
        )));
    }
    if made.exit_code.is_some_and(|code| code != 0) {
        let detail = made.stderr.trim();
        return Err(Error::Other(if detail.is_empty() {
            format!("command failed on {}", machine.host)
        } else {
            detail.chars().take(240).collect()
        }));
    }
    Ok(made.stdout)
}

pub(super) fn agent_server_by_id(
    conn: &rusqlite::Connection,
    id: &str,
) -> Result<super::super::agent_server::AgentServer> {
    let rows = super::super::agent_server::list_servers(conn, |_| false)?;
    rows.into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| Error::NotFound("server not found".into()))
}

fn offline_status() -> super::super::agent_server::ServerInstallStatus {
    super::super::agent_server::ServerInstallStatus {
        installed: false,
        version: String::new(),
        available: String::new(),
        path: "~/.twanagent/bin/twanagent-server".into(),
        online: false,
        update: false,
        paired: false,
        token_hashes: Vec::new(),
        protocol: 0,
        desktop_protocol: twanagent_service::PROTOCOL_VERSION,
    }
}

fn status_for(
    work: &ServerWork,
    server: &super::super::agent_server::AgentServer,
) -> Result<super::super::agent_server::ServerInstallStatus> {
    // Port 22 first. A pairing or version read is SSH, and it only runs when the machine answers.
    if !super::machine_reachable(&server.host, server.port) {
        return Ok(offline_status());
    }
    let machine = super::machine_for_server(work, server)?;
    let stdout = super::require_exec(
        work,
        &machine,
        &super::super::agent_server::version_check_script(),
        20,
    )?;
    let mut status = super::super::agent_server::parse_version_check(&stdout);
    // The offer is the file this Mac would copy, probed from `uname`. A crate that is newer
    // than its last build must not tell the row an update is ready.
    if status.installed {
        let probed = super::require_exec(
            work,
            &machine,
            &super::super::agent_server::target_probe_script(),
            15,
        )
        .unwrap_or_default();
        let mut lines = probed.lines();
        let arch = lines.next().unwrap_or("").trim();
        let os = lines.next().unwrap_or("").trim();
        let offer = super::super::agent_server::copyable_version(arch, os);
        if !offer.is_empty() {
            status.update = super::super::agent_server::update_against(&status.version, &offer);
            status.available = if status.update { offer } else { String::new() };
        }
    }
    // The saved token is what this desktop will send. A file on the server only counts as paired
    // when one of its hashes is that token. The row can show this before any chat is opened.
    let conn = super::work_db(work)?;
    let ours = stored_token(&conn, &server.id).ok();
    status.paired = match ours {
        Some(token) => token_hash_matches(&status.token_hashes, &token),
        None => false,
    };
    Ok(status)
}

fn stored_token(conn: &rusqlite::Connection, server_id: &str) -> Result<String> {
    // Pairing writes this column and the keychain. The column is enough, and reading
    // the keychain first asks for the login password whenever this build's signature
    // is not on the item yet.
    let token: Option<String> = conn
        .query_row(
            "SELECT token FROM agent_servers WHERE id = ?1",
            [server_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    if let Some(token) = token.filter(|value| super::super::agent_server::valid_token(value)) {
        return Ok(token);
    }
    if let Some(token) = crate::secrets::get_agent_token(server_id) {
        if super::super::agent_server::valid_token(&token) {
            return Ok(token);
        }
    }
    Err(Error::Other(
        "Pair this server before sending a message.".into(),
    ))
}

fn token_hash_matches(hashes: &[String], token: &str) -> bool {
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(token.trim().as_bytes()));
    hashes.iter().any(|hash| hash.eq_ignore_ascii_case(&digest))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InstallProgress {
    pub id: String,
    pub phase: String,
    pub sent: u64,
    pub total: u64,
}

/// `1.0.0-beta.3` matches a sidecar that says `twanagent-server 1.0.0-beta.3`.
fn version_matches(reported: &str, built: &str) -> bool {
    let reported = reported
        .trim()
        .strip_prefix("twanagent-server")
        .unwrap_or(reported)
        .trim();
    let built = built
        .trim()
        .strip_prefix("twanagent-server")
        .unwrap_or(built)
        .trim();
    !built.is_empty() && reported == built
}

fn emit_install(app: &AppHandle, id: &str, phase: &str, sent: u64, total: u64) {
    let _ = app.emit(
        "dev-install-progress",
        super::InstallProgress {
            id: id.to_string(),
            phase: phase.to_string(),
            sent,
            total,
        },
    );
}

fn copy_binary(
    app: &AppHandle,
    work: &ServerWork,
    server_id: &str,
    machine: &Machine,
) -> Result<super::super::agent_server::ServerInstallStatus> {
    let probe = super::require_exec(
        work,
        machine,
        &super::super::agent_server::target_probe_script(),
        15,
    )?;
    let mut lines = probe.lines();
    let arch = lines.next().unwrap_or("").trim();
    let os = lines.next().unwrap_or("").trim();
    let path = super::super::agent_server::binary_for_target(arch, os)?;
    emit_install(app, server_id, "reading", 0, 0);
    let bytes = std::fs::read(&path)
        .map_err(|err| Error::Other(format!("could not read {}: {err}", path.display())))?;
    let built = super::super::agent_server::binary_version(&bytes);
    if built.is_empty() {
        return Err(Error::Other(format!(
            "{} has no version. Build twanagent-server again, then update.",
            path.display()
        )));
    }
    let current = super::super::agent_server::parse_version_check(&super::require_exec(
        work,
        machine,
        &super::super::agent_server::version_check_script(),
        20,
    )?);
    if current.installed && version_matches(&current.version, &built) {
        return Err(Error::Other(format!(
            "{built} is already on {}. Build a newer twanagent-server before updating.",
            machine.host
        )));
    }
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    let payload = encoded.into_bytes();
    let wire = payload.len() as u64;
    let total = bytes.len() as u64;
    emit_install(app, server_id, "copying", 0, total);
    let secret = super::machine_secret(machine);
    // A second SSH login stalls the shared connection on this Tailscale host, so the status check
    // stays on Checking. The copy uses the one connection and gives it back when the send finishes.
    let session = work.ssh_pool.session(machine, secret.as_deref())?;
    let copied = session.exec_with_stdin(
        &super::super::ssh::ExecRequest {
            cwd: "/".into(),
            command: super::super::agent_server::binary_install_command(total, &built),
            timeout_secs: 180,
        },
        &payload,
        &mut |sent| {
            let file_sent = if wire == 0 {
                0
            } else {
                sent.saturating_mul(total) / wire
            };
            emit_install(app, server_id, "copying", file_sent.min(total), total);
        },
    )?;
    if copied.timed_out {
        return Err(Error::Other(format!(
            "timed out copying the program to {}",
            machine.host
        )));
    }
    if copied.exit_code != Some(0) || !copied.stdout.contains("installed") {
        let detail = copied.stderr.trim();
        return Err(Error::Other(if detail.is_empty() {
            format!("the copy to {} did not finish", machine.host)
        } else {
            detail.to_string()
        }));
    }
    emit_install(app, server_id, "installing", total, total);
    // `--version` runs the program that is already in memory. Replacing the file does not change it.
    let on_disk = super::require_exec(
        work,
        machine,
        &super::super::agent_server::file_version_script(),
        20,
    )
    .unwrap_or_default();
    let reported = on_disk
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .trim_matches(|ch: char| ch == '\'' || ch == '"')
        .trim_end_matches(|ch: char| !ch.is_ascii_alphanumeric());
    if !version_matches(reported, &built) {
        return Err(Error::Other(format!(
            "copied {built} to {}, but the file there reads {}. Rebuild twanagent-server, then update again.",
            machine.host,
            if reported.is_empty() { "nothing" } else { reported }
        )));
    }
    let mut status = super::super::agent_server::parse_version_check(&format!(
        "status installed twanagent-server {built}\n"
    ));
    status.protocol = twanagent_service::PROTOCOL_VERSION;
    let wanted = super::super::agent_server::server_version();
    // The file copied is the newest build on this Mac. When that build is older than this app,
    // the server is updated as far as the file allows, and the row still offers a newer build.
    if super::super::agent_server::server_update_available(&format!("twanagent-server {built}")) {
        status.update = true;
        status.available = wanted.to_string();
    } else {
        status.update = false;
        status.available.clear();
    }
    Ok(status)
}

fn write_token(work: &ServerWork, machine: &Machine, server_id: &str) -> Result<()> {
    write_token_mode(work, machine, server_id, "replace")
}

/// `replace` is a first pairing or a rotation. `add` keeps the tokens already on the machine.
fn write_token_mode(
    work: &ServerWork,
    machine: &Machine,
    server_id: &str,
    mode: &str,
) -> Result<()> {
    let conn = super::work_db(work)?;
    let token = super::super::agent_server::new_token();
    let script = super::super::agent_server::install_script(mode)?;
    let _ = require_stdin(work, machine, &script, token.as_bytes(), 20)?;
    // The keychain is the copy this desktop uses. The column stays so a build that has not
    // moved yet, and a keychain that refused the write, can still find it.
    if crate::secrets::set_agent_token(server_id, &token).is_err() {
        super::super::agent_server::set_server_token(&conn, server_id, &token)?;
        return Ok(());
    }
    super::super::agent_server::set_server_token(&conn, server_id, &token)?;
    Ok(())
}

/// Providers with a key on that machine. Falls back to the last copy this Mac recorded.
pub(super) fn provider_keys_on_server(
    work: &ServerWork,
    machine: &Machine,
    server: Option<&super::super::agent_server::AgentServer>,
    conn: &rusqlite::Connection,
) -> Result<Vec<String>> {
    let saved = server
        .map(|server| super::super::agent_server::server_provider_keys(conn, &server.id))
        .transpose()?
        .unwrap_or_default();
    if !super::machine_reachable(&machine.host, machine.port) {
        return Ok(saved);
    }
    let stdout = super::require_exec(
        work,
        machine,
        super::super::agent_server::provider_keys_present_script(),
        15,
    )?;
    let names = super::super::agent_server::parse_provider_keys(Some(stdout.trim()));
    if let Some(server) = server {
        if names != saved {
            let _ = super::super::agent_server::set_server_provider_keys(conn, &server.id, &names);
        }
    }
    Ok(names)
}

fn provider_keys_for(work: &ServerWork, providers: &[String]) -> twanagent_service::ProviderKeys {
    let wanted: std::collections::HashSet<&str> =
        providers.iter().map(|name| name.trim()).collect();
    let pick = |name: &str, value: Option<String>| {
        if wanted.contains(name) {
            value.unwrap_or_default()
        } else {
            String::new()
        }
    };
    twanagent_service::ProviderKeys {
        xai: pick(
            "xai",
            crate::secrets::resolve_xai_key_on_disk(&work.data_dir),
        ),
        anthropic: pick(
            "anthropic",
            crate::secrets::resolve_anthropic_key_on_disk(&work.data_dir),
        ),
        minimax: pick(
            "minimax",
            crate::secrets::resolve_minimax_key_on_disk(&work.data_dir),
        ),
        openai: pick(
            "openai",
            crate::secrets::resolve_openai_key_on_disk(&work.data_dir),
        ),
    }
}

fn keys_view(names: &[String]) -> super::ServerProviderKeys {
    keys_view_with(names, &[])
}

fn keys_view_with(names: &[String], replaced: &[String]) -> super::ServerProviderKeys {
    let has = |name: &str| names.iter().any(|item| item == name);
    let was_replaced = |name: &str| replaced.iter().any(|item| item == name);
    super::ServerProviderKeys {
        xai: has("xai"),
        anthropic: has("anthropic"),
        minimax: has("minimax"),
        openai: has("openai"),
        replaced: super::ServerKeyReplaced {
            xai: was_replaced("xai"),
            anthropic: was_replaced("anthropic"),
            minimax: was_replaced("minimax"),
            openai: was_replaced("openai"),
        },
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ServerProviderKeys {
    pub xai: bool,
    pub anthropic: bool,
    pub minimax: bool,
    #[serde(default)]
    pub openai: bool,
    /// True when this copy replaced a different key already on the server. Absent on older replies.
    #[serde(default)]
    pub replaced: super::ServerKeyReplaced,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ServerKeyReplaced {
    #[serde(default)]
    pub xai: bool,
    #[serde(default)]
    pub anthropic: bool,
    #[serde(default)]
    pub minimax: bool,
    #[serde(default)]
    pub openai: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerStorage {
    pub bytes: u64,
    pub conversation_bytes: u64,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_list_agent_servers(
    state: State<'_, AppState>,
) -> Result<Vec<super::super::agent_server::AgentServer>> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        super::super::agent_server::list_servers(&conn, |_| false)
    })
    .await
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerGit {
    pub installed: bool,
}

/// A folder that already exists on the server. It may not be in this Mac's sidebar yet.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ServerProject {
    pub name: String,
    pub remote_path: String,
    /// True when this Mac already saved the folder. Opening it again reuses that row.
    pub saved: bool,
}

/// Folders under the home projects directories on this machine.
/// The sidebar list only has projects this Mac created, so a folder from another client would be missing.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_server_projects(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<super::ServerProject>> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        let saved = config::list_remote_projects(&conn)?;
        let stdout = super::require_exec(
            &work,
            &machine,
            &super::super::files::remote_projects_command(),
            20,
        )?;
        Ok(super::server_projects_from(&stdout, &machine.id, &saved))
    })
    .await
}

pub(crate) fn server_projects_from(
    stdout: &str,
    machine_id: &str,
    saved: &[config::RemoteProject],
) -> Vec<super::ServerProject> {
    super::super::files::parse_remote_projects(stdout)
        .into_iter()
        .filter_map(|path| {
            let name = path.rsplit('/').find(|part| !part.is_empty())?.to_string();
            let known = saved
                .iter()
                .any(|row| row.machine_id == machine_id && row.remote_path == path);
            Some(super::ServerProject {
                name,
                remote_path: path,
                saved: known,
            })
        })
        .collect()
}

/// `git --version` on the paired machine. A missing binary is not an error.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_server_git(state: State<'_, AppState>, id: String) -> Result<super::ServerGit> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        git_on(&work, &machine)
    })
    .await
}

/// Install git with the server's package manager. Does nothing when git is already there.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_install_server_git(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::ServerGit> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        let current = git_on(&work, &machine)?;
        if current.installed {
            return Ok(current);
        }
        let script = "if command -v apt-get >/dev/null 2>&1; then sudo -n DEBIAN_FRONTEND=noninteractive apt-get update && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y git; elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y git; elif command -v yum >/dev/null 2>&1; then sudo -n yum install -y git; elif command -v apk >/dev/null 2>&1; then sudo -n apk add git; elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -Sy --noconfirm git; elif command -v brew >/dev/null 2>&1; then brew install git; else echo 'no package manager found' >&2; exit 1; fi";
        let _ = super::require_exec(&work, &machine, script, 180)?;
        git_on(&work, &machine)
    })
    .await
}

fn git_on(work: &ServerWork, machine: &Machine) -> Result<super::ServerGit> {
    let stdout = super::require_exec(
        work,
        machine,
        "command -v git >/dev/null 2>&1 && git --version || true",
        15,
    )?;
    Ok(super::ServerGit {
        installed: stdout.to_ascii_lowercase().contains("git version"),
    })
}

/// SSH in and report whether `twanagent-server` is on that machine. Does not copy or pair.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_probe_agent_server(
    state: State<'_, AppState>,
    host: String,
    port: Option<u16>,
) -> Result<super::super::agent_server::ServerInstallStatus> {
    let work = super::server_work(&state);
    let port = port.unwrap_or(22);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let machine = config::list_machines(&conn)?
            .into_iter()
            .find(|row| row.host.eq_ignore_ascii_case(host.trim()) && row.port == port)
            .ok_or_else(|| {
                Error::NotFound("sign in to this server again before checking".into())
            })?;
        if !super::machine_reachable(&machine.host, machine.port) {
            return Ok(offline_status());
        }
        let stdout = super::require_exec(
            &work,
            &machine,
            &super::super::agent_server::version_check_script(),
            20,
        )?;
        Ok(super::super::agent_server::parse_version_check(&stdout))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_agent_server_status(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::super::agent_server::ServerInstallStatus> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        status_for(&work, &server)
    })
    .await
}

/// Up or down, without SSH. The project picker only draws a reach dot. A full status
/// logs in, and that reads the key passphrase from the login keychain.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_agent_server_online(state: State<'_, AppState>, id: String) -> Result<bool> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        Ok(super::machine_reachable(&server.host, server.port))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_install_agent_binary(
    app: AppHandle,
    id: String,
) -> Result<super::super::agent_server::ServerInstallStatus> {
    let state = app.state::<AppState>();
    let work = super::server_work(&state);
    let server_id = id.clone();
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        copy_binary(&app, &work, &server_id, &machine)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_install_agent_server(
    state: State<'_, AppState>,
    name: String,
    user: String,
    host: String,
    port: Option<u16>,
    auth: String,
    key_path: Option<String>,
    secret: Option<String>,
) -> Result<super::super::agent_server::AgentServer> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        install_agent_server(&work, name, user, host, port, auth, key_path, secret)
    })
    .await
}

fn install_agent_server(
    work: &ServerWork,
    name: String,
    user: String,
    host: String,
    port: Option<u16>,
    auth: String,
    key_path: Option<String>,
    secret: Option<String>,
) -> Result<super::super::agent_server::AgentServer> {
    let method = AuthMethod::parse(if auth.trim().is_empty() {
        "agent"
    } else {
        &auth
    })?;
    let secret = secret.filter(|value| !value.trim().is_empty());
    let method = if secret.is_none() {
        config::auth_without_secret(method, key_path.as_deref())
    } else {
        method
    };
    let conn = super::work_db(work)?;
    let port = port.unwrap_or(22);
    // The machine stays under its address. A friendly name is only the server label,
    // so two servers can both be called Office without one login replacing the other.
    // The machine name is also a lookup key. Reusing the bare host would retarget
    // a different port that was already saved under that name.
    let machine_name = if port == 22 {
        host.clone()
    } else {
        format!("{host}:{port}")
    };
    let machine = config::upsert_machine(
        &conn,
        NewMachine {
            name: machine_name,
            user,
            host: host.clone(),
            port,
            auth: method,
            key_path,
        },
    )?;
    if let Some(secret) = secret {
        let account = machine
            .secret_account
            .clone()
            .ok_or_else(|| Error::Other("this login does not take a secret".into()))?;
        if let Err(err) = crate::secrets::set_ssh_secret(&account, &secret) {
            let _ = config::delete_machine(&conn, &machine.id);
            return Err(err);
        }
    }
    let known = KnownHosts::load(&work.data_dir);
    let trusted = known
        .rows
        .iter()
        .any(|row| row.host == machine.host && row.port == machine.port);
    if !trusted {
        return Err(Error::Other(
            "Confirm the host key before installing on this server.".into(),
        ));
    }
    // Connecting saves the machine. The program is copied only when it is missing.
    // A token already on the machine is the pairing. Replacing it would drop the one the server uses.
    let already = super::super::agent_server::server_by_host(&conn, &machine.host, machine.port)?;
    let created = already.is_none();
    let label = name.trim();
    let server = if let Some(already) = already {
        // A blank name on a second connect keeps the label they already set.
        if !label.is_empty() && label != already.name {
            super::super::agent_server::rename_server(&conn, &already.id, label)?;
            agent_server_by_id(&conn, &already.id)?
        } else {
            already
        }
    } else {
        super::super::agent_server::insert_server(
            &conn,
            super::super::agent_server::NewAgentServer {
                name: if label.is_empty() {
                    host
                } else {
                    label.to_string()
                },
                user: machine.user.clone(),
                host: machine.host.clone(),
                port: machine.port,
                machine_id: Some(machine.id.clone()),
            },
        )?
    };
    let present = super::super::agent_server::parse_version_check(&super::require_exec(
        work,
        &machine,
        &super::super::agent_server::version_check_script(),
        20,
    )?);
    if present.paired {
        if !server.paired {
            // The machine already has clients. Add this desktop instead of replacing them,
            // and keep a copy of one existing token so a later call still matches.
            if let Err(err) = write_token_mode(work, &machine, &server.id, "add") {
                if created {
                    let _ = super::super::agent_server::delete_server(&conn, &server.id);
                }
                return Err(err);
            }
        }
        return agent_server_by_id(&conn, &server.id);
    }
    if let Err(err) = write_token(work, &machine, &server.id) {
        if created {
            let _ = super::super::agent_server::delete_server(&conn, &server.id);
        }
        return Err(err);
    }
    agent_server_by_id(&conn, &server.id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_rename_agent_server(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<super::super::agent_server::AgentServer> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        super::super::agent_server::rename_server(&conn, &id, &name)?;
        agent_server_by_id(&conn, &id)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_pair_agent_server(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::super::agent_server::AgentServer> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        write_token(&work, &machine, &server.id)?;
        agent_server_by_id(&conn, &server.id)
    })
    .await
}

/// Drop the server from this desktop. `wipe` deletes the token file on the machine, which logs
/// every paired desktop out, then forgets the server here. `rotate` writes a fresh token that
/// only this desktop keeps, so the other clients stop working and this one stays paired.
/// Neither touches the program or the provider keys.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_remove_agent_server(
    state: State<'_, AppState>,
    id: String,
    wipe: Option<bool>,
    rotate: Option<bool>,
) -> Result<()> {
    let work = super::server_work(&state);
    let wipe = wipe.unwrap_or(false);
    let rotate = rotate.unwrap_or(false);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        if rotate {
            let server = agent_server_by_id(&conn, &id)?;
            let machine = super::machine_for_server(&work, &server)?;
            write_token_mode(&work, &machine, &id, "replace")?;
            return Ok(());
        }
        if wipe {
            if let Ok(server) = agent_server_by_id(&conn, &id) {
                if let Ok(machine) = super::machine_for_server(&work, &server) {
                    let _ = super::require_exec(
                        &work,
                        &machine,
                        &super::super::agent_server::forget_token_script(false),
                        20,
                    );
                }
            }
        }
        let _ = super::super::agent_server::delete_server(&conn, &id)?;
        let _ = crate::secrets::delete_agent_token(&id);
        Ok(())
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_server_storage(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::ServerStorage> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        server_storage(&work, &machine)
    })
    .await
}

fn server_storage(work: &ServerWork, machine: &Machine) -> Result<super::ServerStorage> {
    let script = "data=\"$HOME/.twanagent\"; \
if [ -d \"$data\" ]; then du -sk \"$data\" | awk '{print $1}'; else echo 0; fi; \
find \"$data\" -name 'store.db' -type f -exec du -sk {} + 2>/dev/null | awk '{s+=$1} END {print s+0}'";
    let stdout = super::require_exec(work, machine, script, 20)?;
    let mut lines = stdout.lines();
    let total_kb: u64 = lines.next().unwrap_or("0").trim().parse().unwrap_or(0);
    let conv_kb: u64 = lines.next().unwrap_or("0").trim().parse().unwrap_or(0);
    Ok(super::ServerStorage {
        bytes: total_kb.saturating_mul(1024),
        conversation_bytes: conv_kb.saturating_mul(1024),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_server_provider_keys(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::ServerProviderKeys> {
    let conn = super::open_db(&state)?;
    let names = super::super::agent_server::server_provider_keys(&conn, &id)?;
    Ok(keys_view(&names))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_copy_server_provider_keys(
    state: State<'_, AppState>,
    id: String,
    providers: Vec<String>,
) -> Result<super::ServerProviderKeys> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = super::machine_for_server(&work, &server)?;
        copy_provider_keys(&work, &conn, &machine, &id, &providers)
    })
    .await
}

fn copy_provider_keys(
    work: &ServerWork,
    conn: &rusqlite::Connection,
    machine: &Machine,
    id: &str,
    providers: &[String],
) -> Result<super::ServerProviderKeys> {
    let keys = provider_keys_for(work, providers);
    let payload = super::super::agent_server::provider_keys_payload(&keys)?;
    let stdout = require_stdin(
        work,
        machine,
        super::super::agent_server::provider_keys_script(),
        &payload,
        20,
    )?;
    if !stdout.lines().any(|line| line.trim() == "copied") {
        let detail = stdout.trim();
        return Err(Error::Other(if detail.is_empty() {
            format!("the keys did not land on {}", machine.host)
        } else {
            format!(
                "the keys did not land on {}: {}",
                machine.host,
                detail.chars().take(240).collect::<String>()
            )
        }));
    }
    let replaced = super::super::agent_server::parse_replaced_providers(&stdout);
    let names = super::super::agent_server::set_server_provider_keys(&conn, &id, &providers)?;
    Ok(keys_view_with(&names, &replaced))
}
