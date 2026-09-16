import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachXtermInput, binaryStringToBytes } from "./dev-term-io.ts";

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
});
