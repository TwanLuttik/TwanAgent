import { useEffect, useRef, useState } from "react";
import {
  actionIsActive,
  actionRunLine,
  actionsView,
  planActionsRefresh,
  type ActionHeadline,
  type ActionRun,
} from "../../lib/github-actions";
import type { GitActionsSnapshot } from "../../lib/tauri";
import * as api from "../../lib/tauri";
import { Symbol } from "../Symbol";

const RETRY_AFTER_PUSH_MS = 8_000;

/**
 * One status row under the branch. The saved list paints first.
 * GitHub is asked again only while this pane is open, and never twice at once.
 */
export function ActionsRow({
  workspace,
  branch,
  refreshToken,
}: {
  workspace: string;
  branch: string;
  /** Bumps after a push so a new run is picked up without waiting out the idle window. */
  refreshToken: number;
}) {
  const [runs, setRuns] = useState<ActionRun[]>([]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scheduleRef = useRef<(force?: boolean) => void>(() => {});
  const active = runs.some(actionIsActive);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let inFlight = false;
    let again = false;
    let stopped = false;
    let fetchedAt: number | null = null;
    let hasActive = false;
    let sawFetch = false;

    function schedule(force = false) {
      window.clearTimeout(timer);
      if (cancelled || stopped) return;
      if (force && inFlight) {
        again = true;
        return;
      }
      const plan = planActionsRefresh({
        fetchedAt,
        now: Date.now(),
        hasActive,
        inFlight,
        visible: document.visibilityState !== "hidden",
        force,
      });
      if (!plan.refresh) {
        if (plan.delayMs > 0) timer = window.setTimeout(() => schedule(false), plan.delayMs);
        return;
      }
      void pull();
    }

    function apply(snap: GitActionsSnapshot) {
      const at = Date.parse(snap.fetched_at);
      fetchedAt = Number.isNaN(at) ? Date.now() : at;
      hasActive = snap.runs.some(actionIsActive);
      setRuns(snap.runs);
      setNow(Date.now());
    }

    async function pull() {
      if (inFlight || cancelled || stopped) return;
      inFlight = true;
      try {
        const snap = await api.gitActions(workspace);
        if (cancelled) return;
        if (!snap) {
          stopped = true;
          sawFetch = true;
          setRuns([]);
          return;
        }
        sawFetch = true;
        apply(snap);
      } catch {
        if (!cancelled) fetchedAt = Date.now();
      } finally {
        inFlight = false;
      }
      if (cancelled || stopped) return;
      const retry = again;
      again = false;
      schedule(retry);
    }

    scheduleRef.current = schedule;
    void api.gitActionsCached(workspace).then(
      (snap) => {
        if (cancelled || sawFetch) return;
        if (snap) apply(snap);
        schedule(false);
      },
      () => {
        if (!cancelled) schedule(false);
      },
    );
    function onVisible() {
      schedule(false);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      scheduleRef.current = () => {};
    };
  }, [workspace]);

  useEffect(() => {
    if (!refreshToken) return;
    scheduleRef.current(true);
    const retry = window.setTimeout(() => scheduleRef.current(true), RETRY_AFTER_PUSH_MS);
    return () => window.clearTimeout(retry);
  }, [refreshToken]);

  const view = actionsView(runs, branch, now);
  if (!view.show) return null;
  const tone = view.headline?.tone ?? "run";
  const primary = view.headline?.text ?? view.elsewhere ?? "";
  const secondary = view.headline && view.elsewhere ? view.elsewhere : null;
  const both = view.branchRuns.length > 0 && view.otherActive.length > 0;

  return (
    <div className="group/actions mt-0.5">
      <div className="flex items-center pr-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-1 pl-2.5 text-left"
        >
          <StatusDot tone={tone} />
          <span className={`min-w-0 flex-1 truncate text-[12px] ${toneText(tone)}`}>{primary}</span>
          <Symbol name={open ? "chevron.down" : "chevron.right"} className="size-2.5 shrink-0 text-muted" />
        </button>
        <button
          type="button"
          aria-label="Refresh GitHub Actions"
          title="Refresh GitHub Actions"
          onClick={() => scheduleRef.current(true)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 hover:text-ink group-hover/actions:opacity-100"
        >
          <Symbol name="arrow.2.circlepath" className="size-3" />
        </button>
      </div>
      {secondary ? <p className="truncate pr-3 pb-0.5 pl-6 text-[12px] text-muted">{secondary}</p> : null}
      {open ? (
        <div className="pt-0.5 pb-1">
          {view.branchRuns.length > 0 ? (
            <section>
              {both ? <h3 className="px-2 pt-1 pb-0.5 text-[11px] font-semibold text-muted">This branch</h3> : null}
              {view.branchRuns.map((run) => (
                <RunLine key={run.id} run={run} now={now} showBranch={false} />
              ))}
            </section>
          ) : null}
          {view.otherActive.length > 0 ? (
            <section>
              <h3 className="px-2 pt-1 pb-0.5 text-[11px] font-semibold text-muted">Running elsewhere</h3>
              {view.otherActive.map((run) => (
                <RunLine key={run.id} run={run} now={now} showBranch />
              ))}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RunLine({ run, now, showBranch }: { run: ActionRun; now: number; showBranch: boolean }) {
  const line = actionRunLine(run, now);
  const name = run.workflow.trim() || "Workflow";
  const title = run.title.trim();
  return (
    <button
      type="button"
      onClick={() => {
        if (run.url) void api.openUrl(run.url);
      }}
      className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left hover:bg-wash"
    >
      <StatusDot tone={line.tone} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-ink">{name}</span>
        {title && title !== name ? <span className="block truncate text-[11px] text-muted">{title}</span> : null}
      </span>
      <span className="shrink-0 text-right text-[11px] text-muted">
        {showBranch && run.branch ? <span className="block max-w-[8rem] truncate">{run.branch}</span> : null}
        <span className="tabular-nums">{line.text}</span>
      </span>
    </button>
  );
}

function StatusDot({ tone }: { tone: ActionHeadline["tone"] }) {
  const color = tone === "fail" ? "bg-err" : tone === "run" ? "bg-warn motion-safe:animate-pulse" : tone === "cancel" ? "bg-muted" : "bg-ok";
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${color}`} />;
}

function toneText(tone: ActionHeadline["tone"]): string {
  if (tone === "fail") return "text-err";
  if (tone === "pass" || tone === "cancel") return "text-muted";
  return "text-ink";
}
