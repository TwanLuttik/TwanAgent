import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_WINDOW_PAGE,
  CHAT_WINDOW_TURNS,
  chatTurnSlice,
  hasOlderTurns,
  revealOlderTurns,
  scrollTopAfterPrepend,
} from "./chat-window.ts";

describe("chatTurnSlice", () => {
  it("mounts every turn when the chat is short", () => {
    assert.deepEqual(chatTurnSlice(0, 0), { start: 0, count: 0 });
    assert.deepEqual(chatTurnSlice(3, 0), { start: 0, count: 3 });
    assert.deepEqual(chatTurnSlice(CHAT_WINDOW_TURNS, 0), { start: 0, count: CHAT_WINDOW_TURNS });
  });

  it("mounts only the newest window", () => {
    assert.deepEqual(chatTurnSlice(80, 0), { start: 80 - CHAT_WINDOW_TURNS, count: CHAT_WINDOW_TURNS });
    assert.deepEqual(chatTurnSlice(80, CHAT_WINDOW_TURNS), {
      start: 80 - CHAT_WINDOW_TURNS,
      count: CHAT_WINDOW_TURNS,
    });
  });

  it("grows toward the oldest turn without passing it", () => {
    const revealed = CHAT_WINDOW_TURNS + CHAT_WINDOW_PAGE;
    assert.deepEqual(chatTurnSlice(80, revealed), { start: 80 - revealed, count: revealed });
    assert.deepEqual(chatTurnSlice(30, 100), { start: 0, count: 30 });
  });

  it("ignores junk counts", () => {
    assert.deepEqual(chatTurnSlice(-4, Number.NaN), { start: 0, count: 0 });
    assert.deepEqual(chatTurnSlice(40.9, 10.2), { start: 40 - CHAT_WINDOW_TURNS, count: CHAT_WINDOW_TURNS });
  });
});

describe("revealOlderTurns", () => {
  it("pages backward and stops at the start", () => {
    assert.equal(revealOlderTurns(80, 0), CHAT_WINDOW_TURNS + CHAT_WINDOW_PAGE);
    assert.equal(revealOlderTurns(30, CHAT_WINDOW_TURNS), 30);
    assert.equal(hasOlderTurns(80, 0), true);
    assert.equal(hasOlderTurns(CHAT_WINDOW_TURNS, 0), false);
    assert.equal(hasOlderTurns(80, 80), false);
  });
});

describe("scrollTopAfterPrepend", () => {
  it("shifts the viewport by the height inserted above it", () => {
    assert.equal(
      scrollTopAfterPrepend({ scrollTop: 40, scrollHeight: 800 }, 1400),
      640,
    );
  });

  it("leaves the viewport alone when nothing grew", () => {
    assert.equal(scrollTopAfterPrepend({ scrollTop: 40, scrollHeight: 800 }, 800), 40);
    assert.equal(scrollTopAfterPrepend({ scrollTop: 40, scrollHeight: 800 }, 700), 40);
  });
});
