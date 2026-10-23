import { useId, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "./ui/chart";
import { formatTokenCount } from "../lib/context";
import { providerFor, type ProviderId } from "../lib/provider";
import {
  chartCeiling,
  trendBucketSpan,
  type UsageTrend,
  type UsageTrendPoint,
  type UsageTrendRange,
} from "../lib/usage";

/** Same hues as the provider marks in the rest of the app. */
const SERIES: { id: ProviderId | "other"; label: string; color: string }[] = [
  { id: "xai", label: "Grok", color: "var(--usage-xai)" },
  { id: "minimax", label: "MiniMax", color: "#e21680" },
  { id: "anthropic", label: "Claude", color: "#d97757" },
  { id: "other", label: "Other", color: "#8d8d92" },
];

type SeriesId = ProviderId | "other";

function seriesId(model: string): SeriesId {
  const id = model.trim();
  if (!id) return "other";
  if (providerFor(id) === "xai" && !id.toLowerCase().startsWith("grok")) return "other";
  return providerFor(id);
}

const chartConfig = {
  xai: { label: "Grok", color: "var(--usage-xai)" },
  minimax: { label: "MiniMax", color: "#e21680" },
  anthropic: { label: "Claude", color: "#d97757" },
  other: { label: "Other", color: "#8d8d92" },
  total: { label: "Total" },
  label: { label: "When" },
} satisfies ChartConfig;

type ChartRow = {
  label: string;
  atMs: number;
  total: number;
  xai: number;
  minimax: number;
  anthropic: number;
  other: number;
};

export function UsageLineChart({
  trend,
  range,
  focusModel = null,
  focusProvider = null,
}: {
  trend: UsageTrend;
  range: UsageTrendRange;
  /** One model. Wins over `focusProvider`. */
  focusModel?: string | null;
  /** A provider id, such as `xai`. Other series fade. */
  focusProvider?: string | null;
}) {
  const gradientId = useId().replace(/:/g, "");
  const rows = useMemo(() => chartRows(trend.points), [trend.points]);
  const present = useMemo(() => seriesPresent(rows), [rows]);
  const focusSeries = focusModel
    ? seriesId(focusModel)
    : focusProvider && SERIES.some((row) => row.id === focusProvider)
      ? (focusProvider as SeriesId)
      : null;
  // The ceiling is the busiest day of everything, not the row under the pointer.
  // Rescaling on hover made the remaining line jump to a new height and back.
  const ceiling = useMemo(() => {
    const peak = Math.max(0, ...rows.map((row) => row.total));
    return peak > 0 ? chartCeiling(peak) : 0;
  }, [rows]);
  const ticks = tickIndexes(rows, range);
  const tickLabels = new Map(ticks.map((index) => [index, rows[index]?.label ?? ""]));

  return (
    <ChartContainer
      config={chartConfig}
      className="usage-chart aspect-auto h-[168px] w-full"
      aria-label={chartLabel(trend)}
    >
      <AreaChart data={rows.map((row, index) => ({ ...row, index }))} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-line)" strokeOpacity={0.5} />
        <XAxis
          dataKey="index"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          ticks={ticks.map(String)}
          tickFormatter={(value) => tickLabels.get(Number(value)) ?? ""}
          tick={{ fill: "var(--color-muted)", fontSize: 11 }}
        />
        <YAxis
          width={36}
          domain={[0, ceiling > 0 ? ceiling : "auto"]}
          axisLine={false}
          tickLine={false}
          tickCount={2}
          tickFormatter={(value) => (Number(value) > 0 ? formatTokenCount(Number(value)) : "")}
          tick={{ fill: "var(--color-muted)", fontSize: 10 }}
        />
        <ChartTooltip
          cursor={{ stroke: "var(--color-line)", strokeWidth: 1 }}
          isAnimationActive
          animationDuration={180}
          animationEasing="ease-out"
          content={<UsageTooltip range={range} focusSeries={focusSeries} />}
        />
        <defs>
          {SERIES.map((series) => (
            <linearGradient key={series.id} id={`fill-${gradientId}-${series.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={series.color} stopOpacity={0.8} />
              <stop offset="95%" stopColor={series.color} stopOpacity={0.1} />
            </linearGradient>
          ))}
        </defs>
        {present.map((series) => {
          const dim = focusSeries != null && focusSeries !== series.id;
          return (
            <Area
              key={series.id}
              dataKey={series.id}
              type="monotone"
              fill={`url(#fill-${gradientId}-${series.id})`}
              fillOpacity={dim ? 0.05 : 0.4}
              stroke={series.color}
              strokeWidth={1.75}
              strokeOpacity={dim ? 0.2 : 1}
              stackId="usage"
              isAnimationActive={false}
              activeDot={dim ? false : { r: 4, strokeWidth: 0, fill: series.color }}
              style={{ transition: "fill-opacity 180ms ease-out, stroke-opacity 180ms ease-out" }}
            />
          );
        })}
      </AreaChart>
    </ChartContainer>
  );
}

function UsageTooltip({
  active,
  payload,
  range,
  focusSeries,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartRow; value?: unknown; dataKey?: unknown }>;
  range: UsageTrendRange;
  focusSeries: SeriesId | null;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const total = focusSeries ? row[focusSeries] : row.total;
  const parts = SERIES.map((series) => ({ ...series, total: row[series.id] }))
    .filter((series) => series.total > 0)
    .sort((a, b) => b.total - a.total);
  return (
    <div className="grid min-w-[9.5rem] gap-0.5 rounded-[10px] border border-line bg-canvas/95 px-2.5 py-1.5 text-[11px] text-ink shadow-card">
      <div className="font-medium tabular-nums">{formatTokenCount(total)}</div>
      <div className="text-muted">{trendBucketSpan(range, row.atMs)}</div>
      {parts.length > 0 ? (
        <div className="mt-1 grid gap-0.5 border-t border-line/70 pt-1">
          {parts.map((series) => (
            <div
              key={series.id}
              className={`flex items-center justify-between gap-3 ${
                focusSeries && focusSeries !== series.id ? "opacity-35" : ""
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="usage-dot" style={{ background: series.color }} />
                <span className="min-w-0 truncate text-muted">{series.label}</span>
              </span>
              <span className="shrink-0 tabular-nums">{formatTokenCount(series.total)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-0.5 text-muted">No tokens</div>
      )}
    </div>
  );
}

function chartRows(points: UsageTrendPoint[]): ChartRow[] {
  return points.map((point) => {
    const row: ChartRow = {
      label: point.label,
      atMs: point.atMs,
      total: point.total,
      xai: 0,
      minimax: 0,
      anthropic: 0,
      other: 0,
    };
    for (const model of point.models) {
      row[seriesId(model.model)] += model.total;
    }
    return row;
  });
}

function seriesPresent(rows: ChartRow[]): { id: SeriesId; label: string; color: string }[] {
  return SERIES.filter((series) => rows.some((row) => row[series.id] > 0)).sort((a, b) => {
    const total = (id: SeriesId) => rows.reduce((sum, row) => sum + row[id], 0);
    return total(a.id) - total(b.id);
  });
}

function tickIndexes(rows: ChartRow[], range: UsageTrendRange): number[] {
  if (rows.length === 0) return [];
  if (rows.length <= 8) return rows.map((_, i) => i);
  const mid = Math.floor((rows.length - 1) / 2);
  const last = rows.length - 1;
  if (range !== "24h") return [0, mid, last];
  return [0, mid, last].filter((index, i, all) => all.indexOf(index) === i);
}

function chartLabel(trend: UsageTrend): string {
  const first = trend.points[0]?.label ?? "";
  const last = trend.points[trend.points.length - 1]?.label ?? "";
  return `${formatTokenCount(trend.totals.total)} tokens from ${first} to ${last}`;
}
