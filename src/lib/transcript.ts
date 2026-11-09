import { isCompactionEvent } from "./compact.ts";
import { fileBaseName } from "./file-icon.ts";
import { TURN_FAILURE_PREFIX, type ChatImage, type ChatMessage } from "./chat-types.ts";
import { normalizeGitPath } from "./git-changes.ts";
import {
  liveToolChange,
  liveToolDetail,
  liveToolLabel,
  mergeToolFileChanges,
  skillTrailPreview,
  subagentConversationIdFromResult,
  toolActivityLabel,
  toolDetail,
  toolFileChange,
  toolTrailFileChanges,
  webSearchResultSites,
  webSearchSitesLabel,
  type LiveToolInput,
  type ToolFileChange,
} from "./tool-text.ts";

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
      /** Conversation id for a subagent row, aligned with `callIds`. Empty until the run is saved. */
      opens?: string[];
      /** Set when this tool batch is the end of the turn, so the finish line can follow it. */
      durationMs?: number;
      finishedAt?: string;
    };

export type ToolTrailRow = {
  label: string;
  change: ToolFileChange | null;
  detail: string;
  /** Nested calls on the same file, shown under this row as a tree. */
  children?: ToolTrailRow[];
  /** Conversation this row opens. Set for a subagent, empty for every other call. */
  openId?: string;
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

function oneTrailRow(label: string, change: ToolFileChange | null, detail: string, openId = ""): ToolTrailRow {
  const row: ToolTrailRow = { label, change, detail };
  const id = openId.trim();
  if (id) row.openId = id;
  return row;
}

/**
 * Fold a run of the same tool into one line.
 * Reads, writes, and edits of one file become a tree: the file is the parent and each call is a child.
 */
export function foldToolTrailRows(
  labels: string[],
  details: (ToolFileChange | null)[] = [],
  commands: string[] = [],
  openIds: string[] = [],
): ToolTrailRow[] {
  const rows: ToolTrailRow[] = [];
  let i = 0;
  while (i < labels.length) {
    const group = trailGroup(labels[i] ?? "");
    if (!group) {
      rows.push(oneTrailRow(labels[i] ?? "", details[i] ?? null, commands[i] ?? "", openIds[i] ?? ""));
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < labels.length && trailGroup(labels[j] ?? "") === group) j += 1;
    if (group === "read" || group === "edit") {
      rows.push(
        ...foldFileToolRun(
          group,
          labels.slice(i, j),
          details.slice(i, j),
          commands.slice(i, j),
          openIds.slice(i, j),
        ),
      );
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
  openIds: string[] = [],
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
      rows.push(oneTrailRow(labels[i] ?? "", null, commands[i] ?? "", openIds[i] ?? ""));
      i += 1;
      continue;
    }
    const merged = mergeToolFileChanges(details.slice(i, j).flatMap((item) => (item ? [item] : [])))[0] ?? null;
    if (count === 1) {
      rows.push(oneTrailRow(labels[i] ?? "", merged, commands[i] ?? "", openIds[i] ?? ""));
      i = j;
      continue;
    }
    const children = labels.slice(i, j).map((label, offset) =>
      oneTrailRow(label, details[i + offset] ?? null, commands[i + offset] ?? "", openIds[i + offset] ?? ""),
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
  if (type === "Edit" || type === "Editing") return "pencil";
  if (type === "List") return "folder";
  if (type === "Chats" || type === "Chat") return "messages";
  if (type === "Create") return "plus";
  if (type === "Skill") return "book";
  if (type === "MCP") return "cable.connector";
  return "ellipsis";
}

/** Sidebar activity mark. Known tools use the conversation icon; other lines keep the turn arrow. */
export function sidebarActivityIcon(label: string): string {
  const icon = toolTrailTypeIcon(toolTrailKind(label));
  return icon === "ellipsis" ? "arrow.turn.down.right" : icon;
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
      fillListedChats(out, msg);
      fillReadChat(out, msg);
      fillCreatedChat(out, msg);
      fillSubagent(out, msg);
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
      const finish = toolFinish(msg);
      const last = out[out.length - 1];
      if (last?.kind === "tools") {
        last.labels.push(...labels);
        last.details.push(...details);
        last.commands.push(...commands);
        last.callIds.push(...callIds);
        last.files = mergeToolFileChanges([...last.files, ...files]);
        if (finish.finishedAt) last.finishedAt = finish.finishedAt;
        if (typeof finish.durationMs === "number") last.durationMs = finish.durationMs;
      } else out.push({ kind: "tools", labels, files, details, commands, callIds, ...finish });
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

export type ListedChatRow = { alias: string; id: string; title: string };

/** One chat per line from `list_chats`: alias, id, title, time. */
export function listedChatRows(content: string): ListedChatRow[] {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text || text === "No chats." || text.startsWith("Error:")) return [];
  const rows: ListedChatRow[] = [];
  for (const line of text.split("\n")) {
    const [alias, id, title] = line.split("\t");
    const name = alias?.trim() ?? "";
    const chatId = id?.trim() ?? "";
    if (!name || !chatId) continue;
    rows.push({ alias: name, id: chatId, title: (title ?? "").trim() || chatId });
  }
  return rows;
}

/** Titles on the row. One project keeps the alias once. */
export function listedChatsLabel(rows: ListedChatRow[]): string {
  if (!rows.length) return "Chats";
  const aliases = [...new Set(rows.map((row) => row.alias))];
  const shown = rows.slice(0, 4);
  const extra = rows.length > shown.length ? ` +${rows.length - shown.length}` : "";
  if (aliases.length === 1) {
    return `Chats in ${aliases[0]}: ${shown.map((row) => row.title).join(", ")}${extra}`;
  }
  return `Chats ${shown.map((row) => `${row.alias} ${row.title}`).join(", ")}${extra}`;
}

export function listedChatsDetail(rows: ListedChatRow[]): string {
  return rows.map((row) => `${row.alias}  ${row.id}  ${row.title}`).join("\n");
}

/** `read_chat` starts with the alias and id, then the title. */
export function readChatHeading(content: string): { alias: string; id: string; title: string } | null {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text || text.startsWith("Error:")) return null;
  const lines = text.split("\n");
  const head = lines[0]?.trim() ?? "";
  const space = head.indexOf(" ");
  if (space <= 0) return null;
  const alias = head.slice(0, space).trim();
  const id = head.slice(space + 1).trim();
  const title = (lines[1] ?? "").trim();
  if (!alias || !id || !title || title === "archived" || title.startsWith("updated ")) return null;
  return { alias, id, title };
}

function chatToolIndex(
  items: TranscriptItem[],
  toolMessage: ChatMessage,
  labelMatches: (label: string) => boolean,
): { item: Extract<TranscriptItem, { kind: "tools" }>; index: number } | null {
  if (toolMessage.role !== "tool") return null;
  const id = toolMessage.tool_call_id ?? "";
  if (!id) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.kind === "user") return null;
    if (item.kind !== "tools") continue;
    const index = item.callIds.indexOf(id);
    if (index < 0 || !labelMatches(item.labels[index] ?? "")) continue;
    return { item, index };
  }
  return null;
}

