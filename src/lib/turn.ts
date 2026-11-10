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

/**
 * The provider is down. The turn keeps asking until it answers.
 * A one-off decode error stays on the single retry in `isRetryableChatError`.
 */
export function isTransientProviderError(error: string): boolean {
  if (!isRetryableChatError(error)) return false;
  const text = error.toLowerCase();
  return (
    text.includes("temporarily unavailable") ||
    text.includes("did not respond") ||
    text.includes("overloaded") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("service unavailable") ||
    text.includes("unavailable") ||
    text.includes("error 429") ||
    text.includes("error 500") ||
    text.includes("error 502") ||
    text.includes("error 503") ||
    text.includes("error 504") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("connection reset") ||
    text.includes("broken pipe") ||
    text.includes("error sending request") ||
    text.includes("connection refused") ||
    text.includes("model stream closed")
  );
}

/** 2s, 4s, 8s, 16s, then 30s. Matches the Rust pause. */
export function providerRetryPauseMs(attempt: number): number {
  const seconds = attempt <= 0 ? 2 : attempt === 1 ? 4 : attempt === 2 ? 8 : attempt === 3 ? 16 : 30;
  return seconds * 1000;
}

const PROVIDER_RETRY_PREFIX = "The model is unavailable.";

/** Shown while the turn waits out a provider outage. `retry` is 1 on the first try. */
export function providerRetryStatus(retry: number): string {
  const count = Math.max(1, Math.floor(retry));
  return `${PROVIDER_RETRY_PREFIX} Retry ${count}…`;
}

export function isProviderRetryStatus(label: string): boolean {
  return label.trim().startsWith(PROVIDER_RETRY_PREFIX);
}

/** Blank clears the wait label and the chat goes back to Thinking. */
export function activityFromTurnStatus(text: string | null | undefined): ConversationActivity | null {
  const label = (text ?? "").trim();
  if (!label) return null;
  return { kind: "tool", label };
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

/**
 * A hosted turn shows the prompt immediately, then the server sends the saved
 * transcript only when the turn finishes. A list that comes back while the
 * first prompt is still running does not contain that chat yet. Opening the
 * newest saved chat then paints the previous conversation over the one the
 * user just sent. The chat on screen wins until that list includes it.
 */
export function hostedChatToOpen(input: {
  currentId: string;
  currentInRows: boolean;
  preferredId: string;
}): string {
  if (input.currentId && !input.currentInRows) return input.currentId;
  return input.preferredId;
}

/**
 * The server copy of a hosted chat can be older than the prompt already on
 * screen. Status frames do not carry messages, and a stopped turn may save
 * only the first prompt. Keep the transcript that has the newer prompt.
 * A longer tool save must not drop the concluding reply the other list already has.
 * That save is what gets written back, so a restart would miss the answer too.
 */
export function mergeHostedTranscript(shown: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return shown;
  if (shown.length === 0) return incoming;
  const shownPrompts = promptCount(shown);
  const incomingPrompts = promptCount(incoming);
  if (shownPrompts > incomingPrompts) return shown;
  if (incomingPrompts > shownPrompts) return incoming;
  const base = incoming.length >= shown.length ? incoming : shown;
  const extra = base === incoming ? shown : incoming;
  return attachPlainReply(base, extra);
}

/**
 * The transcript to paint when a turn finishes.
 * A saved copy can hold the reply in the same number of messages the live list
 * already has. A longer live list can be the tool rows only. Length then kept
 * that list, the reply was never painted, and the next save stored the gap.
 */
export function mergeFinishedTranscript(live: ChatMessage[], stored: ChatMessage[]): ChatMessage[] {
  if (!stored.length) return live;
  if (!live.length) return stored;
  const chosen = preferFinishedTranscript(live, stored);
  const other = chosen === stored ? live : stored;
  return attachPlainReply(chosen, other);
}

function promptCount(messages: ChatMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message?.role === "user") count += 1;
  }
  return count;
}

