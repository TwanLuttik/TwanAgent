import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PANE_IDLE_TIMEOUT_MS, afterInput, type IdleClock } from "../after-input.ts";

function fakeClock(): IdleClock & { fireIdle: () => void; fireTimer: () => void; idleTimeout: number | null; timerMs: number | null } {
  let idle: (() => void) | null = null;
  let timer: (() => void) | null = null;
  const clock = {
    idleTimeout: null as number | null,
    timerMs: null as number | null,
    requestIdleCallback(work: () => void, options: { timeout: number }) {
      idle = work;
      clock.idleTimeout = options.timeout;
      return 1;
    },
    cancelIdleCallback() {
      idle = null;
    },
    setTimeout(work: () => void, ms: number) {
      timer = work;
      clock.timerMs = ms;
      return 2;
    },
    clearTimeout() {
      timer = null;
    },
    fireIdle() {
      idle?.();
    },
    fireTimer() {
      timer?.();
    },
  };
  return clock;
}

describe("afterInput", () => {
  it("waits until the main thread is idle before running", () => {
    const clock = fakeClock();
    let ran = false;
    afterInput(() => {
      ran = true;
    }, clock);
    assert.equal(ran, false);
    assert.equal(clock.idleTimeout, PANE_IDLE_TIMEOUT_MS);
    assert.equal(clock.timerMs, null);
    clock.fireIdle();
    assert.equal(ran, true);
  });

  it("does not run work that was cancelled", () => {
    const clock = fakeClock();
    let ran = false;
    const cancel = afterInput(() => {
      ran = true;
    }, clock);
    cancel();
    clock.fireIdle();
    assert.equal(ran, false);
  });

  it("uses a short timer when the webview has no idle callback", () => {
    const clock = fakeClock();
    clock.requestIdleCallback = undefined;
    let ran = false;
    afterInput(() => {
      ran = true;
    }, clock);
    assert.equal(ran, false);
    assert.equal(clock.timerMs, 32);
    clock.fireTimer();
    assert.equal(ran, true);
  });
});
