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

const IMAGE_FILTERS = [
  { name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "jfif"] },
];

export async function pickImage(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: IMAGE_FILTERS,
  });
  return typeof selected === "string" ? selected : null;
}

export type KeyStatus = { saved: boolean; env: boolean };
export type Effort = { id: string; label: string; detail?: string };
export type ModelProvider = "xai" | "anthropic" | "minimax" | string;

export type Model = {
  id: string;
  name: string;
  efforts: Effort[];
  context_window?: number | null;
  context_windows?: number[] | null;
  provider?: ModelProvider;
  /** Claude capability ids: vision, thinking, pdf, effort. */
  capabilities?: string[] | null;
};
export type ProviderStatus = {
  id: string;
  ready: boolean;
  hint: string;
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
  providers?: ProviderStatus[];
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

export type ClaudeCliInfo = {
  installed: boolean;
  path: string;
  version: string | null;
  logged_in: boolean;
  email: string | null;
};

export function claudeCliInfo(): Promise<ClaudeCliInfo> {
  return invoke("dev_claude_cli_info");
}

export type MinimaxCliInfo = {
  installed: boolean;
  path: string;
  version: string | null;
  logged_in: boolean;
  email: string | null;
};

export function minimaxCliInfo(): Promise<MinimaxCliInfo> {
  return invoke("dev_minimax_cli_info");
}

export type ApiAccountUsageWindow = {
  id: string;
  label: string;
  used_percent: number;
  resets_at?: string | null;
};

export type ApiAccountUsage = {
  provider: string;
  connected: boolean;
  label: string;
  windows: ApiAccountUsageWindow[];
};

/** Allowance on the signed-in Claude account. Disconnected when Claude is not logged in. */
export function accountUsage(): Promise<ApiAccountUsage> {
  return invoke("dev_account_usage");
}

/** The last Claude allowance saved in the app database. Null until one has loaded. */
export function accountUsageCached(): Promise<ApiAccountUsage | null> {
  return invoke("dev_account_usage_cached");
}

/** Token-plan quota, or a pay-as-you-go balance, for the signed-in MiniMax account. */
export function minimaxAccountUsage(): Promise<ApiAccountUsage> {
  return invoke("dev_minimax_account_usage");
}

/** The last MiniMax allowance saved in the app database. Null until one has loaded. */
export function minimaxAccountUsageCached(): Promise<ApiAccountUsage | null> {
  return invoke("dev_minimax_account_usage_cached");
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

export function usageDbOpen(): Promise<void> {
  return invoke("dev_usage_db_open");
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
  original?: string | null;
  status: string;
  staged: boolean;
  unstaged?: boolean;
  additions: number;
  deletions: number;
};
export type GitBranches = { current: string | null; branches: string[]; repo?: boolean };
export type GitRepoSummary = {
  repo: boolean;
  current: string | null;
  detached: boolean;
  commit: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
};
export type GitCommit = {
  hash: string;
  short: string;
  author: string;
  at: string;
  subject: string;
};
export type GitIdentity = { name: string; email: string; configured: boolean };
export type ConversationSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  kind?: string;
  journey_id?: string | null;
  sort_order?: number;
  effort?: string | null;
  model?: string | null;
  context_window?: number | null;
  permission?: string | null;
  archived?: boolean;
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
export type ApiThinkingBlock = {
  type: "thinking" | "redacted_thinking" | string;
  thinking?: string;
  signature?: string;
  data?: string;
};
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
  duration_ms?: number | null;
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
  duration_ms?: number | null;
};
export type ChatEvent = {
  stream_id: string;
  kind: "delta" | "done" | "error" | string;
  text?: string | null;
  tool_calls?: ToolCall[] | null;
  usage?: ApiChatUsage | null;
  thinking?: ApiThinkingBlock[] | null;
};

export type WebSearchEvent = {
  stream_id: string;
  kind: "site" | "scope" | string;
  host?: string | null;
  text?: string | null;
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

export function addProject(path: string): Promise<FolderSuggestion> {
  return invoke("dev_app_add_project", { path });
}

export function removeProject(path: string): Promise<boolean> {
  return invoke("dev_app_remove_project", { path });
}

export function reorderProjects(paths: string[]): Promise<FolderSuggestion[]> {
  return invoke("dev_app_reorder_projects", { paths });
}

export function getAppSetting(key: string): Promise<string | null> {
  return invoke("dev_app_get_setting", { key });
}

export function setAppSetting(key: string, value: string): Promise<void> {
  return invoke("dev_app_set_setting", { key, value });
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

export function anthropicKeyStatus(): Promise<KeyStatus> {
  return invoke("dev_anthropic_key_status");
}

export function setAnthropicKey(key: string): Promise<KeyStatus> {
  return invoke("dev_set_anthropic_key", { key });
}

export function clearAnthropicKey(): Promise<KeyStatus> {
  return invoke("dev_clear_anthropic_key");
}

export function minimaxKeyStatus(): Promise<KeyStatus> {
  return invoke("dev_minimax_key_status");
}

export function setMinimaxKey(key: string): Promise<KeyStatus> {
  return invoke("dev_set_minimax_key", { key });
}

export function clearMinimaxKey(): Promise<KeyStatus> {
  return invoke("dev_clear_minimax_key");
}

export function listDir(workspace: string, path = ""): Promise<Entry[]> {
  return invoke("dev_list_dir", { workspace, path });
}

export type TreeSnapshot = { signature: string; dirs: string[]; files?: string[] };

/** File and folder paths, hashed. Unchanged when only file contents change. Works for remote projects. */
export function treeSignature(workspace: string): Promise<TreeSnapshot> {
  return invoke("dev_tree_signature", { workspace });
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

export function mcpSignIn(name: string): Promise<void> {
  return invoke("dev_mcp_sign_in", { name });
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

export function renamePath(workspace: string, path: string, name: string): Promise<string> {
  return invoke("dev_rename_path", { workspace, path, name });
}

export function movePaths(workspace: string, paths: string[], dest: string): Promise<string[]> {
  return invoke("dev_move_paths", { workspace, paths, dest });
}

export function deletePaths(workspace: string, paths: string[]): Promise<void> {
  return invoke("dev_delete_paths", { workspace, paths });
}

export function createDir(workspace: string, parent: string, name: string): Promise<string> {
  return invoke("dev_create_dir", { workspace, parent, name });
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

export function gitStatus(workspace: string, stats = true): Promise<GitChange[]> {
  return invoke("dev_git_status", { workspace, stats });
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

export function gitSummary(workspace: string): Promise<GitRepoSummary> {
  return invoke("dev_git_summary", { workspace });
}

/** Branch label for a folder that is not the open workspace. Does not register it. */
export function gitProjectSummary(path: string): Promise<GitRepoSummary> {
  return invoke("dev_git_project_summary", { path });
}

export function gitCreateBranch(workspace: string, name: string, checkout = true): Promise<GitBranches> {
  return invoke("dev_git_create_branch", { workspace, name, checkout });
}

export function gitStage(workspace: string, paths: string[]): Promise<GitChange[]> {
  return invoke("dev_git_stage", { workspace, paths });
}

export function gitUnstage(workspace: string, paths: string[]): Promise<GitChange[]> {
  return invoke("dev_git_unstage", { workspace, paths });
}

export function gitDiscard(workspace: string, paths: string[]): Promise<GitChange[]> {
  return invoke("dev_git_discard", { workspace, paths });
}

export function gitCommit(workspace: string, message: string): Promise<string> {
  return invoke("dev_git_commit", { workspace, message });
}

export function gitIdentity(workspace: string): Promise<GitIdentity> {
  return invoke("dev_git_identity", { workspace });
}

export function gitSetIdentity(workspace: string, name: string, email: string): Promise<GitIdentity> {
  return invoke("dev_git_set_identity", { workspace, name, email });
}

export function gitSync(workspace: string, action: "fetch" | "pull" | "push" | "publish"): Promise<string> {
  return invoke("dev_git_sync", { workspace, action });
}

export function gitStash(workspace: string, action: "push" | "pop" | "list", message = ""): Promise<string> {
  return invoke("dev_git_stash", { workspace, action, message });
}

export function gitLog(workspace: string, limit = 40): Promise<GitCommit[]> {
  return invoke("dev_git_log", { workspace, limit });
}

export function gitShow(workspace: string, hash: string): Promise<string> {
  return invoke("dev_git_show", { workspace, hash });
}

export function gitFileAt(workspace: string, path: string, revision = "HEAD"): Promise<string> {
  return invoke("dev_git_file_at", { workspace, path, revision });
}

export function runCommand(workspace: string, command: string): Promise<string> {
  return invoke("dev_run_command", { workspace, command });
}

export function openUrl(url: string): Promise<void> {
  return invoke("dev_open_url", { url });
}

export function revealFolder(path: string): Promise<void> {
  return invoke("dev_reveal_folder", { path });
}

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

export function workspaceRemote(workspace: string): Promise<WorkspaceRemote | null> {
  return invoke("dev_workspace_remote", { workspace });
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

export function archiveConversation(workspace: string, id: string, archived: boolean): Promise<void> {
  return invoke("dev_archive_conversation", { workspace, id, archived });
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

export function setSpaceCornerImage(path: string): Promise<PreparedImage> {
  return invoke("dev_set_space_corner_image", { path });
}

export function spaceCornerImage(): Promise<PreparedImage | null> {
  return invoke("dev_space_corner_image");
}

export function clearSpaceCornerImage(): Promise<void> {
  return invoke("dev_clear_space_corner_image");
}

export type SpeechModelStatus = "missing" | "partial" | "ready";

export type SpeechModelInfo = {
  id: string;
  label: string;
  file: string;
  bytes: number;
  english: boolean;
  status: SpeechModelStatus;
};

export type SpeechDownloadEvent = {
  id: string;
  received: number;
  total: number;
  done: boolean;
};

export type MicrophoneInfo = {
  ready: boolean;
  exe: string;
  reason: string;
};

export function microphoneInfo(): Promise<MicrophoneInfo> {
  return invoke("dev_microphone_info");
}

export function microphoneReady(): Promise<boolean> {
  return invoke("dev_microphone_ready");
}

export function speechModels(): Promise<SpeechModelInfo[]> {
  return invoke("dev_speech_models");
}

export function speechDownload(id: string): Promise<SpeechModelInfo> {
  return invoke("dev_speech_download", { id });
}

export function onSpeechDownload(fn: (event: SpeechDownloadEvent) => void): Promise<UnlistenFn> {
  return listen<SpeechDownloadEvent>("speech-download", (ev) => fn(ev.payload));
}

export function transcribe(bytesBase64: string, filename: string): Promise<string> {
  return invoke("dev_transcribe", {
    bytesBase64,
    bytes_base64: bytesBase64,
    filename,
  });
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

export function webSearch(streamId: string, argumentsJson: string): Promise<string> {
  return invoke("dev_web_search", {
    streamId,
    stream_id: streamId,
    arguments: argumentsJson,
  });
}

export function onWebSearch(fn: (ev: WebSearchEvent) => void): Promise<UnlistenFn> {
  return listen<WebSearchEvent>("dev-web-search", (ev) => fn(ev.payload));
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

export function grokPlanSet(
  workspace: string,
  sessionId: string,
  state: string,
  awaitingApproval: boolean,
): Promise<ApiGrokPlan> {
  return invoke("dev_grok_plan_set", {
    workspace,
    sessionId,
    session_id: sessionId,
    state,
    awaitingApproval,
    awaiting_approval: awaitingApproval,
  });
}

export function grokPlanWrite(workspace: string, sessionId: string, contents: string): Promise<void> {
  return invoke("dev_grok_plan_write", {
    workspace,
    sessionId,
    session_id: sessionId,
    contents,
  });
}

export function grokPlanEdit(
  workspace: string,
  sessionId: string,
  oldString: string,
  newString: string,
): Promise<void> {
  return invoke("dev_grok_plan_edit", {
    workspace,
    sessionId,
    session_id: sessionId,
    oldString,
    newString,
    old_string: oldString,
    new_string: newString,
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
