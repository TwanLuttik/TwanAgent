import { permissionSystemLine, type PermissionMode } from "./dev-permission.ts";
import { fileBaseName } from "./file-icon.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export const TURN_FAILURE_PREFIX = "Couldn't continue: ";

export type ChatToolCall = { id: string; name: string; arguments: string };

export type ChatMessage = {
  role: ChatRole;
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  error?: boolean;
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

export function isExistingProjectName(query: string, rows: { name: string }[]): boolean {
  const name = sanitizeProjectName(query);
  if (!name) return false;
  const key = name.toLowerCase();
  return rows.some((row) => {
    const existing = sanitizeProjectName(row.name) ?? row.name.trim();
    return existing.toLowerCase() === key;
  });
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

export type ConversationActivity =
  | { kind: "thinking" }
  | { kind: "editing"; path: string }
  | { kind: "tool"; label: string };

export function activityFromToolCall(call: ChatToolCall): ConversationActivity {
  const args = parseToolArgs(call.arguments);
  if (call.name === "edit_file" || call.name === "write_file") {
    const path = String(args.path ?? "").trim();
    return { kind: "editing", path: path || "file" };
  }
  return { kind: "tool", label: toolSummary(call.name, args) };
}

export function conversationActivityLabel(activity: ConversationActivity | null | undefined): string {
  if (!activity || activity.kind === "thinking") return "Thinking…";
  if (activity.kind === "editing") return `Editing ${fileBaseName(activity.path) || activity.path}`;
  return activity.label;
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
  if (name === "update_journey_knowledge") {
    return String(args.mode ?? "") === "edit" ? "Edit journey knowledge" : "Update journey knowledge";
  }
  return name;
}

export function toolActivityLabel(call: ChatToolCall): string {
  return toolSummary(call.name, parseToolArgs(call.arguments));
}

export type ToolFileChange = {
  path: string;
  name: string;
  additions: number;
  deletions: number;
  added: string[];
  removed: string[];
};

const SNIPPET_CAP = 40;

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split("\n");
}

export function toolFileChange(call: ChatToolCall): ToolFileChange | null {
  if (call.name !== "write_file" && call.name !== "edit_file") return null;
  const args = parseToolArgs(call.arguments);
  const path = normalizeGitPath(String(args.path ?? ""));
  if (!path) return null;
  if (call.name === "write_file") {
    const added = splitLines(String(args.contents ?? ""));
    return {
      path,
      name: fileBaseName(path),
      additions: added.length,
      deletions: 0,
      added,
      removed: [],
    };
  }
  const added = splitLines(String(args.new_string ?? args.newString ?? ""));
  const removed = splitLines(String(args.old_string ?? args.oldString ?? ""));
  return {
    path,
    name: fileBaseName(path),
    additions: added.length,
    deletions: removed.length,
    added,
    removed,
  };
}

export function mergeToolFileChanges(rows: ToolFileChange[]): ToolFileChange[] {
  const byPath = new Map<string, ToolFileChange>();
  for (const change of rows) {
    const prev = byPath.get(change.path);
    if (!prev) {
      byPath.set(change.path, {
        ...change,
        added: change.added.slice(0, SNIPPET_CAP),
        removed: change.removed.slice(0, SNIPPET_CAP),
      });
      continue;
    }
    byPath.set(change.path, {
      path: change.path,
      name: change.name,
      additions: prev.additions + change.additions,
      deletions: prev.deletions + change.deletions,
      added: [...prev.added, ...change.added].slice(0, SNIPPET_CAP),
      removed: [...prev.removed, ...change.removed].slice(0, SNIPPET_CAP),
    });
  }
  return [...byPath.values()];
}

export function toolTrailFileChanges(calls: ChatToolCall[]): ToolFileChange[] {
  return mergeToolFileChanges(
    calls.flatMap((call) => {
      const change = toolFileChange(call);
      return change ? [change] : [];
    }),
  );
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

export function gitChangeTotals(
  changes: GitDecorChange[],
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    const stats = gitLineStats(change);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return { additions, deletions };
}

export function formatDiffCount(n: number): string {
  return n.toLocaleString("en-US");
}

export type GitChangeTreeFile<T extends GitDecorChange = GitDecorChange> = {
  kind: "file";
  name: string;
  change: T;
};

export type GitChangeTreeDir<T extends GitDecorChange = GitDecorChange> = {
  kind: "dir";
  name: string;
  path: string;
  children: GitChangeTreeNode<T>[];
};

export type GitChangeTreeNode<T extends GitDecorChange = GitDecorChange> =
  | GitChangeTreeFile<T>
  | GitChangeTreeDir<T>;

export function gitChangesTree<T extends GitDecorChange>(changes: T[]): GitChangeTreeNode<T>[] {
  type MutableDir = {
    kind: "dir";
    name: string;
    path: string;
    children: GitChangeTreeNode<T>[];
    dirs: Map<string, MutableDir>;
  };

  const root: MutableDir = { kind: "dir", name: "", path: "", children: [], dirs: new Map() };

  for (const change of changes) {
    const path = normalizeGitPath(change.path);
    if (!path) continue;
    const parts = path.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = {
          kind: "dir",
          name: part,
          path: dir.path ? `${dir.path}/${part}` : part,
          children: [],
          dirs: new Map(),
        };
        dir.dirs.set(part, next);
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", name: fileName, change });
  }

  const sortNodes = (nodes: GitChangeTreeNode<T>[]): GitChangeTreeNode<T>[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) {
      if (node.kind === "dir") sortNodes(node.children);
    }
    return nodes;
  };

  return sortNodes(root.children);
}

export type TranscriptItem =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string }
  | { kind: "error"; content: string }
  | { kind: "tools"; labels: string[]; files: ToolFileChange[] };

