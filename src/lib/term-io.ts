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

/** Scheme plus a run of URL characters. Trailing punctuation is trimmed separately. */
const TERMINAL_URL = /https?:\/\/[^\s<>"']+/gi;
const URL_TRAILING = /[.,;:!?)>\]]+$/;

/**
 * One physical row of a wrapped line, in buffer order. `text` is the row
 * without the cells past `cols`.
 */
export type TerminalLinkRow = { y: number; text: string; wrapped: boolean };

/**
 * http(s) links on the wrapped line that contains `rows[anchor]`. A URL split
 * by the terminal width is one range, so hovering any piece of it underlines
 * the whole address.
 */
export function terminalLinksInRows(
  rows: TerminalLinkRow[],
  anchor: number,
  cols: number,
): { text: string; startX: number; startY: number; endX: number; endY: number }[] {
  if (cols < 1 || anchor < 0 || anchor >= rows.length) return [];
  let first = anchor;
  while (first > 0 && rows[first]?.wrapped) first -= 1;
  let last = anchor;
  while (last + 1 < rows.length && rows[last + 1]?.wrapped) last += 1;

  let joined = "";
  const owned: number[] = [];
  for (let i = first; i <= last; i++) {
    const text = rows[i]?.text.slice(0, cols) ?? "";
    joined += text;
    for (let n = 0; n < text.length; n++) owned.push(i);
  }

  const links: { text: string; startX: number; startY: number; endX: number; endY: number }[] = [];
  TERMINAL_URL.lastIndex = 0;
  for (const match of joined.matchAll(TERMINAL_URL)) {
    const raw = match[0];
    const trimmed = raw.replace(URL_TRAILING, "").length;
    if (trimmed <= "https://".length) continue;
    const from = match.index ?? 0;
    const to = from + trimmed - 1;
    const startRow = owned[from];
    const endRow = owned[to];
    if (startRow == null || endRow == null) continue;
    const startY = rows[startRow]?.y;
    const endY = rows[endRow]?.y;
    if (startY == null || endY == null) continue;
    let startX = 1;
    for (let i = from - 1; i >= 0 && owned[i] === startRow; i--) startX += 1;
    let endX = 1;
    for (let i = to - 1; i >= 0 && owned[i] === endRow; i--) endX += 1;
    links.push({ text: joined.slice(from, from + trimmed), startX, startY, endX, endY });
  }
  return links;
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
  cols?: number;
  buffer?: {
    active: {
      viewportY: number;
      length: number;
      getLine: (y: number) => { isWrapped: boolean; translateToString: (trimRight?: boolean) => string } | undefined;
    };
  };
  registerLinkProvider?: (provider: TerminalLinkProvider) => { dispose: () => void };
};

type TerminalLink = {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  text: string;
  decorations: { pointerCursor: boolean; underline: boolean };
  activate: (event: MouseEvent, text: string) => void;
  hover?: (event: MouseEvent, text: string) => void;
  leave?: (event: MouseEvent, text: string) => void;
};

type TerminalLinkProvider = {
  provideLinks: (bufferLineNumber: number, callback: (links: TerminalLink[] | undefined) => void) => void;
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

/**
 * Command on macOS, Ctrl elsewhere. A lone Command press often produces no
 * key event while the terminal is focused, so mouse events count too.
 */
export function terminalLinkModifierDown(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  getModifierState?: (key: string) => boolean;
}, mac = terminalIsMac()): boolean {
  if (mac) return event.metaKey || event.getModifierState?.("Meta") === true;
  return event.ctrlKey || event.getModifierState?.("Control") === true;
}

export function terminalIsMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * Plain URLs stay ordinary text. Holding Command (Ctrl elsewhere) makes the
 * one under the pointer clickable: it underlines, the cursor becomes a
 * pointer, and a click opens it. Releasing the key clears that immediately.
 */
