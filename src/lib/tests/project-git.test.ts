import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectGitLabel } from "../project-git.ts";

describe("projectGitLabel", () => {
  it("shows the current branch", () => {
    assert.deepEqual(projectGitLabel({ current: "feat/claude-models", branches: ["main"], repo: true }), {
      branch: "feat/claude-models",
    });
  });

  it("hides folders that are not a git repo", () => {
    assert.equal(projectGitLabel(null), null);
    assert.equal(projectGitLabel({ current: null, branches: [], repo: false }), null);
  });

  it("labels a detached head and skips an empty repo with no branch yet", () => {
    assert.deepEqual(projectGitLabel({ current: null, branches: ["main"], repo: true }), { branch: "detached" });
    assert.equal(projectGitLabel({ current: null, branches: [], repo: true }), null);
  });

  it("keeps ahead, behind, and dirty counts from a summary", () => {
    assert.deepEqual(
      projectGitLabel({
        repo: true,
        current: "main",
        detached: false,
        commit: "abc1234",
        upstream: "origin/main",
        ahead: 2,
        behind: 0,
        dirty: 3,
        staged: 1,
        unstaged: 1,
        untracked: 1,
        conflicts: 0,
      }),
      { branch: "main", ahead: 2, dirty: 3 },
    );
  });
});
