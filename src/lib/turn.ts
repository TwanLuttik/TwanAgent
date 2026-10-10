import { isSameProject } from "./all-projects.ts";
import { TURN_FAILURE_PREFIX, type ChatImage, type ChatMessage, type ConversationActivity } from "./core.ts";

export const SKIPPED_STOPPED = "Skipped: stopped.";
export { TURN_FAILURE_PREFIX };

export function isRetryableChatError(error: string): boolean {
  const text = error.toLowerCase();
  if (!text || text.includes("stopped") || text.includes("signed in")) return false;
  if (text.includes("401") || text.includes("api key") || text.includes("login expired")) return false;
  return (
    text.includes("xai request failed") ||
    text.includes("429") ||
    text.includes("500") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("decoding response body") ||
    text.includes("connection reset") ||
    text.includes("broken pipe")
  );
}

export function turnFailureMessage(error: string): ChatMessage {
  const text = error.trim() || "xAI request failed.";
  return {
    role: "assistant",
    content: `${TURN_FAILURE_PREFIX}${text}`,
    error: true,
  };
}

export function isTurnFailureMessage(msg: ChatMessage): boolean {
  return Boolean(msg.error) || String(msg.content ?? "").startsWith(TURN_FAILURE_PREFIX);
}

/** A finished reply the user has not opened yet. Failures and stops do not count. */
export function markUnseenFinished(
  ids: ReadonlySet<string>,
  id: string,
  opts: { aborted: boolean; failed: boolean; looking: boolean; queued: boolean },
): ReadonlySet<string> {
  if (!id || opts.aborted || opts.failed || opts.looking || opts.queued || ids.has(id)) return ids;
  const next = new Set(ids);
  next.add(id);
  return next;
}

export function clearUnseenFinished(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!id || !ids.has(id)) return ids;
  const next = new Set(ids);
  next.delete(id);
  return next;
}

export const EMPTY_COMPLETION_MESSAGE = "Grok returned an empty reply.";

export function isEmptyCompletion(text: string, toolCalls: { length: number }): boolean {
  return !(text || "").trim() && toolCalls.length === 0;
}

export const UNFINISHED_TOOL = "Error: the command did not finish.";

/** Every assistant tool call needs a tool result or the next request is invalid and the turn looks finished. */
export function closeDanglingToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) answered.add(msg.tool_call_id);
  }
  const missing: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const call of msg.tool_calls ?? []) {
      if (!call.id || answered.has(call.id)) continue;
      missing.push({ role: "tool", tool_call_id: call.id, content: UNFINISHED_TOOL });
      answered.add(call.id);
    }
  }
  return missing.length ? [...messages, ...missing] : messages;
}

export function turnAppliesToChat(turnId: string, visibleId: string): boolean {
  return Boolean(turnId) && turnId === visibleId;
}

export function liveTurnMessages(input: {
  workspace: string;
  conversationId: string;
  runningWorkspace: string;
  runningId: string;
  live: ChatMessage[] | null;
  liveByChat?: ReadonlyMap<string, { messages: ChatMessage[] }> | null;
}): ChatMessage[] | null {
  const fromChat = input.conversationId ? input.liveByChat?.get(input.conversationId)?.messages : undefined;
  // The map is already per conversation. Another project's foreground turn must not drop it.
  if (fromChat) return fromChat;
  if (!input.live || !input.conversationId || input.conversationId !== input.runningId) return null;
  if (!isSameProject(input.runningWorkspace, input.workspace)) return null;
  return input.live;
}

export function canPersistTurn(conversationId: string, deletedIds: Iterable<string>): boolean {
  if (!conversationId) return false;
  for (const id of deletedIds) {
    if (id === conversationId) return false;
  }
  return true;
}

export function draftForChat(drafts: Record<string, string>, chatId: string): string {
  return drafts[chatId] ?? "";
}

export function setDraftForChat(
  drafts: Record<string, string>,
  chatId: string,
  text: string,
): Record<string, string> {
  if (!text) {
    if (!(chatId in drafts)) return drafts;
    const next = { ...drafts };
    delete next[chatId];
    return next;
  }
  if (drafts[chatId] === text) return drafts;
  return { ...drafts, [chatId]: text };
}

export type PendingMessage = {
  text: string;
  images?: ChatImage[];
};

export function pendingForChat(
  pending: Record<string, PendingMessage[]>,
  chatId: string,
): PendingMessage[] {
  return pending[chatId] ?? [];
}

export function enqueuePending(
  pending: Record<string, PendingMessage[]>,
  chatId: string,
  text: string,
  images: ChatImage[] = [],
): Record<string, PendingMessage[]> {
  const trimmed = text.trim();
  if (!chatId || (!trimmed && images.length === 0)) return pending;
  const item: PendingMessage = images.length ? { text: trimmed, images } : { text: trimmed };
  return { ...pending, [chatId]: [...(pending[chatId] ?? []), item] };
}

export type PendingEdit = { chatId: string; index: number };

export function updatePending(
  pending: Record<string, PendingMessage[]>,
  chatId: string,
  index: number,
  text: string,
): { pending: Record<string, PendingMessage[]>; saved: boolean } {
  const current = pending[chatId];
  if (!current || index < 0 || index >= current.length) return { pending, saved: false };
  const trimmed = text.trim();
  const images = current[index].images ?? [];
  if (!trimmed && images.length === 0) return { pending, saved: false };
  const item: PendingMessage = images.length ? { text: trimmed, images } : { text: trimmed };
  const next = current.slice();
  next[index] = item;
  return { pending: { ...pending, [chatId]: next }, saved: true };
}

