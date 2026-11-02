import { fileBaseName } from "./file-icon.ts";
import { normalizeGitPath } from "./git-changes.ts";
import type { ChatMessage, ChatToolCall } from "./chat-types.ts";

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
  if (name === "list_chats") {
    const alias = String(args.alias ?? "").trim();
    return alias ? `Chats in ${alias}` : "Chats";
  }
  if (name === "read_chat") {
    const alias = String(args.alias ?? "").trim();
    const id = String(args.id ?? "").trim();
    if (alias && id) return `Chat ${alias} ${id}`;
    return alias ? `Chat ${alias}` : "Chat";
  }
  if (name === "create_chat") {
    const alias = String(args.alias ?? "").trim();
    return alias ? `Create chat ${alias}` : "Create chat";
  }
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
  if (call.name === "list_chats") return String(args.alias ?? "").trim();
  if (call.name === "read_chat") return String(args.id ?? "").trim();
  if (call.name === "create_chat") {
    const message = String(args.message ?? "").trim();
    return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message;
  }
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
