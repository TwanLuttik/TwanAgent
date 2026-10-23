import { useEffect, useMemo, useState } from "react";
import { AccountForecastView } from "../components/AccountForecast";
import { Symbol } from "../components/Symbol";
import { UsageLineChart } from "../components/UsageLineChart";
import { accountFromUsage, forecastAccounts, forecastHeadline } from "../lib/account-forecast";
import { providerFor, providerProfile, type ProviderId } from "../lib/provider";
import { useAccountUsage } from "../lib/account-usage-store";
import { formatTokenCount } from "../lib/context";
import {
  buildUsageSnapshot,
  estimateUsageCost,
  formatDuration,
  formatModelName,
  formatUsd,
  modelRate,
  buildUsageTrend,
  rangeStartMs,
  usageMix,
  usageShareLabel,
  type UsageEvent,
  type UsageModel,
  type UsageRange,
} from "../lib/usage";
import * as api from "../lib/tauri";

type BreakdownRow = {
  /** Stable key. A provider row uses the provider id. */
  model: string;
  name: string;
  /** Model id the chart highlights. Empty for a provider, which keeps every series. */
  focus: string | null;
  mark: string;
  total: number;
  usd: number;
  priced: boolean;
};

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
    // Accounts need a week of history for the pace bars. The token page filters
    // the same rows down to the selected range.
    const since = new Date(rangeStartMs(90)).toISOString();
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
  }, []);

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
  const share = shareOf(snap.models, cost);
  const projectMax = Math.max(1, ...all.projects.map((project) => project.total));
  const mix = useMemo(
    () => usageMix(events, { range, workspacePath }),
    [events, range, workspacePath],
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
      <div className="mx-auto grid w-full max-w-[1080px] gap-8">
        <section className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="m-0 text-[18px] font-semibold tracking-tight">Token usage</h1>
              <p className="mt-1 mb-0 max-w-[58ch] text-[12px] leading-relaxed text-muted">
                New tokens only. A tool round does not count the prompt again. Cost is a list-price estimate, and cached reads use the cached rate.
              </p>
            </div>
            <Segmented label="Usage range" value={range} options={RANGES} onChange={setRange} />
          </div>
          {error ? <p className="m-0 text-[12px] text-err">{error}</p> : null}
          <TokenUsage
            range={range}
            workspacePath={workspacePath}
            setWorkspacePath={setWorkspacePath}
            focusModel={focusModel}
            setFocusModel={setFocusModel}
            all={all}
            snap={snap}
            trend={trend}
            cost={cost}
            share={share}
            projectMax={projectMax}
            mix={mix}
          />
        </section>
        <section className="border-t border-line/40 pt-6">
          <AccountsPage events={events} />
        </section>
      </div>
    </div>
  );
}

function AccountsPage({ events }: { events: UsageEvent[] }) {
  const grok = useAccountUsage("xai");
  const claude = useAccountUsage("anthropic");
  const minimax = useAccountUsage("minimax");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const rows = useMemo(() => {
    const accounts = [
      accountFromUsage("xai", grok.usage, nowMs),
      accountFromUsage("anthropic", claude.usage, nowMs),
      accountFromUsage("minimax", minimax.usage, nowMs),
    ];
    return accounts.flatMap((account) => forecastAccounts(account, events, nowMs));
  }, [claude.usage, events, grok.usage, minimax.usage, nowMs]);
  const headline = useMemo(() => forecastHeadline(rows, nowMs), [nowMs, rows]);
  const waiting =
    (grok.loading && !grok.usage) ||
    (claude.loading && !claude.usage) ||
    (minimax.loading && !minimax.usage);
  if (waiting && rows.every((row) => row.account.reconnect)) {
    return <p className="m-0 py-4 text-[12px] text-muted">Checking signed-in accounts…</p>;
  }
  return <AccountForecastView rows={rows} headline={headline} nowMs={nowMs} />;
}

