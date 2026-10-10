use tauri::{AppHandle, Emitter, Manager, State};

use super::config::{self, AuthMethod, Machine, NewMachine, RemoteProject};
use super::ssh::{HostKeyDecision, HostPrompt, KnownHost, KnownHosts};
use crate::error::{Error, Result};
use crate::state::AppState;

fn open_db(state: &AppState) -> Result<rusqlite::Connection> {
    crate::appdb::open(&state.data_dir)
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
    Ok(Some(WorkspaceRemote {
        machine_id: machine.id,
        machine_name: machine.name,
        host: machine.host,
        user: machine.user,
        port: machine.port,
        remote_path: project.remote_path,
        project_name: project.name,
        online,
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
