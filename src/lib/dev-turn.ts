import { TURN_FAILURE_PREFIX, type ChatMessage } from "./dev.ts";

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
    text.includes("timeout")
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

export const EMPTY_COMPLETION_MESSAGE = "Grok returned an empty reply.";

export function isEmptyCompletion(text: string, toolCalls: { length: number }): boolean {
  return !(text || "").trim() && toolCalls.length === 0;
}

export function turnAppliesToChat(turnId: string, visibleId: string): boolean {
  return Boolean(turnId) && turnId === visibleId;
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

export function skipToolIfAborted(signal: AbortSignal): string | null {
  return signal.aborted ? SKIPPED_STOPPED : null;
}
