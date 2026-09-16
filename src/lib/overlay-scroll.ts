export const OVERLAY_SCROLL_HIDE_MS = 800;

type ScrollHost = {
  dataset: { scrolling?: string };
};

function scrollHost(target: EventTarget | null): ScrollHost | null {
  if (!target || typeof target !== "object") return null;
  if (!("dataset" in target)) return null;
  return target as ScrollHost;
}

export function installOverlayScroll(
  root: EventTarget = document,
  wait: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
): () => void {
  const timers = new WeakMap<object, ReturnType<typeof setTimeout>>();

  const onScroll = (event: Event) => {
    const el = scrollHost(event.target);
    if (!el) return;
    el.dataset.scrolling = "";
    const prev = timers.get(el);
    if (prev) cancel(prev);
    const id = wait(() => {
      delete el.dataset.scrolling;
      timers.delete(el);
    }, OVERLAY_SCROLL_HIDE_MS);
    timers.set(el, id);
  };

  root.addEventListener("scroll", onScroll, true);
  return () => root.removeEventListener("scroll", onScroll, true);
}
