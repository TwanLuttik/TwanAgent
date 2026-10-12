use tauri::{AppHandle, Emitter, Manager, State};

use super::config::{self, AuthMethod, Machine, NewMachine, RemoteProject};
use super::ssh::{HostKeyDecision, HostPrompt, KnownHost, KnownHosts};
use crate::error::{Error, Result};
use crate::state::AppState;

fn open_db(state: &AppState) -> Result<rusqlite::Connection> {
    crate::appdb::open(&state.data_dir)
}

/// What a background server check needs. `AppState` itself is not moved off the command thread.
struct ServerWork {
    data_dir: std::path::PathBuf,
    ssh_pool: std::sync::Arc<super::ssh::Pool>,
}

fn server_work(state: &AppState) -> ServerWork {
    ServerWork {
        data_dir: state.data_dir.clone(),
        ssh_pool: state.ssh_pool.clone(),
    }
}

fn work_db(work: &ServerWork) -> Result<rusqlite::Connection> {
    crate::appdb::open(&work.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_discover_ssh(app: AppHandle) -> Result<Vec<super::discover::LanHost>> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app_emit = app.clone();
    let scan = tokio::spawn(async move {
        let _ = super::discover::scan_ssh_stream(tx).await;
    });
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    while let Some(host) = rx.recv().await {
        if !seen.insert(host.host.clone()) {
            continue;
        }
        let _ = app_emit.emit("dev-ssh-found", &host);
        found.push(host);
    }
    let _ = scan.await;
    Ok(found)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_ssh_defaults() -> super::discover::SshDefaults {
    super::discover::ssh_defaults()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_remote_home(state: State<'_, AppState>, id: String) -> Result<String> {
    let conn = open_db(&state)?;
    let machine = config::machine_by_id(&conn, &id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    let out = state.ssh_pool.exec(
        &machine,
        secret.as_deref(),
        &super::ssh::ExecRequest {
            cwd: "/".into(),
            command: "printf %s \"$HOME\"".into(),
            timeout_secs: 15,
        },
    )?;
    let home = out.stdout.trim();
    if !home.starts_with('/') || home.contains('\n') {
        return Err(Error::Other("could not read the home folder on that server".into()));
    }
    Ok(home.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_machines(state: State<'_, AppState>) -> Result<Vec<Machine>> {
    let conn = open_db(&state)?;
    config::list_machines(&conn)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_save_machine(
    state: State<'_, AppState>,
    name: String,
    user: String,
    host: String,
    port: Option<u16>,
    auth: String,
    key_path: Option<String>,
    secret: Option<String>,
) -> Result<Machine> {
    let method = AuthMethod::parse(&auth)?;
    let secret = secret.filter(|s| !s.trim().is_empty());
    // An empty password means "use the key this Mac already has", not a missing password.
    let method = if secret.is_none() {
        config::auth_without_secret(method, key_path.as_deref())
    } else {
        method
    };
    let conn = open_db(&state)?;
    let machine = config::upsert_machine(
        &conn,
        NewMachine {
            name,
            user,
            host,
            port: port.unwrap_or(22),
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
    Ok(machine)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_delete_machine(state: State<'_, AppState>, id: String) -> Result<()> {
    let conn = open_db(&state)?;
    let projects = config::list_remote_projects(&conn)?;
    for project in projects.iter().filter(|p| p.machine_id == id) {
        let _ = super::mount::unmount(std::path::Path::new(&project.mount_path));
    }
    let secrets = config::delete_machine(&conn, &id)?;
    for account in secrets {
        let _ = crate::secrets::delete_ssh_secret(&account);
    }
    state.ssh_pool.drop_machine(&id);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_remote_projects(state: State<'_, AppState>) -> Result<Vec<RemoteProject>> {
    let conn = open_db(&state)?;
    config::list_remote_projects(&conn)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_test_machine(state: State<'_, AppState>, id: String) -> Result<TestMachineResult> {
    let conn = open_db(&state)?;
    let machine = config::machine_by_id(&conn, &id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    probe(&state, &machine)
}

#[derive(Debug, serde::Serialize)]
pub struct TestMachineResult {
    pub ok: bool,
    pub message: String,
    pub host_prompt: Option<HostPrompt>,
}

fn probe(state: &AppState, machine: &Machine) -> Result<TestMachineResult> {
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    let (_session, presented) = state.ssh_pool.probe(machine, secret.as_deref())?;
    let known = KnownHosts::load(&state.data_dir);
    match known.decide(&presented) {
        HostKeyDecision::Trusted => Ok(TestMachineResult {
            ok: true,
            message: format!("Host key for {} is trusted.", machine.host),
            host_prompt: None,
        }),
        HostKeyDecision::Unknown(host) => Ok(TestMachineResult {
            ok: false,
            message: "Confirm this host key before connecting.".into(),
            host_prompt: Some(prompt(machine, &host, false)),
        }),
        HostKeyDecision::Changed { presented, .. } => Ok(TestMachineResult {
            ok: false,
            message: "The host key changed. Connection was refused.".into(),
            host_prompt: Some(prompt(machine, &presented, true)),
        }),
    }
}

fn prompt(machine: &Machine, host: &KnownHost, changed: bool) -> HostPrompt {
    HostPrompt {
        machine_id: machine.id.clone(),
        host: host.host.clone(),
        port: host.port,
        key_type: host.key_type.clone(),
        fingerprint: host.fingerprint.clone(),
        changed,
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_accept_host(
    state: State<'_, AppState>,
    machine_id: String,
    fingerprint: String,
    key_type: String,
) -> Result<()> {
    let conn = open_db(&state)?;
    let machine = config::machine_by_id(&conn, &machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let fingerprint = fingerprint.trim();
    if fingerprint.is_empty() {
        return Err(Error::Other("fingerprint is empty".into()));
    }
    let mut known = KnownHosts::load(&state.data_dir);
    known.accept(KnownHost {
        host: machine.host,
        port: machine.port,
        key_type: if key_type.trim().is_empty() {
            "ssh-ed25519".into()
        } else {
            key_type.trim().to_string()
        },
        fingerprint: fingerprint.to_string(),
    });
    known.save(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_create_remote_project(
    app: AppHandle,
    name: String,
    machine_id: String,
    remote_path: String,
) -> Result<String> {
    let state = app.state::<AppState>();
    let remote_path = config::validate_remote_path(&remote_path)?;
    let name = config::validate_name(&name)?;
    let conn = open_db(&state)?;
    let machine = config::machine_by_id(&conn, &machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let known = KnownHosts::load(&state.data_dir);
    let trusted = known.rows.iter().any(|row| row.host == machine.host && row.port == machine.port);
    if !trusted {
        return Err(Error::Other(
            "Confirm the host key before creating a project on this server.".into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mount = super::mount::mount_dir(&state.data_dir, &id);
    super::mount::ensure_mount_point(&mount)?;
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    let mkdir = super::mount::mkdir_remote_command(&remote_path)?;
    let made = state.ssh_pool.exec(
        &machine,
        secret.as_deref(),
        &super::ssh::ExecRequest {
            cwd: "/".into(),
            command: mkdir,
            timeout_secs: 30,
        },
    )?;
    if made.timed_out || made.exit_code != Some(0) {
        let detail = made.stderr.trim();
        return Err(Error::Other(if detail.is_empty() {
            format!("could not create {remote_path} on {}", machine.host)
        } else {
            format!("could not create {remote_path} on {}: {detail}", machine.host)
        }));
    }
    // The project stays on the server. File tools use SSH, so macOS does not get a mounted drive.
    let _ = super::mount::unmount(&mount);
    let _project = config::insert_remote_project(&conn, &machine.id, &name, &remote_path, &mount)?;
    let canon = state.register_workspace(&app, &mount)?;
    let conn = open_db(&state)?;
    let _ = crate::appdb::add_project_named(&conn, &canon, Some(&name));
    Ok(crate::dev::path_string(&canon))
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_workspace_remote(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Option<WorkspaceRemote>> {
    let root = state.require_workspace(&workspace)?;
    let conn = open_db(&state)?;
    let Some(project) = config::remote_project_by_mount(&conn, &root)? else {
        return Ok(None);
    };
    let machine = config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let online = machine_reachable(&machine.host, machine.port);
    let providers = super::agent_server::server_by_host(&conn, &machine.host, machine.port)?
        .map(|server| super::agent_server::server_provider_keys(&conn, &server.id))
        .transpose()?
        .unwrap_or_default();
    Ok(Some(WorkspaceRemote {
        machine_id: machine.id,
        machine_name: machine.name,
        host: machine.host,
        user: machine.user,
        port: machine.port,
        remote_path: project.remote_path,
        project_name: project.name,
        online,
        providers,
    }))
}

#[derive(Debug, serde::Serialize)]
pub struct WorkspaceRemote {
    pub machine_id: String,
    pub machine_name: String,
    pub host: String,
    pub user: String,
    pub port: u16,
    pub remote_path: String,
    pub project_name: String,
    pub online: bool,
    /// Provider ids whose keys were copied onto the paired TwanAgent server. Empty when none were.
    pub providers: Vec<String>,
}

/// Port check only. A full SSH login would block file tools that share the connection.
pub fn machine_reachable(host: &str, port: u16) -> bool {
    use std::net::ToSocketAddrs;
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return false;
    }
    let Ok(mut addrs) = format!("{host}:{port}").to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(900)).is_ok()
}

fn machine_secret(machine: &Machine) -> Option<String> {
    machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret)
}

fn exec_on(work: &ServerWork, machine: &Machine, command: &str, timeout_secs: u64) -> Result<super::ssh::ExecResult> {
    let secret = machine_secret(machine);
    work.ssh_pool.exec(
        machine,
        secret.as_deref(),
        &super::ssh::ExecRequest {
            cwd: "/".into(),
            command: command.to_string(),
            timeout_secs,
        },
    )
}

fn require_exec(work: &ServerWork, machine: &Machine, command: &str, timeout_secs: u64) -> Result<String> {
    let made = exec_on(work, machine, command, timeout_secs)?;
    if made.timed_out {
        return Err(Error::Other(format!("timed out talking to {}", machine.host)));
    }
    if made.exit_code != Some(0) {
        let detail = made.stderr.trim();
        return Err(Error::Other(if detail.is_empty() {
            format!("command failed on {}", machine.host)
        } else {
            format!("{detail}")
        }));
    }
    Ok(made.stdout)
}

fn machine_for_server(work: &ServerWork, server: &super::agent_server::AgentServer) -> Result<Machine> {
    let conn = work_db(work)?;
    if let Some(id) = server.machine_id.as_deref() {
        if let Some(machine) = config::machine_by_id(&conn, id)? {
            return Ok(machine);
        }
    }
    let rows = config::list_machines(&conn)?;
    rows.into_iter()
        .find(|row| row.host.eq_ignore_ascii_case(&server.host) && row.port == server.port)
        .ok_or_else(|| Error::NotFound("sign in to this server again before installing".into()))
}

fn agent_server_by_id(conn: &rusqlite::Connection, id: &str) -> Result<super::agent_server::AgentServer> {
    let rows = super::agent_server::list_servers(conn, |_| false)?;
    rows.into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| Error::NotFound("server not found".into()))
}

fn offline_status() -> super::agent_server::ServerInstallStatus {
    super::agent_server::ServerInstallStatus {
        installed: false,
        version: String::new(),
        path: "~/.twanagent/bin/twanagent-server".into(),
        online: false,
    }
}

fn status_for(work: &ServerWork, server: &super::agent_server::AgentServer) -> Result<super::agent_server::ServerInstallStatus> {
    if !machine_reachable(&server.host, server.port) {
        return Ok(offline_status());
    }
    let machine = machine_for_server(work, server)?;
    let stdout = require_exec(work, &machine, &super::agent_server::version_check_script(), 20)?;
    Ok(super::agent_server::parse_version_check(&stdout))
}

fn copy_binary(work: &ServerWork, machine: &Machine) -> Result<super::agent_server::ServerInstallStatus> {
    let probe = require_exec(work, machine, &super::agent_server::target_probe_script(), 15)?;
    let mut lines = probe.lines();
    let arch = lines.next().unwrap_or("").trim();
    let os = lines.next().unwrap_or("").trim();
    let path = super::agent_server::binary_for_target(arch, os)?;
    let bytes = std::fs::read(&path).map_err(|err| Error::Other(format!("could not read {}: {err}", path.display())))?;
    let scripts = super::agent_server::binary_install_scripts(&bytes)?;
    for script in &scripts {
        let _ = require_exec(work, machine, script, 120)?;
    }
    let stdout = require_exec(work, machine, &super::agent_server::version_check_script(), 20)?;
    Ok(super::agent_server::parse_version_check(&stdout))
}

fn write_token(work: &ServerWork, machine: &Machine, server_id: &str) -> Result<()> {
    let conn = work_db(work)?;
    let token = super::agent_server::new_token();
    let script = super::agent_server::install_script(&token)?;
    let _ = require_exec(work, machine, &script, 20)?;
    super::agent_server::set_server_token(&conn, server_id, &token)?;
    Ok(())
}

fn provider_keys_for(work: &ServerWork, providers: &[String]) -> twanagent_service::ProviderKeys {
    let wanted: std::collections::HashSet<&str> = providers.iter().map(|name| name.trim()).collect();
    let pick = |name: &str, value: Option<String>| {
        if wanted.contains(name) {
            value.unwrap_or_default()
        } else {
            String::new()
        }
    };
    twanagent_service::ProviderKeys {
        xai: pick("xai", crate::secrets::resolve_xai_key_on_disk(&work.data_dir)),
        anthropic: pick("anthropic", crate::secrets::resolve_anthropic_key_on_disk()),
        minimax: pick("minimax", crate::secrets::resolve_minimax_key_on_disk()),
    }
}

fn keys_view(names: &[String]) -> ServerProviderKeys {
    let has = |name: &str| names.iter().any(|item| item == name);
    ServerProviderKeys {
        xai: has("xai"),
        anthropic: has("anthropic"),
        minimax: has("minimax"),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerProviderKeys {
    pub xai: bool,
    pub anthropic: bool,
    pub minimax: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerStorage {
    pub bytes: u64,
    pub conversation_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteSkillFile {
    pub path: String,
    pub read_path: String,
    pub origin: String,
    pub contents: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteCapabilities {
    pub mcp: Vec<String>,
    pub auth: Vec<String>,
    pub skills: Vec<RemoteSkillFile>,
}

/// The paired TwanAgent server for this workspace, when the project lives on one.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_workspace_server_id(state: State<'_, AppState>, workspace: String) -> Result<Option<String>> {
    let root = state.require_workspace(&workspace)?;
    let Some(project) = super::project_for_workspace(&state, &root)? else {
        return Ok(None);
    };
    let conn = open_db(&state)?;
    let machine = config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    Ok(super::agent_server::server_by_host(&conn, &machine.host, machine.port)?.map(|server| server.id))
}

/// MCP and skills for the machine that owns this workspace. Local projects return nothing.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_workspace_capabilities(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Option<RemoteCapabilities>> {
    let root = state.require_workspace(&workspace)?;
    let Some(project) = super::project_for_workspace(&state, &root)? else {
        return Ok(None);
    };
    let conn = open_db(&state)?;
    let machine = config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let work = server_work(&state);
    crate::state::run_blocking(move || Ok(Some(read_capabilities(&work, &machine)?))).await
}

/// MCP configs, signed-in names, and skills that live on this server. Not this Mac.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_server_capabilities(state: State<'_, AppState>, id: String) -> Result<RemoteCapabilities> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = machine_for_server(&work, &server)?;
        read_capabilities(&work, &machine)
    })
    .await
}

fn read_capabilities(work: &ServerWork, machine: &Machine) -> Result<RemoteCapabilities> {
    let script = r#"python3 - <<'PY'
import json, os
home = os.path.expanduser("~")
mcp = {}
for rel in (".grok/config.toml", ".cursor/mcp.json", ".claude.json"):
    path = os.path.join(home, rel)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            mcp[rel] = handle.read()
    except OSError:
        pass
auth = []
cred = os.path.join(home, ".grok", "mcp_credentials.json")
try:
    with open(cred, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    if isinstance(raw, dict):
        seen = []
        for key in raw:
            name = str(key).split(":", 1)[0].strip()
            if name and name not in seen:
                seen.append(name)
        auth = seen
except (OSError, ValueError):
    pass
roots = [
    (os.path.join(home, ".grok", "skills"), "user"),
    (os.path.join(home, ".grok", "commands"), "user"),
    (os.path.join(home, ".agents", "skills"), "user"),
    (os.path.join(home, ".claude", "skills"), "claude"),
    (os.path.join(home, ".claude", "commands"), "claude"),
    (os.path.join(home, ".cursor", "skills"), "cursor"),
    (os.path.join(home, ".grok", "bundled", "skills"), "bundled"),
]
skills = []
def add(path, origin):
    rel = os.path.relpath(path, home).replace(os.sep, "/")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            skills.append({"path": "~/" + rel, "read_path": rel, "origin": origin, "contents": handle.read()})
    except OSError:
        pass
for root, origin in roots:
    if not os.path.isdir(root):
        continue
    if root.endswith("/commands") or root.endswith(os.sep + "commands"):
        for name in sorted(os.listdir(root)):
            if name.lower().endswith(".md") and name.lower() != "readme.md":
                add(os.path.join(root, name), origin)
        continue
    for name in sorted(os.listdir(root)):
        add(os.path.join(root, name, "SKILL.md"), origin)
plugins = os.path.join(home, ".grok", "installed-plugins")
if os.path.isdir(plugins):
    for plugin in sorted(os.listdir(plugins)):
        skill_root = os.path.join(plugins, plugin, "skills")
        if not os.path.isdir(skill_root):
            continue
        for name in sorted(os.listdir(skill_root)):
            add(os.path.join(skill_root, name, "SKILL.md"), "plugin")
print(json.dumps({"mcp": mcp, "auth": auth, "skills": skills}))
PY"#;
    let stdout = require_exec(work, machine, script, 30)?;
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|err| Error::Other(err.to_string()))?;
    let mcp = parsed
        .get("mcp")
        .and_then(|value| value.as_object())
        .map(|map| {
            [".grok/config.toml", ".cursor/mcp.json", ".claude.json"]
                .into_iter()
                .filter_map(|rel| map.get(rel).and_then(|value| value.as_str()).map(|text| format!("{rel}\n{text}")))
                .collect()
        })
        .unwrap_or_default();
    let auth = parsed
        .get("auth")
        .and_then(|value| value.as_array())
        .map(|rows| rows.iter().filter_map(|row| row.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let skills = parsed
        .get("skills")
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(RemoteSkillFile {
                        path: row.get("path")?.as_str()?.to_string(),
                        read_path: row.get("read_path")?.as_str()?.to_string(),
                        origin: row.get("origin")?.as_str()?.to_string(),
                        contents: row.get("contents")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(RemoteCapabilities { mcp, auth, skills })
}

/// Copy this Mac's MCP configs, skills, and the browser sign-in for one server. The browser stays here.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_sync_server_capabilities(
    state: State<'_, AppState>,
    id: String,
    mcp_name: Option<String>,
) -> Result<RemoteCapabilities> {
    let work = server_work(&state);
    let signed = mcp_name.unwrap_or_default();
    crate::state::run_blocking(move || {
        if !signed.trim().is_empty() {
            crate::dev::mcp_oauth::mcp_sign_in(signed.trim())?;
        }
        let bundle = local_capability_bundle()?;
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = machine_for_server(&work, &server)?;
        let script = capability_copy_script(&bundle)?;
        let _ = require_exec(&work, &machine, &script, 60)?;
        read_capabilities(&work, &machine)
    })
    .await
}

fn local_capability_bundle() -> Result<serde_json::Value> {
    let home = crate::dev::paths::home_dir().ok_or_else(|| Error::Other("home folder is unknown".into()))?;
    let mut mcp = serde_json::Map::new();
    for rel in crate::dev::mcp::USER_MCP_FILES {
        if let Ok(text) = crate::dev::mcp::read_user_mcp(rel) {
            mcp.insert((*rel).to_string(), serde_json::Value::String(text));
        }
    }
    let creds = std::fs::read_to_string(crate::grok_cli::grok_home().unwrap_or_else(|| home.join(".grok")).join("mcp_credentials.json"))
        .unwrap_or_else(|_| "{}".into());
    let grok = crate::grok_cli::grok_home().unwrap_or_else(|| home.join(".grok"));
    let skills = crate::dev::skills::collect_skill_files(&home, &grok, None);
    let mut copied = Vec::new();
    for row in skills {
        if !row.home {
            continue;
        }
        let Ok(contents) = crate::dev::skills::read_user_skill(&row.read_path) else {
            continue;
        };
        copied.push(serde_json::json!({
            "path": row.read_path,
            "contents": contents,
        }));
    }
    Ok(serde_json::json!({
        "mcp": mcp,
        "credentials": creds,
        "skills": copied,
    }))
}

fn capability_copy_script(bundle: &serde_json::Value) -> Result<String> {
    let body = serde_json::to_vec(bundle).map_err(|err| Error::Other(err.to_string()))?;
    if body.len() > 8_000_000 {
        return Err(Error::Other("MCP and skills are too large to copy".into()));
    }
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, body);
    let program = r#"
import base64, json, os, sys
data = json.loads(base64.b64decode(sys.stdin.read()))
home = os.path.expanduser("~")

def allowed(rel):
    rel = str(rel).replace("\\", "/").strip()
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return ""
    return rel

for rel, text in data.get("mcp", {}).items():
    rel = allowed(rel)
    if not rel:
        continue
    path = os.path.join(home, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text if isinstance(text, str) else "")

cred = os.path.join(home, ".grok", "mcp_credentials.json")
os.makedirs(os.path.dirname(cred), exist_ok=True)
with open(cred, "w", encoding="utf-8") as handle:
    handle.write(data.get("credentials") if isinstance(data.get("credentials"), str) else "{}")
os.chmod(cred, 0o600)

for row in data.get("skills", []):
    if not isinstance(row, dict):
        continue
    rel = allowed(row.get("path", ""))
    if not rel:
        continue
    path = os.path.join(home, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(row.get("contents") if isinstance(row.get("contents"), str) else "")
print("copied")
"#;
    let program_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, program.as_bytes());
    Ok(format!(
        "printf %s {} | base64 -d | python3 -c \"import base64,sys; exec(base64.b64decode('{}'))\"",
        super::ssh::shell_single_quote(&encoded),
        program_b64
    ))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_list_agent_servers(state: State<'_, AppState>) -> Result<Vec<super::agent_server::AgentServer>> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        super::agent_server::list_servers(&conn, |_| false)
    })
    .await
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerGit {
    pub installed: bool,
}

/// `git --version` on the paired machine. A missing binary is not an error.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_server_git(state: State<'_, AppState>, id: String) -> Result<ServerGit> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = machine_for_server(&work, &server)?;
        git_on(&work, &machine)
    })
    .await
}

/// Install git with the server's package manager. Does nothing when git is already there.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_install_server_git(state: State<'_, AppState>, id: String) -> Result<ServerGit> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = machine_for_server(&work, &server)?;
        let current = git_on(&work, &machine)?;
        if current.installed {
            return Ok(current);
        }
        let script = "if command -v apt-get >/dev/null 2>&1; then sudo -n DEBIAN_FRONTEND=noninteractive apt-get update && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y git; elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y git; elif command -v yum >/dev/null 2>&1; then sudo -n yum install -y git; elif command -v apk >/dev/null 2>&1; then sudo -n apk add git; elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -Sy --noconfirm git; elif command -v brew >/dev/null 2>&1; then brew install git; else echo 'no package manager found' >&2; exit 1; fi";
        let _ = require_exec(&work, &machine, script, 180)?;
        git_on(&work, &machine)
    })
    .await
}

fn git_on(work: &ServerWork, machine: &Machine) -> Result<ServerGit> {
    let stdout = require_exec(work, machine, "command -v git >/dev/null 2>&1 && git --version || true", 15)?;
    Ok(ServerGit {
        installed: stdout.to_ascii_lowercase().contains("git version"),
    })
}

/// SSH in and report whether `twanagent-server` is on that machine. Does not copy or pair.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_probe_agent_server(
    state: State<'_, AppState>,
    host: String,
    port: Option<u16>,
) -> Result<super::agent_server::ServerInstallStatus> {
    let work = server_work(&state);
    let port = port.unwrap_or(22);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let machine = config::list_machines(&conn)?
            .into_iter()
            .find(|row| row.host.eq_ignore_ascii_case(host.trim()) && row.port == port)
            .ok_or_else(|| Error::NotFound("sign in to this server again before checking".into()))?;
        if !machine_reachable(&machine.host, machine.port) {
            return Ok(offline_status());
        }
        let stdout = require_exec(&work, &machine, &super::agent_server::version_check_script(), 20)?;
        Ok(super::agent_server::parse_version_check(&stdout))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_agent_server_status(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::agent_server::ServerInstallStatus> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        status_for(&work, &server)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_install_agent_binary(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::agent_server::ServerInstallStatus> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = machine_for_server(&work, &server)?;
        copy_binary(&work, &machine)
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
) -> Result<super::agent_server::AgentServer> {
    let work = server_work(&state);
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
) -> Result<super::agent_server::AgentServer> {
    let method = AuthMethod::parse(if auth.trim().is_empty() { "agent" } else { &auth })?;
    let secret = secret.filter(|value| !value.trim().is_empty());
    let method = if secret.is_none() {
        config::auth_without_secret(method, key_path.as_deref())
    } else {
        method
    };
    let conn = work_db(work)?;
    let machine = config::upsert_machine(
        &conn,
        NewMachine {
            name: name.clone(),
            user,
            host: host.clone(),
            port: port.unwrap_or(22),
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
    let trusted = known.rows.iter().any(|row| row.host == machine.host && row.port == machine.port);
    if !trusted {
        return Err(Error::Other("Confirm the host key before installing on this server.".into()));
    }
    // Connecting only saves the machine and a pairing token. The program is copied when it is missing.
    let already = super::agent_server::server_by_host(&conn, &machine.host, machine.port)?;
    let created = already.is_none();
    let server = if let Some(already) = already {
        already
    } else {
        super::agent_server::insert_server(
            &conn,
            super::agent_server::NewAgentServer {
                name: if name.trim().is_empty() { host } else { name },
                user: machine.user.clone(),
                host: machine.host.clone(),
                port: machine.port,
                machine_id: Some(machine.id.clone()),
            },
        )?
    };
    if let Err(err) = write_token(work, &machine, &server.id) {
        if created {
            let _ = super::agent_server::delete_server(&conn, &server.id);
        }
        return Err(err);
    }
    agent_server_by_id(&conn, &server.id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_pair_agent_server(state: State<'_, AppState>, id: String) -> Result<super::agent_server::AgentServer> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = machine_for_server(&work, &server)?;
        write_token(&work, &machine, &server.id)?;
        agent_server_by_id(&conn, &server.id)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_remove_agent_server(state: State<'_, AppState>, id: String) -> Result<()> {
    let conn = open_db(&state)?;
    let _ = super::agent_server::delete_server(&conn, &id)?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_server_storage(state: State<'_, AppState>, id: String) -> Result<ServerStorage> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = machine_for_server(&work, &server)?;
        server_storage(&work, &machine)
    })
    .await
}

fn server_storage(work: &ServerWork, machine: &Machine) -> Result<ServerStorage> {
    let script = "data=\"$HOME/.twanagent\"; \
if [ -d \"$data\" ]; then du -sk \"$data\" | awk '{print $1}'; else echo 0; fi; \
find \"$data\" -name 'store.db' -type f -exec du -sk {} + 2>/dev/null | awk '{s+=$1} END {print s+0}'";
    let stdout = require_exec(work, machine, script, 20)?;
    let mut lines = stdout.lines();
    let total_kb: u64 = lines.next().unwrap_or("0").trim().parse().unwrap_or(0);
    let conv_kb: u64 = lines.next().unwrap_or("0").trim().parse().unwrap_or(0);
    Ok(ServerStorage {
        bytes: total_kb.saturating_mul(1024),
        conversation_bytes: conv_kb.saturating_mul(1024),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_server_provider_keys(state: State<'_, AppState>, id: String) -> Result<ServerProviderKeys> {
    let conn = open_db(&state)?;
    let names = super::agent_server::server_provider_keys(&conn, &id)?;
    Ok(keys_view(&names))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_copy_server_provider_keys(
    state: State<'_, AppState>,
    id: String,
    providers: Vec<String>,
) -> Result<ServerProviderKeys> {
    let work = server_work(&state);
    crate::state::run_blocking(move || {
        let conn = work_db(&work)?;
        let server = agent_server_by_id(&conn, &id)?;
        let machine = machine_for_server(&work, &server)?;
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
) -> Result<ServerProviderKeys> {
    let keys = provider_keys_for(work, providers);
    let script = super::agent_server::provider_keys_script(&keys)?;
    let _ = require_exec(work, machine, &script, 20)?;
    let names = super::agent_server::set_server_provider_keys(&conn, &id, &providers)?;
    Ok(keys_view(&names))
}
