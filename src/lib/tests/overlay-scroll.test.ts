import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installOverlayScroll, OVERLAY_SCROLL_HIDE_MS } from "../overlay-scroll.ts";

class FakeRoot extends EventTarget {
  dataset: { scrolling?: string } = {};
}

describe("installOverlayScroll", () => {
  it("shows the bar while scrolling and hides it after idle", () => {
    const root = new FakeRoot();
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const stop = installOverlayScroll(
      root,
      ((fn: () => void, ms?: number) => {
        pending.push({ fn, ms: ms ?? 0 });
        return pending.length;
      }) as typeof setTimeout,
      () => {},
    );

    root.dispatchEvent(new Event("scroll", { bubbles: true }));
    assert.equal(root.dataset.scrolling, "");
    assert.equal(pending.at(-1)?.ms, OVERLAY_SCROLL_HIDE_MS);

    pending.at(-1)?.fn();
    assert.equal(root.dataset.scrolling, undefined);
    stop();
  });
});
