import { permissionSystemLine, type PermissionMode } from "./dev-permission.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatToolCall = { id: string; name: string; arguments: string };

export type ChatMessage = {
  role: ChatRole;
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
};

export const HEAVY_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".git",
  "__pycache__",
  ".next",
  ".turbo",
]);

export function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "Folder";
}

export type ProjectRow = { name: string; path: string };

export function projectKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function mergeProjectRows(fromDisk: ProjectRow[], recents: string[]): ProjectRow[] {
  const out: ProjectRow[] = [];
  const seen = new Set<string>();
  for (const path of recents) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const key = projectKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: folderName(trimmed), path: trimmed.replace(/[/\\]+$/, "") || trimmed });
  }
  for (const row of fromDisk) {
    const key = projectKey(row.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function filterProjectRows(rows: ProjectRow[], query: string): ProjectRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (row) => row.name.toLowerCase().includes(q) || row.path.toLowerCase().includes(q),
  );
}

export type FolderActionId = "open" | "create" | "clone";

export type FolderAction = {
  id: FolderActionId;
  label: string;
  hint: string;
  icon: string;
};

export const FOLDER_ACTIONS: FolderAction[] = [
  { id: "open", label: "Open folder", hint: "Type a folder location", icon: "folder.fill" },
  {
    id: "create",
    label: "New project",
    hint: "Create a folder in the app directory",
    icon: "plus",
  },
  { id: "clone", label: "Clone from Git", hint: "Clone a repository", icon: "square.and.arrow.down" },
];

export function looksLikePath(query: string): boolean {
  const s = query.trim();
  if (!s) return false;
  return s.startsWith("/") || s.startsWith("~") || s.startsWith(".") || /^[A-Za-z]:[\\/]/.test(s);
}

export function looksLikeGitUrl(query: string): boolean {
  const s = query.trim();
  if (!s) return false;
  if (/[\0\s]/.test(s)) return false;
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i.test(s);
}

export function sanitizeProjectName(raw: string): string | null {
  const s = raw.trim();
  if (!s || s === "." || s === "..") return null;
  if (/[/\\]/.test(s)) return null;
  const cleaned = s
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 80);
}

export function repoNameFromUrl(url: string): string | null {
  const s = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  const part = s.split(/[:/]/).filter(Boolean).pop();
  return part ? sanitizeProjectName(part) : null;
}

export function preferredFolderAction(query: string): FolderActionId {
  if (looksLikeGitUrl(query)) return "clone";
  if (looksLikePath(query)) return "open";
  if (sanitizeProjectName(query)) return "create";
  return "open";
}

export function folderActionEnabled(id: FolderActionId, query: string): boolean {
  if (id === "open") return true;
  if (id === "create") return sanitizeProjectName(query) !== null;
  return looksLikeGitUrl(query);
}

export function folderActionHint(id: FolderActionId, query: string): string {
  if (id === "open") {
    const path = query.trim();
    return path && looksLikePath(path) ? path : "Type a folder location";
  }
  if (id === "create") {
    const name = sanitizeProjectName(query);
    return name ? `Create ${name} in the app directory` : "Create a folder in the app directory";
  }
  const url = query.trim();
  if (!looksLikeGitUrl(url)) return "Paste a git URL to clone";
  const name = repoNameFromUrl(url);
  return name ? `Clone into the app directory as ${name}` : "Paste a git URL to clone";
}

export function pathWithSlash(path: string): string {
  if (!path) return path;
  return /[/\\]$/.test(path) ? path : `${path}/`;
}

export function conversationTitleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && typeof m.content === "string");
  const text = (first?.content ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "New chat";
  return text.length > 42 ? `${text.slice(0, 41)}…` : text;
}

