import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tabItemsFromIds, splitChatTab, type TabItem } from "../split-pane.ts";
import { nestProjectChats, projectChromeTabs, projectMenuEntries, rememberProjectChat } from "../project-tabs.ts";

const homes = {
  a: "/work/App",
  b: "/work/App/",
  c: "/notes",
  d: "/work/App",
};

function strip(overrides: Partial<Parameters<typeof projectChromeTabs>[0]> = {}) {
  return projectChromeTabs({
    items: tabItemsFromIds(["a", "b", "c"]),
    homes,
    titles: { a: "Login", b: "New chat", c: "Notes" },
    runningIds: new Set(["b"]),
    activeChatId: "c",
    lastOpen: { "/work/app": "b" },
    codeFocused: false,
    ...overrides,
  });
}

describe("projectChromeTabs", () => {
  it("collapses a project's open conversations into one tab", () => {
    const tabs = strip();
    assert.deepEqual(
      tabs.map((entry) => (entry.kind === "project" ? entry.name : entry.kind)),
      ["App", "notes"],
    );
    const app = tabs[0];
    assert.equal(app?.kind, "project");
    if (app?.kind !== "project") return;
    assert.equal(app.running, true);
    assert.equal(app.selected, false);
    assert.equal(app.openId, "b");
    assert.deepEqual(
      app.chats.map((chat) => chat.title),
      ["Login", "New thread"],
    );
    assert.equal(app.chats[1]?.running, true);
    assert.equal(app.chats[0]?.selected, false);
    const notes = tabs[1];
    assert.equal(notes?.kind, "project");
    if (notes?.kind !== "project") return;
    assert.equal(notes.selected, true);
    assert.equal(notes.openId, "c");
    assert.equal(notes.chats[0]?.selected, true);
  });

  it("opens the conversation on screen when that project is current", () => {
    const tabs = strip({ activeChatId: "a", lastOpen: { "/work/app": "b" } });
    const app = tabs[0];
    assert.equal(app?.kind, "project");
    if (app?.kind !== "project") return;
    assert.equal(app.selected, true);
    assert.equal(app.openId, "a");
  });

  it("falls back to the first open conversation when the remembered one is gone", () => {
    const tabs = strip({ lastOpen: { "/work/app": "missing" }, activeChatId: "c" });
    const app = tabs[0];
    assert.equal(app?.kind, "project");
    if (app?.kind !== "project") return;
    assert.equal(app.openId, "a");
  });

  it("keeps the Code tab on its own, where it sits among projects", () => {
    const items: TabItem[] = [...tabItemsFromIds(["a"]), { kind: "code" }, ...tabItemsFromIds(["c"])];
    const tabs = strip({ items, codeFocused: true, activeChatId: "a" });
    assert.deepEqual(
      tabs.map((entry) => entry.kind),
      ["project", "code", "project"],
    );
    assert.equal(tabs[0]?.kind === "project" ? tabs[0].selected : true, false);
    assert.equal(tabs[0]?.kind === "project" ? tabs[0].openId : "", "a");
  });

  it("keeps one tab when the same project continues after Code", () => {
    const items: TabItem[] = [...tabItemsFromIds(["a"]), { kind: "code" }, ...tabItemsFromIds(["b"])];
    const tabs = strip({ items, activeChatId: "b" });
    const projects = tabs.filter((entry) => entry.kind === "project");
    assert.equal(projects.length, 1);
    assert.deepEqual(projects[0]?.kind === "project" ? projects[0].chats.map((chat) => chat.id) : [], ["a", "b"]);
    assert.equal(tabs[1]?.kind, "code");
    assert.equal(projects[0]?.kind === "project" ? projects[0].openId : "", "b");
  });

  it("groups conversations that have no project yet", () => {
    const tabs = strip({
      items: tabItemsFromIds(["x", "y"]),
      homes: {},
      titles: { x: "Draft", y: "Other" },
      runningIds: new Set(),
      activeChatId: "x",
      lastOpen: {},
    });
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0]?.kind === "project" ? tabs[0].name : "", "Chats");
    assert.equal(tabs[0]?.kind === "project" ? tabs[0].openId : "", "x");
  });

  it("lists both sides of a split under that project", () => {
    const items = splitChatTab(tabItemsFromIds(["a", "d", "c"]), "d", "split-1", homes);
    const tabs = strip({ items, activeChatId: "d" });
    const app = tabs[0];
    assert.equal(app?.kind, "project");
    if (app?.kind !== "project") return;
    assert.deepEqual(
      app.chats.map((chat) => chat.id),
      ["a", "d"],
    );
    assert.equal(app.chats[1]?.split?.groupId, "split-1");
    assert.equal(app.chats[1]?.split?.pane, 1);
    assert.equal(app.chats[1]?.selected, true);
  });

  it("uses a sidebar name when one was given", () => {
    const tabs = strip({ names: { "/work/app": "Orca" } });
    assert.equal(tabs[0]?.kind === "project" ? tabs[0].name : "", "Orca");
  });
});

