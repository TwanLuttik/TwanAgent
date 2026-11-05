import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MachineAuth = "agent" | "private_key" | "password";

export type Machine = {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  auth: MachineAuth | string;
  key_path?: string | null;
  secret_account?: string | null;
  created_at: string;
};

export type RemoteProject = {
  id: string;
  machine_id: string;
  name: string;
  remote_path: string;
  mount_path: string;
  created_at: string;
};

export type HostPrompt = {
  machine_id: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  changed: boolean;
};

export type TestMachineResult = {
  ok: boolean;
  message: string;
  host_prompt?: HostPrompt | null;
};

export type WorkspaceRemote = {
  machine_id: string;
  machine_name: string;
  host: string;
  user: string;
  port: number;
  remote_path: string;
  project_name: string;
  online: boolean;
  providers?: string[];
  paired?: boolean;
};

export type LanHost = { host: string; port: number; label: string };

export type SshDefaults = { user: string; key_path?: string | null };

export function discoverSsh(): Promise<LanHost[]> {
  return invoke("dev_discover_ssh");
}

export function onSshFound(fn: (host: LanHost) => void): Promise<UnlistenFn> {
  return listen<LanHost>("dev-ssh-found", (ev) => fn(ev.payload));
}

export function sshDefaults(): Promise<SshDefaults> {
  return invoke("dev_ssh_defaults");
}

export function remoteHome(id: string): Promise<string> {
  return invoke("dev_remote_home", { id });
}

export function listMachines(): Promise<Machine[]> {
  return invoke("dev_list_machines");
}

export function saveMachine(input: {
  name: string;
  user: string;
  host: string;
  port?: number;
  auth: MachineAuth;
  keyPath?: string;
  secret?: string;
}): Promise<Machine> {
  return invoke("dev_save_machine", {
    name: input.name,
    user: input.user,
    host: input.host,
    port: input.port ?? 22,
    auth: input.auth,
    keyPath: input.keyPath ?? null,
    key_path: input.keyPath ?? null,
    secret: input.secret ?? null,
  });
}

export function deleteMachine(id: string): Promise<void> {
  return invoke("dev_delete_machine", { id });
}

export function listRemoteProjects(): Promise<RemoteProject[]> {
  return invoke("dev_list_remote_projects");
}

export function testMachine(id: string): Promise<TestMachineResult> {
  return invoke("dev_test_machine", { id });
}

export function acceptHost(machineId: string, fingerprint: string, keyType: string): Promise<void> {
  return invoke("dev_accept_host", {
    machineId,
    machine_id: machineId,
    fingerprint,
    keyType,
    key_type: keyType,
  });
}

export function createRemoteProject(name: string, machineId: string, remotePath: string): Promise<string> {
  return invoke("dev_create_remote_project", {
    name,
    machineId,
    machine_id: machineId,
    remotePath,
    remote_path: remotePath,
  });
}

export function cloneRemoteRepo(url: string, machineId: string, remotePath: string): Promise<string> {
  return invoke("dev_clone_remote_repo", {
    url,
    machineId,
    machine_id: machineId,
    remotePath,
    remote_path: remotePath,
  });
}

export function workspaceRemote(workspace: string): Promise<WorkspaceRemote | null> {
  return invoke("dev_workspace_remote", { workspace });
}

/** Open the SSH session for a cloud project. False when it is local or the server did not answer. */
export function warmWorkspaceLink(workspace: string): Promise<boolean> {
  return invoke("dev_warm_workspace_link", { workspace });
}

export type AgentServer = {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  machine_id?: string | null;
  installed_at: string;
  paired: boolean;
};

export type ServerInstallStatus = {
  installed: boolean;
  version: string;
  path: string;
  online: boolean;
  update?: boolean;
  /** The version this Mac would install. Set only when `update` is true. */
  available?: string;
  /** `~/.twanagent/auth-token` on that machine matches the token saved here. */
  paired?: boolean;
  /** The protocol baked into the binary. 0 when that build does not say. */
  protocol?: number;
  /** The protocol this app speaks. */
  desktop_protocol?: number;
};

export type ServerProviderKeys = {
  xai: boolean;
  anthropic: boolean;
  minimax: boolean;
  /** Set on a copy. True when that provider's key replaced a different one already on the server. */
  replaced?: {
    xai: boolean;
    anthropic: boolean;
    minimax: boolean;
  };
};

