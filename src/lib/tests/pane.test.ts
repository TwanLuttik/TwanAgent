import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addableKinds,
  closePane,
  defaultPaneState,
  nextTerminalTitle,
  openPane,
  selectPane,
  type PaneTab,
} from "../pane.ts";

function tabsOf(kinds: Array<PaneTab["kind"] | [PaneTab["kind"], string]>): PaneTab[] {
  return kinds.map((entry, i) => {
    const kind = typeof entry === "string" ? entry : entry[0];
    const title = typeof entry === "string" ? (kind === "terminal" ? "Terminal" : kind === "files" ? "Files" : "Git") : entry[1];
    return { id: `${kind}-${i}`, kind, title };
  });
}

describe("defaultPaneState", () => {
  it("opens Terminal, Files, and Git with Files selected", () => {
    const state = defaultPaneState();
    assert.deepEqual(
      state.tabs.map((t) => t.kind),
      ["terminal", "files", "git"],
    );
    assert.equal(state.tabs.find((t) => t.id === state.activeId)?.kind, "files");
    assert.equal(state.tabs.find((t) => t.kind === "files")?.title, "Files");
    assert.equal(state.tabs.find((t) => t.kind === "git")?.title, "Git");
    assert.equal(state.tabs.find((t) => t.kind === "terminal")?.title, "Terminal");
  });
});

describe("addableKinds", () => {
  it("always offers Terminal, and Files/Git only when that kind is closed", () => {
    const all = defaultPaneState().tabs;
    assert.deepEqual(addableKinds(all), ["terminal"]);
    assert.deepEqual(addableKinds(all.filter((t) => t.kind !== "files")), ["terminal", "files"]);
    assert.deepEqual(addableKinds(all.filter((t) => t.kind !== "git")), ["terminal", "git"]);
    assert.deepEqual(addableKinds([]), ["terminal", "files", "git"]);
  });
});

describe("nextTerminalTitle", () => {
  it("uses Terminal then Terminal 2, 3 based on the highest existing number", () => {
    assert.equal(nextTerminalTitle([]), "Terminal");
    assert.equal(nextTerminalTitle(tabsOf(["terminal"])), "Terminal 2");
    assert.equal(
      nextTerminalTitle([
        { id: "a", kind: "terminal", title: "Terminal" },
        { id: "b", kind: "terminal", title: "Terminal 2" },
      ]),
      "Terminal 3",
    );
    assert.equal(
      nextTerminalTitle([{ id: "b", kind: "terminal", title: "Terminal 2" }]),
      "Terminal 3",
    );
  });
});

describe("openPane", () => {
  it("adds another Terminal and selects it", () => {
    const start = defaultPaneState();
    const next = openPane(start, "terminal");
    assert.equal(next.tabs.length, 4);
    assert.equal(next.tabs.filter((t) => t.kind === "terminal").length, 2);
    const added = next.tabs[next.tabs.length - 1];
    assert.equal(added.kind, "terminal");
    assert.equal(added.title, "Terminal 2");
    assert.equal(next.activeId, added.id);
    assert.notEqual(added.id, start.tabs[0].id);
  });

  it("selects the existing Files or Git tab instead of duplicating it", () => {
    const start = defaultPaneState();
    const files = start.tabs.find((t) => t.kind === "files")!;
    const again = openPane(start, "files");
    assert.equal(again.tabs.length, 3);
    assert.equal(again.activeId, files.id);

    const withoutGit = { ...start, tabs: start.tabs.filter((t) => t.kind !== "git"), activeId: files.id };
    const reopened = openPane(withoutGit, "git");
    assert.equal(reopened.tabs.filter((t) => t.kind === "git").length, 1);
    assert.equal(reopened.tabs.find((t) => t.id === reopened.activeId)?.kind, "git");
    assert.equal(reopened.tabs.find((t) => t.kind === "git")?.title, "Git");
  });
});

describe("closePane", () => {
  it("does not close the last tab", () => {
    const only = { tabs: [{ id: "files", kind: "files" as const, title: "Files" }], activeId: "files" };
    assert.deepEqual(closePane(only, "files"), only);
  });

  it("closes a tab and selects a neighbor when the active tab is closed", () => {
    const start = defaultPaneState();
    const files = start.tabs.find((t) => t.kind === "files")!;
    const git = start.tabs.find((t) => t.kind === "git")!;
    const closed = closePane(start, files.id);
    assert.equal(closed.tabs.some((t) => t.id === files.id), false);
    assert.equal(closed.activeId, git.id);
    assert.equal(closed.tabs.length, 2);
  });

  it("keeps the current selection when a different tab is closed", () => {
    const start = defaultPaneState();
    const term = start.tabs.find((t) => t.kind === "terminal")!;
    const closed = closePane(start, term.id);
    assert.equal(closed.activeId, start.activeId);
    assert.equal(closed.tabs.some((t) => t.kind === "terminal"), false);
  });
});

describe("selectPane", () => {
  it("selects an open tab and ignores unknown ids", () => {
    const start = defaultPaneState();
    const term = start.tabs.find((t) => t.kind === "terminal")!;
    assert.equal(selectPane(start, term.id).activeId, term.id);
    assert.equal(selectPane(start, "missing").activeId, start.activeId);
  });
});
