import { isSameProject } from "./all-projects.ts";
import { contextWindowChoices, resolveContextWindow } from "./context.ts";
import { TURN_FAILURE_PREFIX, type ChatImage, type ChatMessage, type ConversationActivity } from "./core.ts";
import { parsePermissionMode } from "./permission.ts";

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
  /** `done/total` for the todo list in this turn. Absent when the turn has no todos. */
  todo?: { done: number; total: number } | null;
};

function sameActivity(a: ConversationActivity | null | undefined, b: ConversationActivity | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "editing" && b.kind === "editing") return a.path === b.path;
  if (a.kind === "tool" && b.kind === "tool") return a.label === b.label;
  return true;
}

function sameTodo(a: RunningTurn["todo"], b: RunningTurn["todo"]): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.done === b.done && a.total === b.total;
}

/**
 * Sidebar label for one live turn.
 * A tool tick that repeats the same label must keep the previous object so the conversation list does not reconcile.
 */
export function patchRunningTurn(
  running: Record<string, RunningTurn>,
  id: string,
  patch: Partial<RunningTurn>,
): Record<string, RunningTurn> {
  if (!id) return running;
  const current = running[id] ?? { activity: null, startedAt: patch.startedAt ?? 0 };
  const next: RunningTurn = {
    activity: patch.activity !== undefined ? patch.activity : current.activity,
    startedAt: patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
    todo: patch.todo !== undefined ? patch.todo : current.todo,
  };
  if (
    running[id] &&
    sameActivity(current.activity, next.activity) &&
    current.startedAt === next.startedAt &&
    sameTodo(current.todo, next.todo)
  ) {
    return running;
  }
  return { ...running, [id]: next };
}

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

export type ComposerModel = {
  id: string;
  efforts?: readonly { id: string }[] | null;
  context_windows?: number[] | null;
  context_window?: number | null;
};

export type ComposerSettings = {
  model: string;
  effort: string;
  contextWindow: number;
  permission: string;
};

export type StoredComposerSettings = {
  model?: string | null;
  effort?: string | null;
  contextWindow?: number | null;
  permission?: string | null;
};

/**
 * Model id sent with the next turn.
 * A chat that already has an assistant reply keeps its saved model.
 * A new chat has none yet, so the composer chip wins over a model copied
 * from the previous conversation when the empty chat was created.
 */
export function modelForTurn(
  messages: readonly { role?: string | null }[],
  storedModel: string | null | undefined,
  chipModel: string,
): string {
  const stored = (storedModel ?? "").trim();
  const chip = chipModel.trim();
  if (messages.some((message) => message.role === "assistant") && stored) return stored;
  return chip || stored;
}

/**
 * Settings for the chat being opened.
 * A value saved on that chat wins. Anything missing stays on the app default.
 * The context size is kept only when the chosen model offers it.
 *
 * A brand-new chat has no saved model yet. The composer chip is the choice
 * until the first message stores one, so switching models before that send
 * is not overwritten by the model copied from the previous chat.
 */
export function composerSettingsForChat(
  stored: StoredComposerSettings | null | undefined,
  models: readonly ComposerModel[],
  fallback: ComposerSettings,
): ComposerSettings {
  const modelId = (stored?.model ?? "").trim();
  const model = models.find((row) => row.id === modelId) ?? models.find((row) => row.id === fallback.model) ?? models[0];
  const modelChoice = model?.id || fallback.model;
  const effort = effortForModel(stored?.effort, model?.efforts, fallback.effort);
  const choices = contextWindowChoices(model?.context_windows, model?.context_window);
  const contextWindow = resolveContextWindow(
    choices,
    stored?.contextWindow ?? fallback.contextWindow,
    model?.context_window,
    modelChoice,
  );
  return {
    model: modelChoice,
    effort,
    contextWindow,
    permission: parsePermissionMode(stored?.permission || fallback.permission),
  };
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

/**
 * Keep a reply that was still streaming when the turn stopped.
 * The user message stays put. Text already saved by a finished model round
 * is not added again. An empty buffer leaves the transcript unchanged.
 */
export function commitPartialReply(
  messages: ChatMessage[],
  partial: { text?: string | null; reasoning?: string | null },
): ChatMessage[] {
  const text = partial.text ?? "";
  const reasoning = String(partial.reasoning ?? "").trim();
  if (!text.trim() && !reasoning) return messages;
  return [
    ...messages,
    {
      role: "assistant",
      content: text,
      ...(reasoning ? { reasoning } : {}),
    },
  ];
}
