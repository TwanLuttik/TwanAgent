import {
  allowanceKind,
  formatForecastWhen,
  formatResetWhen,
  timelineSlices,
  usageHistoryLine,
  windowTimeline,
  type AccountUsageHistory,
  type TimelineSlice,
  type AccountForecast,
  type ForecastHeadline,
  type UsageLinePoint,
} from "../lib/account-forecast";
import { formatAccountBalance } from "../lib/account-usage";
import { Symbol } from "./Symbol";

const DAY = 24 * 60 * 60 * 1000;

export function AccountForecastView({
  rows,
  headline,
  nowMs,
  history,
}: {
  rows: AccountForecast[];
  headline: ForecastHeadline;
  nowMs: number;
  history: AccountUsageHistory[];
}) {
  return (
    <section className="min-w-0">
      <header className="mb-3">
        <h2 className="m-0 text-[18px] font-semibold tracking-tight text-ink">{headlineTitle(headline)}</h2>
        <p className="mt-1 mb-0 text-[12px] text-muted">{headlineDetail(headline, nowMs)}</p>
      </header>
      <div className="grid gap-0.5">
        {rows.map((row) => (
          <ForecastRow
            key={`${row.account.id}:${row.window?.id ?? "none"}`}
            row={row}
            nowMs={nowMs}
            history={history}
          />
        ))}
      </div>
    </section>
  );
}

function headlineTitle(headline: ForecastHeadline): string {
  if (headline.count <= 0) return "No account runs out before reset";
  if (headline.count === 1) return "1 account runs out before reset";
  return `${headline.count} accounts run out before reset`;
}

function headlineDetail(headline: ForecastHeadline, nowMs: number): string {
  const first = headline.first;
  if (!first?.runsOut) return "Assumes the current pace holds.";
  return `${first.account.name} first, ${formatForecastWhen(first.runsOut.atMs, nowMs)}`;
}

const BAR_COLOR: Record<string, string> = {
  xai: "var(--usage-xai)",
  anthropic: "#d97757",
  minimax: "#e21680",
  openai: "#10a37f",
};

function ForecastRow({
  row,
  nowMs,
  history,
}: {
  row: AccountForecast;
  nowMs: number;
  history: AccountUsageHistory[];
}) {
  const summary = rowSummary(row, nowMs);
  const color = BAR_COLOR[row.account.id] ?? "var(--color-ink)";
  const timeline = row.window ? windowTimeline(row.window, row.usedPercent, nowMs) : null;
  const line =
    timeline && row.window?.resetsAt != null
      ? usageHistoryLine(
          history.filter(
            (point) =>
              point.provider === row.account.id &&
              point.windowId === row.window?.id &&
              Math.abs(point.resetsAtMs - (row.window?.resetsAt ?? 0)) < 120_000,
          ),
          timeline.openedAt,
          timeline.resetsAt,
          nowMs,
          row.usedPercent,
        )
      : [];
  return (
    <div className="px-1 py-3">
      <div className="flex items-center gap-2">
        <Symbol name={row.account.logo} colored className="size-4 shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-ink">{row.account.name}</span>
          {row.account.detail ? <span className="block truncate text-[11px] text-muted">{row.account.detail}</span> : null}
        </span>
        <span className="ml-auto min-w-0 text-right">
          <span className="block truncate text-[12px] font-medium text-ink">{summary.title}</span>
          <span className="block truncate text-[11px] text-muted">{summary.detail}</span>
        </span>
      </div>
      {timeline && row.window ? <PlanTimeline timeline={timeline} color={color} line={line} /> : null}
    </div>
  );
}

