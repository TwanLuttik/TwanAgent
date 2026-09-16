import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

export function appVersion(): Promise<string> {
  return invoke("app_version");
}

export async function pickDir(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export type DevKeyStatus = { saved: boolean; env: boolean };
export type DevEffort = { id: string; label: string };
export type DevModel = { id: string; name: string; efforts: DevEffort[] };
export type DevRuntime = {
  installed: boolean;
  logged_in: boolean;
  version: string | null;
  email: string | null;
  default_model: string;
  default_effort: string;
  models: DevModel[];
  has_key: boolean;
  ready: boolean;
  hint: string;
};

export function devRuntime(): Promise<DevRuntime> {
  return invoke("dev_runtime");
}
export type DevEntry = { name: string; path: string; kind: "file" | "dir" | string; size: number | null };
export type DevGitChange = {
  path: string;
  status: string;
  staged: boolean;
  additions: number;
  deletions: number;
};
export type DevGitBranches = { current: string | null; branches: string[] };
export type DevConversationSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  kind?: string;
};
export type DevConversation = DevConversationSummary & { messages: unknown[] };
export type DevToolCall = { id: string; name: string; arguments: string };
export type DevChatEvent = {
  stream_id: string;
  kind: "delta" | "done" | "error" | string;
  text?: string | null;
  tool_calls?: DevToolCall[] | null;
};

export function devProjectsRoot(): Promise<string> {
  return invoke("dev_projects_root");
}

export function devListProjects(): Promise<DevFolderSuggestion[]> {
  return invoke("dev_list_projects");
}

export function devOpenFolder(path: string): Promise<string> {
  return invoke("dev_open_folder", { path });
}

export type DevFolderSuggestion = { name: string; path: string };

export function devSuggestFolders(path: string): Promise<DevFolderSuggestion[]> {
  return invoke("dev_suggest_folders", { path });
}

export function devCreateProject(name: string): Promise<string> {
  return invoke("dev_create_project", { name });
}

export function devCloneRepo(url: string, name?: string): Promise<string> {
  return invoke("dev_clone_repo", { url, name: name ?? null });
}

export function devKeyStatus(): Promise<DevKeyStatus> {
  return invoke("dev_key_status");
}

export function devSetKey(key: string): Promise<DevKeyStatus> {
  return invoke("dev_set_key", { key });
}

export function devClearKey(): Promise<DevKeyStatus> {
  return invoke("dev_clear_key");
}

export function devListDir(workspace: string, path = ""): Promise<DevEntry[]> {
  return invoke("dev_list_dir", { workspace, path });
}

export function devReadFile(workspace: string, path: string): Promise<string> {
  return invoke("dev_read_file", { workspace, path });
}

export function devResolveFile(workspace: string, path: string): Promise<string> {
  return invoke("dev_resolve_file", { workspace, path });
}

export function devWriteFile(workspace: string, path: string, contents: string): Promise<void> {
  return invoke("dev_write_file", { workspace, path, contents });
}

export function devEditFile(
  workspace: string,
  path: string,
  oldString: string,
  newString: string,
): Promise<void> {
  return invoke("dev_edit_file", {
    workspace,
    path,
    oldString,
    newString,
    old_string: oldString,
    new_string: newString,
  });
}

export function devGitStatus(workspace: string): Promise<DevGitChange[]> {
  return invoke("dev_git_status", { workspace });
}

export function devGitDiff(workspace: string, path = ""): Promise<string> {
  return invoke("dev_git_diff", { workspace, path });
}

export function devGitBranches(workspace: string): Promise<DevGitBranches> {
  return invoke("dev_git_branches", { workspace });
}

export function devGitSwitch(workspace: string, name: string): Promise<DevGitBranches> {
  return invoke("dev_git_switch", { workspace, name });
}

export function devRunCommand(workspace: string, command: string): Promise<string> {
  return invoke("dev_run_command", { workspace, command });
}

export function devListConversations(workspace: string): Promise<DevConversationSummary[]> {
  return invoke("dev_list_conversations", { workspace });
}

export function devGetConversation(workspace: string, id: string): Promise<DevConversation> {
  return invoke("dev_get_conversation", { workspace, id });
}

export function devSaveConversation(workspace: string, conversation: DevConversation): Promise<DevConversation> {
  return invoke("dev_save_conversation", { workspace, conversation });
}

export function devReorderConversations(
  workspace: string,
  ids: string[],
): Promise<DevConversationSummary[]> {
  return invoke("dev_reorder_conversations", { workspace, ids });
}

export function devDeleteConversation(workspace: string, id: string): Promise<void> {
  return invoke("dev_delete_conversation", { workspace, id });
}

export function devChatStart(
  streamId: string,
  messages: unknown[],
  model?: string,
  effort?: string,
): Promise<void> {
  return invoke("dev_chat_start", {
    streamId,
    stream_id: streamId,
    messages,
    model,
    effort,
  });
}

export function devChatCancel(streamId: string): Promise<void> {
  return invoke("dev_chat_cancel", { streamId, stream_id: streamId });
}

export function onDevChat(fn: (ev: DevChatEvent) => void): Promise<UnlistenFn> {
  return listen<DevChatEvent>("dev-chat", (ev) => fn(ev.payload));
}

export type DevPtyEvent = {
  id: string;
  kind: "data" | "exit" | string;
  data?: string | null;
};

export function devPtyOpen(workspace: string, cols: number, rows: number): Promise<string> {
  return invoke("dev_pty_open", { workspace, cols, rows });
}

export function devPtyOpenGrok(workspace: string, cols: number, rows: number): Promise<string> {
  return invoke("dev_pty_open_grok", { workspace, cols, rows });
}

export function devPtyWrite(id: string, data: string): Promise<void> {
  return invoke("dev_pty_write", { id, data });
}

export function devPtyWriteBytes(id: string, data: number[]): Promise<void> {
  return invoke("dev_pty_write_bytes", { id, data });
}

export function devPtyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("dev_pty_resize", { id, cols, rows });
}

export function devPtyKill(id: string): Promise<void> {
  return invoke("dev_pty_kill", { id });
}

export function onDevPty(fn: (ev: DevPtyEvent) => void): Promise<UnlistenFn> {
  return listen<DevPtyEvent>("dev-pty", (ev) => fn(ev.payload));
}
