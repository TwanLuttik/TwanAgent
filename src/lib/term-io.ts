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

const WHEEL_LINE_PX = 40;

/**
 * Lines to move the terminal viewport. A trackpad tick is a fraction of a
 * line; a mouse notch is about one line. Alt (xterm fast scroll) multiplies.
 */
export function terminalWheelLines(event: {
  deltaY: number;
  deltaMode?: number;
  altKey?: boolean;
}): number {
  if (!event.deltaY) return 0;
  const px = event.deltaMode === 1 ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
  const lines = Math.max(1, Math.round(Math.abs(px) / WHEEL_LINE_PX));
  const speed = event.altKey ? 5 : 1;
  return Math.sign(px) * lines * speed;
}

type XtermInput = {
  onData: (fn: (data: string) => void) => unknown;
  onBinary: (fn: (data: string) => void) => unknown;
  hasSelection?: () => boolean;
  attachCustomKeyEventHandler?: (fn: (event: KeyboardEvent) => boolean) => void;
  element?: HTMLElement | null;
  modes?: { mouseTrackingMode?: string };
  scrollLines?: (amount: number) => void;
};

/**
 * Ctrl/Cmd+C copies when text is selected. Otherwise it is the terminal
 * interrupt (ETX), so a running command can be cancelled.
 */
export function terminalKeyReachesPty(
  event: { type?: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  hasSelection: boolean,
): boolean {
  if (event.type && event.type !== "keydown") return true;
  const mod = event.metaKey || event.ctrlKey;
  const plain = mod && !event.altKey && !event.shiftKey;
  const key = event.key.toLowerCase();
  if (plain && key === "c") return !hasSelection;
  if (plain && key === "a") return false;
  return true;
}

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
    // The viewport overlay ignores pointer events so TUI clicks hit the screen.
    // That also drops the wheel, and the document scroll lock cancels it before
    // xterm's own handler. Scroll the buffer unless the app asked for wheel reports.
    element.addEventListener(
      "wheel",
      (event) => {
        if (term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== "none") return;
        const lines = terminalWheelLines(event);
        if (!lines) return;
        event.preventDefault();
        event.stopPropagation();
        term.scrollLines?.(lines);
      },
      { capture: true, passive: false },
    );
  }
  term.attachCustomKeyEventHandler?.((event) =>
    terminalKeyReachesPty(event, Boolean(term.hasSelection?.())),
  );
}