function PlanTimeline({
  timeline,
  color,
  line,
}: {
  timeline: NonNullable<ReturnType<typeof windowTimeline>>;
  color: string;
  line: UsageLinePoint[];
}) {
  const slices = timelineSlices(timeline.openedAt, timeline.resetsAt);
  const cells = slices.length > 0 ? slices : [{ start: 0, span: 1, label: "" }];
  const now = timeline.now * 100;
  const nowAlign = now < 12 ? "translate-x-0" : now > 82 ? "-translate-x-full" : "-translate-x-1/2";
  const showNow = now < 82;
  return (
    <div className="mt-2">
      <div className="relative mb-1 h-4 text-[10px] font-medium">
        {showNow ? (
          <span className={`absolute bottom-0 text-ink ${nowAlign}`} style={{ left: `${now}%` }}>
            Now
          </span>
        ) : null}
      </div>
      <div className="relative">
        <div className="flex h-8 gap-[3px]">
          {cells.map((slice) => (
            <TimelineCell key={`${slice.start}:${slice.label}`} slice={slice} />
          ))}
        </div>
        <UsageLine points={line} color={color} />
        <span
          className="pointer-events-none absolute inset-y-[-3px] z-10 w-0.5 -translate-x-1/2 rounded-full bg-ink shadow-[0_0_0_2px_var(--color-canvas)]"
          style={{ left: `${now}%` }}
          title="Now"
        />
      </div>
      <div className="relative mt-1 h-4 text-[10px] tabular-nums text-muted">
        {cells.map((slice) =>
          slice.span >= 0.08 && slice.label ? (
            <span
              key={`${slice.start}:${slice.label}`}
              className="absolute truncate"
              style={{ left: `${slice.start * 100}%`, width: `${slice.span * 100}%` }}
            >
              {slice.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function TimelineCell({ slice }: { slice: TimelineSlice }) {
  return (
    <span className="relative h-full overflow-hidden rounded-[4px] bg-wash-strong" style={{ width: `${slice.span * 100}%` }} />
  );
}

function UsageLine({ points, color }: { points: UsageLinePoint[]; color: string }) {
  if (points.length === 0) return null;
  if (points.length === 1) {
    const point = points[0];
    return (
      <span
        className="absolute z-[5] size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full"
        style={{ left: `${point.x * 100}%`, bottom: `${point.y * 100}%`, background: color }}
        title="Usage so far"
      />
    );
  }
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${(point.x * 100).toFixed(2)} ${((1 - point.y) * 100).toFixed(2)}`)
    .join(" ");
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[5] h-full w-full overflow-visible"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function rowSummary(row: AccountForecast, nowMs: number): { title: string; detail: string } {
  const kind = allowanceKind(row.account);
  if (kind === "reconnect") return { title: "Reconnect", detail: "Sign in to see the plan" };
  if (kind === "credits") {
    const balance = formatAccountBalance(row.account.balanceCents, row.account.balanceCurrency ?? "USD");
    if (balance) return { title: "Credits", detail: `${balance} left` };
    if (row.account.creditStatus === "exhausted") return { title: "Credits", detail: "Used up" };
    return { title: "Credits", detail: "Available" };
  }
  if (kind === "unknown") {
    return row.account.detail && !GENERIC_DETAIL.has(row.account.detail)
      ? { title: "Usage plan", detail: "Allowance not reported" }
      : { title: "No allowance", detail: "Nothing reported" };
  }
  const reset = row.window?.resetsAt;
  if (row.runsOut && reset != null && row.runsOut.atMs < reset) {
    return {
      title: `Runs out ${formatForecastWhen(row.runsOut.atMs, nowMs)}`,
      detail: formatResetWhen(reset, nowMs),
    };
  }
  if (reset != null) {
    const atReset = Math.min(100, row.usedPercent + row.pacePerDay * ((reset - nowMs) / DAY));
    return {
      title: `~${Math.round(atReset)}% at reset`,
      detail: formatResetWhen(reset, nowMs),
    };
  }
  return { title: `${Math.round(row.usedPercent)}% used`, detail: "Usage plan" };
}

const GENERIC_DETAIL = new Set(["GPT", "Grok", "Claude", "MiniMax", "OpenAI"]);
