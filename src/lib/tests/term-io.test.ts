import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachXtermInput,
  binaryStringToBytes,
  dragSelectsTerminalText,
  pointerMovedPast,
  terminalKeyReachesPty,
  terminalWheelLines,
} from "../term-io.ts";

describe("binaryStringToBytes", () => {
  it("keeps xterm DEFAULT mouse reports as raw bytes, not UTF-8", () => {
    // CSI M Pb Px Py — coords 100,20 encode as 132, 52
    const report = `\x1b[M${String.fromCharCode(32)}${String.fromCharCode(132)}${String.fromCharCode(52)}`;
    assert.deepEqual(binaryStringToBytes(report), [0x1b, 0x5b, 0x4d, 32, 132, 52]);
  });

  it("masks char codes to a single byte", () => {
    assert.deepEqual(binaryStringToBytes(String.fromCharCode(0x1b, 300)), [0x1b, 44]);
  });
});

describe("dragSelectsTerminalText", () => {
  it("selects on a plain left drag and leaves modifier clicks for the app", () => {
    assert.equal(dragSelectsTerminalText({ button: 0, shiftKey: false, altKey: false }), true);
    assert.equal(dragSelectsTerminalText({ button: 0, shiftKey: true, altKey: false }), false);
    assert.equal(dragSelectsTerminalText({ button: 0, shiftKey: false, altKey: true }), false);
    assert.equal(dragSelectsTerminalText({ button: 2, shiftKey: false, altKey: false }), false);
  });
});

describe("pointerMovedPast", () => {
  it("treats a click as still and a few pixels as a drag", () => {
    assert.equal(pointerMovedPast({ x: 10, y: 10 }, { x: 12, y: 11 }), false);
    assert.equal(pointerMovedPast({ x: 10, y: 10 }, { x: 16, y: 10 }), true);
  });
});

describe("terminalKeyReachesPty", () => {
  const key = (name: string, extra: Partial<KeyboardEvent> = {}) =>
    ({ type: "keydown", key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra }) as KeyboardEvent;

  it("lets Ctrl+C interrupt unless text is selected", () => {
    assert.equal(terminalKeyReachesPty(key("c", { ctrlKey: true }), false), true);
    assert.equal(terminalKeyReachesPty(key("c", { metaKey: true }), false), true);
    assert.equal(terminalKeyReachesPty(key("c", { ctrlKey: true }), true), false);
    assert.equal(terminalKeyReachesPty(key("c", { ctrlKey: true, shiftKey: true }), false), true);
  });

  it("keeps select-all local and lets other keys through", () => {
    assert.equal(terminalKeyReachesPty(key("a", { ctrlKey: true }), false), false);
    assert.equal(terminalKeyReachesPty(key("k", { metaKey: true }), false), true);
    assert.equal(terminalKeyReachesPty(key("c"), false), true);
  });
});

describe("terminalWheelLines", () => {
  it("turns a mouse notch into one line and a trackpad flick into several", () => {
    assert.equal(terminalWheelLines({ deltaY: 4 }), 1);
    assert.equal(terminalWheelLines({ deltaY: -4 }), -1);
    assert.equal(terminalWheelLines({ deltaY: 120 }), 3);
    assert.equal(terminalWheelLines({ deltaY: 0 }), 0);
  });

  it("speeds up while alt is held and treats line-mode deltas as lines", () => {
    assert.equal(terminalWheelLines({ deltaY: 40, altKey: true }), 5);
    assert.equal(terminalWheelLines({ deltaY: 3, deltaMode: 1 }), 3);
  });
});