describe("nestProjectChats", () => {
  const chats = [
    { id: "parent", title: "Parent" },
    { id: "other", title: "Other" },
    { id: "child", title: "Child" },
    { id: "late", title: "Late" },
  ];
  const parents: Record<string, string> = { child: "parent", late: "child", orphan: "missing" };

  it("indents a subagent under the chat that opened it", () => {
    const rows = nestProjectChats(chats, (id) => parents[id] ?? "");
    assert.deepEqual(
      rows.map((row) => [row.id, row.depth]),
      [
        ["parent", 0],
        ["child", 1],
        ["late", 2],
        ["other", 0],
      ],
    );
  });

  it("keeps a subagent in place when its parent is not open, still indented", () => {
    const rows = nestProjectChats(
      [{ id: "a" }, { id: "orphan" }, { id: "b" }],
      (id) => parents[id] ?? "",
      (id) => id === "orphan",
    );
    assert.deepEqual(
      rows.map((row) => [row.id, row.depth]),
      [
        ["a", 0],
        ["orphan", 1],
        ["b", 0],
      ],
    );
  });

  it("does not loop when two chats point at each other", () => {
    const rows = nestProjectChats(
      [{ id: "a" }, { id: "b" }],
      (id) => (id === "a" ? "b" : "a"),
    );
    assert.deepEqual(rows.map((row) => row.id).sort(), ["a", "b"]);
    assert.equal(rows.length, 2);
  });
});

describe("projectMenuEntries", () => {
  const split = (id: string, pane: 0 | 1) => ({ id, split: { groupId: "s", pane } });
  const chat = (id: string) => ({ id, split: null });

  it("shows both panes of a split as one group", () => {
    const entries = projectMenuEntries(
      [chat("a"), split("left", 0), split("right", 1), chat("z")],
      () => "",
    );
    assert.deepEqual(
      entries.map((entry) =>
        entry.kind === "split" ? ["split", entry.rows.map((row) => row.chat.id)] : ["chat", entry.chat.id],
      ),
      [
        ["chat", "a"],
        ["split", ["left", "right"]],
        ["chat", "z"],
      ],
    );
  });

  it("places the group where the first pane is listed and keeps left then right", () => {
    const entries = projectMenuEntries(
      [split("right", 1), chat("mid"), split("left", 0)],
      () => "",
    );
    assert.equal(entries[0]?.kind, "split");
    assert.deepEqual(
      entries[0]?.kind === "split" ? entries[0].rows.map((row) => row.chat.id) : [],
      ["left", "right"],
    );
    assert.equal(entries[1]?.kind === "chat" ? entries[1].chat.id : "", "mid");
  });

  it("indents a subagent of a split pane inside the group", () => {
    const entries = projectMenuEntries(
      [split("left", 0), chat("child"), split("right", 1)],
      (id) => (id === "child" ? "left" : ""),
    );
    const group = entries[0];
    assert.equal(group?.kind, "split");
    assert.deepEqual(
      group?.kind === "split" ? group.rows.map((row) => [row.chat.id, row.depth]) : [],
      [
        ["left", 0],
        ["child", 1],
        ["right", 0],
      ],
    );
  });

  it("leaves a split side alone when the other pane is not in this list", () => {
    const entries = projectMenuEntries([split("left", 0), chat("other")], () => "");
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "chat" ? entry.chat.id : entry.kind)),
      ["left", "other"],
    );
  });
});

describe("rememberProjectChat", () => {
  it("records the open conversation under its project", () => {
    const next = rememberProjectChat({}, homes, "a");
    assert.equal(next["/work/app"], "a");
    assert.equal(rememberProjectChat(next, homes, "a"), next);
    assert.equal(rememberProjectChat(next, homes, ""), next);
  });
});
