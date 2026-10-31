import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { beginTurnClock, endTurnClock, rememberTurnClock, resetTurnClocksForTests } from "../turn-clock.ts";

afterEach(() => resetTurnClocksForTests());

describe("turn clock", () => {
  it("keeps the original start when a later stamp arrives", () => {
    assert.equal(beginTurnClock("chat-a", 1_000), 1_000);
    assert.equal(rememberTurnClock("chat-a", 9_000), 1_000);
    assert.equal(rememberTurnClock("chat-a", Date.now()), 1_000);
  });

  it("starts a fresh clock after the turn ends", () => {
    beginTurnClock("chat-a", 1_000);
    endTurnClock("chat-a");
    assert.equal(rememberTurnClock("chat-a", 5_000), 5_000);
    assert.equal(beginTurnClock("chat-a", 8_000), 8_000);
    assert.equal(rememberTurnClock("chat-a", 9_000), 8_000);
  });

  it("remembers a start that survived the page losing its react state", () => {
    beginTurnClock("chat-a", 1_000);
    assert.equal(rememberTurnClock("chat-a", 0), 1_000);
  });

  it("accepts an earlier start reported by the still-running process", () => {
    beginTurnClock("chat-a", 9_000);
    assert.equal(rememberTurnClock("chat-a", 1_000), 1_000);
  });
});
