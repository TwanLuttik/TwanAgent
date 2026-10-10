import { isCompactionEvent, isCompactionSummary } from "./compact.ts";
import { permissionSystemLine, remoteWorkspaceLine, type PermissionMode, type RemoteWorkspace } from "./permission.ts";
import { fileBaseName } from "./file-icon.ts";
import { mcpSystemLine, type DetectedMcpServer } from "./mcp.ts";
import { skillSystemLine, type DetectedSkill } from "./skill.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export const TURN_FAILURE_PREFIX = "Couldn't continue: ";

export type ChatToolCall = { id: string; name: string; arguments: string };

export type ChatImage = {
  id: string;
  path: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  resized: boolean;
  dataUrl?: string;
};

export type ChatMessage = {
  role: ChatRole;
  content?: string | null;
  /** Model reasoning for this assistant step. Kept in the transcript, not sent back to the API. */
  reasoning?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  error?: boolean;
  images?: ChatImage[];
  /** How long this prompt took, in milliseconds. Kept on the final assistant reply. */
  durationMs?: number;
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

export type ProjectServer = {
  machineName: string;
  host: string;
  user: string;
  port: number;
  remotePath: string;
  online: boolean;
};

export type ProjectRow = { name: string; path: string; remote?: boolean; server?: ProjectServer };

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
  const first = messages.find((m) => m.role === "user");
  const text = (first?.content ?? "").trim().replace(/\s+/g, " ");
  if (text) return text.length > 42 ? `${text.slice(0, 41)}…` : text;
  const named = first?.images?.map((img) => img.name.trim()).find(Boolean);
  if (named) return named.length > 42 ? `${named.slice(0, 41)}…` : named;
  if (first?.images?.length) return first.images.length === 1 ? "Image" : `${first.images.length} images`;
  return "New chat";
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
  liveTools: LiveToolInput[] = [],
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
  if (tool) return clipPreview(liveToolLabel(tool));
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
  if (name === "write_file") return `Write ${fileBaseName(path) || path || "file"}`;
  if (name === "edit_file") return `Edit ${fileBaseName(path) || path || "file"}`;
  if (name === "list_dir") return `List ${path || "."}`;
  if (name === "git_status") return "Git status";
  if (name === "git_diff") return path ? `Diff ${fileBaseName(path) || path}` : "Diff";
  if (name === "run_command") {
    const description = String(args.description ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^run\s+/i, "");
    if (description) return `Run ${description}`;
    const command = String(args.command ?? "").trim().replace(/\s+/g, " ");
    return command ? `Run ${command}` : "Run command";
  }
  if (name === "spawn_subagent") {
    const label = String(args.description ?? "").trim();
    return label ? `Subagent: ${label}` : "Subagent";
  }
  if (name === "update_journey_knowledge") {
    return String(args.mode ?? "") === "edit" ? "Edit journey knowledge" : "Update journey knowledge";
  }
  if (name === "todo_write") return "Updated todos";
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

/** Slim one-line detail shown when a tool row is expanded. */
export function toolDetail(call: ChatToolCall): string {
  const args = parseToolArgs(call.arguments);
  if (call.name === "run_command") {
    return String(args.command ?? "").trim().replace(/\s+/g, " ");
  }
  if (call.name === "spawn_subagent") {
    return String(args.prompt ?? "").trim().replace(/\s+/g, " ");
  }
  if (call.name === "git_diff") {
    const path = String(args.path ?? "").trim();
    return path ? `git diff ${path}` : "git diff";
  }
  if (call.name === "git_status") return "git status";
  if (call.name === "read_file" || call.name === "list_dir") {
    return String(args.path ?? "").trim();
  }
  if (call.name === "update_journey_knowledge") {
    const mode = String(args.mode ?? "").trim();
    return mode ? `journey knowledge (${mode})` : "journey knowledge";
  }
  return "";
}

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
  return gitDirtyDirs(map).has(normalizeGitPath(dirPath));
}

