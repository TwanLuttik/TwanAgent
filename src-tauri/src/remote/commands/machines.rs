use tauri::{AppHandle, Emitter, Manager, State};

use super::super::config::{self, AuthMethod, Machine, NewMachine, RemoteProject};
use super::super::ssh::{HostKeyDecision, HostPrompt, KnownHost, KnownHosts};
use super::ServerWork;
use crate::error::{Error, Result};
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_discover_ssh(app: AppHandle) -> Result<Vec<super::super::discover::LanHost>> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app_emit = app.clone();
    let scan = tokio::spawn(async move {
        let _ = super::super::discover::scan_ssh_stream(tx).await;
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
pub fn dev_ssh_defaults() -> super::super::discover::SshDefaults {
    super::super::discover::ssh_defaults()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_remote_home(state: State<'_, AppState>, id: String) -> Result<String> {
    let conn = super::open_db(&state)?;
    let machine = config::machine_by_id(&conn, &id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    let out = state.ssh_pool.exec(
        &machine,
        secret.as_deref(),
        &super::super::ssh::ExecRequest {
            cwd: "/".into(),
            command: "printf %s \"$HOME\"".into(),
            timeout_secs: 15,
        },
    )?;
    let home = out.stdout.trim();
    if !home.starts_with('/') || home.contains('\n') {
        return Err(Error::Other(
            "could not read the home folder on that server".into(),
        ));
    }
    Ok(home.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_list_machines(state: State<'_, AppState>) -> Result<Vec<Machine>> {
    let conn = super::open_db(&state)?;
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
    let conn = super::open_db(&state)?;
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
    let conn = super::open_db(&state)?;
    let projects = config::list_remote_projects(&conn)?;
    for project in projects.iter().filter(|p| p.machine_id == id) {
        let _ = super::super::mount::unmount(std::path::Path::new(&project.mount_path));
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
    let conn = super::open_db(&state)?;
    config::list_remote_projects(&conn)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_test_machine(
    state: State<'_, AppState>,
    id: String,
) -> Result<super::TestMachineResult> {
    let conn = super::open_db(&state)?;
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

fn probe(state: &AppState, machine: &Machine) -> Result<super::TestMachineResult> {
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    let (_session, presented) = state.ssh_pool.probe(machine, secret.as_deref())?;
    let known = KnownHosts::load(&state.data_dir);
    match known.decide(&presented) {
        HostKeyDecision::Trusted => Ok(super::TestMachineResult {
            ok: true,
            message: format!("Host key for {} is trusted.", machine.host),
            host_prompt: None,
        }),
        HostKeyDecision::Unknown(host) => Ok(super::TestMachineResult {
            ok: false,
            message: "Confirm this host key before connecting.".into(),
            host_prompt: Some(prompt(machine, &host, false)),
        }),
        HostKeyDecision::Changed { presented, .. } => Ok(super::TestMachineResult {
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
    let conn = super::open_db(&state)?;
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
pub async fn dev_clone_remote_repo(
    app: AppHandle,
    url: String,
    machine_id: String,
    remote_path: String,
) -> Result<String> {
    let state = app.state::<AppState>();
    let work = super::server_work(&state);
    let url = crate::dev::projects::validate_git_url_public(&url)?.to_string();
    let remote_path = config::validate_remote_path(&remote_path)?;
    let name = remote_path
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("project")
        .to_string();
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let machine = config::machine_by_id(&conn, &machine_id)?
            .ok_or_else(|| Error::NotFound("machine not found".into()))?;
        require_trusted_host(&work, &machine)?;
        let command = super::super::mount::clone_remote_command(&remote_path, &url)?;
        let _ = super::require_exec(&work, &machine, &command, 600)?;
        register_remote_project(&app, &machine, &name, &remote_path)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_create_remote_project(
    app: AppHandle,
    name: String,
    machine_id: String,
    remote_path: String,
) -> Result<String> {
    let state = app.state::<AppState>();
    let remote_path = config::validate_remote_path(&remote_path)?;
    let name = config::validate_name(&name)?;
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let conn = super::work_db(&work)?;
        let machine = config::machine_by_id(&conn, &machine_id)?
            .ok_or_else(|| Error::NotFound("machine not found".into()))?;
        require_trusted_host(&work, &machine)?;
        let _ = super::require_exec(
            &work,
            &machine,
            &super::super::mount::mkdir_remote_command(&remote_path)?,
            30,
        )?;
        register_remote_project(&app, &machine, &name, &remote_path)
    })
    .await
}

fn require_trusted_host(work: &ServerWork, machine: &config::Machine) -> Result<()> {
    let known = KnownHosts::load(&work.data_dir);
    let trusted = known
        .rows
        .iter()
        .any(|row| row.host == machine.host && row.port == machine.port);
    if trusted {
        return Ok(());
    }
    Err(Error::Other(
        "Confirm the host key before creating a project on this server.".into(),
    ))
}

fn register_remote_project(
    app: &AppHandle,
    machine: &config::Machine,
    name: &str,
    remote_path: &str,
) -> Result<String> {
    let state = app.state::<AppState>();
    let conn = super::open_db(&state)?;
    // Opening a folder that already exists on the server must not add a second sidebar row.
    if let Some(existing) = config::list_remote_projects(&conn)?
        .into_iter()
        .find(|row| row.machine_id == machine.id && row.remote_path == remote_path)
    {
        let mount = std::path::PathBuf::from(&existing.mount_path);
        super::super::mount::ensure_mount_point(&mount)?;
        let canon = state.register_workspace(app, &mount)?;
        let conn = super::open_db(&state)?;
        let _ = crate::appdb::add_project_named(&conn, &canon, Some(name));
        return Ok(crate::dev::path_string(&canon));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mount = super::super::mount::mount_dir(&state.data_dir, &id);
    super::super::mount::ensure_mount_point(&mount)?;
    // The project stays on the server. File tools use SSH, so macOS does not get a mounted drive.
    let _ = super::super::mount::unmount(&mount);
    let _project = config::insert_remote_project(&conn, &machine.id, name, remote_path, &mount)?;
    let canon = state.register_workspace(app, &mount)?;
    let conn = super::open_db(&state)?;
    let _ = crate::appdb::add_project_named(&conn, &canon, Some(name));
    Ok(crate::dev::path_string(&canon))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_workspace_remote(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<Option<super::WorkspaceRemote>> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let root = crate::dev::paths::expand_folder_path(&workspace)?;
        let conn = super::work_db(&work)?;
        let Some(project) = config::remote_project_by_mount(&conn, &root)? else {
            return Ok(None);
        };
        let machine = config::machine_by_id(&conn, &project.machine_id)?
            .ok_or_else(|| Error::NotFound("machine not found".into()))?;
        let online = machine_reachable(&machine.host, machine.port);
        let paired_server =
            super::super::agent_server::server_by_host(&conn, &machine.host, machine.port)?;
        // The file on the server is the truth. The local note is only a fallback when SSH cannot answer.
        let providers = super::servers::provider_keys_on_server(
            &work,
            &machine,
            paired_server.as_ref(),
            &conn,
        )?;
        let paired = paired_server.as_ref().is_some_and(|server| server.paired);
        Ok(Some(super::WorkspaceRemote {
            machine_id: machine.id,
            machine_name: machine.name,
            host: machine.host,
            user: machine.user,
            port: machine.port,
            remote_path: project.remote_path,
            project_name: project.name,
            online,
            providers,
            paired,
        }))
    })
    .await
}

/// Open the SSH session before the file tree asks for it.
/// File tools share one channel, so the first login would otherwise stall the window.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_warm_workspace_link(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<bool> {
    let work = super::server_work(&state);
    crate::state::run_blocking(move || {
        let root = crate::dev::paths::expand_folder_path(&workspace)?;
        let conn = super::work_db(&work)?;
        let Some(project) = config::remote_project_by_mount(&conn, &root)? else {
            return Ok(false);
        };
        let machine = config::machine_by_id(&conn, &project.machine_id)?
            .ok_or_else(|| Error::NotFound("machine not found".into()))?;
        if !machine_reachable(&machine.host, machine.port) {
            return Ok(false);
        }
        let secret = super::machine_secret(&machine);
        let _session = work.ssh_pool.session(&machine, secret.as_deref())?;
        // The live socket has to belong to the process that will run the turn.
        // Starting it here means the first send does not have to wait for it.
        let _ = work.ssh_pool.exec(
            &machine,
            secret.as_deref(),
            &super::super::ssh::ExecRequest {
                cwd: "/".into(),
                command: "$HOME/.twanagent/bin/twanagent-server --serve --data \"$HOME/.twanagent\" >/dev/null 2>&1 &".into(),
                timeout_secs: 8,
            },
        );
        Ok(true)
    })
    .await
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
    /// The machine has a paired `twanagent-server`. Chats for this project run there.
    #[serde(default)]
    pub paired: bool,
}

/// Up check, before any SSH login. Ping first, then the SSH port.
/// A host that drops ICMP still counts as up when the port accepts a connection.
/// Tailscale peers often do. DNS lookup has no timeout of its own, so the lookup is capped.
pub fn machine_reachable(host: &str, port: u16) -> bool {
    use std::net::ToSocketAddrs;
    let host = host.trim().to_string();
    if host.is_empty() || port == 0 {
        return false;
    }
    let ping_host = host.clone();
    let (ping_tx, ping_rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("twanagent-ping".into())
        .spawn(move || {
            let _ = ping_tx.send(host_answers_ping(&ping_host));
        })
        .ok();
    let answered = ping_rx
        .recv_timeout(std::time::Duration::from_millis(1500))
        .unwrap_or(false);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("twanagent-reach".into())
        .spawn(move || {
            let found = format!("{host}:{port}")
                .to_socket_addrs()
                .ok()
                .and_then(|mut addrs| addrs.next());
            let _ = tx.send(found);
        })
        .ok();
    let Ok(Some(addr)) = rx.recv_timeout(std::time::Duration::from_millis(1200)) else {
        return false;
    };
    let port_open =
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(900)).is_ok();
    // The port is the login. Ping only confirms the address is a live machine.
    let _ = answered;
    port_open
}

/// One echo. Failure is not "down": many servers drop ICMP and still accept SSH.
fn host_answers_ping(host: &str) -> bool {
    let host = host.trim();
    if host.is_empty() || host.contains([' ', '\n', '\'']) {
        return false;
    }
    #[cfg(unix)]
    {
        std::process::Command::new("ping")
            .args(["-c", "1", "-W", "1000", host])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(not(unix))]
    {
        let _ = host;
        false
    }
}
