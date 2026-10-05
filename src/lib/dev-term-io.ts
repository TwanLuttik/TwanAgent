/** xterm `onBinary` payload: each JS char is one byte (0–255). */
export function binaryStringToBytes(data: string): number[] {
  const bytes = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * A plain drag should select text. Shift (and Option on macOS) stays available
 * for apps that turned mouse tracking on, such as a full-screen TUI.
 * A click that has not moved yet must still reach xterm so the terminal focuses.
 */
export function dragSelectsTerminalText(event: { button: number; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.shiftKey && !event.altKey;
}

const DRAG_START = 4;

export function pointerMovedPast(
  start: { x: number; y: number },
  point: { x?: number; y?: number; clientX?: number; clientY?: number },
): boolean {
  const x = point.clientX ?? point.x ?? start.x;
  const y = point.clientY ?? point.y ?? start.y;
  return Math.hypot(x - start.x, y - start.y) >= DRAG_START;
}

type XtermInput = {
  onData: (fn: (data: string) => void) => unknown;
  onBinary: (fn: (data: string) => void) => unknown;
  attachCustomKeyEventHandler?: (fn: (event: KeyboardEvent) => boolean) => void;
  element?: HTMLElement | null;
};

export function attachXtermInput(
  term: XtermInput,
  writeText: (data: string) => void,
  writeBytes: (data: number[]) => void,
): void {
  term.onData(writeText);
  term.onBinary((data) => writeBytes(binaryStringToBytes(data)));
  // xterm disables its own selection while mouse tracking is on, and its
  // mousedown handler sends the click to the pty before selection can start.
  // Stop that only after the pointer actually moves. A still click must reach
  // xterm so the hidden textarea focuses and typing works.
  const element = term.element;
  if (element) {
    let drag: { x: number; y: number } | null = null;
    element.addEventListener(
      "mousedown",
      (event) => {
        drag = dragSelectsTerminalText(event) ? { x: event.clientX, y: event.clientY } : null;
      },
      true,
    );
    element.addEventListener(
      "mousemove",
      (event) => {
        if (!drag || (event.buttons & 1) === 0) return;
        if (!pointerMovedPast(drag, event)) return;
        drag = null;
        event.stopPropagation();
      },
      true,
    );
    element.addEventListener("mouseup", () => {
      drag = null;
    });
  }
  term.attachCustomKeyEventHandler?.((event) => {
    if (event.type !== "keydown") return true;
    const mod = event.metaKey || event.ctrlKey;
    const plain = mod && !event.altKey && !event.shiftKey;
    const key = event.key.toLowerCase();
    if (plain && (key === "c" || key === "a")) return false;
    return true;
  });
}
