import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatIdsInTabs,
  clampSplitShare,
  closeSplitPane,
  closeTabChat,
  focusSplitChat,
  focusSplitPane,
  moveTabItem,
  openTabChat,
  primaryChatId,
  revealTabChat,
  setSplitShare,
  splitChatTab,
  splitGroupForChat,
  splitSelectedChats,
  tabItemKey,
  tabItemsFromIds,
  unsplitGroup,
  withCodeTab,
  CODE_TAB_KEY,
  visibleChatIds,
} from "../split-pane.ts";

describe("splitChatTab", () => {
  it("pairs the right-clicked chat with the tab on its left", () => {
    const items = tabItemsFromIds(["a", "b", "c"]);
    const next = splitChatTab(items, "b", "split-1");
    assert.deepEqual(next, [
      {
        kind: "split",
        group: { id: "split-1", chatIds: ["a", "b"], activePane: 1, leftShare: 0.5 },
      },
      { kind: "chat", id: "c" },
    ]);
    assert.equal(primaryChatId(next[0]!), "b");
    assert.deepEqual(visibleChatIds(next[0]!), ["a", "b"]);
  });

  it("pairs the first tab with the chat on its right", () => {
    const next = splitChatTab(tabItemsFromIds(["a", "b"]), "a", "split-1");
    assert.equal(next.length, 1);
    assert.equal(next[0]?.kind, "split");
    if (next[0]?.kind !== "split") return;
    assert.deepEqual(next[0].group.chatIds, ["a", "b"]);
  });

  it("does nothing when there is no other chat to pair", () => {
    const alone = tabItemsFromIds(["a"]);
    assert.equal(splitChatTab(alone, "a", "split-1"), alone);
    const split = splitChatTab(tabItemsFromIds(["a", "b"]), "a", "split-1");
    assert.equal(splitChatTab(split, "missing"), split);
    assert.equal(splitChatTab(split, "a"), split);
  });
});

describe("close and unsplit", () => {
  it("turns a split back into two tabs", () => {
    const split = splitChatTab(tabItemsFromIds(["a", "b", "c"]), "b", "split-1");
    assert.deepEqual(unsplitGroup(split, "split-1"), tabItemsFromIds(["a", "b", "c"]));
    assert.equal(unsplitGroup(split, "missing"), split);
  });

  it("keeps the other pane when one side of a split closes", () => {
    const split = splitChatTab(tabItemsFromIds(["left", "right"]), "left", "split-1");
    const closed = closeSplitPane(split, "split-1", 0);
    assert.deepEqual(closed, tabItemsFromIds(["right"]));
    assert.deepEqual(closeTabChat(split, "right"), {
      items: tabItemsFromIds(["left"]),
      removed: true,
      next: "left",
    });
  });

  it("selects the neighbor when a normal tab closes", () => {
    assert.deepEqual(closeTabChat(tabItemsFromIds(["a", "b", "c"]), "b"), {
      items: tabItemsFromIds(["a", "c"]),
      removed: true,
      next: "c",
    });
    assert.deepEqual(closeTabChat(tabItemsFromIds(["a"]), "a"), {
      items: [],
      removed: true,
      next: null,
    });
    assert.deepEqual(closeTabChat(tabItemsFromIds(["a"]), "missing"), {
      items: tabItemsFromIds(["a"]),
      removed: false,
      next: null,
    });
  });
});

