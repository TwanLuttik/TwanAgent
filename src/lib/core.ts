import { isCompactionEvent, isCompactionSummary } from "./compact.ts";
import { isFileAttachment, stripImageTokens } from "./image.ts";
import { permissionSystemLine, remoteWorkspaceLine, type PermissionMode, type RemoteWorkspace } from "./permission.ts";
import { fileBaseName } from "./file-icon.ts";
import { mcpSystemLine, type DetectedMcpServer } from "./mcp.ts";
import { agentIdentityLine } from "./provider.ts";
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
  /** Local preview while a dropped picture is still being copied. Not saved. */
  previewUrl?: string;
  /** Missing on pictures saved before other files could be attached. */
  kind?: "image" | "file";
  /** Size of a non-image file, in bytes. Pictures leave this unset. */
  bytes?: number;
};

/** One Anthropic thinking block, replayed unmodified on the next request. */
export type ThinkingBlock = {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
  data?: string;
};

export type ChatMessage = {
  role: ChatRole;
  content?: string | null;
  /** Display text for this assistant step. Grok does not send it back. */
  reasoning?: string;
  /** Signed Claude thinking blocks. Required, unchanged, on the next Claude request. */
  thinking?: ThinkingBlock[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  error?: boolean;
  images?: ChatImage[];
  /** How long this prompt took, in milliseconds. Kept on the final assistant reply. */
  durationMs?: number;
  /** When this reply finished, as an ISO timestamp. Kept on the final assistant reply. */
  finishedAt?: string;
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
  /** Provider ids whose keys were copied to this server. */
  providers?: string[];
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
    hint: "Create a folder on this Mac",
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

export function folderActionHint(id: FolderActionId, query: string, place = "this Mac"): string {
  if (id === "open") {
    const path = query.trim();
    return path && looksLikePath(path) ? path : "Type a folder location";
  }
  if (id === "create") {
    const name = sanitizeProjectName(query);
    return name ? `Create ${name} on ${place}` : `Create a folder on ${place}`;
  }
  const url = query.trim();
  if (!looksLikeGitUrl(url)) return "Paste a git URL to clone";
  const name = repoNameFromUrl(url);
  return name ? `Clone ${name} onto ${place}` : `Paste a git URL to clone onto ${place}`;
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

/** A 1-based line number from a tool argument. Strings and whole numbers are accepted. */
export function toolLineInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** Range shown on a read, such as `(10 - 60)` or `(10+)`. Empty for a whole-file read. */
export function readLineRangeLabel(args: Record<string, unknown>): string {
  const offset = toolLineInt(args.offset);
  const limit = toolLineInt(args.limit);
  if (offset == null && limit == null) return "";
  const start = offset ?? 1;
  if (limit != null) return `(${start} - ${start + limit - 1})`;
  return `(${start}+)`;
}

export function needsShellConfirm(name: string): boolean {
  return name === "run_command";
}

export function toolSummary(name: string, args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (name === "read_file") {
    const range = readLineRangeLabel(args);
    return range ? `Read ${path} ${range}` : `Read ${path}`;
  }
  if (name === "grep") {
    const pattern = String(args.pattern ?? args.query ?? "").trim();
    return pattern ? `Search ${pattern}` : "Search";
  }
  if (name === "glob") {
    const pattern = String(args.pattern ?? "").trim();
    return pattern ? `Find ${pattern}` : "Find files";
  }
  if (name === "write_file") return `Write ${fileBaseName(path) || path || "file"}`;
  if (name === "edit_file") return `Edit ${fileBaseName(path) || path || "file"}`;
  if (name === "list_dir") return `List ${path || "."}`;
  if (name === "git_status") return "Git status";
  if (name === "git_diff") {
    const commit = String(args.commit ?? args.hash ?? "").trim();
    if (commit) return `Commit ${commit.slice(0, 7)}`;
    return path ? `Diff ${fileBaseName(path) || path}` : "Diff";
  }
  if (name === "git_log") return "Git log";
  if (name === "git_commit") return "Commit";
  if (name === "web_search") {
    const query = String(args.query ?? args.search_term ?? "")
      .trim()
      .replace(/\s+/g, " ");
    return query ? `Web search: ${query}` : "Web search";
  }
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
  if (name === "load_skill") {
    const skill = String(args.name ?? "").trim();
    return skill ? `Skill ${skill}` : "Skill";
  }
  if (name.startsWith("mcp__")) return mcpToolLabel(name);
  if (name === "todo_write") return "Updated todos";
  if (name === "enter_plan_mode") return "Enter plan mode";
  if (name === "exit_plan_mode") return "Exit plan mode";
  return name;
}

/** `mcp__server__tool` becomes `MCP server tool`, matching the status line. */
export function mcpToolLabel(name: string): string {
  const rest = name.replace(/^mcp__/, "").split("__").join(" ").trim();
  return rest ? `MCP ${rest}` : "MCP";
}

export function toolActivityLabel(call: ChatToolCall): string {
  return toolSummary(call.name, parseToolArgs(call.arguments));
}

const WEB_SEARCH_SITE_CAP = 8;

/** Hosts the model asked to search, before any results come back. */
export function webSearchDomains(args: Record<string, unknown>): string[] {
  const raw = args.allowed_domains ?? args.allowedDomains;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const host = siteHost(String(item));
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
    if (out.length === 5) break;
  }
  return out;
}

export function siteHost(raw: string): string {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || /\s/.test(trimmed)) return "";
  const withoutScheme = trimmed.replace(/^https?:\/\//i, "");
  const host = withoutScheme.split(/[/?#]/)[0]?.replace(/\.$/, "").replace(/^www\./i, "") ?? "";
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host) || host.includes("..")) return "";
  return host.toLowerCase();
}

/** One line of websites, shown under the search while it runs and after it finishes. */
export function webSearchSitesLabel(sites: string[]): string {
  const unique: string[] = [];
  for (const site of sites) {
    const host = siteHost(site) || site.trim();
    if (!host || unique.includes(host)) continue;
    unique.push(host);
    if (unique.length === WEB_SEARCH_SITE_CAP) break;
  }
  return unique.join("\n");
}

/** Hosts from a finished search result. Keeps the order the search returned them. */
export function webSearchResultSites(content: string): string[] {
  const sites: string[] = [];
  const seen = new Set<string>();
  const urls = content.match(/https?:\/\/[^\s<>)\]]+/g) ?? [];
  for (const url of urls) {
    const host = siteHost(url.replace(/[.,;:]+$/, ""));
    if (!host || seen.has(host)) continue;
    seen.add(host);
    sites.push(host);
    if (sites.length === WEB_SEARCH_SITE_CAP) break;
  }
  return sites;
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
  if (call.name === "web_search") {
    return webSearchSitesLabel(webSearchDomains(args));
  }
  if (call.name === "spawn_subagent") {
    return String(args.prompt ?? "").trim().replace(/\s+/g, " ");
  }
  if (call.name === "git_diff") {
    const path = String(args.path ?? "").trim();
    return path ? `git diff ${path}` : "git diff";
  }
  if (call.name === "git_status") return "git status";
  if (call.name === "git_log") return "git log";
  if (call.name === "git_commit") return String(args.message ?? "").trim();
  if (call.name === "read_file") {
    const path = String(args.path ?? "").trim();
    const range = readLineRangeLabel(args);
    return range ? `${path} ${range}` : path;
  }
  if (call.name === "list_dir") {
    return String(args.path ?? "").trim();
  }
  if (call.name === "grep") {
    const pattern = String(args.pattern ?? args.query ?? "").trim();
    const where = String(args.path ?? "").trim();
    const glob = String(args.glob ?? "").trim();
    return [pattern, glob, where].filter(Boolean).join(" ");
  }
  if (call.name === "glob") {
    const pattern = String(args.pattern ?? "").trim();
    const where = String(args.path ?? "").trim();
    return [pattern, where].filter(Boolean).join(" ");
  }
  if (call.name === "load_skill") return String(args.name ?? "").trim();
  if (call.name.startsWith("mcp__")) return mcpArgsDetail(args);
  return "";
}