/** Every folder that contains a change, including the workspace root. Built once per status. */
export function gitDirtyDirs(map: Map<string, GitDecorChange>): Set<string> {
  const dirs = new Set<string>();
  if (map.size === 0) return dirs;
  dirs.add("");
  for (const path of map.keys()) {
    const normalized = normalizeGitPath(path);
    let slash = normalized.lastIndexOf("/");
    while (slash > 0) {
      const dir = normalized.slice(0, slash);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      slash = dir.lastIndexOf("/");
    }
  }
  return dirs;
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

export type LiveToolRow = { label: string; change: ToolFileChange | null; detail?: string };

export type LiveToolInput = string | LiveToolRow;

export function liveToolLabel(tool: LiveToolInput): string {
  return typeof tool === "string" ? tool : tool.label;
}

export function liveToolChange(tool: LiveToolInput): ToolFileChange | null {
  return typeof tool === "string" ? null : tool.change;
}

export function liveToolDetail(tool: LiveToolInput): string {
  return typeof tool === "string" ? "" : (tool.detail ?? "");
}

export type TranscriptItem =
  | { kind: "user"; content: string; images?: ChatImage[] }
  | { kind: "thinking"; content: string; live?: boolean }
  | { kind: "assistant"; content: string; durationMs?: number }
  | { kind: "compaction" }
  | { kind: "error"; content: string }
  | {
      kind: "tools";
      labels: string[];
      files: ToolFileChange[];
      details: (ToolFileChange | null)[];
      commands: string[];
    };

export type ToolTrailRow = { label: string; change: ToolFileChange | null; detail: string };

function trailGroup(label: string): "read" | "list" | null {
  if (label.startsWith("Read ")) return "read";
  if (label.startsWith("List ")) return "list";
  return null;
}

/** Fold a run of reads or lists into one line, matching the CLI tool list. */
export function foldToolTrailRows(
  labels: string[],
  details: (ToolFileChange | null)[] = [],
  commands: string[] = [],
): ToolTrailRow[] {
  const rows: ToolTrailRow[] = [];
  let i = 0;
  while (i < labels.length) {
    const group = trailGroup(labels[i] ?? "");
    if (group) {
      let j = i + 1;
      while (j < labels.length && trailGroup(labels[j] ?? "") === group) j += 1;
      const count = j - i;
      const paths = commands.slice(i, j).map((item) => item.trim()).filter(Boolean);
      rows.push({
        label:
          group === "read"
            ? count === 1
              ? "Read 1 file"
              : `Read ${count} files`
            : count === 1
              ? "List 1 directory"
              : `List ${count} directories`,
        change: null,
        detail: paths.join("\n"),
      });
      i = j;
      continue;
    }
    rows.push({ label: labels[i] ?? "", change: details[i] ?? null, detail: commands[i] ?? "" });
    i += 1;
  }
  return rows;
}

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

export function toolTrailTypeIcon(type: string): string {
  if (type === "$") return "terminal";
  if (type === "Subagent") return "person.2";
  if (type === "Git status" || type === "Diff") return "arrow.triangle.branch";
  if (type.includes("journey knowledge")) return "sparkles";
  if (type === "Read") return "doc";
  if (type === "Write") return "square.and.arrow.down";
  if (type === "Edit") return "pencil";
  if (type === "List") return "folder";
  return "ellipsis";
}

export function isLiveToolTrail(items: TranscriptItem[], index: number, busy: boolean): boolean {
  return busy && items[index]?.kind === "tools" && index === items.length - 1;
}

export function transcriptItems(messages: ChatMessage[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const msg of messages) {
    if (isCompactionEvent(msg)) {
      out.push({ kind: "compaction" });
      continue;
    }
    if (msg.role === "tool" || msg.role === "system") continue;
    if (msg.role === "user") {
      const item: TranscriptItem = { kind: "user", content: String(msg.content ?? "") };
      if (msg.images?.length) item.images = msg.images;
      out.push(item);
      continue;
    }
    if (msg.error || String(msg.content ?? "").startsWith(TURN_FAILURE_PREFIX)) {
      out.push({ kind: "error", content: String(msg.content ?? "") });
      continue;
    }
    const text = (msg.content ?? "").trim();
    const reasoning = String(msg.reasoning ?? "").trim();
    const calls = (msg.tool_calls ?? []).filter((call) => call.name !== "todo_write");
    const labels = calls.map(toolActivityLabel);
    const details = calls.map((call) => toolFileChange(call));
    const commands = calls.map(toolDetail);
    const files = toolTrailFileChanges(calls);
    if (reasoning) out.push({ kind: "thinking", content: reasoning });
    if (text) {
      const item: TranscriptItem = { kind: "assistant", content: String(msg.content ?? "") };
      if (!calls.length && typeof msg.durationMs === "number" && msg.durationMs >= 0) {
        item.durationMs = msg.durationMs;
      }
      out.push(item);
    }
    if (labels.length) {
      const last = out[out.length - 1];
      if (last?.kind === "tools") {
        last.labels.push(...labels);
        last.details.push(...details);
        last.commands.push(...commands);
        last.files = mergeToolFileChanges([...last.files, ...files]);
      } else out.push({ kind: "tools", labels, files, details, commands });
    }
  }
  return out;
}

export type TranscriptUserItem = Extract<TranscriptItem, { kind: "user" }>;
export type TranscriptFollowItem = Exclude<TranscriptItem, { kind: "user" }>;

export type TranscriptTurn = {
  user?: TranscriptUserItem;
  rest: TranscriptFollowItem[];
};

export function groupTranscriptTurns(items: TranscriptItem[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn = { rest: [] };
  for (const item of items) {
    if (item.kind === "user") {
      if (current.user || current.rest.length) turns.push(current);
      current = { user: item, rest: [] };
      continue;
    }
    current.rest.push(item);
  }
  if (current.user || current.rest.length) turns.push(current);
  return turns;
}

function thinkingAlreadyShown(items: TranscriptItem[], text: string): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.kind === "user") return false;
    if (item.kind === "thinking") return item.content === text;
  }
  return false;
}