describe("open and focus", () => {
  it("appends a chat that is not already showing", () => {
    const split = splitChatTab(tabItemsFromIds(["a", "b"]), "a", "split-1");
    assert.deepEqual(chatIdsInTabs(split), ["a", "b"]);
    assert.equal(openTabChat(split, "a"), split);
    assert.deepEqual(openTabChat(split, "c"), [...split, { kind: "chat", id: "c" }]);
    assert.equal(splitGroupForChat(split, "b")?.id, "split-1");
    assert.equal(splitGroupForChat(split, "c"), null);
  });

  it("keeps tab order when a split chat or another chat is opened", () => {
    const split = splitChatTab(tabItemsFromIds(["a", "b", "c"]), "b", "split-1");
    const order = chatIdsInTabs(split);
    assert.deepEqual(chatIdsInTabs(revealTabChat(split, "b")), order);
    assert.deepEqual(chatIdsInTabs(revealTabChat(split, "a")), order);
    assert.equal(revealTabChat(split, "a"), split);
    const focused = focusSplitChat(split, "a");
    assert.deepEqual(chatIdsInTabs(focused), order);
    assert.equal(focused[0]?.kind === "split" ? focused[0].group.activePane : null, 0);
    assert.deepEqual(chatIdsInTabs(focusSplitChat(focused, "a")), order);
    assert.deepEqual(chatIdsInTabs(revealTabChat(split, "d")), [...order, "d"]);
  });

  it("reorders tabs and whole groups without opening them", () => {
    const items = tabItemsFromIds(["a", "b", "c"]);
    const moved = moveTabItem(items, tabItemKey(items[2]!), tabItemKey(items[0]!));
    assert.deepEqual(chatIdsInTabs(moved), ["c", "a", "b"]);
    const split = splitChatTab(tabItemsFromIds(["a", "b", "c"]), "b", "split-1");
    const group = split[0]!;
    const tail = split[1]!;
    const reordered = moveTabItem(split, tabItemKey(group), tabItemKey(tail));
    assert.deepEqual(chatIdsInTabs(reordered), ["c", "a", "b"]);
    assert.equal(moveTabItem(split, tabItemKey(group), tabItemKey(group)), split);
  });

  it("reorders the code tab without changing the chats", () => {
    const items = withCodeTab(tabItemsFromIds(["a", "b"]), true);
    assert.equal(items.at(-1)?.kind, "code");
    assert.equal(tabItemKey(items.at(-1)!), CODE_TAB_KEY);
    const moved = moveTabItem(items, CODE_TAB_KEY, tabItemKey(items[0]!));
    assert.deepEqual(
      moved.map((item) => item.kind),
      ["code", "chat", "chat"],
    );
    assert.deepEqual(chatIdsInTabs(moved), ["a", "b"]);
    assert.equal(withCodeTab(moved, false).some((item) => item.kind === "code"), false);
    assert.equal(withCodeTab(items, true), items);
  });

  it("splits the command-selected chats in the order they were picked", () => {
    const items = tabItemsFromIds(["a", "b", "c", "d"]);
    const next = splitSelectedChats(items, ["c", "a"], "split-1");
    assert.deepEqual(chatIdsInTabs(next), ["c", "a", "b", "d"]);
    assert.equal(next[0]?.kind, "split");
    if (next[0]?.kind !== "split") return;
    assert.deepEqual(next[0].group.chatIds, ["c", "a"]);
    assert.equal(splitSelectedChats(items, ["a"]), items);
    const again = splitSelectedChats(next, ["c", "b"]);
    assert.equal(again, next);
  });

  it("keeps a dragged divider inside the row", () => {
    const split = splitChatTab(tabItemsFromIds(["a", "b"]), "a", "split-1");
    const wider = setSplitShare(split, "split-1", 0.7);
    assert.equal(wider[0]?.kind === "split" ? wider[0].group.leftShare : 0, 0.7);
    assert.equal(setSplitShare(wider, "split-1", 0.7), wider);
    assert.equal(clampSplitShare(2), 0.8);
    assert.equal(clampSplitShare(0), 0.2);
  });

  it("remembers which pane is focused", () => {
    const split = splitChatTab(tabItemsFromIds(["a", "b"]), "a", "split-1");
    const focused = focusSplitPane(split, "split-1", 1);
    assert.notEqual(focused, split);
    assert.equal(focused[0]?.kind === "split" ? focused[0].group.activePane : null, 1);
    assert.equal(focusSplitPane(focused, "split-1", 1), focused);
  });
});