const MCP_ARG_CAP = 180;

/** One line per argument, so an MCP row can open onto what it was called with. */
export function mcpArgsDetail(args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const text = mcpArgText(value);
    if (!text) continue;
    lines.push(`${key}: ${text}`);
  }
  return lines.join("\n");
}

function mcpArgText(value: unknown): string {
  if (value == null || value === "") return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!raw) return "";
  const one = raw.replace(/\s+/g, " ").trim();
  return one.length > MCP_ARG_CAP ? `${one.slice(0, MCP_ARG_CAP - 1)}…` : one;
}

const SKILL_TRAIL_LINES = 80;

/** Skill file shown under the row. Long files keep the start and mark the cut. */
export function skillTrailPreview(content: string): string {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= SKILL_TRAIL_LINES) return text;
  return `${lines.slice(0, SKILL_TRAIL_LINES).join("\n")}\n…`;
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
  original?: string | null;
  status: string;
  staged: boolean;
  unstaged?: boolean;
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

export type LiveToolRow = {
  label: string;
  change: ToolFileChange | null;
  detail?: string;
  callId?: string;
};

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
  | { kind: "assistant"; content: string; durationMs?: number; finishedAt?: string }
  | { kind: "compaction" }
  | { kind: "error"; content: string }
  | {
      kind: "tools";
      labels: string[];
      files: ToolFileChange[];
      details: (ToolFileChange | null)[];
      commands: string[];
      callIds: string[];
    };

