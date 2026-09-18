import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_NEAR_BOTTOM_PX, isNearBottom } from "./chat-scroll.ts";

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
