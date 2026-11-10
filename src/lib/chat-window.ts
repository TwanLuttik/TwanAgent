export type HeldTranscript<T> = {
  id: string;
  messages: T;
  model: string;
};

/**
 * Keep showing the transcript already on screen until the next chat's messages arrive.
 * The click changes the active id first. Rendering the previous chat under that id
 * parses it again, which is the hitch before the next conversation shows.
 */
/**
 * The selected chat is not the transcript on screen yet.
 * The click should paint the row and a loading cover first. The next
 * conversation renders on the following frame, so the window can take another click.
 */
export function chatSwitchPending(selectedId: string, shownId: string): boolean {
  return selectedId !== "" && selectedId !== shownId;
}

export function holdTranscript<T>(
  held: HeldTranscript<T>,
  messages: T,
  activeId: string,
  model: string,
): HeldTranscript<T> {
  if (messages !== held.messages) return { id: activeId, messages, model };
  return held;
}

/**
 * Remember which transcript belongs to the chat on screen.
 * Selecting a row changes the active id before its messages arrive. The list
 * still on screen belongs to the chat we left. Storing it under the new id
 * makes both rows open that one conversation, and a later click never fetches
 * the other.
 */
export function rememberShownTranscript<T>(
  cache: Map<string, T>,
  shownId: string,
  activeId: string,
  messages: T,
  previousMessages: T,
): string {
  if (!activeId) return messages === previousMessages ? shownId : "";
  if (activeId !== shownId && messages === previousMessages) return shownId;
  cache.set(activeId, messages);
  return activeId;
}

/**
 * The open that loaded this transcript is still the one the user selected.
 * `shownId` stays on the chat we left until these messages commit, so it cannot
 * be this gate. Gating on it drops the first click and the window stays there
 * until the same row is selected again.
 */
export function openedTranscriptIsCurrent(
  generation: number,
  latestGeneration: number,
  activeId: string,
  requestedId: string,
): boolean {
  return requestedId !== "" && generation === latestGeneration && activeId === requestedId;
}

/**
 * The saved list for `id`, unless a torn switch stored the other chat's array
 * under this id. That copy is not this conversation.
 */
export function cachedTranscript<T>(
  cache: ReadonlyMap<string, T>,
  id: string,
  shownId: string,
  shownMessages: T,
): T | undefined {
  if (!id) return undefined;
  const cached = cache.get(id);
  if (cached === undefined) return undefined;
  if (id !== shownId && cached === shownMessages) return undefined;
  return cached;
}

/** How many messages to paint before the rest of a long turn. One turn can be hundreds of tool rows. */
export const TRANSCRIPT_PAGE_MESSAGES = 48;

/** Index of the first message in the last `limit` messages. */
export function transcriptMessageStart(length: number, limit: number): number {
  const cap = Math.max(1, Math.floor(limit) || 1);
  if (!Number.isFinite(length) || length <= cap) return 0;
  return Math.floor(length) - cap;
}

/** How many rows to mount on the next frame. Stays on `length` once the whole chat is up. */
export function nextTranscriptLimit(length: number, shown: number, page = TRANSCRIPT_PAGE_MESSAGES): number {
  const current = shown > 0 ? shown : page;
  if (!Number.isFinite(length) || length <= current) return Math.max(0, Math.floor(length) || 0);
  return Math.min(Math.floor(length), current + page);
}

type WindowTurn = { user?: unknown; rest: readonly unknown[] };

function turnRows(turn: WindowTurn): number {
  return (turn.user ? 1 : 0) + turn.rest.length;
}

/** Rows from the end of a parsed transcript. Full turns keep their object identity so memo can skip them. */
export function visibleTranscriptEnd<T extends WindowTurn, I>(
  settled: readonly T[],
  tail: readonly I[],
  limit: number,
): { settled: T[]; tail: I[]; hidden: boolean } {
  const cap = Math.max(1, Math.floor(limit) || 1);
  let total = tail.length;
  for (const turn of settled) total += turnRows(turn);
  if (total <= cap) return { settled: settled.slice(), tail: tail.slice(), hidden: false };

  let budget = cap;
  const tailCount = Math.min(tail.length, budget);
  budget -= tailCount;
  const shownTail = tail.slice(tail.length - tailCount);
  const shown: T[] = [];
  for (let i = settled.length - 1; i >= 0 && budget > 0; i--) {
    const turn = settled[i]!;
    const size = turnRows(turn);
    if (size <= budget) {
      shown.push(turn);
      budget -= size;
      continue;
    }
    const keep = budget;
    if (turn.user) {
      const restKeep = Math.max(0, keep - 1);
      shown.push({ ...turn, rest: turn.rest.slice(turn.rest.length - restKeep) });
    } else {
      shown.push({ ...turn, rest: turn.rest.slice(turn.rest.length - keep) });
    }
    budget = 0;
  }
  shown.reverse();
  return { settled: shown, tail: shownTail, hidden: true };
}

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