export type ToolTrailRow = {
  label: string;
  change: ToolFileChange | null;
  detail: string;
  /** Nested calls on the same file, shown under this row as a tree. */
  children?: ToolTrailRow[];
};

function trailGroup(label: string): "read" | "list" | "search" | "find" | "edit" | null {
  if (label.startsWith("Read ")) return "read";
  if (label.startsWith("List ")) return "list";
  if (label === "Search" || label.startsWith("Search ")) return "search";
  if (label === "Find files" || label.startsWith("Find ")) return "find";
  if (label.startsWith("Edit ") || label.startsWith("Write ")) return "edit";
  return null;
}

/** Path a file tool touched, so repeated calls on it can share one tree. */
function trailFileKey(group: "read" | "list" | "search" | "find" | "edit", command: string, change: ToolFileChange | null): string {
  if (group === "edit") {
    const path = change?.path || command.trim();
    return path ? normalizeGitPath(path) : "";
  }
  if (group === "read") {
    const path = command.trim().replace(/\s+\([^)]+\)$/, "");
    return path ? `${normalizeGitPath(path)}\0${command.trim()}` : "";
  }
  if (group === "list") {
    const path = command.trim();
    return path ? normalizeGitPath(path) : "";
  }
  return "";
}

function trailReadPath(command: string): string {
  return command.trim().replace(/\s+\([^)]+\)$/, "");
}

function trailFileLabel(group: "read" | "edit", path: string, count: number): string {
  const name = fileBaseName(path) || path;
  if (group === "read") return count === 1 ? `Read ${name}` : `Read ${name} ×${count}`;
  return count === 1 ? `Edit ${name}` : `Edit ${name} ×${count}`;
}

function oneTrailRow(label: string, change: ToolFileChange | null, detail: string): ToolTrailRow {
  return { label, change, detail };
}

/**
 * Fold a run of the same tool into one line.
 * Reads, writes, and edits of one file become a tree: the file is the parent and each call is a child.
 */
