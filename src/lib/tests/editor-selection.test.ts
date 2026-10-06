import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendSelectionToDraft,
  positionAt,
  selectionPromptSnippet,
  selectionRangeFromOffsets,
} from "../editor-selection.ts";

describe("positionAt", () => {
  it("returns 1-based line and column", () => {
    const text = "one\ntwo\nthree";
    assert.deepEqual(positionAt(text, 0), { line: 1, col: 1 });
    assert.deepEqual(positionAt(text, 3), { line: 1, col: 4 });
    assert.deepEqual(positionAt(text, 4), { line: 2, col: 1 });
    assert.deepEqual(positionAt(text, 8), { line: 3, col: 1 });
  });
});

describe("selectionPromptSnippet", () => {
  it("includes path, line:col range, and the selected text", () => {
    const text = "export type Save = {\n  cash: number;\n};";
    const range = selectionRangeFromOffsets("src/lib/save.ts", text, 0, text.length);
    assert.deepEqual(range, {
      path: "src/lib/save.ts",
      fromLine: 1,
      fromCol: 1,
      toLine: 3,
      toCol: 3,
      text,
    });
    assert.equal(
      selectionPromptSnippet(range),
      "src/lib/save.ts:1:1-3:3\n\n```\nexport type Save = {\n  cash: number;\n};\n```",
    );
  });
});

describe("appendSelectionToDraft", () => {
  it("sets the snippet when the draft is empty and appends otherwise", () => {
    const snippet = "src/a.ts:1:1-1:4\n\n```\nfoo\n```";
    assert.equal(appendSelectionToDraft("", snippet), snippet);
    assert.equal(appendSelectionToDraft("  look  ", snippet), `look\n\n${snippet}`);
  });
});
