import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closePane, openPane } from "../pane.ts";
import {
  closedTerminalTabs,
  filePaneNeedsReload,
  forgetPaneWorkspace,
  paneForWorkspace,
  savePaneForWorkspace,
} from "../pane-sessions.ts";

describe("pane sessions", () => {
  it("keeps pane tabs for a project until they are forgotten", () => {
    forgetPaneWorkspace("/App/Alpha");
    const first = paneForWorkspace("/App/Alpha/");
    const next = openPane(first, "terminal");
    savePaneForWorkspace("/app/alpha", next);
    const again = paneForWorkspace("/app/alpha");
    assert.equal(again.tabs.filter((tab) => tab.kind === "terminal").length, 2);
    assert.equal(again.activeId, next.activeId);
    forgetPaneWorkspace("/app/alpha/");
    const fresh = paneForWorkspace("/app/alpha");
    assert.equal(fresh.tabs.filter((tab) => tab.kind === "terminal").length, 1);
    assert.notEqual(fresh.tabs.find((tab) => tab.kind === "terminal")?.id, next.tabs.at(-1)?.id);
    forgetPaneWorkspace("/app/alpha");
  });

  it("does not reload the file pane for another chat in the same project", () => {
    assert.equal(filePaneNeedsReload("/repo", "/repo"), false);
    assert.equal(filePaneNeedsReload("/repo", "/repo/"), false);
    assert.equal(filePaneNeedsReload("/Repo", "/repo"), false);
    assert.equal(filePaneNeedsReload("/repo", "/other"), true);
    assert.equal(filePaneNeedsReload("", "/repo"), true);
    assert.equal(filePaneNeedsReload("/repo", ""), false);
  });

  it("lists terminal tabs removed by a close", () => {
    const start = paneForWorkspace("/tmp/pane-close-test");
    const withTwo = openPane(start, "terminal");
    const closed = closePane(withTwo, withTwo.tabs.at(-1)!.id);
    const removed = closedTerminalTabs(withTwo, closed);
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.kind, "terminal");
    assert.equal(closedTerminalTabs(closed, closed).length, 0);
    forgetPaneWorkspace("/tmp/pane-close-test");
  });
});