export function foldToolTrailRows(
  labels: string[],
  details: (ToolFileChange | null)[] = [],
  commands: string[] = [],
): ToolTrailRow[] {
  const rows: ToolTrailRow[] = [];
  let i = 0;
  while (i < labels.length) {
    const group = trailGroup(labels[i] ?? "");
    if (!group) {
      rows.push(oneTrailRow(labels[i] ?? "", details[i] ?? null, commands[i] ?? ""));
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < labels.length && trailGroup(labels[j] ?? "") === group) j += 1;
    if (group === "read" || group === "edit") {
      rows.push(...foldFileToolRun(group, labels.slice(i, j), details.slice(i, j), commands.slice(i, j)));
    } else {
      const count = j - i;
      const paths = commands.slice(i, j).map((item) => item.trim()).filter(Boolean);
      rows.push(
        oneTrailRow(
          group === "list"
            ? count === 1
              ? "List 1 directory"
              : `List ${count} directories`
            : group === "search"
              ? count === 1
                ? "Search 1 time"
                : `Search ${count} times`
              : count === 1
                ? "Find 1 pattern"
                : `Find ${count} patterns`,
          null,
          paths.join("\n"),
        ),
      );
    }
    i = j;
  }
  return rows;
}

/** Consecutive calls on one file nest under it. A single call stays one row. */
function foldFileToolRun(
  group: "read" | "edit",
  labels: string[],
  details: (ToolFileChange | null)[],
  commands: string[],
): ToolTrailRow[] {
  const rows: ToolTrailRow[] = [];
  let i = 0;
  while (i < labels.length) {
    const key = trailFileKey(group, commands[i] ?? "", details[i] ?? null);
    let j = i + 1;
    if (key) {
      while (
        j < labels.length &&
        trailFileKey(group, commands[j] ?? "", details[j] ?? null) === key
      ) {
        j += 1;
      }
    }
    const count = j - i;
    if (!key) {
      rows.push(oneTrailRow(labels[i] ?? "", null, commands[i] ?? ""));
      i += 1;
      continue;
    }
    const merged = mergeToolFileChanges(details.slice(i, j).flatMap((item) => (item ? [item] : [])))[0] ?? null;
    if (count === 1) {
      rows.push(oneTrailRow(labels[i] ?? "", merged, commands[i] ?? ""));
      i = j;
      continue;
    }
    const children = labels.slice(i, j).map((label, offset) =>
      oneTrailRow(label, details[i + offset] ?? null, commands[i + offset] ?? ""),
    );
    rows.push({
      label: trailFileLabel(group, group === "read" ? trailReadPath(commands[i] ?? "") : key, count),
      change: group === "edit" ? merged : null,
      detail: "",
      children,
    });
    i = j;
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
  if (trimmed.startsWith("$ ") || trimmed.startsWith("Run ") || trimmed === "Run") return "$";
  if (trimmed.startsWith("Subagent")) return "Subagent";
  if (trimmed === "Git status") return "Git status";
  if (trimmed.endsWith(" journey knowledge")) return trimmed;
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

/** The verb, and everything after it. A range like "(700 - 1099)" stays on the detail. */
export function toolTrailParts(label: string): { verb: string; detail: string } {
  const trimmed = label.trim();
  const verb = toolTrailKind(trimmed);
  if (!verb || verb === trimmed) return { verb: trimmed, detail: "" };
  if (verb === "$") {
    const detail = trimmed.startsWith("$ ")
      ? trimmed.slice(2)
      : trimmed.startsWith("Run ")
        ? trimmed.slice(4)
        : "";
    return { verb: "Run", detail: detail.trim() };
  }
  return { verb, detail: trimmed.slice(verb.length).trim() };
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
  if (type === "Web") return "globe";
  if (type === "Git status" || type === "Diff") return "arrow.triangle.branch";
  if (type.includes("journey knowledge")) return "sparkles";
  if (type === "Read") return "doc.text.magnifyingglass";
  if (type === "Search") return "magnifyingglass";
  if (type === "Find") return "magnifyingglass";
  if (type === "Write") return "square.and.arrow.down";
  if (type === "Edit") return "pencil";
  if (type === "List") return "folder";
  if (type === "Skill") return "book";
  if (type === "MCP") return "cable.connector";
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
    if (msg.role === "tool") {
      fillWebSearchSites(out, msg);
      fillLoadedSkill(out, msg);
      continue;
    }
    if (msg.role === "system") continue;
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
    const calls = (msg.tool_calls ?? []).filter((call) => call.name !== "todo_write" && call.name !== "enter_plan_mode" && call.name !== "exit_plan_mode");
    const labels = calls.map(toolActivityLabel);
    const details = calls.map((call) => toolFileChange(call));
    const commands = calls.map((call) => toolDetail(call));
    const callIds = calls.map((call) => call.id);
    const files = toolTrailFileChanges(calls);
    if (reasoning) out.push({ kind: "thinking", content: reasoning });
    if (text) {
      const item: TranscriptItem = { kind: "assistant", content: String(msg.content ?? "") };
      if (!calls.length) {
        if (typeof msg.durationMs === "number" && msg.durationMs >= 0) item.durationMs = msg.durationMs;
        const finishedAt = String(msg.finishedAt ?? "").trim();
        if (finishedAt) item.finishedAt = finishedAt;
      }
      out.push(item);
    }
    if (labels.length) {
      const last = out[out.length - 1];
      if (last?.kind === "tools") {
        last.labels.push(...labels);
        last.details.push(...details);
        last.commands.push(...commands);
        last.callIds.push(...callIds);
        last.files = mergeToolFileChanges([...last.files, ...files]);
      } else out.push({ kind: "tools", labels, files, details, commands, callIds });
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

/** Replace a search row's requested domains with the sites the result actually cited. */
function fillWebSearchSites(items: TranscriptItem[], toolMessage: ChatMessage): void {
  if (toolMessage.role !== "tool") return;
  const sites = webSearchResultSites(String(toolMessage.content ?? ""));
  if (!sites.length) return;
  const id = toolMessage.tool_call_id ?? "";
  if (!id) return;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.kind === "user") return;
    if (item.kind !== "tools") continue;
    const index = item.callIds.indexOf(id);
    if (index < 0 || !item.labels[index]?.startsWith("Web search")) continue;
    item.commands[index] = webSearchSitesLabel(sites);
    return;
  }
}

/** Replace a skill row's name with the instructions that were actually loaded. */
function fillLoadedSkill(items: TranscriptItem[], toolMessage: ChatMessage): void {
  if (toolMessage.role !== "tool") return;
  const id = toolMessage.tool_call_id ?? "";
  if (!id) return;
  const text = skillTrailPreview(String(toolMessage.content ?? ""));
  if (!text) return;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.kind === "user") return;
    if (item.kind !== "tools") continue;
    const index = item.callIds.indexOf(id);
    if (index < 0 || !item.labels[index]?.startsWith("Skill")) continue;
    item.commands[index] = text;
    return;
  }
}

