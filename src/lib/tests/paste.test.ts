import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PASTE_LABEL,
  expandPasteTokens,
  flattenPasteToken,
  insertCollapsedPaste,
  pasteBeforeCursor,
  removePasteSpan,
  pasteSpans,
  replacePasteToken,
  shouldCollapsePaste,
} from "../paste.ts";

const long = "x".repeat(201);
const block = { id: "ab12", text: long };

describe("insertCollapsedPaste", () => {
  it("keeps a short paste in the draft", () => {
    const next = insertCollapsedPaste("see ", 4, 4, "hello");
    assert.equal(next.draft, "see hello");
    assert.equal(next.paste, null);
    assert.equal(shouldCollapsePaste("x".repeat(200)), false);
  });

  it("replaces a long paste with #pasted", () => {
    const next = insertCollapsedPaste("look ", 5, 5, long, "ab12");
    assert.equal(next.draft, `look ${PASTE_LABEL}-ab12`);
    assert.equal(next.paste?.text, long);
    assert.deepEqual(pasteSpans(next.draft, [block]), [
      { start: 5, end: `look ${PASTE_LABEL}-ab12`.length, id: "ab12" },
    ]);
  });
});

describe("expandPasteTokens", () => {
  it("puts the pasted text back for the model and leaves other hashes", () => {
    const draft = `check ${PASTE_LABEL}-ab12 #not-a-paste`;
    assert.equal(expandPasteTokens(draft, [block]), `check ${long} #not-a-paste`);
  });

  it("removes the whole chip when the caret is at its end", () => {
    const draft = `look ${PASTE_LABEL}-ab12`;
    const span = pasteBeforeCursor(draft, draft.length, draft.length, [block]);
    assert.ok(span);
    if (!span) return;
    assert.deepEqual(removePasteSpan(draft, span), { text: "look ", cursor: 5 });
    assert.equal(pasteBeforeCursor(draft, draft.length - 1, draft.length - 1, [block]), null);
    assert.equal(pasteBeforeCursor(draft, 0, draft.length, [block]), null);
  });

  it("flattens one token back into the input", () => {
    const draft = `a ${PASTE_LABEL}-ab12 b`;
    assert.equal(flattenPasteToken(draft, block), `a ${long} b`);
    assert.equal(replacePasteToken(draft, block, "edited"), "a edited b");
  });
});
