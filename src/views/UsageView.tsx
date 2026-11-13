import { useEffect, useMemo, useRef, useState } from "react";
import { AccountForecastView } from "../components/AccountForecast";
import { Symbol } from "../components/Symbol";
import { UsageRhythm } from "../components/UsageRhythm";
import { accountFromUsage, forecastAccounts, forecastHeadline, historyPoints, type AccountUsageHistory } from "../lib/account-forecast";
import { formatTokenCount } from "../lib/context";
import { projectKey } from "../lib/core";
import { providerFor, providerProfile, type ProviderId } from "../lib/provider";
import { useAccountUsage } from "../lib/account-usage-store";
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
  mark: string;
  total: number;
  /** Tokens from turns recorded on this machine. */
  client: number;
  /** Tokens copied from a paired server. */
  server: number;
  usd: number;
  priced: boolean;
};

const RANGES: { id: UsageRange; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: 7, label: "7d" },
  { id: 30, label: "30d" },
  { id: 90, label: "90d" },
];

const PROVIDER_COLOR: Record<string, string> = {
  xai: "var(--usage-xai)",
  anthropic: "#d97757",
  minimax: "#e21680",
  openai: "#10a37f",
  other: "#8d8d92",
};

export function UsageView({ onClose }: { onClose?: () => void } = {}) {
  const [range, setRange] = useState<UsageRange>(30);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [cloud, setCloud] = useState<api.ApiCloudUsageProject[]>([]);
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
    const load = () =>
      api
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
    // The server log lands in the same table, so the list is read again once it arrives.
    void api
      .usageSync()
      .then(() => load())
      .catch(() => undefined);
    void load();
    void api
      .usageCloud()
      .then((rows) => {
        if (!gone) setCloud(rows);
      })
      .catch(() => undefined);
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
  const mix = useMemo(
    () => usageMix(events, { range, workspacePath }),
    [events, range, workspacePath],
  );
  const branches = usageBranches(share);
  const cloudProjects = useMemo(
    () => (workspacePath ? cloud.filter((project) => projectKey(project.project_path) === projectKey(workspacePath)) : cloud),
    [cloud, workspacePath],
  );
  const cloudChats = cloudProjects.flatMap((project) => project.chats);
  const cloudTokens = cloudChats.reduce((sum, row) => sum + row.prompt_tokens, 0);
  const activeDays = trend.points.filter((point) => point.total > 0).length;
  const busiest = trend.points.reduce<(typeof trend.points)[number] | null>(
    (best, point) => (point.total > (best?.total ?? 0) ? point : best),
    null,
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
      <div className="grid w-full max-w-[960px] gap-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase">Usage</div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <ProjectMenu
                projects={all.projects.map((project) => ({ path: project.path, name: project.name }))}
                value={workspacePath}
                onChange={setWorkspacePath}
              />
              <span className="text-[15px] text-muted">
                {range === "24h" ? "last 24 hours" : `last ${range} days`}
              </span>
            </div>
          </div>
          <Segmented label="Usage range" value={range} options={RANGES} onChange={setRange} />
        </header>

        {error ? <p className="m-0 text-[12px] text-err">{error}</p> : null}

        <section className="grid items-end gap-6 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <Headline label="Estimated spend" value={formatUsd(cost.usd)} />
            <Headline label="Tokens" value={formatTokenCount(snap.totals.total)} />
            {cloudProjects.length > 0 && cloudChats.length > 0 ? (
              <Headline
                label="Cloud context"
                value={formatTokenCount(cloudTokens)}
                hint={cloudHint(cloudProjects.length, cloudChats.length)}
              />
            ) : null}
            <p className="mb-1 max-w-[28ch] text-[12px] leading-relaxed text-muted">
              {snap.totals.total <= 0
                ? "Nothing recorded in this range yet."
                : `${activeDays} ${range === "24h" ? "hours" : "days"} with usage${
                    snap.durationCount > 0 ? `, ${formatDuration(snap.avgDurationMs ?? 0)} a turn` : ""
                  }. List price.`}
            </p>
          </div>
          <SpendSplit share={providerRows(share)} total={cost.usd} />
        </section>

        <section>
          {snap.totals.total <= 0 ? (
            <p className="m-0 border-y border-line/50 py-10 text-center text-[12px] text-muted">
              Token usage shows up here after you send messages.
            </p>
          ) : (
            <UsageRhythm trend={trend} range={range} focusModel={focusModel} />
          )}
          {busiest && busiest.total > 0 && range !== "24h" ? (
            <p className="mt-3 mb-0 text-[12px] text-muted">
              Busiest day {busiest.label}, {formatTokenCount(busiest.total)} tokens
              {snap.totals.total > 0 ? ` · ${usageShareLabel(busiest.total, snap.totals.total)} of the range` : ""}.
            </p>
          ) : null}
        </section>

        <section className="grid grid-cols-2 gap-x-8 gap-y-4 border-y border-line/40 py-3 sm:grid-cols-4">
          <FlowCell label="Fresh input" value={formatTokenCount(mix.fresh)} hint="Billed at the full rate" />
          <FlowCell label="From cache" value={formatTokenCount(mix.cached)} hint={mix.savedUsd > 0 ? `${formatUsd(mix.savedUsd)} saved` : "No cache hits"} />
          <FlowCell label="Written out" value={formatTokenCount(mix.completion)} hint={outputShare(mix)} />
          <FlowCell
            label="Unpriced"
            value={cost.unpricedTokens > 0 ? formatTokenCount(cost.unpricedTokens) : "None"}
            hint={cost.unpricedTokens > 0 ? "No list price, left out of the estimate" : "Every token has a rate"}
          />
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[13px] font-medium">Where it went</h2>
            <span className="text-[11px] text-muted">
              {branches.length} {branches.length === 1 ? "provider" : "providers"}
            </span>
          </div>
          {branches.length === 0 ? (
            <p className="m-0 py-3 text-[12px] text-muted">No model usage in this range.</p>
          ) : (
            <div>
              {branches.map((branch) => (
                <UsageBranchRow
                  key={branch.id}
                  branch={branch}
                  max={branches[0]?.total ?? 1}
                  total={snap.totals.total}
                  focusModel={focusModel}
                  onEnter={setFocusModel}
                  onLeave={() => setFocusModel(null)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="border-t border-line/40 pt-8">
          <AccountsPage events={events} />
        </section>
      </div>
    </div>
  );
}

function cloudHint(projects: number, chats: number): string {
  const projectLabel = `${projects} ${projects === 1 ? "project" : "projects"}`;
  return `${projectLabel} · ${chats} ${chats === 1 ? "chat" : "chats"} open, latest context`;
}

function outputShare(mix: ReturnType<typeof usageMix>): string {
  if (mix.total <= 0) return "Nothing written";
  return `${usageShareLabel(mix.completion, mix.total)} of tokens`;
}

function AccountsPage({ events }: { events: UsageEvent[] }) {
  const grok = useAccountUsage("xai");
  const claude = useAccountUsage("anthropic");
  const minimax = useAccountUsage("minimax");
  const openai = useAccountUsage("openai");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [history, setHistory] = useState<AccountUsageHistory[]>([]);
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    let gone = false;
    const load = () => {
      void api
        .accountUsageHistory()
        .then((rows) => {
          if (gone) return;
          setHistory(
            historyPoints(
              rows.map((row) => ({
                provider: row.provider,
                windowId: row.window_id,
                resetsAt: row.resets_at,
                usedPercent: row.used_percent,
                recordedAt: row.recorded_at,
              })),
            ),
          );
        })
        .catch(() => undefined);
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      gone = true;
      window.clearInterval(id);
    };
  }, []);
  const rows = useMemo(() => {
    const accounts = [
      accountFromUsage("xai", grok.usage, nowMs),
      accountFromUsage("anthropic", claude.usage, nowMs),
      accountFromUsage("minimax", minimax.usage, nowMs),
      accountFromUsage("openai", openai.usage, nowMs),
    ];
    return accounts.flatMap((account) => forecastAccounts(account, events, nowMs));
  }, [claude.usage, events, grok.usage, minimax.usage, nowMs, openai.usage]);
  const headline = useMemo(() => forecastHeadline(rows, nowMs), [nowMs, rows]);
  const waiting =
    (grok.loading && !grok.usage) ||
    (claude.loading && !claude.usage) ||
    (minimax.loading && !minimax.usage) ||
    (openai.loading && !openai.usage);
  if (waiting && rows.every((row) => row.account.reconnect)) {
    return <p className="m-0 py-4 text-[12px] text-muted">Checking signed-in accounts…</p>;
  }
  return <AccountForecastView rows={rows} headline={headline} nowMs={nowMs} history={history} />;
}

function Headline({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 text-[26px] leading-none font-semibold tracking-tight tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted/80">{hint}</div> : null}
    </div>
  );
}

function ProjectMenu({
  projects,
  value,
  onChange,
}: {
  projects: { path: string; name: string }[];
  value: string | null;
  onChange: (path: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = projects.find((project) => project.path === value);
  useEffect(() => {
    if (!open) return;
    function onPointer(ev: PointerEvent) {
      if (!root.current?.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1 text-[15px] font-medium text-ink hover:text-ink/80"
      >
        <span className="max-w-[16rem] truncate">{current?.name ?? "All projects"}</span>
        <svg viewBox="0 0 12 12" className={`size-3 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Project"
          className="absolute top-full left-0 z-20 mt-1.5 max-h-72 w-max min-w-[14rem] max-w-[20rem] overflow-auto rounded-[10px] border border-line bg-canvas py-1 shadow-card"
        >
          <ProjectOption
            name="All projects"
            selected={value == null}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          />
          {projects.map((project) => (
            <ProjectOption
              key={project.path}
              name={project.name}
              selected={project.path === value}
              onClick={() => {
                onChange(project.path);
                setOpen(false);
              }}
            />
          ))}
          {projects.length === 0 ? <div className="px-3 py-1.5 text-[12px] text-muted">No projects in this range</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function ProjectOption({ name, selected, onClick }: { name: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`block w-full truncate px-3 py-1.5 text-left text-[13px] ${
        selected ? "text-ink" : "text-ink/80 hover:bg-wash hover:text-ink"
      }`}
    >
      {name}
    </button>
  );
}

/** Cost share as a single stacked bar, with the dollar amount under each slice. */
function SpendSplit({ share, total }: { share: BreakdownRow[]; total: number }) {
  const parts = share.filter((row) => row.usd > 0);
  if (parts.length === 0 || total <= 0) {
    return (
      <p className="m-0 text-[12px] text-muted sm:text-right">No priced usage in this range.</p>
    );
  }
  return (
    <div className="grid content-end gap-2">
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {parts.map((row) => (
          <div
            key={row.model}
            title={`${row.name} ${formatUsd(row.usd)}`}
            style={{
              width: `${Math.max(2, (row.usd / total) * 100)}%`,
              background: PROVIDER_COLOR[row.model] ?? PROVIDER_COLOR.other,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((row) => (
          <span key={row.model} className="flex items-baseline gap-1.5 text-[12px]">
            <span className="size-1.5 translate-y-[-1px] rounded-full" style={{ background: PROVIDER_COLOR[row.model] ?? PROVIDER_COLOR.other }} />
            <span className="text-muted">{row.name}</span>
            <span className="tabular-nums">{formatUsd(row.usd)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function FlowCell({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-[18px] leading-none font-medium tabular-nums">{value}</div>
      <div className="mt-1.5 text-[11px] text-muted/80">{hint}</div>
    </div>
  );
}

type UsageBranch = {
  id: ProviderId | "other";
  name: string;
  mark: string;
  total: number;
  server: number;
  usd: number;
  priced: boolean;
  children: BreakdownRow[];
};

function branchId(model: string): ProviderId | "other" {
  const provider = providerFor(model);
  if (provider === "xai" && !model.trim().toLowerCase().startsWith("grok")) return "other";
  return provider;
}

/** Providers as parents, models as children, largest first. */
function usageBranches(rows: BreakdownRow[]): UsageBranch[] {
  const groups = new Map<string, UsageBranch>();
  for (const row of rows) {
    const id = branchId(row.model);
    const prev = groups.get(id);
    if (prev) {
      prev.total += row.total;
      prev.server += row.server;
      prev.usd += row.usd;
      prev.priced = prev.priced || row.priced;
      prev.children.push(row);
      continue;
    }
    groups.set(id, {
      id,
      name: id === "other" ? "Other" : PROVIDER_NAMES[id],
      mark: row.mark,
      total: row.total,
      server: row.server,
      usd: row.usd,
      priced: row.priced,
      children: [row],
    });
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function UsageBranchRow({
  branch,
  max,
  total,
  focusModel,
  onEnter,
  onLeave,
}: {
  branch: UsageBranch;
  max: number;
  total: number;
  focusModel: string | null;
  onEnter: (model: string) => void;
  onLeave: () => void;
}) {
  const width = max > 0 ? Math.max(2, (branch.total / max) * 100) : 0;
  const color = PROVIDER_COLOR[branch.id] ?? PROVIDER_COLOR.other;
  const dimParent = focusModel != null && branch.children.every((row) => row.model !== focusModel);
  return (
    <div className={`border-b border-line/25 py-3 transition-opacity last:border-b-0 ${dimParent ? "opacity-35" : ""}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_4.75rem] items-center gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <ProviderMark model={branch.mark} />
              <span className="min-w-0 truncate text-[13px] font-medium">{branch.name}</span>
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">{usageShareLabel(branch.total, total)}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink/[0.06]">
            <div className="h-full rounded-full" style={{ width: `${width}%`, background: color }} />
          </div>
        </div>
        <UsageAmount total={branch.total} usd={branch.usd} priced={branch.priced} />
      </div>
      <div className="mt-1">
        {branch.children.map((row, index) => {
          const childWidth = branch.total > 0 ? Math.max(2, (row.total / branch.total) * 100) : 0;
          const dim = focusModel != null && focusModel !== row.model;
          const last = index === branch.children.length - 1;
          return (
            <div
              key={row.model || "unknown"}
              tabIndex={0}
              onMouseEnter={() => onEnter(row.model)}
              onMouseLeave={onLeave}
              onFocus={() => onEnter(row.model)}
              onBlur={onLeave}
              className={`relative py-1.5 pl-6 outline-none transition-opacity ${dim ? "opacity-35" : ""}`}
            >
              <TreeGuide last={last} />
              <div className="grid grid-cols-[minmax(0,1fr)_4.75rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-[12px] text-ink/85" title={row.name}>{row.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted">{usageShareLabel(row.total, total)}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink/[0.06]">
                    <div className="h-full rounded-full" style={{ width: `${childWidth}%`, background: color, opacity: 0.72 }} />
                  </div>
                  {row.server > 0 ? (
                    <div className="mt-1 text-[11px] tabular-nums text-muted">{formatTokenCount(row.server)} on a server</div>
                  ) : null}
                </div>
                <UsageAmount total={row.total} usd={row.usd} priced={row.priced} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Rounded elbow into the model name. The stem stops at the last model. */
function TreeGuide({ last }: { last: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 left-[7px] h-3.5 w-2.5 rounded-bl-[5px] border-b border-l border-line/50"
      />
      {last ? null : (
        <span aria-hidden className="pointer-events-none absolute top-3.5 bottom-0 left-[7px] w-px bg-line/50" />
      )}
    </>
  );
}

function UsageAmount({ total, usd, priced }: { total: number; usd: number; priced: boolean }) {
  return (
    <div className="text-right">
      <div className="text-[13px] tabular-nums">{formatTokenCount(total)}</div>
      <div className={`mt-0.5 text-[11px] tabular-nums ${priced ? "text-muted" : "text-muted/50"}`} title={priced ? undefined : "No list price"}>
        {priced ? formatUsd(usd) : "—"}
      </div>
    </div>
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
  const color =
    profile.id === "anthropic" ? "text-[#d97757]" : profile.id === "openai" ? "text-[#10a37f]" : "usage-mark-xai";
  return (
    <span className={`flex size-4 shrink-0 items-center justify-center ${color}`}>
      <Symbol name={profile.symbol} className="size-3.5" />
    </span>
  );
}

const PROVIDER_NAMES: Record<ProviderId, string> = {
  xai: "Grok",
  anthropic: "Claude",
  minimax: "MiniMax",
  openai: "OpenAI",
};

function shareOf(models: UsageModel[], cost: ReturnType<typeof estimateUsageCost>): BreakdownRow[] {
  return models
    .map((row) => ({
      model: row.model,
      name: formatModelName(row.model),
      mark: row.model,
      total: row.total,
      client: row.client,
      server: row.server,
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
      prev.client += row.client;
      prev.server += row.server;
      prev.usd += row.usd;
      prev.priced = prev.priced || row.priced;
      continue;
    }
    groups.set(id, {
      model: id,
      name: id === "other" ? "Other" : PROVIDER_NAMES[id],
      mark: row.mark,
      total: row.total,
      client: row.client,
      server: row.server,
      usd: row.usd,
      priced: row.priced,
    });
  }
  return [...groups.values()].sort((a, b) => b.usd - a.usd || b.total - a.total || a.name.localeCompare(b.name));
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
    <div className="flex gap-px rounded-[7px] bg-wash p-0.5" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={String(opt.id)}
          type="button"
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={`rounded-[5px] px-2.5 py-1 text-[11px] leading-none ${
            value === opt.id ? "bg-ink text-canvas" : "text-muted hover:text-ink"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