function thinkingAlreadyShown(items: TranscriptItem[], text: string): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.kind === "user") return false;
    if (item.kind === "thinking") return item.content === text;
  }
  return false;
}

type CommittedTranscript = {
  items: TranscriptItem[];
  turns: TranscriptTurn[];
  /** Finished turns. Stable for this messages array so a stream token does not rebuild them. */
  settled: TranscriptTurn[];
  /** Tool labels already rendered anywhere in the committed transcript. */
  toolLabels: Set<string>;
};

/**
 * Settled turns are keyed by the messages array. Callers replace that array when history
 * changes, so the same reference means the committed turns have not changed.
 */
const committedByMessages = new WeakMap<ChatMessage[], CommittedTranscript>();

function committedTranscript(messages: ChatMessage[]): CommittedTranscript {
  const cached = committedByMessages.get(messages);
  if (cached) return cached;
  const items = transcriptItems(messages);
  const turns = groupTranscriptTurns(items);
  const settled = turns.slice(0, -1);
  const toolLabels = new Set(items.flatMap((item) => (item.kind === "tools" ? item.labels : [])));
  const entry = { items, turns, settled, toolLabels };
  committedByMessages.set(messages, entry);
  return entry;
}

/** Open turn items copied from the committed list, so live appends do not mutate the cache. */
function openTurnItems(committed: CommittedTranscript): TranscriptItem[] {
  const open = committed.turns[committed.turns.length - 1];
  if (!open) return [];
  const items: TranscriptItem[] = [];
  if (open.user) items.push(open.user);
  items.push(...open.rest);
  return items;
}

