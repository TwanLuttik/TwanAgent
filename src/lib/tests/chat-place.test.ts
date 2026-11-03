import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatFooterLabel, pullRequestForBranch } from "../chat-place.ts";

describe("chatFooterLabel", () => {
  it("joins the branch, an open pull request, and where the project lives", () => {
    assert.equal(
      chatFooterLabel({
        branch: "feat/login",
        worktree: false,
        server: false,
        pr: { number: 12, open: true },
      }),
      "feat/login · #12 · Local",
    );
  });

  it("marks a worktree, a closed pull request, and a server", () => {
    assert.equal(
      chatFooterLabel({
        branch: "feat/login",
        worktree: true,
        server: true,
        pr: { number: 4, open: false },
      }),
      "feat/login · #4 closed · Server",
    );
  });

  it("puts ahead and behind next to the branch", () => {
    assert.equal(
      chatFooterLabel({
        branch: "main",
        worktree: false,
        server: false,
        ahead: 2,
        behind: 1,
        dirty: 4,
        pr: null,
      }),
      "main ↑2 ↓1 · Local",
    );
  });

  it("keeps the location when the branch and pull request are unknown", () => {
    assert.equal(
      chatFooterLabel({ branch: "  ", worktree: false, server: false, pr: null }),
      "Local",
    );
  });
});

describe("pullRequestForBranch", () => {
  it("matches the checkout branch and ignores the rest", () => {
    const rows = [
      { number: 4, branch: "feat/login", open: false },
      { number: 9, branch: "main", open: true },
    ];
    assert.deepEqual(pullRequestForBranch(rows, "feat/login"), { number: 4, open: false });
    assert.equal(pullRequestForBranch(rows, "other"), null);
    assert.equal(pullRequestForBranch(rows, "  "), null);
  });
});
