import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_WINDOW_PAGE,
  CHAT_WINDOW_TURNS,
  cachedTranscript,
  cachedTranscriptIsLoaded,
  chatTurnSlice,
  chatSwitchPending,
  holdTranscript,
  hasOlderTurns,
  openedTranscriptIsCurrent,
  rememberShownTranscript,
  revealOlderTurns,
  scrollTopAfterPrepend,
  TRANSCRIPT_PAGE_MESSAGES,
  nextTranscriptLimit,
  transcriptMessageStart,
  visibleTranscriptEnd,
} from "../chat-window.ts";

describe("chatSwitchPending", () => {
  it("is pending only while a different chat is selected", () => {
    assert.equal(chatSwitchPending("b", "a"), true);
    assert.equal(chatSwitchPending("a", "a"), false);
    assert.equal(chatSwitchPending("", "a"), false);
    assert.equal(chatSwitchPending("", ""), false);
  });
});

describe("holdTranscript", () => {
  it("keeps the chat on screen until the next one's messages arrive", () => {
    const first = [{ role: "user", content: "a" }];
    const held = { id: "a", messages: first, model: "grok" };
    assert.equal(holdTranscript(held, first, "b", "gpt"), held);
    const second = [{ role: "user", content: "b" }];
    assert.deepEqual(holdTranscript(held, second, "b", "gpt"), {
      id: "b",
      messages: second,
      model: "gpt",
    });
  });
});

describe("rememberShownTranscript", () => {
  it("does not file the open transcript under the chat that was just selected", () => {
    const cache = new Map<string, string[]>();
    const open = ["remove the local computer"];
    cache.set("a", open);
    const shown = rememberShownTranscript(cache, "a", "b", open, open);
    assert.equal(shown, "a");
    assert.equal(cache.has("b"), false);
    assert.equal(cachedTranscript(cache, "b", shown, open), undefined);
  });

  it("keeps each chat's own transcript once its messages arrive", () => {
    const cache = new Map<string, string[]>();
    const open = ["remove the local computer"];
    const next = ["for the running agents"];
    cache.set("a", open);
    const shown = rememberShownTranscript(cache, "a", "b", next, open);
    assert.equal(shown, "b");
    assert.equal(cachedTranscript(cache, "b", shown, next), next);
    assert.equal(cachedTranscript(cache, "a", shown, next), open);
  });

  it("still updates the chat that is already on screen", () => {
    const cache = new Map<string, string[]>();
    const first = ["a"];
    const streamed = ["a", "more"];
    rememberShownTranscript(cache, "a", "a", first, first);
    const shown = rememberShownTranscript(cache, "a", "a", streamed, first);
    assert.equal(shown, "a");
    assert.equal(cachedTranscript(cache, "a", shown, streamed), streamed);
  });
});

describe("cachedTranscriptIsLoaded", () => {
  it("does not treat a blank cache entry as the chat", () => {
    assert.equal(cachedTranscriptIsLoaded(undefined), false);
    assert.equal(cachedTranscriptIsLoaded(null), false);
    assert.equal(cachedTranscriptIsLoaded([]), false);
    assert.equal(cachedTranscriptIsLoaded(["saved reply"]), true);
  });
});

describe("openedTranscriptIsCurrent", () => {
  it("paints a loaded transcript while the previous chat is still the one on screen", () => {
    const cache = new Map<string, string[]>();
    const open = ["the chat we left"];
    cache.set("a", open);
    const shown = rememberShownTranscript(cache, "a", "b", open, open);
    assert.equal(shown, "a");
    assert.equal(openedTranscriptIsCurrent(1, 1, "b", "b"), true);
  });

  it("drops a load the user already left", () => {
    assert.equal(openedTranscriptIsCurrent(1, 2, "b", "b"), false);
    assert.equal(openedTranscriptIsCurrent(2, 2, "c", "b"), false);
    assert.equal(openedTranscriptIsCurrent(2, 2, "", "b"), false);
    assert.equal(openedTranscriptIsCurrent(2, 2, "b", ""), false);
  });
});

describe("transcriptMessageStart", () => {
  it("keeps only the last page when one turn holds the whole chat", () => {
    assert.equal(transcriptMessageStart(2005, TRANSCRIPT_PAGE_MESSAGES), 2005 - 48);
    assert.equal(transcriptMessageStart(48, 48), 0);
    assert.equal(transcriptMessageStart(10, 48), 0);
    assert.equal(transcriptMessageStart(0, 48), 0);
  });
});

describe("visibleTranscriptEnd", () => {
  it("mounts the end first and keeps earlier turns the same objects", () => {
    const older = { user: "older", rest: ["a"] };
    const recent = { user: "recent", rest: ["b"] };
    const tail = ["live"];
    const first = visibleTranscriptEnd([older, recent], tail, 3);
    assert.equal(first.hidden, true);
    assert.deepEqual(first.tail, ["live"]);
    assert.equal(first.settled.length, 1);
    assert.equal(first.settled[0], recent);
    const grown = visibleTranscriptEnd([older, recent], tail, nextTranscriptLimit(5, 3));
    assert.equal(grown.hidden, false);
    assert.equal(grown.settled[0], older);
    assert.equal(grown.settled[1], recent);
  });
});

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
