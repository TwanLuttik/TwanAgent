import { folderName, projectKey } from "./project-rows.ts";
import { CODE_TAB_KEY, type TabItem } from "./split-pane.ts";

export type ProjectTabSplit = { groupId: string; pane: 0 | 1 };

/** One open conversation inside a project tab. */
export type ProjectTabChat = {
  id: string;
  title: string;
  running: boolean;
  selected: boolean;
  /** Set when this conversation is one side of an open split. */
  split: ProjectTabSplit | null;
};

/** The top bar: one entry per project, plus the Code tab if it is open. */
export type ProjectChromeEntry =
  | {
      kind: "project";
      id: string;
      key: string;
      name: string;
      path: string;
      running: boolean;
      selected: boolean;
      /** Conversation to open when the project tab is clicked. */
      openId: string;
      chats: ProjectTabChat[];
    }
  | { kind: "code"; id: string };

export type NestedProjectChat<T> = T & { depth: number };

/**
 * Subagent conversations sit under the chat that opened them.
 * One whose parent is not in this list stays put, still indented.
 */
export function nestProjectChats<T extends { id: string }>(
  chats: readonly T[],
  parentOf: (id: string) => string,
  isSubagent: (id: string) => boolean = (id) => Boolean(parentOf(id).trim()),
): NestedProjectChat<T>[] {
  const ids = new Set(chats.map((chat) => chat.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const chat of chats) {
    const parent = parentOf(chat.id).trim();
    if (parent && parent !== chat.id && ids.has(parent)) {
      const list = children.get(parent);
      if (list) list.push(chat);
      else children.set(parent, [chat]);
    } else roots.push(chat);
  }
  const out: NestedProjectChat<T>[] = [];
  const seen = new Set<string>();
  const walk = (chat: T, depth: number) => {
    if (seen.has(chat.id)) return;
    seen.add(chat.id);
    const parent = parentOf(chat.id).trim();
    const orphan = isSubagent(chat.id) && (!parent || parent === chat.id || !ids.has(parent));
    out.push({ ...chat, depth: orphan ? Math.max(depth, 1) : depth });
    for (const child of children.get(chat.id) ?? []) walk(child, depth + 1);
  };
  for (const chat of roots) walk(chat, 0);
  for (const chat of chats) walk(chat, 0);
  return out;
}

export type ProjectMenuEntry<T> =
  | { kind: "chat"; chat: T; depth: number }
  | { kind: "split"; groupId: string; rows: { chat: T; depth: number }[] };

/**
 * The project menu. A split is one group, left pane then right, where the
 * first of those panes sat. A subagent of a pane stays inside that group.
 */
export function projectMenuEntries<T extends { id: string; split: ProjectTabSplit | null }>(
  chats: readonly T[],
  parentOf: (id: string) => string,
  isSubagent: (id: string) => boolean = (id) => Boolean(parentOf(id).trim()),
): ProjectMenuEntry<T>[] {
  const ids = new Set(chats.map((chat) => chat.id));
  const byGroup = new Map<string, T[]>();
  for (const chat of chats) {
    const split = chat.split;
    if (!split) continue;
    const list = byGroup.get(split.groupId);
    if (list) list.push(chat);
    else byGroup.set(split.groupId, [chat]);
  }
  const complete = new Set<string>();
  for (const [groupId, members] of byGroup) {
    const panes = new Set(members.map((chat) => chat.split?.pane));
    if (panes.has(0) && panes.has(1)) {
      for (const chat of members) complete.add(chat.id);
    } else byGroup.delete(groupId);
  }

  const children = new Map<string, T[]>();
  const nestedIds = new Set<string>();
  for (const chat of chats) {
    if (complete.has(chat.id)) continue;
    const parent = parentOf(chat.id).trim();
    if (!parent || parent === chat.id || !ids.has(parent)) continue;
    const list = children.get(parent);
    if (list) list.push(chat);
    else children.set(parent, [chat]);
    nestedIds.add(chat.id);
  }

  const out: ProjectMenuEntry<T>[] = [];
  const seen = new Set<string>();

  const take = (chat: T, depth: number, into: { chat: T; depth: number }[]) => {
    if (seen.has(chat.id)) return;
    seen.add(chat.id);
    const parent = parentOf(chat.id).trim();
    const orphan = isSubagent(chat.id) && depth === 0 && (!parent || parent === chat.id || !ids.has(parent));
    into.push({ chat, depth: orphan ? 1 : depth });
    for (const child of children.get(chat.id) ?? []) take(child, depth + 1, into);
  };

  const emitSplit = (groupId: string) => {
    const members = byGroup.get(groupId) ?? [];
    const rows: { chat: T; depth: number }[] = [];
    for (const pane of [0, 1] as const) {
      const chat = members.find((item) => item.split?.pane === pane);
      if (chat) take(chat, 0, rows);
    }
    if (rows.length) out.push({ kind: "split", groupId, rows });
  };

  for (const chat of chats) {
    if (seen.has(chat.id) || nestedIds.has(chat.id)) continue;
    if (chat.split && complete.has(chat.id)) {
      emitSplit(chat.split.groupId);
      continue;
    }
    const rows: { chat: T; depth: number }[] = [];
    take(chat, 0, rows);
    for (const row of rows) out.push({ kind: "chat", chat: row.chat, depth: row.depth });
  }
  return out;
}

export function conversationTabLabel(title: string | undefined): string {
  const raw = title?.trim() ?? "";
  return raw && raw !== "New chat" ? raw : "New thread";
}

/** Remember which conversation was open in its project. Same map when nothing changed. */
export function rememberProjectChat(
  lastOpen: Readonly<Record<string, string>>,
  homes: Readonly<Record<string, string>>,
  chatId: string,
): Record<string, string> {
  const path = homes[chatId] ?? "";
  if (!chatId || !path) return lastOpen;
  const key = projectKey(path);
  if (lastOpen[key] === chatId) return lastOpen;
  return { ...lastOpen, [key]: chatId };
}

type Bucket = {
  key: string;
  path: string;
  name: string;
  chats: ProjectTabChat[];
};

/**
 * One tab per project. Conversations stay in tab order under the project that
 * owns them. The Code tab stays a separate entry, inserted where it first appears.
 */
export function projectChromeTabs(input: {
  items: readonly TabItem[];
  homes: Readonly<Record<string, string>>;
  titles: Readonly<Record<string, string>>;
  runningIds: ReadonlySet<string>;
  activeChatId: string;
  lastOpen: Readonly<Record<string, string>>;
  codeFocused: boolean;
  names?: Readonly<Record<string, string>>;
}): ProjectChromeEntry[] {
  const { items, homes, titles, runningIds, activeChatId, lastOpen, codeFocused, names } = input;
  const buckets: Bucket[] = [];
  const byKey = new Map<string, Bucket>();
  let codeAt: number | null = null;

  const take = (path: string): Bucket => {
    const key = path ? projectKey(path) : "";
    const found = byKey.get(key);
    if (found) return found;
    const named = key ? names?.[key]?.trim() : "";
    const bucket: Bucket = {
      key,
      path,
      name: named || (path ? folderName(path) : "Chats"),
      chats: [],
    };
    byKey.set(key, bucket);
    buckets.push(bucket);
    return bucket;
  };

  const add = (id: string, split: ProjectTabSplit | null) => {
    const next = id.trim();
    if (!next) return;
    const bucket = take(homes[next] ?? "");
    if (bucket.chats.some((chat) => chat.id === next)) return;
    bucket.chats.push({
      id: next,
      title: conversationTabLabel(titles[next]),
      running: runningIds.has(next),
      selected: !codeFocused && next === activeChatId,
      split,
    });
  };

  for (const item of items) {
    if (item.kind === "code") {
      if (codeAt === null) codeAt = buckets.length;
      continue;
    }
    if (item.kind === "chat") {
      add(item.id, null);
      continue;
    }
    const [left, right] = item.group.chatIds;
    add(left, { groupId: item.group.id, pane: 0 });
    add(right, { groupId: item.group.id, pane: 1 });
  }

  const entries: ProjectChromeEntry[] = buckets.map((bucket) => {
    const ids = bucket.chats.map((chat) => chat.id);
    const remembered = lastOpen[bucket.key] ?? "";
    const openId = ids.includes(activeChatId) ? activeChatId : ids.includes(remembered) ? remembered : (ids[0] ?? "");
    return {
      kind: "project" as const,
      id: `project:${bucket.key || "none"}`,
      key: bucket.key,
      name: bucket.name,
      path: bucket.path,
      running: bucket.chats.some((chat) => chat.running),
      selected: bucket.chats.some((chat) => chat.selected),
      openId,
      chats: bucket.chats,
    };
  });
  if (codeAt !== null) entries.splice(codeAt, 0, { kind: "code", id: CODE_TAB_KEY });
  return entries;
}
