import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gitSectionAfterLoad, gitSectionTabs } from "../git-sections.ts";

describe("git section tabs", () => {
  it("hides the pull request until this branch has one", () => {
    assert.deepEqual(gitSectionTabs(false), ["changes", "commits"]);
    assert.deepEqual(gitSectionTabs(true), ["changes", "commits", "request"]);
  });

  it("drops back to changes when the open request disappears", () => {
    assert.equal(gitSectionAfterLoad("request", false), "changes");
    assert.equal(gitSectionAfterLoad("request", true), "request");
    assert.equal(gitSectionAfterLoad("commits", false), "commits");
  });
});
