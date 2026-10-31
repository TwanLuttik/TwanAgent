export type FitClock = {
  request(fn: () => void): number;
  cancel(id: number): void;
};

const RESIZING = "data-pane-resizing";
const SLIDING = "data-pane-sliding";

export const PANE_FIT_EVENT = "twan-pane-fit";

type FlagHost = {
  hasAttribute(name: string): boolean;
};

type FlagTarget = {
  closest(selector: string): unknown;
};

/** True while a pane drag or slide is in progress. Terminals outside the slot still see the document flag. */
export function layoutMoving(root: FlagHost | null, el: FlagTarget | null): boolean {
  if (root?.hasAttribute(RESIZING) || root?.hasAttribute(SLIDING)) return true;
  return !!el?.closest(`[${RESIZING}], [${SLIDING}]`);
}

export function paneLayoutMoving(el?: Element | null): boolean {
  if (typeof document === "undefined") return false;
  return layoutMoving(document.documentElement, el ?? null);
}

function documentRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

export function markPaneResizing(on: boolean): void {
  const root = documentRoot();
  if (!root) return;
  if (on) root.setAttribute(RESIZING, "");
  else root.removeAttribute(RESIZING);
}

export function markPaneSliding(on: boolean): void {
  const root = documentRoot();
  if (!root) return;
  if (on) root.setAttribute(SLIDING, "");
  else root.removeAttribute(SLIDING);
}

/** Ask every visible terminal to fit once. Each gate waits a frame, so pointer-up stays cheap. */
export function requestPaneFit(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PANE_FIT_EVENT));
}

export function onPaneFit(fn: () => void): () => void {
  window.addEventListener(PANE_FIT_EVENT, fn);
  return () => window.removeEventListener(PANE_FIT_EVENT, fn);
}

/**
 * fit() rebuilds the character grid and tells the shell. While the pane edge
 * is moving, size changes are ignored so the drag does not do that work on
 * every frame. settle() runs the one fit after the pointer is released or
 * the slide finishes, even when the box does not change size again.
 */
export function createPaneFitGate(opts: {
  clock: FitClock;
  moving: () => boolean;
  shown: () => boolean;
  fit: () => void;
}): { noteResize: () => void; settle: () => void; dispose: () => void } {
  let frame = 0;

  function schedule() {
    if (frame || !opts.shown() || opts.moving()) return;
    frame = opts.clock.request(() => {
      frame = 0;
      if (!opts.shown() || opts.moving()) return;
      opts.fit();
    });
  }

  return {
    noteResize: schedule,
    settle: schedule,
    dispose() {
      if (frame) opts.clock.cancel(frame);
      frame = 0;
    },
  };
}

export function browserFitClock(): FitClock {
  return {
    request: (fn) => window.requestAnimationFrame(fn),
    cancel: (id) => window.cancelAnimationFrame(id),
  };
}