/** The queue waits while the next message, or one sitting between two others, is open for edit. */
export function pendingEditBlocksSend(count: number, editingIndex: number | null): boolean {
  if (editingIndex == null || editingIndex < 0 || editingIndex >= count) return false;
  if (editingIndex === 0) return true;
  return editingIndex < count - 1;
}

export function pendingIndexAfterRemove(editingIndex: number | null, removedIndex: number): number | null {
  if (editingIndex == null) return null;
  if (editingIndex === removedIndex) return null;
  if (removedIndex < editingIndex) return editingIndex - 1;
  return editingIndex;
}

export function removePending(
  pending: Record<string, PendingMessage[]>,
  chatId: string,
  index: number,
): Record<string, PendingMessage[]> {
  const current = pending[chatId];
  if (!current || index < 0 || index >= current.length) return pending;
  const next = current.filter((_, i) => i !== index);
  if (next.length === 0) {
    const out = { ...pending };
    delete out[chatId];
    return out;
  }
  return { ...pending, [chatId]: next };
}

export function dequeuePending(
  pending: Record<string, PendingMessage[]>,
  chatId: string,
): { pending: Record<string, PendingMessage[]>; item: PendingMessage | null } {
  const current = pending[chatId];
  if (!current?.length) return { pending, item: null };
  const [item, ...rest] = current;
  if (rest.length === 0) {
    const out = { ...pending };
    delete out[chatId];
    return { pending: out, item };
  }
  return { pending: { ...pending, [chatId]: rest }, item };
}

export type RunningTurn = {
  activity: ConversationActivity | null;
  startedAt: number;
};

export function chatTurnIsRunning(runningId: string, chatId: string): boolean {
  return Boolean(chatId) && runningId === chatId;
}

/** A chat stays running while its own turn is in the map, even if another chat is foreground. */
export function chatHasRunningTurn(
  running: Readonly<Record<string, RunningTurn>> | null | undefined,
  chatId: string,
): boolean {
  return Boolean(chatId) && Boolean(running && chatId in running);
}

/** Keep a thinking level only when this model offers it. Otherwise use the model default. */
export function effortForModel(
  effort: string | null | undefined,
  efforts: readonly { id: string }[] | null | undefined,
  fallback = "",
): string {
  const id = (effort ?? "").trim();
  if (id && efforts?.some((row) => row.id === id)) return id;
  const next = fallback.trim();
  if (next && efforts?.some((row) => row.id === next)) return next;
  return efforts?.[0]?.id ?? "";
}

/** The composer follows the open chat. Another chat's turn must not keep this input in the thinking state. */
export function foregroundRunningId(
  running: Readonly<Record<string, RunningTurn>> | null | undefined,
  chatId: string,
): string {
  return chatHasRunningTurn(running, chatId) ? chatId : "";
}

export function runningTurnStartedAt(
  running: Readonly<Record<string, RunningTurn>> | null | undefined,
  chatId: string,
): number {
  if (!chatId || !running) return 0;
  return running[chatId]?.startedAt ?? 0;
}

/** Queue only while this conversation's own turn is running. Another chat's turn does not count. */
export function shouldQueueForChat(runningId: string, chatId: string): boolean {
  return chatTurnIsRunning(runningId, chatId);
}

export function takeNextPending(
  pending: Record<string, PendingMessage[]>,
  finishedId: string,
  editing: PendingEdit | null = null,
):
  | { pending: Record<string, PendingMessage[]>; chatId: string; item: PendingMessage }
  | { pending: Record<string, PendingMessage[]>; chatId: null; item: null } {
  if (!finishedId) return { pending, chatId: null, item: null };
  if (
    editing?.chatId === finishedId &&
    pendingEditBlocksSend(pending[finishedId]?.length ?? 0, editing.index)
  ) {
    return { pending, chatId: null, item: null };
  }
  const taken = dequeuePending(pending, finishedId);
  if (taken.item) return { pending: taken.pending, chatId: finishedId, item: taken.item };
  return { pending, chatId: null, item: null };
}

export function clearPendingForChat(
  pending: Record<string, PendingMessage[]>,
  chatId: string,
): Record<string, PendingMessage[]> {
  if (!(chatId in pending)) return pending;
  const next = { ...pending };
  delete next[chatId];
  return next;
}

export function skipToolIfAborted(signal: AbortSignal): string | null {
  return signal.aborted ? SKIPPED_STOPPED : null;
}

export type RestoredPrompt = {
  messages: ChatMessage[];
  text: string;
  images: ChatImage[];
};

/**
 * Pull the latest user message back out of a stopped turn so it can be edited.
 * Assistant text, tool calls, and earlier turns stay. Nothing is restored when
 * the transcript has no user message.
 */
export function restoreStoppedPrompt(messages: ChatMessage[]): RestoredPrompt | null {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      index = i;
      break;
    }
  }
  if (index < 0) return null;
  const message = messages[index];
  if (!message) return null;
  const text = String(message.content ?? "");
  const images = (message.images ?? []).map(({ dataUrl: _dataUrl, ...image }) => image);
  if (!text.trim() && images.length === 0) return null;
  return {
    messages: messages.slice(0, index),
    text,
    images,
  };
}
