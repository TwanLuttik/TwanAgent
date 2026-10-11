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
