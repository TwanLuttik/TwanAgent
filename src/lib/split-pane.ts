import type { ChatMessage, ConversationActivity, LiveToolRow } from "./core.ts";

/** A conversation tab, or two chats shown side by side. */

export type SplitGroup = {
  id: string;
  chatIds: [string, string];
  /** The pane whose composer is focused. The other pane stays mounted. */
  activePane: 0 | 1;
  /** Share of the row given to the left pane. The right pane takes the rest. */
  leftShare: number;
};

export type TabItem =
  | { kind: "chat"; id: string }
  | { kind: "split"; group: SplitGroup }
  | { kind: "code" };

/** The Code tab. There is only one, so it has a fixed key. */
export const CODE_TAB_KEY = "code";

export type TabMenu =
  | { kind: "chat"; id: string; x: number; y: number }
  | { kind: "split"; groupId: string; pane: 0 | 1; x: number; y: number };

export const SPLIT_SHARE_MIN = 0.2;
export const SPLIT_SHARE_MAX = 0.8;
export const DEFAULT_SPLIT_SHARE = 0.5;

export function clampSplitShare(share: number): number {
  if (!Number.isFinite(share)) return DEFAULT_SPLIT_SHARE;
  return Math.min(SPLIT_SHARE_MAX, Math.max(SPLIT_SHARE_MIN, share));
}

export function newSplitGroupId(): string {
  return `split-${crypto.randomUUID()}`;
}

export function tabItemsFromIds(ids: string[]): TabItem[] {
  return ids.filter((id) => id.trim()).map((id) => ({ kind: "chat", id }));
}

export function chatIdsInTabs(items: TabItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.kind === "chat") ids.push(item.id);
    else if (item.kind === "split") ids.push(item.group.chatIds[0], item.group.chatIds[1]);
  }
  return ids;
}

export function splitGroupForChat(items: TabItem[], chatId: string): SplitGroup | null {
  if (!chatId) return null;
  for (const item of items) {
    if (item.kind === "split" && (item.group.chatIds[0] === chatId || item.group.chatIds[1] === chatId)) {
      return item.group;
    }
  }
  return null;
}

export function tabItemForChat(items: TabItem[], chatId: string): TabItem | null {
  if (!chatId) return null;
  for (const item of items) {
    if (item.kind === "chat" && item.id === chatId) return item;
    if (item.kind === "split" && (item.group.chatIds[0] === chatId || item.group.chatIds[1] === chatId)) {
      return item;
    }
  }
  return null;
}

export function findSplitGroup(items: TabItem[], groupId: string): SplitGroup | null {
  for (const item of items) {
    if (item.kind === "split" && item.group.id === groupId) return item.group;
  }
  return null;
}

/**
 * Pair `id` with the neighbor chat. The right-clicked chat stays on the left.
 * A chat that is already split, or a tab strip with nothing else to pair, stays put.
 */
export function splitChatTab(items: TabItem[], id: string, groupId = newSplitGroupId()): TabItem[] {
  const index = items.findIndex((item) => item.kind === "chat" && item.id === id);
  if (index < 0) return items;
  const partnerIndex = index > 0 ? index - 1 : index + 1 < items.length && items[index + 1]?.kind === "chat" ? index + 1 : -1;
  if (partnerIndex < 0) return items;
  const partner = items[partnerIndex];
  if (!partner || partner.kind !== "chat" || partner.id === id) return items;
  const left = Math.min(index, partnerIndex);
  const right = Math.max(index, partnerIndex);
  const leftItem = items[left];
  const rightItem = items[right];
  if (!leftItem || leftItem.kind !== "chat" || !rightItem || rightItem.kind !== "chat") return items;
  // Tab order stays left to right. The right-clicked chat is the focused pane.
  const group: SplitGroup = {
    id: groupId,
    chatIds: [leftItem.id, rightItem.id],
    activePane: id === leftItem.id ? 0 : 1,
    leftShare: DEFAULT_SPLIT_SHARE,
  };
  const next = items.slice();
  next.splice(left, right - left + 1, { kind: "split", group });
  return next;
}

