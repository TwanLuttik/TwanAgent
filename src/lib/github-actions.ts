/** How often to ask GitHub again while a run is queued or in progress. */
export const ACTIONS_ACTIVE_MS = 20_000;

/** How often to ask when every run we know about has finished. */
export const ACTIONS_IDLE_MS = 180_000;

export type ActionRun = {
  id: number;
  workflow: string;
  title: string;
  /** queued, in_progress, completed, waiting, pending, or requested. */
  status: string;
  /** success, failure, cancelled, skipped, timed_out, or empty while the run is open. */
  conclusion: string;
  branch: string;
  url: string;
  started_at: string;
  updated_at: string;
};

export type ActionsRefresh = { refresh: boolean; delayMs: number };

/**
 * One list call while the Git pane is on screen.
 * A hidden pane and an in-flight call never start another.
 * A force (push, or the refresh button) skips the wait.
 */
export function planActionsRefresh(input: {
  fetchedAt: number | null;
  now: number;
  hasActive: boolean;
  inFlight: boolean;
  visible: boolean;
  force?: boolean;
}): ActionsRefresh {
  if (!input.visible || input.inFlight) return { refresh: false, delayMs: 0 };
  if (input.force || input.fetchedAt == null) return { refresh: true, delayMs: 0 };
  const windowMs = input.hasActive ? ACTIONS_ACTIVE_MS : ACTIONS_IDLE_MS;
  const age = input.now - input.fetchedAt;
  if (age >= windowMs) return { refresh: true, delayMs: 0 };
  return { refresh: false, delayMs: windowMs - age };
}

export type ActionHeadline = { tone: "run" | "fail" | "pass" | "cancel"; text: string };

export type ActionsView = {
  show: boolean;
  headline: ActionHeadline | null;
  elsewhere: string | null;
  /** Latest run of each workflow on this branch, newest first. At most eight. */
  branchRuns: ActionRun[];
  /** Queued or in-progress runs on other branches. At most eight. */
  otherActive: ActionRun[];
};

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required", "stale"]);
const QUEUED = new Set(["queued", "waiting", "pending", "requested"]);

export function actionIsActive(run: ActionRun): boolean {
  return run.status !== "completed";
}

/** Status and age for one row in the expanded list. */
export function actionRunLine(run: ActionRun, now: number): ActionHeadline {
  if (actionIsActive(run)) {
    const word = QUEUED.has(run.status) ? "queued" : "running";
    return { tone: "run", text: `${word} · ${age(run.started_at, now, true)}` };
  }
  if (FAILED.has(run.conclusion)) {
    return { tone: "fail", text: `failed · ${age(run.updated_at, now, false)}` };
  }
  if (run.conclusion === "cancelled") {
    return { tone: "cancel", text: `cancelled · ${age(run.updated_at, now, false)}` };
  }
  return { tone: "pass", text: `passed · ${age(run.updated_at, now, false)}` };
}

export function actionsView(runs: ActionRun[], branch: string, now: number): ActionsView {
  const latest = latestPerWorkflow(runs.filter((run) => run.branch === branch));
  const active = latest.filter(actionIsActive);
  const failed = latest.filter((run) => FAILED.has(run.conclusion));
  const cancelled = latest.filter((run) => run.conclusion === "cancelled");
  const headline = headlineFor(latest, active, failed, cancelled, now);
  const otherActive = runs
    .filter((run) => run.branch !== branch && actionIsActive(run))
    .sort(byNewestStart);
  return {
    show: headline !== null || otherActive.length > 0,
    headline,
    elsewhere: elsewhereLine(otherActive),
    branchRuns: latest.slice(0, 8),
    otherActive: otherActive.slice(0, 8),
  };
}

function headlineFor(
  latest: ActionRun[],
  active: ActionRun[],
  failed: ActionRun[],
  cancelled: ActionRun[],
  now: number,
): ActionHeadline | null {
  if (active.length === 1) {
    const row = active[0];
    const word = QUEUED.has(row.status) ? "queued" : "running";
    return { tone: "run", text: `${workflowName(row)} · ${word} · ${age(row.started_at, now, true)}` };
  }
  if (active.length > 1) {
    const longest = active.reduce((a, b) => (stamp(a.started_at) <= stamp(b.started_at) ? a : b));
    return { tone: "run", text: `${active.length} running · ${age(longest.started_at, now, true)}` };
  }
  if (failed.length === 1) {
    const row = failed[0];
    return { tone: "fail", text: `${workflowName(row)} failed · ${age(row.updated_at, now, false)}` };
  }
  if (failed.length > 1) {
    const newest = failed.reduce((a, b) => (stamp(a.updated_at) >= stamp(b.updated_at) ? a : b));
    return { tone: "fail", text: `${failed.length} failed · ${age(newest.updated_at, now, false)}` };
  }
  if (cancelled.length === 1) {
    const row = cancelled[0];
    return { tone: "cancel", text: `${workflowName(row)} cancelled · ${age(row.updated_at, now, false)}` };
  }
  if (cancelled.length > 1) {
    const newest = cancelled.reduce((a, b) => (stamp(a.updated_at) >= stamp(b.updated_at) ? a : b));
    return { tone: "cancel", text: `${cancelled.length} cancelled · ${age(newest.updated_at, now, false)}` };
  }
  if (latest.length === 0) return null;
  const newest = latest.reduce((a, b) => (stamp(a.updated_at) >= stamp(b.updated_at) ? a : b));
  return { tone: "pass", text: `CI passed · ${age(newest.updated_at, now, false)}` };
}

function elsewhereLine(runs: ActionRun[]): string | null {
  if (runs.length === 0) return null;
  if (runs.length === 1) {
    const row = runs[0];
    const word = QUEUED.has(row.status) ? "queued" : "running";
    return `${workflowName(row)} ${word} on ${row.branch}`;
  }
  return `${runs.length} running on other branches`;
}

function latestPerWorkflow(runs: ActionRun[]): ActionRun[] {
  const best = new Map<string, ActionRun>();
  for (const run of runs) {
    const key = workflowName(run);
    const prev = best.get(key);
    if (!prev || newer(run, prev)) best.set(key, run);
  }
  return [...best.values()].sort(byNewestStart);
}

function newer(run: ActionRun, prev: ActionRun): boolean {
  const started = stamp(run.started_at) - stamp(prev.started_at);
  if (started !== 0) return started > 0;
  return run.id > prev.id;
}

function byNewestStart(a: ActionRun, b: ActionRun): number {
  return stamp(b.started_at) - stamp(a.started_at) || b.id - a.id;
}

function workflowName(run: ActionRun): string {
  const name = run.workflow.trim() || run.title.trim();
  return name || "Workflow";
}

function stamp(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

function age(iso: string, now: number, active: boolean): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return active && seconds >= 5 ? `${seconds}s` : "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}