/**
 * Append live reasoning, text, and tools onto an already-parsed item list.
 * Does not walk messages. Copies a trailing tools item before merging so the
 * committed list stays intact. `seenTools` is every committed tool label, including
 * ones outside `out`, so a settled call is not shown again on the open turn.
 */
function appendLiveTranscript(
  out: TranscriptItem[],
  streamText: string,
  liveTools: LiveToolInput[],
  streamReasoning: string,
  seenTools: Set<string>,
): TranscriptItem[] {
  const pending = liveTools.filter((tool) => !seenTools.has(liveToolLabel(tool)));
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
    const callIds = pending.map((tool) => (typeof tool === "string" ? "" : tool.callId ?? ""));
    const files = mergeToolFileChanges(details.flatMap((change) => (change ? [change] : [])));
    const tail = out[out.length - 1];
    if (tail?.kind === "tools") {
      const merged: TranscriptItem = {
        kind: "tools",
        labels: [...tail.labels, ...labels],
        details: [...tail.details, ...details],
        commands: [...tail.commands, ...commands],
        callIds: [...tail.callIds, ...callIds],
        files: mergeToolFileChanges([...tail.files, ...files]),
      };
      out[out.length - 1] = merged;
    } else out.push({ kind: "tools", labels, files, details, commands, callIds });
  }
  return out;
}

/**
 * Split a transcript so finished turns stay referentially stable while a reply streams.
 * `settled` is every turn before the one that is still growing. `tail` is that open turn,
 * including the live stream, so a token does not rebuild the earlier bubbles.
 * Messages are parsed once; the settled array is cached on the messages array identity.
 */
export function splitLiveTranscript(
  messages: ChatMessage[],
  streamText: string,
  liveTools: LiveToolInput[] = [],
  streamReasoning = "",
): { settled: TranscriptTurn[]; tail: TranscriptItem[] } {
  const committed = committedTranscript(messages);
  return {
    settled: committed.settled,
    tail: appendLiveTranscript(
      openTurnItems(committed),
      streamText,
      liveTools,
      streamReasoning,
      committed.toolLabels,
    ),
  };
}

export function liveTranscriptItems(
  messages: ChatMessage[],
  streamText: string,
  liveTools: LiveToolInput[] = [],
  streamReasoning = "",
): TranscriptItem[] {
  const committed = committedTranscript(messages);
  return appendLiveTranscript(
    committed.items.slice(),
    streamText,
    liveTools,
    streamReasoning,
    committed.toolLabels,
  );
}

export type WorktreeCheckout = {
  name: string;
  branch: string;
  mainName: string;
};

export type WorktreeListRow = {
  path: string;
  branch?: string | null;
  detached?: boolean;
  main?: boolean;
};

