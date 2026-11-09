import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIONS_ACTIVE_MS,
  ACTIONS_IDLE_MS,
  actionRunLine,
  actionsView,
  planActionsRefresh,
  type ActionRun,
} from "../github-actions.ts";

const NOW = Date.parse("2026-04-08T12:10:00Z");

function run(patch: Partial<ActionRun> & Pick<ActionRun, "id">): ActionRun {
  return {
    workflow: "CI",
    title: "CI",
    status: "completed",
    conclusion: "success",
    branch: "main",
    url: `https://github.com/acme/app/actions/runs/${patch.id}`,
    started_at: "2026-04-08T12:00:00Z",
    updated_at: "2026-04-08T12:06:00Z",
    ...patch,
  };
}

describe("planActionsRefresh", () => {
  it("does not call GitHub while the pane is hidden or a call is in flight", () => {
    assert.deepEqual(
      planActionsRefresh({ fetchedAt: null, now: NOW, hasActive: true, inFlight: false, visible: false }),
      { refresh: false, delayMs: 0 },
    );
    assert.deepEqual(
      planActionsRefresh({ fetchedAt: null, now: NOW, hasActive: false, inFlight: true, visible: true }),
      { refresh: false, delayMs: 0 },
    );
  });

  it("fetches immediately when nothing is cached", () => {
    assert.deepEqual(
      planActionsRefresh({ fetchedAt: null, now: NOW, hasActive: false, inFlight: false, visible: true }),
      { refresh: true, delayMs: 0 },
    );
  });

  it("waits out the active window, then fetches while something is running", () => {
    assert.deepEqual(
      planActionsRefresh({
        fetchedAt: NOW - 5_000,
        now: NOW,
        hasActive: true,
        inFlight: false,
        visible: true,
      }),
      { refresh: false, delayMs: ACTIONS_ACTIVE_MS - 5_000 },
    );
    assert.deepEqual(
      planActionsRefresh({
        fetchedAt: NOW - ACTIONS_ACTIVE_MS,
        now: NOW,
        hasActive: true,
        inFlight: false,
        visible: true,
      }),
      { refresh: true, delayMs: 0 },
    );
  });

  it("waits minutes when every run has finished", () => {
    assert.deepEqual(
      planActionsRefresh({
        fetchedAt: NOW - 60_000,
        now: NOW,
        hasActive: false,
        inFlight: false,
        visible: true,
      }),
      { refresh: false, delayMs: ACTIONS_IDLE_MS - 60_000 },
    );
    assert.deepEqual(
      planActionsRefresh({
        fetchedAt: NOW - ACTIONS_IDLE_MS,
        now: NOW,
        hasActive: false,
        inFlight: false,
        visible: true,
      }),
      { refresh: true, delayMs: 0 },
    );
  });

  it("a forced refresh skips the window unless a call is already in flight or the pane is hidden", () => {
    assert.deepEqual(
      planActionsRefresh({
        fetchedAt: NOW,
        now: NOW,
        hasActive: false,
        inFlight: false,
        visible: true,
        force: true,
      }),
      { refresh: true, delayMs: 0 },
    );
    assert.deepEqual(
      planActionsRefresh({
        fetchedAt: null,
        now: NOW,
        hasActive: true,
        inFlight: true,
        visible: true,
        force: true,
      }),
      { refresh: false, delayMs: 0 },
    );
    assert.deepEqual(
      planActionsRefresh({
        fetchedAt: null,
        now: NOW,
        hasActive: true,
        inFlight: false,
        visible: false,
        force: true,
      }),
      { refresh: false, delayMs: 0 },
    );
  });
});

