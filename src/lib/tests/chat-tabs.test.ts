import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeChatTab, openChatTab } from "../chat-tabs.ts";

describe("openChatTab", () => {
  it("appends a conversation and keeps one that is already open", () => {
    assert.deepEqual(openChatTab([], "a"), ["a"]);
    assert.deepEqual(openChatTab(["a"], "b"), ["a", "b"]);
    assert.deepEqual(openChatTab(["a", "b"], "a"), ["a", "b"]);
    assert.deepEqual(openChatTab(["a"], "  "), ["a"]);
  });
});

describe("closeChatTab", () => {
  it("selects the neighbor when the active tab closes", () => {
    assert.deepEqual(closeChatTab(["a", "b", "c"], "b"), { tabs: ["a", "c"], next: "c" });
    assert.deepEqual(closeChatTab(["a", "b"], "b"), { tabs: ["a"], next: "a" });
    assert.deepEqual(closeChatTab(["a"], "a"), { tabs: [], next: null });
  });

  it("leaves the active tab alone when another tab closes", () => {
    assert.deepEqual(closeChatTab(["a", "b"], "missing"), { tabs: ["a", "b"], next: null });
  });
});
