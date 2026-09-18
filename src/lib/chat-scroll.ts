export const CHAT_NEAR_BOTTOM_PX = 64;

export function isNearBottom(el: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}, threshold = CHAT_NEAR_BOTTOM_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