export function attachTerminalLinks(
  term: XtermInput,
  open: (url: string) => void,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const element = term.element;
  if (!element || !term.registerLinkProvider) return () => undefined;

  let armed = false;
  // The modifier can already be down when the pointer arrives. Keydown will
  // not fire again, so the next move has to notice it and paint the link.
  let hovering = false;
  let hovered: TerminalLink | null = null;
  const show = (link: TerminalLink, on: boolean) => {
    link.decorations.underline = on;
    link.decorations.pointerCursor = on;
  };
  const paint = () => {
    if (!hovered) return;
    show(hovered, armed);
  };
  const mac = terminalIsMac();

  const onKey = (event: Event) => {
    const key = event as KeyboardEvent;
    if (key.key !== "Meta" && key.key !== "Control") return;
    if (!terminalLinkModifierDown(key, mac) && event.type !== "keyup") return;
    const down = event.type === "keydown" && terminalLinkModifierDown(key, mac);
    if (armed === down) return;
    armed = down;
    // The pointer may already be sitting on the link. macOS delivers no
    // mousemove while Command is held, and xterm only asks for a link when
    // the pointer enters a cell, so ask again at the last known position.
    if (down) replayPointer();
    paint();
  };
  const onBlur = () => {
    if (!armed) return;
    armed = false;
    paint();
  };
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("keyup", onKey, true);
  target.addEventListener("blur", onBlur);
  // xterm asks providers for a link only when the pointer enters a new cell.
  // Holding Command while already on a URL never crosses that boundary, so
  // replay the last pointer position one pixel over and back. The cursor stays put.
  let pointer: { x: number; y: number } | null = null;
  let replaying = false;
  const replayPointer = () => {
    const screen = element.querySelector(".xterm-screen");
    const view = element.ownerDocument?.defaultView;
    if (!screen || !view || !pointer) return;
    const init = { bubbles: true, clientX: pointer.x, clientY: pointer.y, metaKey: mac, ctrlKey: !mac };
    replaying = true;
    screen.dispatchEvent(new view.MouseEvent("mousemove", { ...init, clientX: pointer.x + 1 }));
    screen.dispatchEvent(new view.MouseEvent("mousemove", init));
    replaying = false;
  };
  const onMove = (event: Event) => {
    if (replaying) return;
    const move = event as MouseEvent;
    pointer = { x: move.clientX, y: move.clientY };
    // A move can report the modifier as up. Trust the key that is actually held.
    const down = armed || terminalLinkModifierDown(move, mac);
    if (!hovering) return;
    if (!down) return;
    armed = true;
    paint();
  };
  element.addEventListener("mousemove", onMove);

  const provider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const active = term.buffer?.active;
      const cols = term.cols ?? 0;
      if (!active || cols < 1) {
        callback(undefined);
        return;
      }
      const y = bufferLineNumber - 1;
      const current = active.getLine(y);
      if (!current) {
        callback(undefined);
        return;
      }
      const rows: TerminalLinkRow[] = [];
      let first = y;
      while (first > 0 && active.getLine(first)?.isWrapped) first -= 1;
      for (let row = first; row < active.length; row++) {
        const line = active.getLine(row);
        if (!line || (row !== first && !line.isWrapped)) break;
        rows.push({
          y: row + 1,
          text: line.translateToString(false),
          wrapped: row !== first && line.isWrapped,
        });
        if (rows.length > 32) break;
      }
      const anchor = rows.findIndex((row) => row.y === bufferLineNumber);
      const found = terminalLinksInRows(rows, anchor, cols).filter(
        (link) => link.startY <= bufferLineNumber && bufferLineNumber <= link.endY,
      );
      if (found.length === 0) {
        callback(undefined);
        return;
      }
      callback(
        found.map((link) => {
          const item: TerminalLink = {
            text: link.text,
            range: {
              start: { x: link.startX, y: link.startY },
              end: { x: link.endX, y: link.endY },
            },
            decorations: { underline: false, pointerCursor: false },
            activate(event, text) {
              if (!terminalLinkModifierDown(event, mac)) return;
              open(text);
            },
            hover(event) {
              hovered = item;
              hovering = true;
              if (terminalLinkModifierDown(event, mac)) armed = true;
              show(item, armed);
            },
            leave() {
              if (hovered === item) hovered = null;
              hovering = false;
              show(item, false);
            },
          };
          return item;
        }),
      );
    },
  });

  return () => {
    hovered = null;
    hovering = false;
    element.removeEventListener("mousemove", onMove);
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("keyup", onKey, true);
    target.removeEventListener("blur", onBlur);
    provider.dispose();
  };
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
