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
export type DevModel = {
  id: string;
  name: string;
  efforts: DevEffort[];
  context_window?: number | null;
};
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
  journey_id?: string | null;
  sort_order?: number;
};
export type DevConversation = DevConversationSummary & {
  messages: unknown[];
  context_usage?: DevChatUsage | null;
};
export type DevJourney = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sort_order: number;
  collapsed: boolean;
  color?: string;
};
export type DevSidebarItem = { kind: "journey" | "conversation" | string; id: string };
export type DevToolCall = { id: string; name: string; arguments: string };
export type DevChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
export type DevChatEvent = {
  stream_id: string;
  kind: "delta" | "done" | "error" | string;
  text?: string | null;
  tool_calls?: DevToolCall[] | null;
  usage?: DevChatUsage | null;
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

export function devExistingFiles(workspace: string, paths: string[]): Promise<string[]> {
  return invoke("dev_existing_files", { workspace, paths });
}

export type DevFilePreview = {
  path: string;
  name: string;
  size: number;
  binary: boolean;
  lines?: number | null;
  preview?: string | null;
  modified?: number | null;
};

export function devFilePreview(workspace: string, path: string): Promise<DevFilePreview> {
  return invoke("dev_file_preview", { workspace, path });
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

export function devListJourneys(workspace: string): Promise<DevJourney[]> {
  return invoke("dev_list_journeys", { workspace });
}

export function devCreateJourney(workspace: string, conversationId: string): Promise<DevJourney> {
  return invoke("dev_create_journey", {
    workspace,
    conversationId,
    conversation_id: conversationId,
  });
}

export function devRenameJourney(workspace: string, id: string, title: string): Promise<DevJourney> {
  return invoke("dev_rename_journey", { workspace, id, title });
}

export function devDeleteJourney(workspace: string, id: string, deleteChats: boolean): Promise<void> {
  return invoke("dev_delete_journey", {
    workspace,
    id,
    deleteChats,
    delete_chats: deleteChats,
  });
}

export function devSetJourneyCollapsed(workspace: string, id: string, collapsed: boolean): Promise<void> {
  return invoke("dev_set_journey_collapsed", { workspace, id, collapsed });
}

export function devSetJourneyColor(workspace: string, id: string, color: string): Promise<DevJourney> {
  return invoke("dev_set_journey_color", { workspace, id, color });
}

export function devMoveConversation(
  workspace: string,
  id: string,
  journeyId: string | null,
): Promise<DevConversation> {
  return invoke("dev_move_conversation", {
    workspace,
    id,
    journeyId,
    journey_id: journeyId,
  });
}

export function devReorderSidebar(workspace: string, items: DevSidebarItem[]): Promise<DevConversationSummary[]> {
  return invoke("dev_reorder_sidebar", { workspace, items });
}

export function devGetJourneyKnowledge(workspace: string, journeyId: string): Promise<string> {
  return invoke("dev_get_journey_knowledge", {
    workspace,
    journeyId,
    journey_id: journeyId,
  });
}

export function devSaveJourneyKnowledge(workspace: string, journeyId: string, contents: string): Promise<void> {
  return invoke("dev_save_journey_knowledge", {
    workspace,
    journeyId,
    journey_id: journeyId,
    contents,
  });
}

export function devUpdateJourneyKnowledge(
  workspace: string,
  journeyId: string,
  args: { mode: string; contents?: string; oldString?: string; newString?: string },
): Promise<string> {
  return invoke("dev_update_journey_knowledge", {
    workspace,
    journeyId,
    journey_id: journeyId,
    mode: args.mode,
    contents: args.contents ?? null,
    oldString: args.oldString ?? null,
    newString: args.newString ?? null,
    old_string: args.oldString ?? null,
    new_string: args.newString ?? null,
  });
}

export function devChatStart(
  streamId: string,
  messages: unknown[],
  model?: string,
  effort?: string,
  journeyId?: string,
): Promise<void> {
  return invoke("dev_chat_start", {
    streamId,
    stream_id: streamId,
    messages,
    model,
    effort,
    journeyId,
    journey_id: journeyId ?? null,
  });
}

export function devChatCancel(streamId: string): Promise<void> {
  return invoke("dev_chat_cancel", { streamId, stream_id: streamId });
}

const chatListeners = new Map<string, (ev: DevChatEvent) => void>();
let chatListen: Promise<UnlistenFn> | null = null;

function ensureChatListen(): Promise<UnlistenFn> {
  if (!chatListen) {
    chatListen = listen<DevChatEvent>("dev-chat", (ev) => {
      const payload = ev.payload;
      if (!payload) return;
      for (const fn of chatListeners.values()) fn(payload);
    });
  }
  return chatListen;
}

export async function onDevChat(fn: (ev: DevChatEvent) => void): Promise<UnlistenFn> {
  await ensureChatListen();
  const key = `tmp-${crypto.randomUUID()}`;
  const wrapped = (ev: DevChatEvent) => fn(ev);
  chatListeners.set(key, wrapped);
  return () => {
    chatListeners.delete(key);
  };
}

export type DevPtyEvent = {
  id: string;
  kind: "data" | "exit" | string;
  data?: string | null;
};

export function devPtyOpen(workspace: string, cols: number, rows: number): Promise<string> {
  return invoke("dev_pty_open", { workspace, cols, rows });
}

export function devPtyOpenGrok(
  workspace: string,
  cols: number,
  rows: number,
  sessionId?: string,
): Promise<string> {
  return invoke("dev_pty_open_grok", {
    workspace,
    cols,
    rows,
    sessionId,
    session_id: sessionId,
  });
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