/**
 * Split a transcript so finished turns stay referentially stable while a reply streams.
 * `settled` is every turn before the one that is still growing. `tail` is that open turn,
 * including the live stream, so a token does not rebuild the earlier bubbles.
 */
export function splitLiveTranscript(
  messages: ChatMessage[],
  streamText: string,
  liveTools: LiveToolInput[] = [],
  streamReasoning = "",
): { settled: TranscriptTurn[]; tail: TranscriptItem[] } {
  const committed = transcriptItems(messages);
  const turns = groupTranscriptTurns(committed);
  const live = liveTranscriptItems(messages, streamText, liveTools, streamReasoning);
  if (turns.length === 0) return { settled: [], tail: live };
  const open = turns[turns.length - 1];
  const openCount = (open?.user ? 1 : 0) + (open?.rest.length ?? 0);
  const settledCount = committed.length - openCount;
  return {
    settled: turns.slice(0, -1),
    tail: live.slice(settledCount),
  };
}

export function liveTranscriptItems(
  messages: ChatMessage[],
  streamText: string,
  liveTools: LiveToolInput[] = [],
  streamReasoning = "",
): TranscriptItem[] {
  const out = transcriptItems(messages);
  const seen = new Set(out.flatMap((item) => (item.kind === "tools" ? item.labels : [])));
  const pending = liveTools.filter((tool) => !seen.has(liveToolLabel(tool)));
  if (streamReasoning && !thinkingAlreadyShown(out, streamReasoning)) {
    out.push({ kind: "thinking", content: streamReasoning, live: true });
  }
  const last = out[out.length - 1];
  if (streamText && !(last?.kind === "assistant" && last.content === streamText)) {
    out.push({ kind: "assistant", content: streamText });
  }
  if (pending.length) {
    const labels = pending.map(liveToolLabel);
    const details = pending.map(liveToolChange);
    const commands = pending.map(liveToolDetail);
    const files = mergeToolFileChanges(details.flatMap((change) => (change ? [change] : [])));
    const tail = out[out.length - 1];
    if (tail?.kind === "tools") {
      tail.labels.push(...labels);
      tail.details.push(...details);
      tail.commands.push(...commands);
      tail.files = mergeToolFileChanges([...tail.files, ...files]);
    } else out.push({ kind: "tools", labels, files, details, commands });
  }
  return out;
}

