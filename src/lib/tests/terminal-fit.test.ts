import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPaneFitGate, layoutMoving, type FitClock } from "../terminal-fit.ts";

function manualClock(): { clock: FitClock; flush: () => void } {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    clock: {
      request(fn) {
        const id = next;
        next += 1;
        queued.set(id, fn);
        return id;
      },
      cancel(id) {
        queued.delete(id);
      },
    },
    flush() {
      const batch = [...queued.values()];
      queued.clear();
      for (const fn of batch) fn();
    },
  };
}

function attrs(initial: string[] = []) {
  const names = new Set(initial);
  return {
    add: (name: string) => names.add(name),
    hasAttribute: (name: string) => names.has(name),
  };
}

describe("pane fit gate", () => {
  it("does not refit on each size change while the pane edge is moving", () => {
    let moving = true;
    let fits = 0;
    const clock = manualClock();
    const gate = createPaneFitGate({
      clock: clock.clock,
      moving: () => moving,
      shown: () => true,
      fit: () => {
        fits += 1;
      },
    });

    gate.noteResize();
    gate.noteResize();
    gate.noteResize();
    clock.flush();
    assert.equal(fits, 0);

    moving = false;
    gate.settle();
    assert.equal(fits, 0);
    clock.flush();
    assert.equal(fits, 1);
  });

  it("coalesces ordinary resizes to one fit per frame", () => {
    let fits = 0;
    const clock = manualClock();
    const gate = createPaneFitGate({
      clock: clock.clock,
      moving: () => false,
      shown: () => true,
      fit: () => {
        fits += 1;
      },
    });
    gate.noteResize();
    gate.noteResize();
    clock.flush();
    assert.equal(fits, 1);
  });

  it("does not fit a hidden terminal or one that is still moving", () => {
    let moving = true;
    let shown = false;
    let fits = 0;
    const clock = manualClock();
    const gate = createPaneFitGate({
      clock: clock.clock,
      moving: () => moving,
      shown: () => shown,
      fit: () => {
        fits += 1;
      },
    });
    gate.settle();
    clock.flush();
    shown = true;
    gate.settle();
    clock.flush();
    assert.equal(fits, 0);
    moving = false;
    gate.settle();
    gate.settle();
    clock.flush();
    assert.equal(fits, 1);
  });
});

describe("layoutMoving", () => {
  it("stays moving for a terminal outside the slot while the document flag is set", () => {
    const root = attrs();
    const outside = { closest: () => null };
    assert.equal(layoutMoving(root, outside), false);
    root.add("data-pane-resizing");
    assert.equal(layoutMoving(root, outside), true);
    root.add("data-pane-sliding");
    assert.equal(layoutMoving(attrs(["data-pane-sliding"]), outside), true);
  });

  it("stays moving when the terminal sits inside the resizing slot", () => {
    const inside = { closest: () => ({}) };
    assert.equal(layoutMoving(attrs(), inside), true);
    assert.equal(layoutMoving(null, { closest: () => null }), false);
  });
});
