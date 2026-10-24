import { useMemo, useState } from "react";
import { formatTokenCount } from "../lib/context";
import { providerFor, type ProviderId } from "../lib/provider";
import { chartCeiling, type UsageTrend, type UsageTrendPoint, type UsageTrendRange } from "../lib/usage";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Same hues as the provider marks. Grok follows the theme so it stays visible. */
const SERIES: { id: ProviderId | "other"; color: string }[] = [
  { id: "xai", color: "var(--usage-xai)" },
  { id: "anthropic", color: "#d97757" },
  { id: "minimax", color: "#e21680" },
  { id: "other", color: "#8d8d92" },
];

type SeriesId = ProviderId | "other";

function seriesId(model: string): SeriesId {
  const id = model.trim();
  if (!id) return "other";
  if (providerFor(id) === "xai" && !id.toLowerCase().startsWith("grok")) return "other";
  return providerFor(id);
}

function stackOf(point: UsageTrendPoint): Record<SeriesId, number> {
  const parts: Record<SeriesId, number> = { xai: 0, anthropic: 0, minimax: 0, other: 0 };
  for (const model of point.models) parts[seriesId(model.model)] += model.total;
  return parts;
}

function dayStart(atMs: number): number {
  const d = new Date(atMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 7 days comes back as one point per hour. A bar chart of 168 hours collapses,
 * so those hours fold into the seven calendar days they belong to.
 */
function dayPoints(points: UsageTrendPoint[]): UsageTrendPoint[] {
  const days: UsageTrendPoint[] = [];
  const index = new Map<number, number>();
  for (const point of points) {
    const atMs = dayStart(point.atMs);
    const slot = index.get(atMs);
    if (slot == null) {
      index.set(atMs, days.length);
      days.push({ ...point, atMs, label: "", models: point.models.map((model) => ({ ...model })) });
      continue;
    }
    const day = days[slot];
    day.prompt += point.prompt;
    day.completion += point.completion;
    day.total += point.total;
    for (const model of point.models) {
      const prev = day.models.find((row) => row.model === model.model);
      if (prev) {
        prev.prompt += model.prompt;
        prev.completion += model.completion;
        prev.total += model.total;
      } else {
        day.models.push({ ...model });
      }
    }
  }
  return days;
}

function chartPoints(trend: UsageTrend, range: UsageTrendRange): UsageTrendPoint[] {
  if (range !== 7) return trend.points;
  return dayPoints(trend.points);
}

/** What the hovered bar covers. 24h is the hour, everything else is the day. */
function bucketLabel(range: UsageTrendRange, atMs: number): string {
  const d = new Date(atMs);
  if (range === "24h") {
    const end = new Date(atMs + 60 * 60 * 1000);
    const hour = (at: Date) => at.toLocaleTimeString(undefined, { hour: "numeric" });
    return `${hour(d)} – ${hour(end)}`;
  }
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * One column per day (or hour, for 24h). The bar is that bucket against the
 * busiest one, so a quiet week reads as quiet instead of stretching to fill.
 */
export function UsageRhythm({
  trend,
  range,
  focusModel = null,
}: {
  trend: UsageTrend;
  range: UsageTrendRange;
  /** Model id under the pointer. Its slices stay bright and the rest fade. */
  focusModel?: string | null;
}) {
  const points = useMemo(() => chartPoints(trend, range), [trend, range]);
  const focus = focusModel ? seriesId(focusModel) : null;
  const [hover, setHover] = useState<number | null>(null);
  const peak = useMemo(() => Math.max(0, ...points.map((point) => point.total)), [points]);
  const ceiling = peak > 0 ? chartCeiling(peak) : 0;
  const active = hover != null ? points[hover] : null;
  const hourly = range === "24h";

  if (points.length === 0 || peak <= 0) return null;

  return (
    <div className="grid gap-2">
      <div className="flex h-5 items-baseline justify-between gap-3 text-[11px] text-muted">
        {active ? (
          <>
            <span className="min-w-0 truncate">{bucketLabel(range, active.atMs)}</span>
            <span className="shrink-0 tabular-nums text-ink">{formatTokenCount(active.total)}</span>
          </>
        ) : (
          <>
            <span>{hourly ? "Each bar is one hour" : "Each bar is one day"}</span>
            <span className="tabular-nums">
              peak {formatTokenCount(peak)}
              <span className="text-muted/70"> · scale {formatTokenCount(ceiling)}</span>
            </span>
          </>
        )}
      </div>
      <div
        className={`relative flex h-[148px] items-end ${hourly ? "gap-px" : "gap-[3px]"}`}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${formatTokenCount(trend.totals.total)} tokens, peak ${formatTokenCount(peak)}`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line/70" />
        {points.map((point, index) => {
          const on = hover === index;
          const parts = stackOf(point);
          return (
            <button
              key={point.atMs}
              type="button"
              aria-label={`${formatTokenCount(point.total)} on ${bucketLabel(range, point.atMs)}`}
              onMouseEnter={() => setHover(index)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              className={`group relative flex h-full min-w-0 flex-1 items-end rounded-[3px] outline-none transition-colors ${
                on ? "bg-ink/[0.06]" : "hover:bg-ink/[0.04]"
              }`}
            >
              <span
                className={`flex w-full flex-col-reverse overflow-hidden rounded-[2px] transition-opacity ${
                  on ? "opacity-100" : "opacity-80 group-hover:opacity-100"
                }`}
                style={{ height: point.total > 0 ? `${Math.max((point.total / ceiling) * 100, 2.5)}%` : "0%" }}
              >
                {SERIES.map((series) =>
                  parts[series.id] > 0 ? (
                    <span
                      key={series.id}
                      className="block w-full transition-opacity duration-150"
                      style={{
                        height: `${(parts[series.id] / point.total) * 100}%`,
                        background: series.color,
                        minHeight: 1,
                        opacity: focus != null && focus !== series.id ? 0.14 : 1,
                      }}
                    />
                  ) : null,
                )}
              </span>
            </button>
          );
        })}
      </div>
      <RhythmAxis points={points} range={range} />
    </div>
  );
}

function RhythmAxis({
  points,
  range,
}: {
  points: UsageTrend["points"];
  range: UsageTrendRange;
}) {
  if (range === "24h") {
    const marks = [0, 6, 12, 18].filter((index) => index < points.length);
    return (
      <div className="relative h-4 text-[10px] text-muted">
        {marks.map((index) => (
          <span
            key={index}
            className="absolute -translate-x-1/2 tabular-nums"
            style={{ left: `${((index + 0.5) / points.length) * 100}%` }}
          >
            {new Date(points[index].atMs).toLocaleTimeString(undefined, { hour: "numeric" })}
          </span>
        ))}
      </div>
    );
  }
  if (range === 7) {
    return (
      <div className="grid gap-[3px] text-center text-[10px] text-muted" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
        {points.map((point) => {
          const d = new Date(point.atMs);
          return (
            <span key={point.atMs} className="truncate">
              {WEEKDAYS[d.getDay()]}
              <span className="text-muted/60"> {d.getDate()}</span>
            </span>
          );
        })}
      </div>
    );
  }
  // One label every few days, always including the first and last day, so a
  // 90 day span reads as a handful of dates instead of a run of letters.
  const step = range === 90 ? 14 : 7;
  const picked = new Set<number>([0, points.length - 1]);
  for (let i = step; i < points.length - 1; i += step) picked.add(i);
  const marks = [...picked]
    .sort((a, b) => a - b)
    .filter((index, i, all) => i === 0 || index - all[i - 1] >= Math.ceil(step / 2));
  return (
    <div className="relative h-4 text-[10px] text-muted">
      {marks.map((index, i) => {
        const last = i === marks.length - 1;
        const d = new Date(points[index].atMs);
        const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        return (
          <span
            key={points[index].atMs}
            className={`absolute whitespace-nowrap ${last ? "-translate-x-full" : i === 0 ? "" : "-translate-x-1/2"}`}
            style={{ left: `${(index / Math.max(1, points.length - 1)) * 100}%` }}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}