/** Put the chats a list actually returned onto that row. */
function fillListedChats(items: TranscriptItem[], toolMessage: ChatMessage): void {
  const found = chatToolIndex(items, toolMessage, (label) => label === "Chats" || label.startsWith("Chats "));
  if (!found) return;
  const text = String(toolMessage.content ?? "").trim();
  if (!text) return;
  const rows = listedChatRows(text);
  if (!rows.length) {
    found.item.commands[found.index] = text;
    return;
  }
  found.item.labels[found.index] = listedChatsLabel(rows);
  found.item.commands[found.index] = listedChatsDetail(rows);
}

/** Remember the conversation a subagent run saved, so the row can open it later. */
function fillSubagent(items: TranscriptItem[], toolMessage: ChatMessage): void {
  const found = chatToolIndex(
    items,
    toolMessage,
    (label) => label === "Subagent" || label.startsWith("Subagent:") || label.startsWith("Subagent "),
  );
  if (!found) return;
  const id = subagentConversationIdFromResult(String(toolMessage.content ?? ""));
  if (!id) return;
  const opens = found.item.opens ? [...found.item.opens] : found.item.labels.map(() => "");
  while (opens.length < found.item.labels.length) opens.push("");
  opens[found.index] = id;
  found.item.opens = opens;
}