export const TOOL_TRAIL_LIVE_ROWS = 3;

export function toolTrailSummary(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 tool call" : `${count} tool calls`;
}

export function toolTrailKind(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("$ ")) return "$";
  if (trimmed.startsWith("Subagent")) return "Subagent";
  if (trimmed === "Git status") return "Git status";
  if (trimmed.endsWith(" journey knowledge")) return trimmed;
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

export function toolTrailTypeCounts(labels: string[]): { type: string; count: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const label of labels) {
    const type = toolTrailKind(label);
    if (!type) continue;
    if (!counts.has(type)) order.push(type);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return order.map((type) => ({ type, count: counts.get(type) ?? 0 }));
}

export function toolTrailTypeCountText(type: string, count: number): string {
  return `${type} ×${count}`;
}

export function isLiveToolTrail(items: TranscriptItem[], index: number, busy: boolean): boolean {
  return busy && items[index]?.kind === "tools" && index === items.length - 1;
}

export function transcriptItems(messages: ChatMessage[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "tool") continue;
    if (msg.role === "user") {
      out.push({ kind: "user", content: String(msg.content ?? "") });
      continue;
    }
    if (msg.error || String(msg.content ?? "").startsWith(TURN_FAILURE_PREFIX)) {
      out.push({ kind: "error", content: String(msg.content ?? "") });
      continue;
    }
    const text = (msg.content ?? "").trim();
    const calls = msg.tool_calls ?? [];
    const labels = calls.map(toolActivityLabel);
    const files = toolTrailFileChanges(calls);
    if (text) out.push({ kind: "assistant", content: String(msg.content ?? "") });
    if (labels.length) {
      const last = out[out.length - 1];
      if (last?.kind === "tools") {
        last.labels.push(...labels);
        last.files = mergeToolFileChanges([...last.files, ...files]);
      } else out.push({ kind: "tools", labels, files });
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
    else out.push({ kind: "tools", labels: pending, files: [] });
  }
  return out;
}

export function systemPrompt(
  workspace: string,
  permission: PermissionMode = "ask",
  knowledge?: string,
): ChatMessage {
  const knowledgeBlock = (knowledge ?? "").trim()
    ? `\nJourney knowledge:\n${knowledge!.trim()}\nDurable notes for this Journey go in update_journey_knowledge, not workspace files.`
    : "";
  return {
    role: "system",
    content: `You are Grok, a coding agent in TwanAgent. Only Grok is available — do not suggest other models.
Workspace: ${workspace}
${permissionSystemLine(permission)}
For independent research, planning, or parallel work, call spawn_subagent. Each child has its own context and reports a summary when it finishes. Use explore to investigate, plan for implementation plans, and general-purpose when the child may edit files.
Prefer edit_file for small changes. Don't commit unless asked. Be concise.${knowledgeBlock}`,
  };
}

export function withSystem(
  workspace: string,
  messages: ChatMessage[],
  system?: ChatMessage,
  permission: PermissionMode = "ask",
  knowledge?: string,
): ChatMessage[] {
  return [
    system ?? systemPrompt(workspace, permission, knowledge),
    ...messages.filter((m) => m.role !== "system"),
  ];
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
  return messages
    .filter((msg) => !msg.error && !String(msg.content ?? "").startsWith(TURN_FAILURE_PREFIX))
    .map((msg) => {
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
