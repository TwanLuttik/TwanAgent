import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canPersistTurn,
  draftForChat,
  isEmptyCompletion,
  isRetryableChatError,
  setDraftForChat,
  skipToolIfAborted,
  turnAppliesToChat,
  turnFailureMessage,
} from "./dev-turn.ts";

describe("turnAppliesToChat", () => {
  it("only applies updates to the conversation that owns the turn", () => {
    assert.equal(turnAppliesToChat("chat-a", "chat-a"), true);
    assert.equal(turnAppliesToChat("chat-a", "chat-b"), false);
    assert.equal(turnAppliesToChat("chat-a", ""), false);
    assert.equal(turnAppliesToChat("", "chat-a"), false);
  });
});

describe("canPersistTurn", () => {
  it("persists the owning conversation unless it was deleted", () => {
    assert.equal(canPersistTurn("chat-a", new Set()), true);
    assert.equal(canPersistTurn("chat-a", new Set(["chat-b"])), true);
    assert.equal(canPersistTurn("chat-a", new Set(["chat-a"])), false);
    assert.equal(canPersistTurn("", new Set()), false);
  });
});

describe("per-conversation drafts", () => {
  it("keeps drafts isolated by chat id", () => {
    let drafts = setDraftForChat({}, "a", "hello a");
    drafts = setDraftForChat(drafts, "b", "hello b");
    assert.equal(draftForChat(drafts, "a"), "hello a");
    assert.equal(draftForChat(drafts, "b"), "hello b");
    assert.equal(draftForChat(drafts, "c"), "");
  });

  it("clears an empty draft for that chat only", () => {
    let drafts = setDraftForChat({}, "a", "keep");
    drafts = setDraftForChat(drafts, "b", "drop");
    drafts = setDraftForChat(drafts, "b", "");
    assert.equal(draftForChat(drafts, "a"), "keep");
    assert.equal(draftForChat(drafts, "b"), "");
    assert.equal(Object.hasOwn(drafts, "b"), false);
  });
});

describe("isRetryableChatError", () => {
  it("retries transport and server failures, not stop or auth", () => {
    assert.equal(isRetryableChatError("xAI request failed: error sending request"), true);
    assert.equal(isRetryableChatError("xAI error 429: rate limited"), true);
    assert.equal(isRetryableChatError("xAI error 503: unavailable"), true);
    assert.equal(isRetryableChatError("Stopped."), false);
    assert.equal(isRetryableChatError("Grok CLI login expired. Run grok login."), false);
    assert.equal(isRetryableChatError("xAI rejected the API key."), false);
  });
});

describe("isEmptyCompletion", () => {
  it("treats whitespace-only text with no tool calls as empty", () => {
    assert.equal(isEmptyCompletion("", []), true);
    assert.equal(isEmptyCompletion("   ", []), true);
    assert.equal(isEmptyCompletion("ok", []), false);
    assert.equal(isEmptyCompletion("", [{ id: "1" }]), false);
  });
});

describe("turnFailureMessage", () => {
  it("keeps the API error in the transcript so the turn is not a silent stop", () => {
    const msg = turnFailureMessage("xAI error 503: unavailable");
    assert.equal(msg.role, "assistant");
    assert.match(String(msg.content), /xAI error 503/);
    assert.equal(msg.error, true);
  });
});

describe("skipToolIfAborted", () => {
  it("lets tools run while the turn is live", () => {
    const ac = new AbortController();
    assert.equal(skipToolIfAborted(ac.signal), null);
  });

  it("skips remaining tools after stop", () => {
    const ac = new AbortController();
    ac.abort();
    assert.equal(skipToolIfAborted(ac.signal), "Skipped: stopped.");
  });
});