const QUIET_TOOLS = new Set(["todo_write", "enter_plan_mode", "exit_plan_mode"]);

function hasVisibleToolCall(message: ChatMessage): boolean {
  return (message.tool_calls ?? []).some((call) => !QUIET_TOOLS.has(call.name));
}

type PlainReply = {
  index: number;
  content: string;
  message: ChatMessage;
};

function hasOnlyQuietTools(message: ChatMessage): boolean {
  const calls = message.tool_calls ?? [];
  return calls.length > 0 && calls.every((call) => QUIET_TOOLS.has(call.name));
}

/**
 * The answer that ends the turn.
 * Tool rows after it still count: a late result can be appended behind the text.
 * Narration that called a tool is not the answer. Neither is a reasoning-only
 * row or a quiet todo/plan update: those used to occupy this slot and the real
 * reply was then dropped when the turn sealed.
 */
function plainReply(messages: ChatMessage[]): PlainReply | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role === "user") return null;
    if (message.role === "tool") continue;
    if (message.role !== "assistant" || message.error) continue;
    if (hasVisibleToolCall(message)) return null;
    if (hasOnlyQuietTools(message)) continue;
    const content = String(message.content ?? "").trim();
    if (!content) {
      // Reasoning with no text is not the answer. An empty row still ends the walk.
      if (String(message.reasoning ?? "").trim()) continue;
      return null;
    }
    return { index: i, content, message };
  }
  return null;
}

function preferFinishedTranscript(live: ChatMessage[], stored: ChatMessage[]): ChatMessage[] {
  if (promptCount(stored) !== promptCount(live)) {
    return promptCount(stored) > promptCount(live) ? stored : live;
  }
  if (stored.length > live.length) return stored;
  if (live.length > stored.length) return live;
  const liveReply = plainReply(live);
  const storedReply = plainReply(stored);
  if (storedReply && !liveReply) return stored;
  if (liveReply && !storedReply) return live;
  if (
    storedReply &&
    liveReply &&
    storedReply.content.length > liveReply.content.length &&
    storedReply.content.startsWith(liveReply.content)
  ) {
    return stored;
  }
  return live;
}

function toolCallIds(message: ChatMessage): string[] {
  const ids: string[] = [];
  for (const call of message.tool_calls ?? []) {
    if (call.id) ids.push(call.id);
  }
  return ids;
}

function sameToolCall(a: ChatMessage, b: ChatMessage): boolean {
  const left = toolCallIds(a);
  const right = toolCallIds(b);
  if (!left.length || !right.length) return false;
  return left.some((id) => right.includes(id));
}

function containsAssistantText(messages: ChatMessage[], text: string): boolean {
  const want = text.trim();
  if (!want) return false;
  return messages.some(
    (message) => message?.role === "assistant" && String(message.content ?? "").trim() === want,
  );
}

/**
 * The live buffer can be folded onto the assistant that also called the tools.
 * A later tool save still has the short narration, so length keeps that copy
 * and the ending disappears with the stream.
 */
function applyLongerAssistantContent(base: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  let next: ChatMessage[] | null = null;
  for (const message of extra) {
    if (!message || message.role !== "assistant" || message.error) continue;
    const full = String(message.content ?? "");
    if (!full.trim()) continue;
    const rows = next ?? base;
    const index = rows.findIndex((row) => row?.role === "assistant" && sameToolCall(row, message));
    if (index < 0) continue;
    const kept = rows[index];
    if (!kept) continue;
    const short = String(kept.content ?? "");
    if (!short.trim() || full.length <= short.length || !full.startsWith(short)) continue;
    if (!next) next = base.slice();
    next[index] = {
      ...kept,
      content: full,
      ...(String(message.reasoning ?? "").trim() ? { reasoning: message.reasoning } : {}),
    };
  }
  return next ?? base;
}