/** Put the created chat's title on the row once the tool returns. */
function fillCreatedChat(items: TranscriptItem[], toolMessage: ChatMessage): void {
  const found = chatToolIndex(items, toolMessage, (label) => label === "Create chat" || label.startsWith("Create "));
  if (!found) return;
  const text = String(toolMessage.content ?? "").trim();
  if (!text || text.startsWith("Error:")) {
    if (text) found.item.commands[found.index] = text;
    return;
  }
  const [alias, , title] = text.split("\t");
  const name = alias?.trim() ?? "";
  const label = title?.trim() ?? "";
  if (name && label) found.item.labels[found.index] = `Create ${name} ${label}`;
}

/** Name the chat that was read, and keep the transcript under the row. */
function fillReadChat(items: TranscriptItem[], toolMessage: ChatMessage): void {
  const found = chatToolIndex(items, toolMessage, (label) => label === "Chat" || label.startsWith("Chat "));
  if (!found) return;
  const text = String(toolMessage.content ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return;
  const heading = readChatHeading(text);
  if (heading) found.item.labels[found.index] = `Chat ${heading.alias} ${heading.title}`;
  found.item.commands[found.index] = skillTrailPreview(text);
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

/** A tool-calling reply can still be the end of the turn. The finish line follows the tools. */
function toolFinish(msg: ChatMessage): { durationMs?: number; finishedAt?: string } {
  const finishedAt = String(msg.finishedAt ?? "").trim();
  const durationMs = typeof msg.durationMs === "number" && msg.durationMs >= 0 ? msg.durationMs : undefined;
  if (!finishedAt && durationMs == null) return {};
  return {
    ...(durationMs == null ? {} : { durationMs }),
    ...(finishedAt ? { finishedAt } : {}),
  };
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

/** Merge pending calls into a new tools item so the committed row stays intact. */
function pushLiveTools(out: TranscriptItem[], pending: LiveToolInput[]): void {
  if (!pending.length) return;
  const labels = pending.map(liveToolLabel);
  const details = pending.map(liveToolChange);
  const commands = pending.map(liveToolDetail);
  const callIds = pending.map((tool) => (typeof tool === "string" ? "" : tool.callId ?? ""));
  const files = mergeToolFileChanges(details.flatMap((change) => (change ? [change] : [])));
  const tail = out[out.length - 1];
  if (tail?.kind === "tools") {
    out[out.length - 1] = {
      kind: "tools",
      labels: [...tail.labels, ...labels],
      details: [...tail.details, ...details],
      commands: [...tail.commands, ...commands],
      callIds: [...tail.callIds, ...callIds],
      files: mergeToolFileChanges([...tail.files, ...files]),
      ...(tail.opens?.length ? { opens: [...tail.opens, ...labels.map(() => "")] } : {}),
    };
    return;
  }
  out.push({ kind: "tools", labels, files, details, commands, callIds });
}

/**
 * Append live reasoning, text, and tools onto an already-parsed item list.
 * Does not walk messages. Copies a trailing tools item before merging so the
 * committed list stays intact. `seenTools` is every committed tool label, including
 * ones outside `out`, so a settled call is not shown again on the open turn.
 * A thought that is still streaming stays last. Calls already running sit above it.
 */
function appendLiveTranscript(
  out: TranscriptItem[],
  streamText: string,
  liveTools: LiveToolInput[],
  streamReasoning: string,
  seenTools: Set<string>,
): TranscriptItem[] {
  const pending = liveTools.filter((tool) => !seenTools.has(liveToolLabel(tool)));
  const showThought = Boolean(streamReasoning) && !thinkingAlreadyShown(out, streamReasoning);
  if (showThought) pushLiveTools(out, pending);
  if (showThought) {
    out.push({ kind: "thinking", content: streamReasoning, live: true });
  }
  const last = out[out.length - 1];
  if (streamText && !(last?.kind === "assistant" && last.content === streamText)) {
    out.push({ kind: "assistant", content: streamText });
  }
  if (!showThought) pushLiveTools(out, pending);
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