export function systemPrompt(
  workspace: string,
  permission: PermissionMode = "ask",
  knowledge?: string,
  mcpServers?: DetectedMcpServer[],
  skills?: DetectedSkill[],
  remote?: RemoteWorkspace | null,
): ChatMessage {
  const knowledgeBlock = (knowledge ?? "").trim()
    ? `\nJourney knowledge:\n${knowledge!.trim()}\nDurable notes for this Journey go in update_journey_knowledge, not workspace files.`
    : "";
  const extra = extraSystemLines(mcpServers, skills);
  const remoteLine = remoteWorkspaceLine(remote);
  const place = remoteLine ? `\n${remoteLine}` : "";
  return {
    role: "system",
    content: `You are Grok, a coding agent in TwanAgent. Only Grok is available — do not suggest other models.
Workspace: ${workspace}${place}
${permissionSystemLine(permission)}
For independent research, planning, or parallel work, call spawn_subagent. Each child has its own context and reports a summary when it finishes. Use explore to investigate, plan for implementation plans, and general-purpose when the child may edit files.
For multi-step work, call todo_write to keep a short step list above the input. Update it as you go, including mid-turn. Keep at most one item in_progress.
Prefer edit_file for small changes. Don't commit unless asked. Be concise.${knowledgeBlock}${extra}`,
  };
}

export function withSystem(
  workspace: string,
  messages: ChatMessage[],
  system?: ChatMessage,
  permission: PermissionMode = "ask",
  knowledge?: string,
  mcpServers?: DetectedMcpServer[],
  skills?: DetectedSkill[],
  remote?: RemoteWorkspace | null,
): ChatMessage[] {
  const base = system ?? systemPrompt(workspace, permission, knowledge, mcpServers, skills, remote);
  const extra = system ? extraSystemLines(mcpServers, skills) : "";
  const content =
    extra && !String(base.content ?? "").includes(extra.trim())
      ? `${base.content ?? ""}${extra}`
      : base.content;
  return [{ ...base, content }, ...messages.filter((m) => m.role !== "system" || isCompactionSummary(m))];
}

function extraSystemLines(mcpServers?: DetectedMcpServer[], skills?: DetectedSkill[]): string {
  const blocks = [mcpSystemLine(mcpServers ?? []), skillSystemLine(skills ?? [])].filter(Boolean);
  return blocks.length ? `\n${blocks.join("\n")}` : "";
}

export type ApiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ApiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ApiChatMessage = {
  role: ChatRole;
  content?: string | null | ApiContentPart[];
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
    .filter((msg) => !isCompactionEvent(msg) && !msg.error && !String(msg.content ?? "").startsWith(TURN_FAILURE_PREFIX))
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
    if (isCompactionSummary(msg)) {
      return { role: "user", content: String(msg.content ?? "") };
    }
    if (msg.role === "user" && msg.images?.length) {
      const parts: ApiContentPart[] = [];
      const text = (msg.content ?? "").trim();
      if (text) parts.push({ type: "text", text });
      for (const img of msg.images) {
        if (!img.dataUrl) continue;
        parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
      }
      return { role: "user", content: parts };
    }
    return {
      role: msg.role,
      content: msg.content ?? "",
    };
  });
}

export function stampTurnDuration(messages: ChatMessage[], durationMs: number): ChatMessage[] {
  if (!Number.isFinite(durationMs) || durationMs < 0) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role === "user") return messages;
    if (msg.role !== "assistant" || msg.error) continue;
    if (!(msg.content ?? "").trim() || msg.tool_calls?.length) continue;
    if (msg.durationMs === durationMs) return messages;
    const next = messages.slice();
    next[i] = { ...msg, durationMs };
    return next;
  }
  return messages;
}

export function newConversationId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
