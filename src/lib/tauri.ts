import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

export function appVersion(): Promise<string> {
  return invoke("app_version");
}

export type AppPerfSnapshot = {
  cpu_percent: number;
  memory_bytes: number;
};

export function appPerfSnapshot(): Promise<AppPerfSnapshot> {
  return invoke("app_perf_snapshot");
}

export async function pickDir(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export type KeyStatus = { saved: boolean; env: boolean };
export type Effort = { id: string; label: string };
export type Model = {
  id: string;
  name: string;
  efforts: Effort[];
  context_window?: number | null;
  context_windows?: number[] | null;
};
export type Runtime = {
  installed: boolean;
  logged_in: boolean;
  version: string | null;
  email: string | null;
  default_model: string;
  default_effort: string;
  models: Model[];
  has_key: boolean;
  ready: boolean;
  hint: string;
};

export function runtime(): Promise<Runtime> {
  return invoke("dev_runtime");
}

export type GrokCliInfo = {
  installed: boolean;
  path: string;
  version: string | null;
  logged_in: boolean;
  email: string | null;
};

export function cliInfo(): Promise<GrokCliInfo> {
  return invoke("dev_cli_info");
}

export type UsageDbInfo = {
  path: string;
  bytes: number;
  exists: boolean;
};

export function usageDbInfo(): Promise<UsageDbInfo> {
  return invoke("dev_usage_db_info");
}

export function usageDbReset(): Promise<UsageDbInfo> {
  return invoke("dev_usage_db_reset");
}

export function openedWorkspaces(): Promise<string[]> {
  return invoke("dev_opened_workspaces");
}

export function forgetWorkspace(path: string): Promise<boolean> {
  return invoke("dev_forget_workspace", { path });
}
export type Entry = { name: string; path: string; kind: "file" | "dir" | string; size: number | null };
export type GitChange = {
  path: string;
  status: string;
  staged: boolean;
  additions: number;
  deletions: number;
};
export type GitBranches = { current: string | null; branches: string[] };
export type ConversationSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  kind?: string;
  journey_id?: string | null;
  sort_order?: number;
  effort?: string | null;
};
export type Compaction = {
  summary: string;
  through: number;
};
export type Conversation = ConversationSummary & {
  messages: unknown[];
  context_usage?: ApiChatUsage | null;
  compaction?: Compaction | null;
};
export type Journey = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sort_order: number;
  collapsed: boolean;
  color?: string;
};
export type SidebarItem = { kind: "journey" | "conversation" | string; id: string };
export type ToolCall = { id: string; name: string; arguments: string };
export type ApiChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
export type ApiUsageEvent = {
  id: number;
  recorded_at: string;
  workspace_path: string;
  workspace_name: string;
  conversation_id: string;
  conversation_title: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
export type ApiUsageRecord = {
  workspace_path: string;
  workspace_name: string;
  conversation_id?: string;
  conversation_title?: string;
  model?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
export type ChatEvent = {
  stream_id: string;
  kind: "delta" | "done" | "error" | string;
  text?: string | null;
  tool_calls?: ToolCall[] | null;
  usage?: ApiChatUsage | null;
};

export function projectsRoot(): Promise<string> {
  return invoke("dev_projects_root");
}

export type ProjectPathMove = { from: string; to: string };

export type ProjectsLocation = {
  root: string;
  legacy_root: string;
  moves: ProjectPathMove[];
};

export function projectsLocation(): Promise<ProjectsLocation> {
  return invoke("dev_projects_location");
}

export function listProjects(): Promise<FolderSuggestion[]> {
  return invoke("dev_list_projects");
}

export function openFolder(path: string): Promise<string> {
  return invoke("dev_open_folder", { path });
}

export type FolderSuggestion = { name: string; path: string };

export function suggestFolders(path: string): Promise<FolderSuggestion[]> {
  return invoke("dev_suggest_folders", { path });
}

export function createProject(name: string): Promise<string> {
  return invoke("dev_create_project", { name });
}

export function deleteProject(path: string): Promise<void> {
  return invoke("dev_delete_project", { path });
}

export function cloneRepo(url: string, name?: string): Promise<string> {
  return invoke("dev_clone_repo", { url, name: name ?? null });
}

export function keyStatus(): Promise<KeyStatus> {
  return invoke("dev_key_status");
}

export function setKey(key: string): Promise<KeyStatus> {
  return invoke("dev_set_key", { key });
}

export function clearKey(): Promise<KeyStatus> {
  return invoke("dev_clear_key");
}

export function listDir(workspace: string, path = ""): Promise<Entry[]> {
  return invoke("dev_list_dir", { workspace, path });
}

export function readFile(workspace: string, path: string): Promise<string> {
  return invoke("dev_read_file", { workspace, path });
}

export function readUserMcp(path: string): Promise<string> {
  return invoke("dev_read_user_mcp", { path });
}

export function writeUserMcp(path: string, contents: string): Promise<void> {
  return invoke("dev_write_user_mcp", { path, contents });
}

export function openUserMcp(path: string): Promise<void> {
  return invoke("dev_open_user_mcp", { path });
}

export function mcpAuthNames(): Promise<string[]> {
  return invoke("dev_mcp_auth_names");
}

export function mcpClearAuth(name: string): Promise<void> {
  return invoke("dev_mcp_clear_auth", { name });
}

export type SkillFile = {
  path: string;
  read_path: string;
  home: boolean;
  origin: string;
};

export function listSkillFiles(workspace?: string | null): Promise<SkillFile[]> {
  return invoke("dev_list_skill_files", { workspace: workspace || null });
}

export function readUserSkill(path: string): Promise<string> {
  return invoke("dev_read_user_skill", { path });
}

export function openUserSkill(path: string): Promise<void> {
  return invoke("dev_open_user_skill", { path });
}

export function resolveFile(workspace: string, path: string): Promise<string> {
  return invoke("dev_resolve_file", { workspace, path });
}

export function existingFiles(workspace: string, paths: string[]): Promise<string[]> {
  return invoke("dev_existing_files", { workspace, paths });
}

export type FilePreview = {
  path: string;
  name: string;
  size: number;
  binary: boolean;
  lines?: number | null;
  preview?: string | null;
  modified?: number | null;
};

export function filePreview(workspace: string, path: string): Promise<FilePreview> {
  return invoke("dev_file_preview", { workspace, path });
}

export function writeFile(workspace: string, path: string, contents: string): Promise<void> {
  return invoke("dev_write_file", { workspace, path, contents });
}

export function editFile(
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

export function gitStatus(workspace: string): Promise<GitChange[]> {
  return invoke("dev_git_status", { workspace });
}

export function gitDiff(workspace: string, path = ""): Promise<string> {
  return invoke("dev_git_diff", { workspace, path });
}

export function gitBranches(workspace: string): Promise<GitBranches> {
  return invoke("dev_git_branches", { workspace });
}

export function gitSwitch(workspace: string, name: string): Promise<GitBranches> {
  return invoke("dev_git_switch", { workspace, name });
}

export function runCommand(workspace: string, command: string): Promise<string> {
  return invoke("dev_run_command", { workspace, command });
}

export function listConversations(workspace: string): Promise<ConversationSummary[]> {
  return invoke("dev_list_conversations", { workspace });
}

export function getConversation(workspace: string, id: string): Promise<Conversation> {
  return invoke("dev_get_conversation", { workspace, id });
}

export function saveConversation(workspace: string, conversation: Conversation): Promise<Conversation> {
  return invoke("dev_save_conversation", { workspace, conversation });
}

export function reorderConversations(
  workspace: string,
  ids: string[],
): Promise<ConversationSummary[]> {
  return invoke("dev_reorder_conversations", { workspace, ids });
}

export function deleteConversation(workspace: string, id: string): Promise<void> {
  return invoke("dev_delete_conversation", { workspace, id });
}

export function listJourneys(workspace: string): Promise<Journey[]> {
  return invoke("dev_list_journeys", { workspace });
}

export function createJourney(workspace: string, conversationId: string): Promise<Journey> {
  return invoke("dev_create_journey", {
    workspace,
    conversationId,
    conversation_id: conversationId,
  });
}

export function renameJourney(workspace: string, id: string, title: string): Promise<Journey> {
  return invoke("dev_rename_journey", { workspace, id, title });
}

export function deleteJourney(workspace: string, id: string, deleteChats: boolean): Promise<void> {
  return invoke("dev_delete_journey", {
    workspace,
    id,
    deleteChats,
    delete_chats: deleteChats,
  });
}

export function setJourneyCollapsed(workspace: string, id: string, collapsed: boolean): Promise<void> {
  return invoke("dev_set_journey_collapsed", { workspace, id, collapsed });
}

export function setJourneyColor(workspace: string, id: string, color: string): Promise<Journey> {
  return invoke("dev_set_journey_color", { workspace, id, color });
}

export function moveConversation(
  workspace: string,
  id: string,
  journeyId: string | null,
): Promise<Conversation> {
  return invoke("dev_move_conversation", {
    workspace,
    id,
    journeyId,
    journey_id: journeyId,
  });
}

export function reorderSidebar(workspace: string, items: SidebarItem[]): Promise<ConversationSummary[]> {
  return invoke("dev_reorder_sidebar", { workspace, items });
}

export function getJourneyKnowledge(workspace: string, journeyId: string): Promise<string> {
  return invoke("dev_get_journey_knowledge", {
    workspace,
    journeyId,
    journey_id: journeyId,
  });
}

export function saveJourneyKnowledge(workspace: string, journeyId: string, contents: string): Promise<void> {
  return invoke("dev_save_journey_knowledge", {
    workspace,
    journeyId,
    journey_id: journeyId,
    contents,
  });
}

export function updateJourneyKnowledge(
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

export type PreparedImage = {
  id: string;
  path: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  resized: boolean;
};

export function prepareImage(
  bytesBase64: string,
  name: string,
  conversationId?: string,
): Promise<PreparedImage> {
  return invoke("dev_prepare_image", {
    bytesBase64,
    bytes_base64: bytesBase64,
    name,
    conversationId: conversationId ?? null,
    conversation_id: conversationId ?? null,
  });
}

export function prepareImagePath(
  path: string,
  conversationId?: string,
): Promise<PreparedImage> {
  return invoke("dev_prepare_image_path", {
    path,
    conversationId: conversationId ?? null,
    conversation_id: conversationId ?? null,
  });
}

export function imageDataUrl(path: string): Promise<string> {
  return invoke("dev_image_data_url", { path });
}

export function chatStart(
  streamId: string,
  messages: unknown[],
  model?: string,
  effort?: string,
  journeyId?: string,
  contextWindow?: number,
): Promise<void> {
  const tokens = contextWindow && contextWindow > 0 ? Math.floor(contextWindow) : null;
  return invoke("dev_chat_start", {
    streamId,
    stream_id: streamId,
    messages,
    model,
    effort,
    journeyId,
    journey_id: journeyId ?? null,
    contextWindow: tokens,
    context_window: tokens,
  });
}

export function chatCancel(streamId: string): Promise<void> {
  return invoke("dev_chat_cancel", { streamId, stream_id: streamId });
}

export function usageRecord(event: ApiUsageRecord): Promise<ApiUsageEvent | null> {
  return invoke("dev_usage_record", { event });
}

export function usageList(since?: string): Promise<ApiUsageEvent[]> {
  return invoke("dev_usage_list", { since: since ?? null });
}

const chatListeners = new Map<string, (ev: ChatEvent) => void>();
let chatListen: Promise<UnlistenFn> | null = null;

function ensureChatListen(): Promise<UnlistenFn> {
  if (!chatListen) {
    chatListen = listen<ChatEvent>("dev-chat", (ev) => {
      const payload = ev.payload;
      if (!payload) return;
      for (const fn of chatListeners.values()) fn(payload);
    });
  }
  return chatListen;
}

export async function onChat(fn: (ev: ChatEvent) => void): Promise<UnlistenFn> {
  await ensureChatListen();
  const key = `tmp-${crypto.randomUUID()}`;
  const wrapped = (ev: ChatEvent) => fn(ev);
  chatListeners.set(key, wrapped);
  return () => {
    chatListeners.delete(key);
  };
}

export type PtyEvent = {
  id: string;
  kind: "data" | "exit" | string;
  data?: string | null;
};

export function ptyOpen(workspace: string, cols: number, rows: number): Promise<string> {
  return invoke("dev_pty_open", { workspace, cols, rows });
}

export type ApiGrokPlan = {
  found: boolean;
  state: string;
  awaiting_approval: boolean;
  content: string;
};

export function grokPlan(workspace: string, sessionId: string): Promise<ApiGrokPlan> {
  return invoke("dev_grok_plan", {
    workspace,
    sessionId,
    session_id: sessionId,
  });
}

export function ptyOpenGrok(
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

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("dev_pty_write", { id, data });
}

export function ptyWriteBytes(id: string, data: number[]): Promise<void> {
  return invoke("dev_pty_write_bytes", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("dev_pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("dev_pty_kill", { id });
}

export function onPty(fn: (ev: PtyEvent) => void): Promise<UnlistenFn> {
  return listen<PtyEvent>("dev-pty", (ev) => fn(ev.payload));
}
