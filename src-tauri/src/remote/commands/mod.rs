mod capabilities;
mod machines;
mod servers;

use super::config::{self, Machine};
use crate::error::{Error, Result};
use crate::state::AppState;

pub(super) fn open_db(state: &AppState) -> Result<rusqlite::Connection> {
    crate::appdb::open(&state.data_dir)
}

/// What a background server check needs. `AppState` itself is not moved off the command thread.
pub(super) struct ServerWork {
    pub(super) data_dir: std::path::PathBuf,
    pub(super) ssh_pool: std::sync::Arc<super::ssh::Pool>,
}

pub(super) fn server_work(state: &AppState) -> ServerWork {
    ServerWork {
        data_dir: state.data_dir.clone(),
        ssh_pool: state.ssh_pool.clone(),
    }
}

pub(super) fn work_db(work: &ServerWork) -> Result<rusqlite::Connection> {
    crate::appdb::open(&work.data_dir)
}

pub(super) fn machine_secret(machine: &Machine) -> Option<String> {
    machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret)
}

pub(super) fn exec_on(work: &ServerWork, machine: &Machine, command: &str, timeout_secs: u64) -> Result<super::ssh::ExecResult> {
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

pub(super) fn require_exec(work: &ServerWork, machine: &Machine, command: &str, timeout_secs: u64) -> Result<String> {
    let made = exec_on(work, machine, command, timeout_secs)?;
    if made.timed_out {
        return Err(Error::Other(format!("timed out talking to {}", machine.host)));
    }
    if made.exit_code.is_some_and(|code| code != 0) {
        let detail = made.stderr.trim();
        let out = made.stdout.trim();
        return Err(Error::Other(if !detail.is_empty() {
            detail.to_string()
        } else if !out.is_empty() {
            out.chars().take(240).collect()
        } else {
            format!("command failed on {}", machine.host)
        }));
    }
    Ok(made.stdout)
}

pub(super) fn machine_for_server(work: &ServerWork, server: &super::agent_server::AgentServer) -> Result<Machine> {
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

pub use machines::{
    __cmd__dev_accept_host, __cmd__dev_clone_remote_repo, __cmd__dev_create_remote_project, __cmd__dev_delete_machine,
    __cmd__dev_discover_ssh, __cmd__dev_list_machines, __cmd__dev_list_remote_projects, __cmd__dev_remote_home,
    __cmd__dev_save_machine, __cmd__dev_ssh_defaults, __cmd__dev_test_machine, __cmd__dev_warm_workspace_link,
    __cmd__dev_workspace_remote, __tauri_command_name_dev_accept_host, __tauri_command_name_dev_clone_remote_repo,
    __tauri_command_name_dev_create_remote_project, __tauri_command_name_dev_delete_machine,
    __tauri_command_name_dev_discover_ssh, __tauri_command_name_dev_list_machines,
    __tauri_command_name_dev_list_remote_projects, __tauri_command_name_dev_remote_home,
    __tauri_command_name_dev_save_machine, __tauri_command_name_dev_ssh_defaults, __tauri_command_name_dev_test_machine,
    __tauri_command_name_dev_warm_workspace_link, __tauri_command_name_dev_workspace_remote, dev_accept_host,
    dev_clone_remote_repo, dev_create_remote_project, dev_delete_machine, dev_discover_ssh, dev_list_machines,
    dev_list_remote_projects, dev_remote_home, dev_save_machine, dev_ssh_defaults, dev_test_machine,
    dev_warm_workspace_link, dev_workspace_remote, machine_reachable, TestMachineResult, WorkspaceRemote,
};

pub use capabilities::{
    __cmd__dev_server_capabilities, __cmd__dev_sync_server_capabilities, __cmd__dev_workspace_capabilities,
    __cmd__dev_workspace_server_id, __tauri_command_name_dev_server_capabilities,
    __tauri_command_name_dev_sync_server_capabilities, __tauri_command_name_dev_workspace_capabilities,
    __tauri_command_name_dev_workspace_server_id, dev_server_capabilities, dev_sync_server_capabilities,
    dev_workspace_capabilities, dev_workspace_server_id, RemoteCapabilities, RemoteSkillFile,
};

pub use servers::{
    __cmd__dev_agent_server_online, __cmd__dev_agent_server_status, __cmd__dev_copy_server_provider_keys,
    __cmd__dev_install_agent_binary,
    __cmd__dev_install_agent_server, __cmd__dev_install_server_git, __cmd__dev_list_agent_servers,
    __cmd__dev_pair_agent_server, __cmd__dev_probe_agent_server, __cmd__dev_remove_agent_server,
    __cmd__dev_rename_agent_server,
    __cmd__dev_server_git, __cmd__dev_server_projects, __cmd__dev_server_provider_keys, __cmd__dev_server_storage,
    __tauri_command_name_dev_agent_server_online, __tauri_command_name_dev_agent_server_status,
    __tauri_command_name_dev_copy_server_provider_keys,
    __tauri_command_name_dev_install_agent_binary, __tauri_command_name_dev_install_agent_server,
    __tauri_command_name_dev_install_server_git, __tauri_command_name_dev_list_agent_servers,
    __tauri_command_name_dev_pair_agent_server, __tauri_command_name_dev_probe_agent_server,
    __tauri_command_name_dev_rename_agent_server,
    __tauri_command_name_dev_remove_agent_server, __tauri_command_name_dev_server_git,
    __tauri_command_name_dev_server_projects, __tauri_command_name_dev_server_provider_keys,
    __tauri_command_name_dev_server_storage, dev_agent_server_online, dev_agent_server_status,
    dev_copy_server_provider_keys,
    dev_install_agent_binary, dev_install_agent_server, dev_install_server_git, dev_list_agent_servers,
    dev_pair_agent_server, dev_probe_agent_server, dev_remove_agent_server, dev_rename_agent_server,
    dev_server_git, dev_server_projects,
    dev_server_provider_keys, dev_server_storage, InstallProgress, ServerGit, ServerKeyReplaced, ServerProject,
    ServerProviderKeys, ServerStorage,
};

pub(crate) use servers::server_projects_from;
