export const SKIPPED_STOPPED = "Skipped: stopped.";

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
