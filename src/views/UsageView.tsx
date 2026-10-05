import { useEffect, useMemo, useState } from "react";
import { UsageChart } from "../components/UsageChart";
import { formatTokenCount } from "../lib/dev-context";
import {
  buildUsageSnapshot,
  rangeStartMs,
  type UsageEvent,
  type UsageRange,
} from "../lib/dev-usage";
import * as api from "../lib/tauri";

const RANGES: { id: UsageRange; label: string }[] = [
  { id: 7, label: "7 days" },
  { id: 30, label: "30 days" },
  { id: 90, label: "90 days" },
];

export function UsageView({ onClose }: { onClose?: () => void } = {}) {
  const [range, setRange] = useState<UsageRange>(30);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!onClose) return;
    const close = onClose;
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let gone = false;
    const since = new Date(rangeStartMs(range)).toISOString();
    void api
      .devUsageList(since)
      .then((rows) => {
        if (!gone) {
          setEvents(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (!gone) setError(String(e));
      });
    return () => {
      gone = true;
    };
  }, [range]);

  const all = useMemo(() => buildUsageSnapshot(events, { range }), [events, range]);
  const snap = useMemo(
    () => buildUsageSnapshot(events, { range, workspacePath }),
    [events, range, workspacePath],
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
      <div className="mx-auto grid w-full max-w-[720px] gap-5">
        <div>
          <h1 className="m-0 text-[15px] font-semibold">Usage</h1>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">
            Tokens added across every project. A tool round counts only the new context, not the prompt sent again.
          </p>
        </div>
        <div className="flex gap-1">
          {RANGES.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setRange(opt.id)}
              className={`rounded-[6px] px-2 py-1 text-[12px] ${
                range === opt.id ? "bg-wash-strong text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {error ? <p className="m-0 text-[12px] text-err">{error}</p> : null}
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Prompt" value={formatTokenCount(snap.totals.prompt)} />
          <Stat label="Completion" value={formatTokenCount(snap.totals.completion)} />
          <Stat label="Total" value={formatTokenCount(snap.totals.total)} />
        </div>
        <section>
          {snap.totals.total === 0 ? (
            <p className="m-0 py-6 text-[12px] text-muted">
              Token usage will show up here after you send messages.
            </p>
          ) : (
            <UsageChart days={snap.days} />
          )}
        </section>
        <section>
          <div className="mb-2 text-[12px] font-medium text-ink">Projects</div>
          {all.projects.length === 0 ? (
            <p className="m-0 text-[12px] text-muted">No project usage in this range.</p>
          ) : (
            <div className="grid gap-0.5">
              <button
                type="button"
                onClick={() => setWorkspacePath(null)}
                className={`flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-left text-[13px] ${
                  !workspacePath ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
                }`}
              >
                <span>All projects</span>
                <span className="tabular-nums text-[12px] text-muted">{formatTokenCount(all.totals.total)}</span>
              </button>
              {all.projects.map((project) => {
                const selected = workspacePath === project.path;
                return (
                  <button
                    key={project.path}
                    type="button"
                    onClick={() => setWorkspacePath(selected ? null : project.path)}
                    className={`flex w-full items-center justify-between gap-3 rounded-[6px] px-2 py-1.5 text-left text-[13px] ${
                      selected ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
                    }`}
                  >
                    <span className="min-w-0 truncate">{project.name}</span>
                    <span className="shrink-0 tabular-nums text-[12px] text-muted">
                      {formatTokenCount(project.total)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}