describe("actionsView", () => {
  it("hides the row when this branch has no runs and nothing is running elsewhere", () => {
    assert.equal(actionsView([], "main", NOW).show, false);
    const elsewhere = actionsView([run({ id: 1, branch: "feature", conclusion: "success" })], "main", NOW);
    assert.equal(elsewhere.show, false);
    assert.equal(elsewhere.elsewhere, null);
  });

  it("says CI passed for a green branch, using the newest finish", () => {
    const view = actionsView(
      [
        run({ id: 1, workflow: "Build", updated_at: "2026-04-08T12:06:00Z" }),
        run({ id: 2, workflow: "Lint", conclusion: "skipped", updated_at: "2026-04-08T12:08:00Z" }),
      ],
      "main",
      NOW,
    );
    assert.deepEqual(view.headline, { tone: "pass", text: "CI passed · 2m" });
    assert.equal(view.elsewhere, null);
    assert.deepEqual(view.branchRuns.map((row) => row.id), [2, 1]);
  });

  it("names a single failure and counts several", () => {
    const one = actionsView(
      [run({ id: 1, workflow: "Build", conclusion: "failure", updated_at: "2026-04-08T12:06:00Z" })],
      "main",
      NOW,
    );
    assert.deepEqual(one.headline, { tone: "fail", text: "Build failed · 4m" });

    const two = actionsView(
      [
        run({ id: 1, workflow: "Build", conclusion: "timed_out", updated_at: "2026-04-08T12:02:00Z" }),
        run({ id: 2, workflow: "Lint", conclusion: "startup_failure", updated_at: "2026-04-08T12:07:00Z" }),
      ],
      "main",
      NOW,
    );
    assert.deepEqual(two.headline, { tone: "fail", text: "2 failed · 3m" });
  });

  it("prefers a running or queued workflow over an older failure", () => {
    const running = actionsView(
      [
        run({ id: 1, workflow: "Build", conclusion: "failure" }),
        run({
          id: 2,
          workflow: "Lint",
          status: "in_progress",
          conclusion: "",
          started_at: "2026-04-08T12:08:00Z",
        }),
      ],
      "main",
      NOW,
    );
    assert.deepEqual(running.headline, { tone: "run", text: "Lint · running · 2m" });

    const queued = actionsView(
      [
        run({
          id: 3,
          workflow: "Build",
          status: "queued",
          conclusion: "",
          started_at: "2026-04-08T12:09:30Z",
        }),
      ],
      "main",
      NOW,
    );
    assert.deepEqual(queued.headline, { tone: "run", text: "Build · queued · 30s" });
  });

  it("collapses several active runs on this branch and uses the longest elapsed", () => {
    const view = actionsView(
      [
        run({
          id: 1,
          workflow: "Build",
          status: "in_progress",
          conclusion: "",
          started_at: "2026-04-08T12:05:00Z",
        }),
        run({
          id: 2,
          workflow: "Lint",
          status: "queued",
          conclusion: "",
          started_at: "2026-04-08T12:09:00Z",
        }),
      ],
      "main",
      NOW,
    );
    assert.deepEqual(view.headline, { tone: "run", text: "2 running · 5m" });
  });

  it("keeps only the latest run of each workflow", () => {
    const view = actionsView(
      [
        run({ id: 1, workflow: "Build", conclusion: "failure", started_at: "2026-04-08T11:00:00Z" }),
        run({ id: 2, workflow: "Build", conclusion: "success", started_at: "2026-04-08T12:00:00Z" }),
      ],
      "main",
      NOW,
    );
    assert.equal(view.headline?.tone, "pass");
    assert.deepEqual(view.branchRuns.map((row) => row.id), [2]);
  });

  it("calls a cancelled latest run cancelled, unless something failed", () => {
    const cancelled = actionsView(
      [run({ id: 1, workflow: "Build", conclusion: "cancelled" })],
      "main",
      NOW,
    );
    assert.deepEqual(cancelled.headline, { tone: "cancel", text: "Build cancelled · 4m" });

    const failed = actionsView(
      [
        run({ id: 1, workflow: "Build", conclusion: "cancelled", updated_at: "2026-04-08T12:08:00Z" }),
        run({ id: 2, workflow: "Lint", conclusion: "action_required", updated_at: "2026-04-08T12:04:00Z" }),
      ],
      "main",
      NOW,
    );
    assert.equal(failed.headline?.tone, "fail");
    assert.equal(failed.headline?.text.startsWith("Lint failed"), true);
  });

  it("adds a second line only for runs still going on other branches", () => {
    const one = actionsView(
      [
        run({ id: 1, workflow: "Build" }),
        run({
          id: 2,
          workflow: "Lint",
          branch: "feature/login",
          status: "in_progress",
          conclusion: "",
          started_at: "2026-04-08T12:08:00Z",
        }),
      ],
      "main",
      NOW,
    );
    assert.equal(one.headline?.text.startsWith("CI passed"), true);
    assert.equal(one.elsewhere, "Lint running on feature/login");
    assert.deepEqual(one.otherActive.map((row) => row.id), [2]);

    const many = actionsView(
      [
        run({ id: 1 }),
        run({ id: 2, branch: "a", status: "queued", conclusion: "", workflow: "Build" }),
        run({ id: 3, branch: "b", status: "in_progress", conclusion: "", workflow: "Lint" }),
      ],
      "main",
      NOW,
    );
    assert.equal(many.elsewhere, "2 running on other branches");
  });

  it("shows at most eight workflows for this branch", () => {
    const runs = Array.from({ length: 9 }, (_, index) =>
      run({
        id: index + 1,
        workflow: `Job ${index + 1}`,
        started_at: new Date(NOW - (9 - index) * 60_000).toISOString(),
      }),
    );
    const view = actionsView(runs, "main", NOW);
    assert.equal(view.branchRuns.length, 8);
    assert.equal(view.branchRuns[0]?.workflow, "Job 9");
  });

  it("labels one run for the expanded list", () => {
    assert.deepEqual(
      actionRunLine(
        run({ id: 1, status: "in_progress", conclusion: "", started_at: "2026-04-08T12:08:00Z" }),
        NOW,
      ),
      { tone: "run", text: "running · 2m" },
    );
    assert.deepEqual(
      actionRunLine(run({ id: 2, conclusion: "failure", updated_at: "2026-04-08T12:06:00Z" }), NOW),
      { tone: "fail", text: "failed · 4m" },
    );
  });
});