/** Put `extra`'s concluding reply onto `base` when this turn's tool list lost it. */
function attachPlainReply(base: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  if (promptCount(base) !== promptCount(extra)) return base;
  const next = applyLongerAssistantContent(base, extra);
  const reply = plainReply(extra);
  if (!reply?.content) return next;
  const current = plainReply(next);
  if (current?.content) {
    if (current.content === reply.content || current.content.startsWith(reply.content)) return next;
    if (reply.content.startsWith(current.content)) {
      const copy = next.slice();
      const kept = next[current.index];
      if (!kept) return next;
      copy[current.index] = {
        ...kept,
        content: String(reply.message.content ?? ""),
        ...(String(reply.message.reasoning ?? "").trim() ? { reasoning: reply.message.reasoning } : {}),
      };
      return copy;
    }
    // The longer list already ends on this sentence.
    if (containsAssistantText(next, reply.content)) return next;
    // Its ending is only the narration the other list already continued past.
    if (containsAssistantText(extra, current.content)) {
      return [...next, plainReplyMessage(reply.message)];
    }
    return next;
  }
  const open = openAssistant(next);
  if (open && open.content === reply.content) return next;
  if (containsAssistantText(next, reply.content)) return next;
  return [...next, plainReplyMessage(reply.message)];
}