export type ServerStorage = {
  bytes: number;
  conversation_bytes: number;
};

export function listAgentServers(): Promise<AgentServer[]> {
  return invoke("dev_list_agent_servers");
}

export function agentServerStatus(id: string): Promise<ServerInstallStatus> {
  return invoke("dev_agent_server_status", { id });
}

/** Whether the machine answers. No SSH login, so the keychain is not touched. */
export function agentServerOnline(id: string): Promise<boolean> {
  return invoke("dev_agent_server_online", { id });
}

/** SSH to a machine that was just saved and see if the server program is there. Does not install it. */
export function probeAgentServer(host: string, port = 22): Promise<ServerInstallStatus> {
  return invoke("dev_probe_agent_server", { host, port });
}

export type InstallProgress = {
  id: string;
  phase: "reading" | "copying" | "installing" | string;
  sent: number;
  total: number;
};

export function installAgentBinary(id: string): Promise<ServerInstallStatus> {
  return invoke("dev_install_agent_binary", { id });
}

export function onInstallProgress(fn: (event: InstallProgress) => void): Promise<UnlistenFn> {
  return listen<InstallProgress>("dev-install-progress", (ev) => fn(ev.payload));
}

export function installAgentServer(input: {
  name: string;
  user: string;
  host: string;
  port?: number;
  auth: MachineAuth;
  keyPath?: string;
  secret?: string;
}): Promise<AgentServer> {
  return invoke("dev_install_agent_server", {
    name: input.name,
    user: input.user,
    host: input.host,
    port: input.port ?? 22,
    auth: input.auth,
    keyPath: input.keyPath ?? null,
    key_path: input.keyPath ?? null,
    secret: input.secret ?? null,
  });
}

export function renameAgentServer(id: string, name: string): Promise<AgentServer> {
  return invoke("dev_rename_agent_server", { id, name });
}

export function pairAgentServer(id: string): Promise<AgentServer> {
  return invoke("dev_pair_agent_server", { id });
}

/** `keep` forgets the server here. `wipe` deletes the token on the machine. `rotate` replaces it. */
export function removeAgentServer(id: string, mode: "keep" | "wipe" | "rotate" = "keep"): Promise<void> {
  return invoke("dev_remove_agent_server", {
    id,
    wipe: mode === "wipe",
    rotate: mode === "rotate",
  });
}

export function serverStorage(id: string): Promise<ServerStorage> {
  return invoke("dev_server_storage", { id });
}

export function serverProviderKeys(id: string): Promise<ServerProviderKeys> {
  return invoke("dev_server_provider_keys", { id });
}

export function copyServerProviderKeys(id: string, providers: string[]): Promise<ServerProviderKeys> {
  return invoke("dev_copy_server_provider_keys", { id, providers });
}

export type RemoteSkillFile = {
  path: string;
  read_path: string;
  origin: string;
  contents: string;
};

export type RemoteCapabilities = {
  /** Config text keyed as `relative path\\ncontents`. */
  mcp: string[];
  auth: string[];
  skills: RemoteSkillFile[];
};

export type ServerProject = {
  name: string;
  remote_path: string;
  /** True when this Mac already saved the folder. */
  saved: boolean;
};

/** Folders that already exist on the server, including ones this Mac never added. */
export function serverProjects(id: string): Promise<ServerProject[]> {
  return invoke("dev_server_projects", { id });
}

export function serverGit(id: string): Promise<{ installed: boolean }> {
  return invoke("dev_server_git", { id });
}

export function installServerGit(id: string): Promise<{ installed: boolean }> {
  return invoke("dev_install_server_git", { id });
}

export function serverCapabilities(id: string): Promise<RemoteCapabilities> {
  return invoke("dev_server_capabilities", { id });
}

export function workspaceCapabilities(workspace: string): Promise<RemoteCapabilities | null> {
  return invoke("dev_workspace_capabilities", { workspace });
}

export function workspaceServerId(workspace: string): Promise<string | null> {
  return invoke("dev_workspace_server_id", { workspace });
}

/** Copy MCP configs and skills. `mcpName` signs in through the browser on this Mac first. */
export function syncServerCapabilities(id: string, mcpName?: string): Promise<RemoteCapabilities> {
  return invoke("dev_sync_server_capabilities", { id, mcpName: mcpName ?? null, mcp_name: mcpName ?? null });
}