function TokenUsage({
  range,
  workspacePath,
  setWorkspacePath,
  focusModel,
  setFocusModel,
  all,
  snap,
  trend,
  cost,
  share,
  projectMax,
  mix,
}: {
  range: UsageRange;
  workspacePath: string | null;
  setWorkspacePath: (path: string | null) => void;
  focusModel: string | null;
  setFocusModel: (model: string | null) => void;
  all: ReturnType<typeof buildUsageSnapshot>;
  snap: ReturnType<typeof buildUsageSnapshot>;
  trend: ReturnType<typeof buildUsageTrend>;
  cost: ReturnType<typeof estimateUsageCost>;
  share: BreakdownRow[];
  projectMax: number;
  mix: ReturnType<typeof usageMix>;
}) {
  const empty = snap.totals.total <= 0;
  const [byModel, setByModel] = useState(false);
  const rows = byModel ? share : providerRows(share);
  const focusProvider = !byModel && focusModel && rows.some((row) => row.model === focusModel) ? focusModel : null;
  return (
    <>
        <section className="grid gap-1">
          <div className="text-[12px] text-muted">
            {range === "24h" ? "Last 24 hours" : `Last ${range} days`}
          </div>
          <div className="text-[32px] font-semibold leading-none tracking-tight tabular-nums">
            {formatTokenCount(snap.totals.total)}
          </div>
          <div className="text-[12px] text-muted">
            {empty
              ? "No tokens yet"
              : `${formatUsd(cost.usd)} estimated · ${snap.durationCount > 0 ? formatDuration(snap.avgDurationMs ?? 0) + " avg" : "no timed turns"}`}
          </div>
        </section>

        <section>
          {empty ? (
            <p className="m-0 py-6 text-[12px] text-muted">Token usage will show up here after you send messages.</p>
          ) : (
            <UsageLineChart
              trend={trend}
              range={range}
              focusModel={byModel ? focusModel : null}
              focusProvider={byModel ? null : focusProvider}
            />
          )}
        </section>

        <section className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line/50 pt-4 sm:grid-cols-5">
          <MixStat label="Processed" value={formatTokenCount(mix.total)} />
          <MixStat label="Cached input" value={formatTokenCount(mix.cached)} />
          <MixStat label="Uncached input" value={formatTokenCount(mix.fresh)} />
          <MixStat label="Output" value={formatTokenCount(mix.completion)} />
          <MixStat
            label="Cache savings"
            value={mix.savedUsd > 0 ? formatUsd(mix.savedUsd) : "$0.00"}
            title="What the cached reads would have cost at the full input rate"
          />
        </section>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)]">
          <div className="grid content-start gap-8">
          <TypeBar mix={mix} />
          <section>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div className="text-[12px] font-medium text-ink">Breakdown</div>
              {share.length > 0 ? (
                <Segmented
                  label="Breakdown grouping"
                  value={byModel ? "model" : "provider"}
                  options={[
                    { id: "provider", label: "Provider" },
                    { id: "model", label: "Model" },
                  ]}
                  onChange={(id) => {
                    setByModel(id === "model");
                    setFocusModel(null);
                  }}
                />
              ) : null}
            </div>
            {rows.length === 0 ? (
              <p className="m-0 text-[12px] text-muted">No model usage in this range.</p>
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="text-[11px] text-muted">
                    <th className="pb-1.5 pr-3 text-left font-normal">{byModel ? "Model" : "Provider"}</th>
                    <th className="w-[5.5rem] pb-1.5 text-right font-normal">Cost</th>
                    <th className="w-[4.25rem] pb-1.5 pl-4 text-right font-normal">Share</th>
                    <th className="w-[4.75rem] pb-1.5 pl-4 text-right font-normal">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const on = focusModel === row.model;
                    const dim = focusModel != null && !on;
                    const priced = row.priced;
                    return (
                      <tr
                        key={row.model || "unknown"}
                        tabIndex={0}
                        onMouseEnter={() => setFocusModel(row.model)}
                        onMouseLeave={() => setFocusModel(null)}
                        onFocus={() => setFocusModel(row.model)}
                        onBlur={() => setFocusModel(null)}
                        className={`rounded-[6px] outline-none ${
                          on ? "bg-wash" : "hover:bg-wash"
                        } ${dim ? "opacity-40" : ""}`}
                      >
                        <td className="max-w-0 py-2.5 pr-3">
                          <span className="flex min-w-0 items-center gap-2">
                            <ProviderMark model={row.mark} />
                            <span className="min-w-0 truncate" title={row.name}>
                              {row.name}
                            </span>
                          </span>
                        </td>
                        <td
                          className={`py-2.5 text-right tabular-nums ${priced ? "text-ink" : "text-muted"}`}
                          title={priced ? undefined : "No list price"}
                        >
                          {priced ? formatUsd(row.usd) : "—"}
                        </td>
                        <td className="py-2.5 pl-4 text-right tabular-nums text-ink/70">
                          {usageShareLabel(row.total, snap.totals.total)}
                        </td>
                        <td className="py-2.5 pl-4 text-right tabular-nums">{formatTokenCount(row.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
          </div>

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
    </>
  );
}

/** The provider's own mark, in that provider's color. Unknown models stay muted. */
function ProviderMark({ model }: { model: string }) {
  const id = model.trim();
  if (!id) return <span className="usage-dot bg-muted/50" />;
  const profile = providerProfile(id);
  if (profile.id === "minimax") {
    return (
      <span className="group/minimax flex size-4 shrink-0 items-center justify-center" data-colored>
        <Symbol name={profile.symbol} className="size-3.5" />
      </span>
    );
  }
  const color = profile.id === "anthropic" ? "text-[#d97757]" : "usage-mark-xai";
  return (
    <span className={`flex size-4 shrink-0 items-center justify-center ${color}`}>
      <Symbol name={profile.symbol} className="size-3.5" />
    </span>
  );
}

function MixStat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-[15px] font-medium leading-none tabular-nums">{value}</div>
    </div>
  );
}

function TypeBar({ mix }: { mix: ReturnType<typeof usageMix> }) {
  const parts = [
    { key: "cache", label: "Cache read", value: mix.cached, cls: "bg-ink/25" },
    { key: "fresh", label: "Input", value: mix.fresh, cls: "bg-ink/55" },
    { key: "out", label: "Output", value: mix.completion, cls: "bg-ink/80" },
  ].filter((part) => part.value > 0);
  if (mix.total <= 0 || parts.length === 0) return null;
  return (
    <section className="grid gap-2">
      <div className="text-[12px] font-medium text-ink">Tokens by type</div>
      <div className="flex h-2 gap-1">
        {parts.map((part) => (
          <div
            key={part.key}
            className={`rounded-full ${part.cls}`}
            style={{ width: `${Math.max(1.5, (part.value / mix.total) * 100)}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {parts.map((part) => (
          <span key={part.key} className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${part.cls}`} />
            {part.label} {formatTokenCount(part.value)}
          </span>
        ))}
      </div>
    </section>
  );
}

const PROVIDER_NAMES: Record<ProviderId, string> = {
  xai: "Grok",
  anthropic: "Claude",
  minimax: "MiniMax",
};

function shareOf(models: UsageModel[], cost: ReturnType<typeof estimateUsageCost>): BreakdownRow[] {
  return models
    .map((row) => ({
      model: row.model,
      name: formatModelName(row.model),
      focus: row.model,
      mark: row.model,
      total: row.total,
      usd: cost.byModel[row.model.trim()] ?? 0,
      priced: modelRate(row.model) != null,
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** One row per provider, largest first. Cost is the sum of its priced models. */
function providerRows(models: BreakdownRow[]): BreakdownRow[] {
  const groups = new Map<string, BreakdownRow>();
  for (const row of models) {
    const provider = providerFor(row.model);
    const id = provider === "xai" && !row.model.trim().toLowerCase().startsWith("grok") ? "other" : provider;
    const prev = groups.get(id);
    if (prev) {
      prev.total += row.total;
      prev.usd += row.usd;
      prev.priced = prev.priced || row.priced;
      continue;
    }
    groups.set(id, {
      model: id,
      name: id === "other" ? "Other" : PROVIDER_NAMES[id],
      focus: id,
      mark: row.mark,
      total: row.total,
      usd: row.usd,
      priced: row.priced,
    });
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
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
