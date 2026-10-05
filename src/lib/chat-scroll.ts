export const CHAT_NEAR_BOTTOM_PX = 64;
export const CHAT_BOTTOM_PAD_FALLBACK = 160;
const CHAT_COMPOSER_GAP_PX = 24;

export function chatBottomPadding(composerHeight: number, gap = CHAT_COMPOSER_GAP_PX): number {
  if (!Number.isFinite(composerHeight) || composerHeight <= 0) return CHAT_BOTTOM_PAD_FALLBACK;
  return Math.ceil(composerHeight + gap);
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
  const view = el.clientHeight ?? 0;
  el.scrollTop = Math.max(0, el.scrollHeight - view);
}