/** The open folder when it is a linked checkout. The main checkout returns null. */
export function worktreeCheckoutFor(
  workspace: string,
  worktrees: WorktreeListRow[] | null | undefined,
): WorktreeCheckout | null {
  if (!workspace || !worktrees?.length) return null;
  const key = projectKey(workspace);
  const here = worktrees.find((row) => projectKey(row.path) === key);
  if (!here || here.main) return null;
  const main = worktrees.find((row) => row.main);
  const branch = here.detached ? "detached" : here.branch?.trim() || "";
  const mainName = main?.path ? folderName(main.path) : "";
  if (!branch || !mainName) return null;
  return { name: folderName(here.path), branch, mainName };
}

/** One line when this folder is a linked worktree, not the main checkout. */
export function worktreeSystemLine(checkout?: WorktreeCheckout | null): string {
  if (!checkout?.name || !checkout.branch || !checkout.mainName) return "";
  return `This checkout is worktree ${checkout.name} on branch ${checkout.branch}. The main checkout is ${checkout.mainName}. Edits here do not change the other checkout.`;
}

export function systemPrompt(
  workspace: string,
  permission: PermissionMode = "ask",
  _knowledge?: string,
  mcpServers?: DetectedMcpServer[],
  skills?: DetectedSkill[],
  remote?: RemoteWorkspace | null,
  modelId?: string,
  planLine?: string,
  worktree?: WorktreeCheckout | null,
): ChatMessage {
  const extra = extraSystemLines(mcpServers, skills);
  const remoteLine = remoteWorkspaceLine(remote);
  const worktreeLine = worktreeSystemLine(worktree);
  const place = [remoteLine, worktreeLine].filter(Boolean).join("\n");
  const placeBlock = place ? `\n${place}` : "";
  const who = agentIdentityLine(modelId);
  const planning = (planLine ?? "").trim();
  return {
    role: "system",
    content: `${who}
Workspace: ${workspace}${placeBlock}
${permissionSystemLine(permission)}${planning ? `\n${planning}` : ""}
For independent research, planning, or parallel work, call spawn_subagent. Each child has its own context and reports a summary when it finishes. Use explore to investigate, plan for implementation plans, and general-purpose when the child may edit files.
For multi-step work, call todo_write to keep a short step list above the input. Update it as you go, including mid-turn. Keep at most one item in_progress.
For current facts, news, docs, or anything that may have changed, call web_search instead of guessing. Cite the source URLs it returns.
To find code, call grep for contents and glob for paths. Do not use the shell to search.
Prefer edit_file for small changes. Don't commit unless asked. Be concise.${extra}`,
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
  modelId?: string,
  planLine?: string,
  worktree?: WorktreeCheckout | null,
): ChatMessage[] {
  const base = system ?? systemPrompt(workspace, permission, knowledge, mcpServers, skills, remote, modelId, planLine, worktree);
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
  /** Signed Claude thinking blocks. Absent for Grok. */
  thinking?: ThinkingBlock[];
  /**
   * Kept so the app can inline non-image files before the provider call.
   * Picture bytes are already content parts. The provider drops this field.
   */
  images?: ChatImage[];
};

function messageTextWithoutImageTokens(msg: ChatMessage): string {
  const text = String(msg.content ?? "");
  return msg.images?.length ? stripImageTokens(text, msg.images) : text;
}

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
    if (msg.role === "assistant" && (msg.tool_calls?.length || msg.thinking?.length)) {
      return {
        role: "assistant",
        content: msg.content?.trim() ? msg.content : null,
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls.map(toApiToolCall) } : {}),
        ...(msg.thinking?.length ? { thinking: msg.thinking } : {}),
      };
    }
    if (isCompactionSummary(msg)) {
      return { role: "user", content: String(msg.content ?? "") };
    }
    if (msg.role === "user" && msg.images?.length) {
      const parts: ApiContentPart[] = [];
      const text = messageTextWithoutImageTokens(msg).trim();
      if (text) parts.push({ type: "text", text });
      for (const img of msg.images) {
        if (isFileAttachment(img) || !img.dataUrl) continue;
        parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
      }
      const hasFile = msg.images.some(isFileAttachment);
      if (!parts.length) {
        return hasFile
          ? { role: "user", content: "", images: msg.images }
          : { role: "user", content: "" };
      }
      return hasFile ? { role: "user", content: parts, images: msg.images } : { role: "user", content: parts };
    }
    return {
      role: msg.role,
      content: msg.content ?? "",
    };
  });
}

