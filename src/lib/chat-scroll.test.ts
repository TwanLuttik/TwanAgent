import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_BOTTOM_PAD_FALLBACK, CHAT_NEAR_BOTTOM_PX, chatBottomPadding, isNearBottom, scrollChatToEnd } from "./chat-scroll.ts";

describe("isNearBottom", () => {
  it("is true when the viewport is at or near the end", () => {
    assert.equal(
      isNearBottom({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 }),
      true,
    );
    assert.equal(
      isNearBottom({
        scrollTop: 500 - 100 - CHAT_NEAR_BOTTOM_PX,
        scrollHeight: 500,
        clientHeight: 100,
      }),
      true,
    );
  });

  it("is false after scrolling up away from the end", () => {
    assert.equal(
      isNearBottom({ scrollTop: 0, scrollHeight: 800, clientHeight: 200 }),
      false,
    );
    assert.equal(
      isNearBottom({
        scrollTop: 500 - 100 - CHAT_NEAR_BOTTOM_PX - 1,
        scrollHeight: 500,
        clientHeight: 100,
      }),
      false,
    );
  });
});

describe("chatBottomPadding", () => {
  it("clears a tall composer so the last row can scroll above it", () => {
    assert.equal(chatBottomPadding(280), 304);
    assert.equal(chatBottomPadding(280.2), 305);
  });

  it("keeps the fallback gap before the composer is measured", () => {
    assert.equal(chatBottomPadding(0), CHAT_BOTTOM_PAD_FALLBACK);
    assert.equal(chatBottomPadding(-8), CHAT_BOTTOM_PAD_FALLBACK);
    assert.equal(chatBottomPadding(Number.NaN), CHAT_BOTTOM_PAD_FALLBACK);
  });
});

describe("scrollChatToEnd", () => {
  it("pins scrollTop to the end when stick-to-bottom is on", () => {
    const el = { scrollTop: 0, scrollHeight: 900, clientHeight: 200 };
    scrollChatToEnd(el, true);
    assert.equal(el.scrollTop, 700);
  });

  it("still reaches the end when the viewport height is unknown", () => {
    const el = { scrollTop: 0, scrollHeight: 900 };
    scrollChatToEnd(el, true);
    assert.equal(el.scrollTop, 900);
  });

  it("leaves the position alone when the user has scrolled up", () => {
    const el = { scrollTop: 40, scrollHeight: 900 };
    scrollChatToEnd(el, false);
    assert.equal(el.scrollTop, 40);
  });

  it("does nothing without a scroller", () => {
    scrollChatToEnd(null, true);
  });
});