export function moveById<T extends { id: string }>(rows: T[], fromId: string, toId: string): T[] {
  if (fromId === toId) return rows;
  const from = rows.findIndex((row) => row.id === fromId);
  const to = rows.findIndex((row) => row.id === toId);
  if (from < 0 || to < 0) return rows;
  const next = rows.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function clipPreview(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function latestAssistantPreview(
  messages: ChatMessage[],
  streamText = "",
  liveTools: string[] = [],
): string {
  const stream = clipPreview(streamText);
  if (stream) return stream;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = clipPreview(String(msg.content ?? ""));
    if (text) return text;
  }
  const tool = liveTools[liveTools.length - 1];
  if (tool) return clipPreview(tool);
  return "Working…";
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function needsShellConfirm(name: string): boolean {
  return name === "run_command";
}

export function toolSummary(name: string, args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (name === "read_file") return `Read ${path}`;
  if (name === "write_file") return `Write ${path}`;
  if (name === "edit_file") return `Edit ${path}`;
  if (name === "list_dir") return `List ${path || "."}`;
  if (name === "git_status") return "Git status";
  if (name === "git_diff") return `Diff ${path || "."}`;
  if (name === "run_command") return `$ ${String(args.command ?? "")}`;
  if (name === "spawn_subagent") {
    const label = String(args.description ?? "").trim();
    return label ? `Subagent: ${label}` : "Subagent";
  }
  return name;
}

export function toolActivityLabel(call: ChatToolCall): string {
  return toolSummary(call.name, parseToolArgs(call.arguments));
}

export type GitDecorChange = {
  path: string;
  status: string;
  staged: boolean;
  additions?: number;
  deletions?: number;
};

export function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function gitChangeMap(changes: GitDecorChange[]): Map<string, GitDecorChange> {
  const map = new Map<string, GitDecorChange>();
  for (const change of changes) {
    map.set(normalizeGitPath(change.path), change);
  }
  return map;
}

export function gitChangeForPath(
  map: Map<string, GitDecorChange>,
  path: string,
): GitDecorChange | undefined {
  return map.get(normalizeGitPath(path));
}

export function gitFolderHasChanges(map: Map<string, GitDecorChange>, dirPath: string): boolean {
  const prefix = normalizeGitPath(dirPath);
  if (!prefix) return map.size > 0;
  const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
  for (const path of map.keys()) {
    if (path === prefix || path.startsWith(withSlash)) return true;
  }
  return false;
}

export function gitLineStats(change: GitDecorChange | undefined): { additions: number; deletions: number } {
  return {
    additions: Math.max(0, change?.additions ?? 0),
    deletions: Math.max(0, change?.deletions ?? 0),
  };
}

export type TranscriptItem =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string }
  | { kind: "tools"; labels: string[] };

export function transcriptItems(messages: ChatMessage[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "tool") continue;
    if (msg.role === "user") {
      out.push({ kind: "user", content: String(msg.content ?? "") });
      continue;
    }
    const text = (msg.content ?? "").trim();
    const labels = (msg.tool_calls ?? []).map(toolActivityLabel);
    if (text) out.push({ kind: "assistant", content: String(msg.content ?? "") });
    if (labels.length) {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.labels.push(...labels);
      else out.push({ kind: "tools", labels });
    }
  }
  return out;
}

export function liveTranscriptItems(
  messages: ChatMessage[],
  streamText: string,
  liveTools: string[] = [],
): TranscriptItem[] {
  const out = transcriptItems(messages);
  const seen = new Set(out.flatMap((item) => (item.kind === "tools" ? item.labels : [])));
  const pending = liveTools.filter((label) => !seen.has(label));
  const last = out[out.length - 1];
  if (streamText && !(last?.kind === "assistant" && last.content === streamText)) {
    out.push({ kind: "assistant", content: streamText });
  }
  if (pending.length) {
    const last = out[out.length - 1];
    if (last?.kind === "tools") last.labels.push(...pending);
    else out.push({ kind: "tools", labels: pending });
  }
  return out;
}

export function systemPrompt(workspace: string, permission: PermissionMode = "ask"): ChatMessage {
  return {
    role: "system",
    content: `You are Grok, a coding agent in TwanAgent. Only Grok is available — do not suggest other models.
Workspace: ${workspace}
${permissionSystemLine(permission)}
For independent research, planning, or parallel work, call spawn_subagent. Each child has its own context and reports a summary when it finishes. Use explore to investigate, plan for implementation plans, and general-purpose when the child may edit files.
Prefer edit_file for small changes. Don't commit unless asked. Be concise.`,
  };
}

export function withSystem(
  workspace: string,
  messages: ChatMessage[],
  system?: ChatMessage,
  permission: PermissionMode = "ask",
): ChatMessage[] {
  return [system ?? systemPrompt(workspace, permission), ...messages.filter((m) => m.role !== "system")];
}

export type ApiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ApiChatMessage = {
  role: ChatRole;
  content?: string | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
};

export function toApiToolCall(call: ChatToolCall): ApiToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.arguments || "{}",
    },
  };
}

export function toApiMessages(messages: ChatMessage[]): ApiChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.tool_call_id ?? "",
        content: msg.content ?? "",
      };
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      return {
        role: "assistant",
        content: msg.content?.trim() ? msg.content : null,
        tool_calls: msg.tool_calls.map(toApiToolCall),
      };
    }
    return {
      role: msg.role,
      content: msg.content ?? "",
    };
  });
}

export function newConversationId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
