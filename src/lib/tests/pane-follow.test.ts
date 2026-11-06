import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdPaneSelection, paneProjectFollow } from "../pane-follow.ts";

describe("paneProjectFollow", () => {
  it("follows another spelling of the same project immediately", () => {
    assert.equal(paneProjectFollow("/repo", "/repo"), "now");
    assert.equal(paneProjectFollow("/Repo", "/repo/"), "now");
    assert.equal(paneProjectFollow("/repo", ""), "now");
  });

  it("waits when the conversation moved to a different project", () => {
    assert.equal(paneProjectFollow("/repo", "/other"), "later");
    assert.equal(paneProjectFollow("", "/repo"), "later");
  });
});

describe("holdPaneSelection", () => {
  it("keeps the mounted project's file highlighted while another project opens", () => {
    assert.equal(holdPaneSelection(true, "src/old.ts", "src/new.ts"), "src/old.ts");
    assert.equal(holdPaneSelection(false, "src/old.ts", "src/new.ts"), "src/new.ts");
    assert.equal(holdPaneSelection(true, null, "src/new.ts"), null);
  });
});