/** Put both chats back as their own tabs, left pane first. */
export function unsplitGroup(items: TabItem[], groupId: string): TabItem[] {
  const index = items.findIndex((item) => item.kind === "split" && item.group.id === groupId);
  if (index < 0) return items;
  const group = items[index];
  if (!group || group.kind !== "split") return items;
  const next = items.slice();
  next.splice(
    index,
    1,
    { kind: "chat", id: group.group.chatIds[0] },
    { kind: "chat", id: group.group.chatIds[1] },
  );
  return next;
}

/** Drop one pane. The chat that remains becomes a normal tab. */
export function closeSplitPane(items: TabItem[], groupId: string, pane: 0 | 1): TabItem[] {
  const index = items.findIndex((item) => item.kind === "split" && item.group.id === groupId);
  if (index < 0) return items;
  const group = items[index];
  if (!group || group.kind !== "split") return items;
  const kept = group.group.chatIds[pane === 0 ? 1 : 0];
  const next = items.slice();
  next[index] = { kind: "chat", id: kept };
  return next;
}

export function focusSplitPane(items: TabItem[], groupId: string, pane: 0 | 1): TabItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== "split" || item.group.id !== groupId || item.group.activePane === pane) return item;
    changed = true;
    return { kind: "split" as const, group: { ...item.group, activePane: pane } };
  });
  return changed ? next : items;
}

/**
 * Remove a chat from the strip. A split that loses one side collapses to the chat that remains.
 * `next` is the neighbor to show when the removed chat was the one on screen.
 */
export function closeTabChat(
  items: TabItem[],
  id: string,
): { items: TabItem[]; removed: boolean; next: string | null } {
  if (!id) return { items, removed: false, next: null };
  const index = items.findIndex((item) => {
    if (item.kind === "chat") return item.id === id;
    if (item.kind === "split") return item.group.chatIds[0] === id || item.group.chatIds[1] === id;
    return false;
  });
  if (index < 0) return { items, removed: false, next: null };
  const item = items[index];
  if (!item) return { items, removed: false, next: null };
  if (item.kind === "split") {
    const pane: 0 | 1 = item.group.chatIds[0] === id ? 0 : 1;
    const kept = item.group.chatIds[pane === 0 ? 1 : 0];
    const next = items.slice();
    next[index] = { kind: "chat", id: kept };
    return { items: next, removed: true, next: kept };
  }
  const next = items.filter((_, i) => i !== index);
  const neighbor = next[index] ?? next[index - 1] ?? null;
  return { items: next, removed: true, next: neighbor ? primaryChatId(neighbor) : null };
}

export function openTabChat(items: TabItem[], id: string): TabItem[] {
  const next = id.trim();
  if (!next) return items;
  if (chatIdsInTabs(items).includes(next)) return items;
  return [...items, { kind: "chat", id: next }];
}

/**
 * Show `id` without moving tabs. A chat already in the strip, including inside a
 * split, stays where it is. Only a chat that is not open yet is appended.
 */
export function revealTabChat(items: TabItem[], id: string): TabItem[] {
  return openTabChat(items, id);
}

/** Move a tab or a whole split group in front of another. Order inside a group stays put. */
export function moveTabItem(items: TabItem[], fromKey: string, toKey: string): TabItem[] {
  if (!fromKey || !toKey || fromKey === toKey) return items;
  const from = items.findIndex((item) => tabItemKey(item) === fromKey);
  const to = items.findIndex((item) => tabItemKey(item) === toKey);
  if (from < 0 || to < 0) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  if (!item) return items;
  next.splice(to, 0, item);
  return next;
}

export function tabItemKey(item: TabItem): string {
  if (item.kind === "chat") return `chat:${item.id}`;
  if (item.kind === "split") return `split:${item.group.id}`;
  return CODE_TAB_KEY;
}

