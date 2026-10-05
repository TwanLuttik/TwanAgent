import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachXtermInput, binaryStringToBytes, dragSelectsTerminalText, pointerMovedPast } from "./dev-term-io.ts";

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

    assert.deepEqual(calls, ["mousedown:capture", "mousemove:capture", "mouseup:bubble"]);
    assert.deepEqual(keys, [false, false, true, true]);
  });
});
