import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toolRevealNextAt,
  toolRevealSteps,
  toolRowsAlreadyShown,
  TOOL_ROW_STAGGER_MS,
} from "../tool-reveal.ts";

describe("tool row reveal", () => {
  it("does not animate rows that are already present when a conversation opens", () => {
    assert.deepEqual(toolRevealSteps(4, 4, 1_000, 0), []);
    assert.equal(toolRevealNextAt(4, 4, 1_000, 0), 0);
  });

  it("staggers only rows that arrive while the conversation is open", () => {
    const now = 5_000;
    assert.deepEqual(toolRevealSteps(3, 1, now, 0), [
      { index: 1, delay: 0 },
      { index: 2, delay: TOOL_ROW_STAGGER_MS },
    ]);
    assert.equal(toolRevealNextAt(3, 1, now, 0), now + TOOL_ROW_STAGGER_MS * 2);
  });

  it("waits out a burst already in flight before the next row", () => {
    const now = 1_000;
    const nextAt = 1_400;
    assert.deepEqual(toolRevealSteps(4, 3, now, nextAt), [{ index: 3, delay: 400 }]);
    assert.equal(toolRevealNextAt(4, 3, now, nextAt), nextAt + TOOL_ROW_STAGGER_MS);
  });

  it("does nothing when no new rows arrived", () => {
    assert.deepEqual(toolRevealSteps(2, 3, 100, 500), []);
    assert.equal(toolRevealNextAt(2, 3, 100, 500), 500);
  });
});

describe("tool rows already shown", () => {
  it("treats the first paint of an open conversation as already visible", () => {
    assert.equal(toolRowsAlreadyShown("Write a.ts\nWrite b.ts", ""), 0);
  });

  it("keeps rows that were already showing when a later batch continues them", () => {
    assert.equal(toolRowsAlreadyShown("Write a.ts\nWrite b.ts\nEdit a.ts", "Write a.ts\nWrite b.ts"), 2);
    assert.equal(toolRowsAlreadyShown("Read app.ts ×2", "Read app.ts"), 1);
    assert.equal(toolRowsAlreadyShown("Write a.ts", "Write a.ts"), 1);
  });

  it("animates a fresh batch that is not a continuation of the rows already seen", () => {
    assert.equal(toolRowsAlreadyShown("Edit globe.js", "Write a.ts\nWrite b.ts"), 0);
    assert.equal(toolRowsAlreadyShown("Edit globe.js", ""), 0);
  });
});
