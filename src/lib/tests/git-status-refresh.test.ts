import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GIT_STATUS_STATS_COALESCE_MS, planGitStatusRefresh, switchedOntoGitTab } from "../git-status-refresh.ts";

const NOW = 10_000;
const WINDOW = GIT_STATUS_STATS_COALESCE_MS;

describe("planGitStatusRefresh", () => {
  it("skips line counts unless the active tab is git", () => {
    assert.deepEqual(
      planGitStatusRefresh({ activeKind: "files", lastStatsAt: null, now: NOW }),
      { run: true, stats: false },
    );
    assert.deepEqual(
      planGitStatusRefresh({ activeKind: "terminal", lastStatsAt: null, now: NOW }),
      { run: true, stats: false },
    );
    assert.deepEqual(
      planGitStatusRefresh({ activeKind: null, lastStatsAt: NOW, now: NOW }),
      { run: true, stats: false },
    );
  });

  it("loads line counts when git is active and no stats pass has run", () => {
    assert.deepEqual(
      planGitStatusRefresh({ activeKind: "git", lastStatsAt: null, now: NOW }),
      { run: true, stats: true },
    );
  });

  it("loads line counts immediately when switching onto the git tab", () => {
    assert.deepEqual(
      planGitStatusRefresh({
        activeKind: "git",
        lastStatsAt: NOW - 200,
        now: NOW,
        switchedToGit: true,
      }),
      { run: true, stats: true },
    );
  });

  it("holds a second stats pass and schedules one trailing refresh", () => {
    const held = planGitStatusRefresh({
      activeKind: "git",
      lastStatsAt: NOW - 400,
      now: NOW,
    });
    assert.deepEqual(held, { run: false, stats: false, delayMs: WINDOW - 400 });
  });

  it("notices only the refresh that lands on the git tab", () => {
    assert.equal(switchedOntoGitTab("files", "git"), true);
    assert.equal(switchedOntoGitTab("terminal", "git"), true);
    assert.equal(switchedOntoGitTab(null, "git"), true);
    assert.equal(switchedOntoGitTab("git", "git"), false);
    assert.equal(switchedOntoGitTab("git", "files"), false);
    assert.equal(switchedOntoGitTab("files", "terminal"), false);
  });

  it("runs stats again once the coalesce window has passed", () => {
    assert.deepEqual(
      planGitStatusRefresh({
        activeKind: "git",
        lastStatsAt: NOW - WINDOW,
        now: NOW,
      }),
      { run: true, stats: true },
    );
    assert.deepEqual(
      planGitStatusRefresh({
        activeKind: "git",
        lastStatsAt: NOW - WINDOW - 1,
        now: NOW,
      }),
      { run: true, stats: true },
    );
  });
});