describe("attachXtermInput", () => {
  it("sends typed input as text and binary mouse reports as bytes", () => {
    let onData: ((data: string) => void) | undefined;
    let onBinary: ((data: string) => void) | undefined;
    const text: string[] = [];
    const bytes: number[][] = [];

    attachXtermInput(
      {
        onData(fn) {
          onData = fn;
        },
        onBinary(fn) {
          onBinary = fn;
        },
      },
      (data) => text.push(data),
      (data) => bytes.push(data),
    );

    onData?.("a");
    onData?.("\x1b[<0;10;5M");
    onBinary?.(`\x1b[M${String.fromCharCode(32)}${String.fromCharCode(132)}${String.fromCharCode(52)}`);

    assert.deepEqual(text, ["a", "\x1b[<0;10;5M"]);
    assert.deepEqual(bytes, [[0x1b, 0x5b, 0x4d, 32, 132, 52]]);
  });

  it("lets a click through and stops only a plain drag, while copy and select-all stay local", () => {
    const calls: string[] = [];
    const keys: boolean[] = [];
    const handlers = new Map<string, (event: {
      button: number;
      buttons: number;
      shiftKey: boolean;
      altKey: boolean;
      clientX: number;
      clientY: number;
      stopPropagation: () => void;
    }) => void>();
    const element = {
      addEventListener(
        type: string,
        fn: (event: {
          button: number;
          buttons: number;
          shiftKey: boolean;
          altKey: boolean;
          clientX: number;
          clientY: number;
          stopPropagation: () => void;
        }) => void,
        capture?: boolean,
      ) {
        calls.push(`${type}:${capture ? "capture" : "bubble"}`);
        handlers.set(type, fn);
      },
    };
    const stopped = { value: false };
    const stop = () => {
      stopped.value = true;
    };
    attachXtermInput(
      {
        element: element as unknown as HTMLElement,
        onData() {},
        onBinary() {},
        hasSelection: () => false,
        attachCustomKeyEventHandler(fn) {
          keys.push(fn({ type: "keydown", key: "c", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent));
          keys.push(fn({ type: "keydown", key: "a", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent));
          keys.push(fn({ type: "keydown", key: "c", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true } as KeyboardEvent));
          keys.push(fn({ type: "keydown", key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent));
        },
      },
      () => undefined,
      () => undefined,
    );

    const down = handlers.get("mousedown");
    const move = handlers.get("mousemove");
    down?.({ button: 0, buttons: 1, shiftKey: false, altKey: false, clientX: 10, clientY: 10, stopPropagation: stop });
    assert.equal(stopped.value, false);
    move?.({ button: 0, buttons: 1, shiftKey: false, altKey: false, clientX: 12, clientY: 10, stopPropagation: stop });
    assert.equal(stopped.value, false);
    move?.({ button: 0, buttons: 1, shiftKey: false, altKey: false, clientX: 20, clientY: 10, stopPropagation: stop });
    assert.equal(stopped.value, true);
    stopped.value = false;
    down?.({ button: 0, buttons: 1, shiftKey: true, altKey: false, clientX: 10, clientY: 10, stopPropagation: stop });
    move?.({ button: 0, buttons: 1, shiftKey: true, altKey: false, clientX: 30, clientY: 10, stopPropagation: stop });
    assert.equal(stopped.value, false);

    assert.deepEqual(calls, ["mousedown:capture", "mousemove:capture", "mouseup:bubble", "wheel:capture"]);
    assert.deepEqual(keys, [true, false, true, true]);
  });

  it("scrolls the buffer on wheel unless the app is tracking the mouse", () => {
    const handlers = new Map<string, (event: WheelEvent) => void>();
    const scrolled: number[] = [];
    const element = {
      addEventListener(type: string, fn: (event: WheelEvent) => void, _capture?: unknown) {
        handlers.set(type, fn);
      },
    };
    const term = {
      element: element as unknown as HTMLElement,
      onData() {},
      onBinary() {},
      modes: { mouseTrackingMode: "none" as string },
      scrollLines(amount: number) {
        scrolled.push(amount);
      },
    };
    attachXtermInput(term, () => undefined, () => undefined);
    const wheel = handlers.get("wheel");
    const event = {
      deltaY: 80,
      altKey: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      defaultPrevented: false,
      stopped: false,
    };
    wheel?.(event as unknown as WheelEvent);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(scrolled, [2]);

    term.modes.mouseTrackingMode = "vt200";
    event.defaultPrevented = false;
    wheel?.(event as unknown as WheelEvent);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(scrolled, [2]);
  });
});
