export const TOOL_ROW_STAGGER_MS = 200;

export type ToolRevealStep = { index: number; delay: number };

/**
 * How many folded rows were already on screen before this trail painted.
 * A live trail remounts when text lands between tool batches. The same row
 * count, or a longer continuation of the labels already seen, stays put.
 * A shorter list or a fresh batch animates from the start.
 * An empty `seenSignature` also returns 0. That does not mean "animate the
 * open chat": nothing was painted in this visit yet. `toolRowsVisibleOnMount`
 * turns that into the full row count so selecting a running chat stays still.
 * Folded labels such as "Read app.ts" change text as the count grows, so a
 * same-length list counts as the rows already showing rather than a new batch.
 */
export function toolRowsAlreadyShown(signature: string, seenSignature: string): number {
  if (!signature || !seenSignature) return 0;
  const seenCount = seenSignature.split("\n").length;
  if (signature === seenSignature) return seenCount;
  if (signature.startsWith(`${seenSignature}\n`)) return seenCount;
  const nextCount = signature.split("\n").length;
  if (nextCount === seenCount) return seenCount;
  return 0;
}

/**
 * How many folded rows are already on screen when a live trail mounts.
 * No signature yet means this chat was just opened, or opened again after
 * leaving it: every call that already ran is visible at once. A signature
 * from earlier in this visit means we are still watching, so a continuation
 * keeps those rows and a fresh batch starts from zero.
 */
export function toolRowsVisibleOnMount(rowCount: number, signature: string, seenSignature: string): number {
  if (rowCount <= 0) return 0;
  if (!seenSignature) return rowCount;
  return toolRowsAlreadyShown(signature, seenSignature);
}

/**
 * Rows already on screen when a live trail mounts should appear at once.
 * Only rows that arrive while the conversation is open stagger in.
 * `queued` is how many rows have already been scheduled. Pass the mounted
 * total as `queued` on the first call so those rows are treated as seen.
 */
export function toolRevealSteps(total: number, queued: number, now: number, nextAt: number): ToolRevealStep[] {
  if (total <= queued) return [];
  const steps: ToolRevealStep[] = [];
  let at = nextAt > now ? nextAt : now;
  for (let i = queued; i < total; i++) {
    steps.push({ index: i, delay: at - now });
    at += TOOL_ROW_STAGGER_MS;
  }
  return steps;
}

/** When the next row should start, after `steps` have been scheduled. */
export function toolRevealNextAt(total: number, queued: number, now: number, nextAt: number): number {
  if (total <= queued) return nextAt;
  const start = nextAt > now ? nextAt : now;
  return start + (total - queued) * TOOL_ROW_STAGGER_MS;
}
