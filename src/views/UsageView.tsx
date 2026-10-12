import { useEffect, useMemo, useState } from "react";
import { UsageChart } from "../components/UsageChart";
import { UsageLineChart } from "../components/UsageLineChart";
import { formatTokenCount } from "../lib/context";
import {
  buildUsageSnapshot,
  estimateUsageCost,
  formatDuration,
  formatModelName,
  formatUsd,
  modelColorIndex,
  buildUsageTrend,
  rangeStartMs,
  type UsageEvent,
  type UsageModel,
  type UsageRange,
} from "../lib/usage";
import * as api from "../lib/tauri";

const RANGES: { id: UsageRange; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: 7, label: "7 days" },
  { id: 30, label: "30 days" },
  { id: 90, label: "90 days" },
];

export function UsageView({ onClose }: { onClose?: () => void } = {}) {
  const [range, setRange] = useState<UsageRange>(30);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [error, setError] = useState("");
  const [focusModel, setFocusModel] = useState<string | null>(null);

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
      .usageList(since)
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
  const trend = useMemo(
    () => buildUsageTrend(events, { range, workspacePath }),
    [events, range, workspacePath],
  );
  const cost = useMemo(
    () => estimateUsageCost(events, { range, workspacePath }),
    [events, range, workspacePath],
  );
  const share = shareOf(snap.models);
  const projectMax = Math.max(1, ...all.projects.map((project) => project.total));
  const promptShare = snap.totals.total > 0 ? Math.round((snap.totals.prompt / snap.totals.total) * 100) : 0;

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
      <div className="mx-auto grid w-full max-w-[920px] gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="m-0 text-[18px] font-semibold tracking-tight">Usage</h1>
            <p className="mt-1 mb-0 max-w-[46ch] text-[12px] leading-relaxed text-muted">
              New tokens only. A tool round does not count the prompt again. Cost is an xAI, Anthropic, and MiniMax
              list-price estimate, with cached tokens priced as fresh input.
            </p>
          </div>
          <Segmented
            label="Usage range"
            value={range}
            options={RANGES}
            onChange={setRange}
          />
        </div>
        {error ? <p className="m-0 text-[12px] text-err">{error}</p> : null}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Stat
            label="Tokens"
            value={formatTokenCount(snap.totals.total)}
            detail={snap.totals.total > 0 ? `${promptShare}% prompt` : "No tokens yet"}
          />
          <Stat
            label="Est. cost"
            value={formatUsd(cost.usd)}
            detail={costDetail(cost)}
            title="xAI, Anthropic, and MiniMax list prices for the tokens added in this range"
          />
          <Stat
            label="Completion"
            value={formatTokenCount(snap.totals.completion)}
            detail={`${formatTokenCount(snap.totals.prompt)} in`}
          />
          <Stat
            label="Avg response"
            value={snap.avgDurationMs == null ? "—" : formatDuration(snap.avgDurationMs)}
            detail={snap.durationCount > 0 ? `${snap.durationCount} turns` : "No timed turns"}
          />
        </div>

        <section>
          <div className="mb-1">
            <div className="text-[12px] font-medium text-ink">Tokens over time</div>
            <div className="text-[11px] text-muted">Drag a range to total it. Double-click to clear.</div>
          </div>
          <UsageLineChart trend={trend} range={range} focusModel={focusModel} />
          {snap.models.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 px-1">
              {snap.models.map((row) => {
                const dim = focusModel != null && focusModel !== row.model;
                return (
                  <span
                    key={row.model || "unknown"}
                    className={`flex items-center gap-1.5 text-[11px] text-muted ${dim ? "opacity-35" : ""}`}
                  >
                    <span className={`usage-dot usage-swatch-${modelColorIndex(row.model)}`} />
                    {formatModelName(row.model)}
                  </span>
                );
              })}
            </div>
          ) : null}
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div className="text-[12px] font-medium text-ink">Activity</div>
            <div className="text-[11px] text-muted">
              {range === "24h" ? "Last 24 hours" : `${range} day calendar`}
            </div>
          </div>
          {snap.totals.total === 0 ? (
            <p className="m-0 py-4 text-[12px] text-muted">Token usage will show up here after you send messages.</p>
          ) : (
            <UsageChart days={snap.days} />
          )}
        </section>

        <div className="grid gap-8 sm:grid-cols-2">
          <section>
            <div className="mb-3 text-[12px] font-medium text-ink">Models</div>
            {snap.models.length === 0 ? (
              <p className="m-0 text-[12px] text-muted">No model usage in this range.</p>
            ) : (
              <div className="grid">
                {share.map((row) => {
                  const on = focusModel === row.model;
                  const dim = focusModel != null && !on;
                  return (
                    <button
                      key={row.model || "unknown"}
                      type="button"
                      onMouseEnter={() => setFocusModel(row.model)}
                      onMouseLeave={() => setFocusModel(null)}
                      onFocus={() => setFocusModel(row.model)}
                      onBlur={() => setFocusModel(null)}
                      className={`grid grid-cols-[auto_minmax(0,1fr)_4.25rem_2.75rem] items-center gap-x-3 rounded-[8px] px-2 py-1.5 text-left text-[13px] ${
                        on ? "bg-wash-strong" : "hover:bg-wash"
                      } ${dim ? "opacity-40" : ""}`}
                    >
                      <span className={`usage-dot usage-swatch-${modelColorIndex(row.model)}`} />
                      <span className="min-w-0 truncate">{formatModelName(row.model)}</span>
                      <span className="text-right tabular-nums text-[12px] text-muted">
                        {formatTokenCount(row.total)}
                      </span>
                      <span className="text-right tabular-nums text-[12px] text-ink/55">{row.percent}%</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div className="text-[12px] font-medium text-ink">Projects</div>
              {workspacePath ? (
                <button
                  type="button"
                  onClick={() => setWorkspacePath(null)}
                  className="text-[11px] text-accent hover:text-accent-hover"
                >
                  Clear filter
                </button>
              ) : null}
            </div>
            {all.projects.length === 0 ? (
              <p className="m-0 text-[12px] text-muted">No project usage in this range.</p>
            ) : (
              <div className="grid gap-1">
                <ProjectRow
                  name="All projects"
                  total={all.totals.total}
                  max={projectMax}
                  selected={!workspacePath}
                  onClick={() => setWorkspacePath(null)}
                />
                {all.projects.map((project) => (
                  <ProjectRow
                    key={project.path}
                    name={project.name}
                    total={project.total}
                    max={projectMax}
                    selected={workspacePath === project.path}
                    onClick={() => setWorkspacePath(workspacePath === project.path ? null : project.path)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function costDetail(cost: { usd: number; xai: number; anthropic: number; minimax: number; unpricedTokens: number }): string {
  if (cost.usd <= 0 && cost.unpricedTokens <= 0) return "List price";
  const parts = [`xAI ${formatUsd(cost.xai)}`, `Claude ${formatUsd(cost.anthropic)}`];
  if (cost.minimax > 0) parts.push(`MiniMax ${formatUsd(cost.minimax)}`);
  if (cost.unpricedTokens > 0) parts.push(`${formatTokenCount(cost.unpricedTokens)} unpriced`);
  return parts.join(" · ");
}

function shareOf(models: UsageModel[]): (UsageModel & { percent: number })[] {
  const total = models.reduce((sum, row) => sum + row.total, 0);
  if (total <= 0) return models.map((row) => ({ ...row, percent: 0 }));
  const rows = models.map((row) => {
    const exact = (row.total / total) * 100;
    return { ...row, exact, percent: Math.floor(exact) };
  });
  let left = 100 - rows.reduce((sum, row) => sum + row.percent, 0);
  const byRemainder = [...rows].sort((a, b) => (b.exact - b.percent) - (a.exact - a.percent));
  for (const row of byRemainder) {
    if (left <= 0) break;
    row.percent += 1;
    left -= 1;
  }
  return rows;
}

function Stat({
  label,
  value,
  detail,
  title,
}: {
  label: string;
  value: string;
  detail: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold leading-none tracking-tight tabular-nums">{value}</div>
      <div className="mt-1.5 text-[11px] leading-snug text-muted">{detail}</div>
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-px rounded-[6px] bg-wash p-px" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={String(opt.id)}
          type="button"
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={`rounded-[5px] px-1.5 py-0.5 text-[10px] leading-none ${
            value === opt.id ? "bg-canvas text-ink shadow-card" : "text-muted hover:text-ink"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ProjectRow({
  name,
  total,
  max,
  selected,
  onClick,
}: {
  name: string;
  total: number;
  max: number;
  selected: boolean;
  onClick: () => void;
}) {
  const percent = max > 0 ? Math.round((total / max) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`grid w-full grid-cols-[minmax(0,1fr)_4.25rem_2.75rem] items-center gap-x-3 rounded-[8px] px-2 py-1.5 text-left text-[13px] ${
        selected ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
      }`}
    >
      <span className="min-w-0 truncate">{name}</span>
      <span className="text-right tabular-nums text-[12px] text-muted">{formatTokenCount(total)}</span>
      <span className="text-right tabular-nums text-[12px] text-ink/55">{percent}%</span>
    </button>
  );
}