export type FinishStamp = { at: string; durationMs?: number | null };

/**
 * Fill `finishedAt` on replies that were saved before the clock time was stored.
 * `events` are usage records for one conversation, oldest first. Each record is
 * the end of one model step, so a tool round and the final reply both count.
 * A reply that already has a time is left alone.
 */
export function backfillFinishedAt(messages: ChatMessage[], events: FinishStamp[]): ChatMessage[] {
  const stamps = events
    .map((event) => ({ at: event.at.trim(), durationMs: event.durationMs }))
    .filter((event) => Number.isFinite(Date.parse(event.at)));
  if (!stamps.length || !messages.some(needsFinishStamp)) return messages;

  const steps: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isModelStep(messages[i]!)) steps.push(i);
  }
  if (!steps.length) return messages;

  let cursor = 0;
  const assigned = new Map<number, FinishStamp>();
  for (const index of steps) {
    const message = messages[index]!;
    if (String(message.finishedAt ?? "").trim()) {
      const known = Date.parse(message.finishedAt!);
      while (cursor < stamps.length && Date.parse(stamps[cursor]!.at) <= known) cursor += 1;
      continue;
    }
    if (cursor >= stamps.length) break;
    assigned.set(index, stamps[cursor]!);
    cursor += 1;
  }
  if (!assigned.size) return messages;

  let changed = false;
  const next = messages.slice();
  for (const [index, stamp] of assigned) {
    const message = next[index]!;
    if (!showsFinishedLine(message)) continue;
    changed = true;
    const duration =
      typeof message.durationMs === "number" || typeof stamp.durationMs !== "number" || stamp.durationMs < 0
        ? {}
        : { durationMs: stamp.durationMs };
    next[index] = { ...message, finishedAt: stamp.at, ...duration };
  }
  return changed ? next : messages;
}

function needsFinishStamp(message: ChatMessage): boolean {
  return showsFinishedLine(message) && !String(message.finishedAt ?? "").trim();
}

function showsFinishedLine(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.error &&
    !String(message.content ?? "").startsWith(TURN_FAILURE_PREFIX) &&
    Boolean((message.content ?? "").trim()) &&
    !(message.tool_calls ?? []).some(
      (call) => call.name !== "todo_write" && call.name !== "enter_plan_mode" && call.name !== "exit_plan_mode",
    )
  );
}

function isModelStep(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.error) return false;
  if (String(message.content ?? "").startsWith(TURN_FAILURE_PREFIX)) return false;
  return Boolean((message.content ?? "").trim() || message.tool_calls?.length || message.thinking?.length);
}

export function stampTurnDuration(
  messages: ChatMessage[],
  durationMs: number,
  finishedAt = "",
): ChatMessage[] {
  const stampTime = finishedAt.trim();
  const stampDuration = Number.isFinite(durationMs) && durationMs >= 0;
  if (!stampDuration && !stampTime) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role === "user") return messages;
    if (msg.role !== "assistant" || msg.error) continue;
    if (!(msg.content ?? "").trim() || msg.tool_calls?.length) continue;
    const sameDuration = !stampDuration || msg.durationMs === durationMs;
    const sameTime = !stampTime || msg.finishedAt === stampTime;
    if (sameDuration && sameTime) return messages;
    const next = messages.slice();
    next[i] = {
      ...msg,
      ...(stampDuration ? { durationMs } : {}),
      ...(stampTime ? { finishedAt: stampTime } : {}),
    };
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