function plainReplyMessage(message: ChatMessage): ChatMessage {
  const reasoning = String(message.reasoning ?? "").trim();
  return {
    role: "assistant",
    content: String(message.content ?? ""),
    ...(reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.thinking?.length ? { thinking: message.thinking } : {}),
    ...(message.finishedAt ? { finishedAt: message.finishedAt } : {}),
    ...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
  };
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

/**
 * A new chat has no id yet, so its composer lives under `""`.
 * Sending creates a real id. The empty key has to move with it, or the next
 * new chat still shows the prompt that was just sent.
 */
export function claimDraftForChat<T>(
  drafts: Record<string, T>,
  chatId: string,
  empty: (value: T) => boolean,
): Record<string, T> {
  if (!chatId || !("" in drafts)) return drafts;
  const held = drafts[""];
  const next = { ...drafts };
  delete next[""];
  if (empty(held) || chatId in next) return next;
  next[chatId] = held;
  return next;
}

/** Drop the composer state every unsaved new chat shares. */
export function forgetUnsavedDraft<T>(drafts: Record<string, T>): Record<string, T> {
  if (!("" in drafts)) return drafts;
  const next = { ...drafts };
  delete next[""];
  return next;
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
 * The turn clock starts once.
 * A tool step, an assistant message between tool calls, or a rejoin that stamps
 * `Date.now()` again must not move it forward. An earlier stamp still wins, so a
 * reload can put the original start back.
 */
export function keepTurnStartedAt(current: number | undefined, next: number | undefined): number {
  const have = current ?? 0;
  const want = next ?? 0;
  if (have > 0 && want > 0) return Math.min(have, want);
  if (have > 0) return have;
  return want > 0 ? want : 0;
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
  const current = running[id] ?? { activity: null, startedAt: 0 };
  const held = running[id]?.startedAt ?? 0;
  const requested = patch.startedAt !== undefined ? patch.startedAt : held;
  const next: RunningTurn = {
    activity: patch.activity !== undefined ? patch.activity : current.activity,
    startedAt: keepTurnStartedAt(held, requested),
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
/** Chats the process is still running that this page has not joined yet. */
export function localTurnsToRejoin(
  chatIds: readonly string[],
  live: readonly { conversation_id: string }[],
  known: ReadonlySet<string>,
  joined: ReadonlyMap<string, unknown>,
): string[] {
  const ids = new Set(live.map((row) => row.conversation_id));
  return chatIds.filter((id) => ids.has(id) && !known.has(id) && !joined.has(id));
}

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
 * The sidebar row the composer should follow when this chat is opened.
 * A running turn rewrites the row on every step and used to keep the model
 * from before the turn. Opening it then left the input on the previous chat.
 * Prefer the model the turn is actually sending, then the row, then disk.
 */
export function composerRowForOpen<T extends StoredComposerSettings>(
  known: T | null | undefined,
  saved: StoredComposerSettings | null | undefined,
  turnModel?: string | null,
): StoredComposerSettings {
  const running = (turnModel ?? "").trim();
  return {
    model: running || saved?.model || known?.model,
    effort: saved?.effort ?? known?.effort,
    contextWindow: saved?.contextWindow ?? known?.contextWindow,
    permission: saved?.permission ?? known?.permission,
  };
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

/**
 * Queue only while the foreground id is this conversation.
 * A turn running in another chat is invisible here. `chatShouldQueue` is the check that sees it.
 */
export function shouldQueueForChat(runningId: string, chatId: string): boolean {
  return chatTurnIsRunning(runningId, chatId);
}

/** Queue when this chat has its own turn, even if the user is looking at a different chat. */
export function chatShouldQueue(active: { has(id: string): boolean }, chatId: string): boolean {
  return Boolean(chatId) && active.has(chatId);
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

type OpenAssistant = {
  index: number;
  content: string;
  reasoning: string;
  /** Tool results follow this message, so the live buffer is the next reply. */
  trailingTools: boolean;
};

/** The assistant message the live buffer belongs to, if this turn has one. */
function openAssistant(messages: ChatMessage[]): OpenAssistant | null {
  let trailingTools = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role === "user") break;
    if (msg.role !== "assistant" || msg.error) {
      if (msg?.role === "tool") trailingTools = true;
      continue;
    }
    return {
      index: i,
      content: String(msg.content ?? "").trim(),
      reasoning: String(msg.reasoning ?? "").trim(),
      trailingTools,
    };
  }
  return null;
}

/** True when the stored text already includes the live buffer. */
function bufferHeld(stored: string, live: string): boolean {
  if (!live) return true;
  return stored === live || stored.startsWith(live);
}

/**
 * The open reply already contains this buffer.
 * A save must not clear the buffer until that is true, or the finished turn
 * paints no text until the transcript is loaded again. An earlier tool round
 * does not count: its sentence is not the reply still streaming.
 */
export function replyCoversStream(messages: ChatMessage[], text: string, reasoning = ""): boolean {
  const want = text.trim();
  const thought = reasoning.trim();
  if (!want && !thought) return true;
  const open = openAssistant(messages);
  if (!open || open.trailingTools) return false;
  return bufferHeld(open.content, want) && bufferHeld(open.reasoning, thought);
}

/**
 * True when clearing the live buffer would not take the reply off the screen.
 * The open reply counts, and so does the sentence already saved just before a
 * tool result. A reply that exists only in the buffer must stay there.
 */
export function messagesShowStream(messages: ChatMessage[], text: string, reasoning = ""): boolean {
  if (replyCoversStream(messages, text, reasoning)) return true;
  const want = text.trim();
  const thought = reasoning.trim();
  if (!want && !thought) return true;
  const open = openAssistant(messages);
  if (!open?.trailingTools) return false;
  // The narration before the tools is already on screen. Only an exact match
  // is that narration. A prefix match cleared the real reply when it started
  // with the same words, and the bubble never came back.
  return open.content === want && bufferHeld(open.reasoning, thought);
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
  const want = text.trim();
  if (!want && !reasoning) return messages;
  if (replyCoversStream(messages, text, reasoning)) return messages;
  const open = openAssistant(messages);
  // The snapshot has the start of this same reply and the buffer has the rest.
  if (
    open &&
    !open.trailingTools &&
    open.content &&
    want.startsWith(open.content) &&
    want !== open.content
  ) {
    const next = messages.slice();
    const msg = messages[open.index];
    if (!msg) return messages;
    next[open.index] = {
      ...msg,
      content: text,
      ...(reasoning ? { reasoning } : {}),
    };
    return next;
  }
  return [
    ...messages,
    {
      role: "assistant",
      content: text,
      ...(reasoning ? { reasoning } : {}),
    },
  ];
}