/** Put the Code tab at the end once files are open. A saved place is kept. */
export function withCodeTab(items: TabItem[], open: boolean): TabItem[] {
  const present = items.some((item) => item.kind === "code");
  if (!open) return present ? items.filter((item) => item.kind !== "code") : items;
  if (present) return items;
  return [...items, { kind: "code" }];
}

/**
 * Pair the command-selected chats, in the order they were picked.
 * The first two plain tabs become the split. A chat already inside a split is left there.
 */
export function splitSelectedChats(items: TabItem[], ids: readonly string[], groupId = newSplitGroupId()): TabItem[] {
  const picked = uniqueIds(ids).filter((id) => tabItemForChat(items, id)?.kind === "chat");
  if (picked.length < 2) return items;
  const [leftId, rightId] = picked;
  const left = items.findIndex((item) => item.kind === "chat" && item.id === leftId);
  const right = items.findIndex((item) => item.kind === "chat" && item.id === rightId);
  if (left < 0 || right < 0 || left === right) return items;
  const at = Math.min(left, right);
  const group: SplitGroup = {
    id: groupId,
    chatIds: [leftId!, rightId!],
    activePane: 0,
    leftShare: DEFAULT_SPLIT_SHARE,
  };
  const next = items.filter((item) => !(item.kind === "chat" && (item.id === leftId || item.id === rightId)));
  next.splice(at, 0, { kind: "split", group });
  return next;
}

export function setSplitShare(items: TabItem[], groupId: string, share: number): TabItem[] {
  const nextShare = clampSplitShare(share);
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== "split" || item.group.id !== groupId || item.group.leftShare === nextShare) return item;
    changed = true;
    return { kind: "split" as const, group: { ...item.group, leftShare: nextShare } };
  });
  return changed ? next : items;
}

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const next = id.trim();
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}

/** Focus the pane that already holds this chat. The pair and its order stay put. */
export function focusSplitChat(items: TabItem[], id: string): TabItem[] {
  const group = splitGroupForChat(items, id);
  if (!group) return items;
  const pane: 0 | 1 = group.chatIds[0] === id ? 0 : 1;
  return focusSplitPane(items, group.id, pane);
}

/** The chat a tab shows when it is selected. A split uses its focused pane. */
export function primaryChatId(item: TabItem): string {
  if (item.kind === "chat") return item.id;
  if (item.kind === "code") return "";
  return item.group.chatIds[item.group.activePane];
}

export type SplitPaneCache = {
  messages: ChatMessage[];
  streamText: string;
  streamReasoning: string;
  liveTools: LiveToolRow[];
  activity: ConversationActivity | null;
};

const paneCache = new Map<string, SplitPaneCache>();

export function rememberSplitPane(id: string, patch: Partial<SplitPaneCache>) {
  if (!id) return;
  const prev = paneCache.get(id) ?? {
    messages: [],
    streamText: "",
    streamReasoning: "",
    liveTools: [],
    activity: null,
  };
  paneCache.set(id, { ...prev, ...patch });
}

export function splitPaneCache(id: string): SplitPaneCache | null {
  return paneCache.get(id) ?? null;
}

/**
 * The transcript to show when a split pane becomes the focused chat.
 * The pane already painted `shown`. An empty cache must not replace that with
 * a new-chat screen. A cache that has messages wins, because a live turn may
 * be ahead of the copy the pane loaded.
 */
export function focusedSplitMessages(shown: readonly ChatMessage[], cached: readonly ChatMessage[] | null | undefined): ChatMessage[] {
  if (cached && cached.length > 0) return cached.slice();
  return shown.slice();
}

export function forgetSplitPane(id: string) {
  if (id) paneCache.delete(id);
}

/** Chats that should stay mounted. A split keeps both. */
export function visibleChatIds(item: TabItem | null): string[] {
  if (!item) return [];
  if (item.kind === "chat") return [item.id];
  if (item.kind === "code") return [];
  return [item.group.chatIds[0], item.group.chatIds[1]];
}
