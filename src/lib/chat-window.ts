/** How many turns stay mounted. Older turns stay in memory but are not rendered. */
export const CHAT_WINDOW_TURNS = 24;

/** Turns revealed each time the user scrolls up to the start of the mounted window. */
export const CHAT_WINDOW_PAGE = 16;

export type ChatTurnSlice = {
  start: number;
  count: number;
};

export function clampTurnCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

/** Oldest-first turns. `revealed` is how many turns from the end should mount. */
export function chatTurnSlice(turnCount: number, revealed: number): ChatTurnSlice {
  const count = clampTurnCount(turnCount);
  const want = Math.max(CHAT_WINDOW_TURNS, clampTurnCount(revealed));
  if (count === 0 || want >= count) return { start: 0, count };
  return { start: count - want, count: want };
}

export function revealOlderTurns(turnCount: number, revealed: number): number {
  const count = clampTurnCount(turnCount);
  const next = Math.max(CHAT_WINDOW_TURNS, clampTurnCount(revealed)) + CHAT_WINDOW_PAGE;
  return Math.min(count, next);
}

export function hasOlderTurns(turnCount: number, revealed: number): boolean {
  return chatTurnSlice(turnCount, revealed).start > 0;
}

/**
 * Keep the viewport still when older content is inserted above it.
 * `before` is the scroller metrics captured before the prepend.
 */
export function scrollTopAfterPrepend(
  before: { scrollTop: number; scrollHeight: number },
  afterScrollHeight: number,
): number {
  const grew = afterScrollHeight - before.scrollHeight;
  if (!Number.isFinite(grew) || grew <= 0) return before.scrollTop;
  return before.scrollTop + grew;
}
