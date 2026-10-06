import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  installDocumentScrollLock,
  shouldPreventDocumentWheel,
  type WheelBox,
} from "../document-scroll.ts";

function pane(partial: Partial<WheelBox> = {}): WheelBox {
  return {
    overflowX: "hidden",
    overflowY: "auto",
    scrollTop: 40,
    scrollLeft: 0,
    scrollHeight: 400,
    clientHeight: 200,
    scrollWidth: 200,
    clientWidth: 200,
    ...partial,
  };
}

describe("shouldPreventDocumentWheel", () => {
  it("blocks the document when nothing under the cursor can scroll", () => {
    const landing: WheelBox = {
      overflowX: "hidden",
      overflowY: "hidden",
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 600,
      clientHeight: 600,
      scrollWidth: 800,
      clientWidth: 800,
    };
    assert.equal(shouldPreventDocumentWheel(landing, 0, 40), true);
    assert.equal(shouldPreventDocumentWheel(null, 0, 40), true);
  });

  it("lets an inner pane consume wheel while it still has room", () => {
    assert.equal(shouldPreventDocumentWheel(pane({ scrollTop: 40 }), 0, 30), false);
    assert.equal(shouldPreventDocumentWheel(pane({ scrollTop: 40 }), 0, -20), false);
  });

  it("blocks when the inner pane is already at that edge", () => {
    assert.equal(shouldPreventDocumentWheel(pane({ scrollTop: 0 }), 0, -20), true);
    assert.equal(
      shouldPreventDocumentWheel(pane({ scrollTop: 200 }), 0, 20),
      true,
    );
  });

  it("walks up to a parent that can still scroll", () => {
    const child: WheelBox = pane({
      scrollTop: 0,
      parent: pane({ scrollTop: 80 }),
    });
    assert.equal(shouldPreventDocumentWheel(child, 0, -20), false);
  });

  it("lets a horizontal-only code or table region pass vertical wheel to the parent", () => {
    const region: WheelBox = pane({
      overflowX: "auto",
      overflowY: "hidden",
      scrollTop: 0,
      scrollHeight: 48,
      clientHeight: 48,
      scrollWidth: 640,
      clientWidth: 320,
      parent: pane({ scrollTop: 80 }),
    });
    assert.equal(shouldPreventDocumentWheel(region, 0, 40), false);
    assert.equal(shouldPreventDocumentWheel(region, 0, -20), false);
  });
});

describe("installDocumentScrollLock", () => {
  it("cancels wheel events that would move the document", () => {
    const root = new EventTarget();
    const stop = installDocumentScrollLock(root);
    const ev = Object.assign(new Event("wheel", { cancelable: true }), {
      deltaX: 0,
      deltaY: 40,
    });
    root.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    stop();
  });
});
