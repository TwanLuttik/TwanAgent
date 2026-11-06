/** Cap so a busy transcript cannot postpone the file pane forever. */
export const PANE_IDLE_TIMEOUT_MS = 480;

const FALLBACK_DELAY_MS = 32;

export type IdleClock = {
  requestIdleCallback?: (work: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout: (work: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
};

/**
 * Run after the conversation has painted and the window can take a click.
 * An idle callback waits for input. A short timer covers webviews without one.
 */
export function afterInput(work: () => void, clock?: IdleClock, timeoutMs = PANE_IDLE_TIMEOUT_MS): () => void {
  const host = clock ?? browserClock();
  let cancelled = false;
  const run = () => {
    if (!cancelled) work();
  };
  if (host.requestIdleCallback) {
    const id = host.requestIdleCallback(run, { timeout: timeoutMs });
    return () => {
      cancelled = true;
      host.cancelIdleCallback?.(id);
    };
  }
  const id = host.setTimeout(run, FALLBACK_DELAY_MS);
  return () => {
    cancelled = true;
    host.clearTimeout(id);
  };
}

function browserClock(): IdleClock {
  return {
    requestIdleCallback:
      typeof requestIdleCallback === "function"
        ? (fn, options) => requestIdleCallback(fn, options)
        : undefined,
    cancelIdleCallback:
      typeof cancelIdleCallback === "function" ? (id) => cancelIdleCallback(id) : undefined,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}
