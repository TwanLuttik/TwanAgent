export type WheelBox = {
  overflowX: string;
  overflowY: string;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  parent?: WheelBox | null;
};

function canScroll(
  overflow: string,
  pos: number,
  size: number,
  client: number,
  delta: number,
): boolean {
  if (delta === 0) return false;
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") return false;
  if (size <= client) return false;
  if (delta < 0) return pos > 0;
  return pos + client < size;
}

export function canConsumeWheel(el: WheelBox, deltaX: number, deltaY: number): boolean {
  return (
    canScroll(el.overflowY, el.scrollTop, el.scrollHeight, el.clientHeight, deltaY) ||
    canScroll(el.overflowX, el.scrollLeft, el.scrollWidth, el.clientWidth, deltaX)
  );
}

export function shouldPreventDocumentWheel(
  target: WheelBox | null,
  deltaX: number,
  deltaY: number,
): boolean {
  let el = target;
  while (el) {
    if (canConsumeWheel(el, deltaX, deltaY)) return false;
    el = el.parent ?? null;
  }
  return true;
}

function boxChain(target: EventTarget | null): WheelBox | null {
  if (typeof Element === "undefined" || !(target instanceof Element)) return null;
  let el: Element | null = target;
  let head: WheelBox | null = null;
  let prev: WheelBox | null = null;
  while (el) {
    const style = getComputedStyle(el);
    const node: WheelBox = {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
    if (!head) head = node;
    if (prev) prev.parent = node;
    prev = node;
    el = el.parentElement;
  }
  return head;
}

function wheelDeltas(event: Event): { deltaX: number; deltaY: number } | null {
  if (!("deltaX" in event) || !("deltaY" in event)) return null;
  const { deltaX, deltaY } = event as { deltaX: unknown; deltaY: unknown };
  if (typeof deltaX !== "number" || typeof deltaY !== "number") return null;
  return { deltaX, deltaY };
}

export function installDocumentScrollLock(root: EventTarget = document): () => void {
  const onWheel = (event: Event) => {
    const delta = wheelDeltas(event);
    if (!delta) return;
    if (!shouldPreventDocumentWheel(boxChain(event.target), delta.deltaX, delta.deltaY)) return;
    event.preventDefault();
  };
  root.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => root.removeEventListener("wheel", onWheel, true);
}
