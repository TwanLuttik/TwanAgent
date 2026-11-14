export const CHAT_NEAR_BOTTOM_PX = 64;
export const CHAT_BOTTOM_PAD_FALLBACK = 160;
const CHAT_COMPOSER_GAP_PX = 24;
/** Ease toward the end. Large enough to catch up with streaming text, small enough to stay smooth. */
export const CHAT_FOLLOW_EASE = 0.28;
/** A gap smaller than this snaps closed instead of easing the last pixel. */
export const CHAT_FOLLOW_SNAP_PX = 1;

export function chatBottomPadding(composerHeight: number, gap = CHAT_COMPOSER_GAP_PX): number {
  if (!Number.isFinite(composerHeight) || composerHeight <= 0) return CHAT_BOTTOM_PAD_FALLBACK;
  return Math.ceil(composerHeight + gap);
}

export function chatScrollMax(el: { scrollHeight: number; clientHeight?: number }): number {
  const view = el.clientHeight ?? 0;
  return Math.max(0, el.scrollHeight - view);
}

export function isNearBottom(el: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}, threshold = CHAT_NEAR_BOTTOM_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function scrollChatToEnd(
  el: { scrollTop: number; scrollHeight: number; clientHeight?: number } | null,
  pin: boolean,
): void {
  if (!el || !pin) return;
  el.scrollTop = chatScrollMax(el);
}

type StoredChatScroll = { top: number; nearBottom: boolean };

const scrollByChat = new Map<string, StoredChatScroll>();

/** Remember where this conversation was scrolled so another pane can take the screen. */
export function rememberChatScroll(id: string, scrollTop: number, nearBottom = false) {
  if (!id || !Number.isFinite(scrollTop)) return;
  scrollByChat.set(id, { top: Math.max(0, scrollTop), nearBottom });
}

export function chatScrollFor(id: string): number | null {
  const value = scrollByChat.get(id);
  return value == null ? null : value.top;
}

/** The chat was at the end when it was scrolled, not only a pixel offset from a taller page. */
export function chatScrollNearBottom(id: string): boolean {
  return scrollByChat.get(id)?.nearBottom ?? false;
}

/**
 * Put a saved scroll back once this chat's transcript is on screen.
 * A chat left at the bottom pins to the end of the mounted page even when the
 * old offset is taller than that page. An offset that does not fit, and was
 * not the bottom, does not stick — the caller still marks the chat settled so
 * a later scroll to the end can follow.
 */
export function restoreChatScroll(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  savedTop: number | null,
  nearBottom: boolean,
): { scrollTop: number; stick: boolean } {
  if (nearBottom || savedTop == null) {
    return { scrollTop: chatScrollMax(el), stick: true };
  }
  if (!scrollOffsetFits(el, savedTop)) {
    return { scrollTop: el.scrollTop, stick: false };
  }
  const scrollTop = Math.min(savedTop, chatScrollMax(el));
  return {
    scrollTop,
    stick: stickToBottomAfterRestore(
      { scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      savedTop,
    ),
  };
}

export function forgetChatScroll(id: string) {
  if (id) scrollByChat.delete(id);
}

/**
 * A pane follows its own tail only while that pane is at the bottom.
 * The other pane in a split does not count, so one scrolled-up chat stays put.
 */
export function panesThatFollow<T extends { id: string; nearBottom: boolean }>(panes: readonly T[]): string[] {
  const ids: string[] = [];
  for (const pane of panes) {
    if (!pane.id || !pane.nearBottom || ids.includes(pane.id)) continue;
    ids.push(pane.id);
  }
  return ids;
}

/**
 * The scroller can put this offset back.
 * No saved offset means there is nothing to wait for.
 * A large offset on a short shell is not at the bottom. It has not been laid out yet.
 */
export function scrollOffsetFits(
  el: { scrollHeight: number; clientHeight?: number },
  saved: number | null,
): boolean {
  if (saved == null || !Number.isFinite(saved)) return true;
  return saved <= chatScrollMax(el) + CHAT_NEAR_BOTTOM_PX;
}

/**
 * Stick after putting a saved offset back.
 * No saved offset means the pane has not been scrolled, so it follows.
 * An offset the current transcript cannot reach means the messages are not in
 * the scroller yet, so it does not follow until that offset can be applied.
 */
export function stickToBottomAfterRestore(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  saved: number | null,
): boolean {
  if (saved == null) return true;
  const max = chatScrollMax(el);
  if (saved > max + CHAT_NEAR_BOTTOM_PX) return false;
  return isNearBottom({
    scrollTop: Math.min(saved, max),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  });
}

type ChatPadEl = {
  style: { paddingBottom: string };
  dataset: { chatPadMode?: string };
};

type ChatPadScroller = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  querySelector: (selector: string) => ChatPadEl | null;
};

/**
 * Write the composer's new pad before the next paint and report where to scroll.
 * Returns null when the pad did not change, or when the composer is centered
 * and the spacer is the small middle gap rather than the dock.
 * The caller assigns scrollTop so a follow flag can cover the scroll event.
 */
export function applyComposerPadResize(scroller: ChatPadScroller | null, nextPad: number, pin: boolean): number | null {
  if (!scroller || !Number.isFinite(nextPad)) return null;
  const pad = scroller.querySelector("[data-chat-pad]");
  if (!pad || pad.dataset.chatPadMode === "center") return null;
  const parsed = parseFloat(pad.style.paddingBottom);
  const previous = Number.isFinite(parsed) ? parsed : nextPad;
  if (previous === nextPad) return null;
  const top = scrollTopAfterComposerResize(scroller, previous, nextPad, pin);
  pad.style.paddingBottom = `${nextPad}px`;
  return top;
}

/**
 * Scroll position after the composer box changes height.
 * `scrollHeight` still includes `previousPad`. Pinning to that stale end leaves
 * the messages too high once the field shrinks — the chat looks scrolled up.
 * A reader who is not pinned keeps their place; the pad is below them.
 */
export function scrollTopAfterComposerResize(
  el: { scrollTop: number; scrollHeight: number; clientHeight?: number },
  previousPad: number,
  nextPad: number,
  pin: boolean,
): number {
  const view = el.clientHeight ?? 0;
  const delta = (Number.isFinite(nextPad) ? nextPad : 0) - (Number.isFinite(previousPad) ? previousPad : 0);
  const max = Math.max(0, el.scrollHeight + delta - view);
  if (pin) return max;
  return Math.min(Math.max(0, el.scrollTop), max);
}

/** Jump to the end in one assignment when stick-to-bottom is on. */
export function pinChatToEnd(
  el: { scrollTop: number; scrollHeight: number; clientHeight?: number } | null,
  pin: boolean,
): void {
  scrollChatToEnd(el, pin);
}

/**
 * Move part of the way to the end.
 * Returns true when the view is still short, so the caller keeps following.
 * The live chat no longer uses this loop; it stays for tests.
 */
export function easeChatToEnd(
  el: { scrollTop: number; scrollHeight: number; clientHeight?: number } | null,
  pin: boolean,
  ease = CHAT_FOLLOW_EASE,
): boolean {
  if (!el || !pin) return false;
  const max = chatScrollMax(el);
  const gap = max - el.scrollTop;
  if (gap <= CHAT_FOLLOW_SNAP_PX) {
    if (el.scrollTop !== max) el.scrollTop = max;
    return false;
  }
  const step = Math.max(1, gap * ease);
  const next = Math.min(max, el.scrollTop + step);
  if (max - next <= CHAT_FOLLOW_SNAP_PX) {
    el.scrollTop = max;
    return false;
  }
  el.scrollTop = next;
  return true;
}
