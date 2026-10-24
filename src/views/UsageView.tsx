import { useEffect, useMemo, useRef, useState } from "react";
import { AccountForecastView } from "../components/AccountForecast";
import { Symbol } from "../components/Symbol";
import { UsageRhythm } from "../components/UsageRhythm";
import { accountFromUsage, forecastAccounts, forecastHeadline } from "../lib/account-forecast";
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
  usageCostUsd,
  usageDelta,
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

type ChatRow = {
  id: string;
  title: string;
  project: string;
  model: string;
  total: number;
  usd: number;
  turns: number;
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
  const chats = useMemo(
    () => topChats(events, { range, workspacePath }),
    [events, range, workspacePath],
  );
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
      <div className="mx-auto grid w-full max-w-[920px] gap-10">
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
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[13px] font-medium">Where it went</h2>
            <span className="text-[11px] text-muted">{share.length} {share.length === 1 ? "model" : "models"}</span>
          </div>
          {share.length === 0 ? (
            <p className="m-0 py-3 text-[12px] text-muted">No model usage in this range.</p>
          ) : (
            <div>
              {share.map((row) => (
                <ModelLane
                  key={row.model || "unknown"}
                  row={row}
                  max={share[0]?.total ?? 1}
                  shareLabel={usageShareLabel(row.total, snap.totals.total)}
                  dim={focusModel != null && focusModel !== row.model}
                  onEnter={() => setFocusModel(row.model)}
                  onLeave={() => setFocusModel(null)}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[13px] font-medium">Conversations</h2>
            <span className="text-[11px] text-muted">Largest first</span>
          </div>
          {chats.length === 0 ? (
            <p className="m-0 py-3 text-[12px] text-muted">No conversations in this range.</p>
          ) : (
            <ol className="m-0 grid list-none gap-0 p-0">
              {chats.map((chat, index) => (
                <li
                  key={chat.id}
                  className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-line/40 py-2.5 last:border-b-0"
                >
                  <span className="text-[11px] tabular-nums text-muted">{String(index + 1).padStart(2, "0")}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]" title={chat.title}>{chat.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted">
                      {chat.project}
                      {chat.model ? ` · ${formatModelName(chat.model)}` : ""}
                      {chat.turns > 1 ? ` · ${chat.turns} turns` : ""}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-[13px] tabular-nums">{formatTokenCount(chat.total)}</span>
                    <span className="mt-0.5 block text-[11px] tabular-nums text-muted">
                      {chat.usd > 0 ? formatUsd(chat.usd) : "—"}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
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

function ModelLane({
  row,
  max,
  shareLabel,
  dim,
  onEnter,
  onLeave,
}: {
  row: BreakdownRow;
  max: number;
  shareLabel: string;
  dim: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const width = max > 0 ? Math.max(3, (row.total / max) * 100) : 0;
  const serverShare = row.total > 0 ? (row.server / row.total) * 100 : 0;
  const clientShare = row.total > 0 ? (row.client / row.total) * 100 : 0;
  const place = `${formatTokenCount(row.client)} on this Mac, ${formatTokenCount(row.server)} on a server`;
  return (
    <div
      tabIndex={0}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={`grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-3 border-b border-line/30 py-2.5 outline-none transition-opacity ${
        dim ? "opacity-35" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <ProviderMark model={row.mark} />
            <span className="min-w-0 truncate text-[13px]" title={row.name}>{row.name}</span>
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted">{shareLabel}</span>
        </div>
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-wash" title={place}>
          <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${width}%` }}>
            {row.client > 0 ? (
              <div className="h-full bg-ink/70" style={{ width: `${clientShare}%` }} />
            ) : null}
            {row.server > 0 ? (
              <div className={`h-full bg-ink/30 ${row.client > 0 ? "border-l border-canvas" : ""}`} style={{ width: `${serverShare}%` }} />
            ) : null}
          </div>
        </div>
        <div className="mt-1 flex gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-ink/70" />
            <span className="tabular-nums">{formatTokenCount(row.client)} here</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-ink/30" />
            <span className="tabular-nums">{formatTokenCount(row.server)} server</span>
          </span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[13px] tabular-nums">{formatTokenCount(row.total)}</div>
        <div className={`mt-0.5 text-[11px] tabular-nums ${row.priced ? "text-muted" : "text-muted/50"}`} title={row.priced ? undefined : "No list price"}>
          {row.priced ? formatUsd(row.usd) : "—"}
        </div>
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
  const color = profile.id === "anthropic" ? "text-[#d97757]" : "usage-mark-xai";
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

/** The conversations that spent the most new tokens in the window. */
function topChats(
  events: UsageEvent[],
  opts: { range: UsageRange; workspacePath?: string | null },
  limit = 6,
): ChatRow[] {
  const nowMs = Date.now();
  const startMs = rangeStartMs(opts.range, nowMs);
  const want = opts.workspacePath ? projectKey(opts.workspacePath) : "";
  const ordered = events
    .map((ev) => ({ ev, atMs: Date.parse(ev.recorded_at) }))
    .filter((row) => Number.isFinite(row.atMs))
    .sort((a, b) => a.atMs - b.atMs || a.ev.id - b.ev.id);
  const previous = new Map<string, UsageEvent>();
  const byChat = new Map<string, ChatRow & { modelTokens: Map<string, number> }>();
  for (const row of ordered) {
    const key = `${row.ev.conversation_id || `event:${row.ev.id}`}\0${row.ev.model.trim()}`;
    const delta = usageDelta(row.ev, previous.get(key));
    previous.set(key, row.ev);
    if (row.atMs < startMs || row.atMs > nowMs) continue;
    if (want && projectKey(row.ev.workspace_path) !== want) continue;
    if (delta.total <= 0) continue;
    const id = row.ev.conversation_id || `event:${row.ev.id}`;
    const cost = usageCostUsd(delta, row.ev.model, row.ev.prompt_tokens) ?? 0;
    const prev = byChat.get(id);
    if (prev) {
      prev.total += delta.total;
      prev.usd += cost;
      prev.turns += 1;
      prev.modelTokens.set(row.ev.model, (prev.modelTokens.get(row.ev.model) ?? 0) + delta.total);
      if (!prev.title && row.ev.conversation_title) prev.title = row.ev.conversation_title;
      continue;
    }
    byChat.set(id, {
      id,
      title: row.ev.conversation_title || "Untitled",
      project: row.ev.workspace_name || "Project",
      model: row.ev.model,
      total: delta.total,
      usd: cost,
      turns: 1,
      modelTokens: new Map([[row.ev.model, delta.total]]),
    });
  }
  return [...byChat.values()]
    .map((row) => {
      let model = row.model;
      let best = -1;
      for (const [id, total] of row.modelTokens) {
        if (total > best) {
          best = total;
          model = id;
        }
      }
      return { id: row.id, title: row.title, project: row.project, model, total: row.total, usd: row.usd, turns: row.turns };
    })
    .sort((a, b) => b.total - a.total || a.title.localeCompare(b.title))
    .slice(0, limit);
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
