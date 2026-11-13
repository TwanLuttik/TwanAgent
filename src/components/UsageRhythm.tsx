import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatTokenCount } from "../lib/context";
import { providerFor, type ProviderId } from "../lib/provider";
import { chartCeiling, smoothCurve, type UsageTrend, type UsageTrendPoint, type UsageTrendRange } from "../lib/usage";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Same hues as the provider marks. Grok follows the theme so it stays visible. */
const SERIES: { id: ProviderId | "other"; color: string }[] = [
  { id: "xai", color: "var(--usage-xai)" },
  { id: "anthropic", color: "#d97757" },
  { id: "minimax", color: "#e21680" },
  { id: "openai", color: "#10a37f" },
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
  const parts: Record<SeriesId, number> = { xai: 0, anthropic: 0, minimax: 0, openai: 0, other: 0 };
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

const CHART_H = 148;
const PAD_TOP = 12;
const PAD_BOTTOM = 8;

/**
 * One smooth line for the range. 7 days folds the hourly points into days.
 * The scale stays the busiest bucket, so pointing at a model does not restretch it.
 */
export function UsageRhythm({
  trend,
  range,
  focusModel = null,
}: {
  trend: UsageTrend;
  range: UsageTrendRange;
  /** Model id under the pointer. The line shows that provider instead of the total. */
  focusModel?: string | null;
}) {
  const points = useMemo(() => chartPoints(trend, range), [trend, range]);
  const focus = focusModel ? seriesId(focusModel) : null;
  const [hover, setHover] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const gradientId = useId().replace(/:/g, "");
  const peak = useMemo(() => Math.max(0, ...points.map((point) => point.total)), [points]);
  const ceiling = peak > 0 ? chartCeiling(peak) : 0;
  const color = seriesColor(focus ?? dominantSeries(points));
  const active = hover != null ? points[hover] : null;
  const activeValue = active ? (focus ? stackOf(active)[focus] : active.total) : 0;
  const plot = useMemo(() => {
    if (width <= 0 || ceiling <= 0) return null;
    const coords = points.map((point, index) => ({
      x: pointX(index, points.length, width, range),
      y: pointY(focus ? stackOf(point)[focus] : point.total, ceiling),
    }));
    const line = smoothCurve(coords);
    if (!line || coords.length === 0) return null;
    const first = coords[0];
    const last = coords[coords.length - 1];
    const base = pointY(0, ceiling);
    return { coords, line, area: `${line} L ${last.x.toFixed(1)} ${base.toFixed(1)} L ${first.x.toFixed(1)} ${base.toFixed(1)} Z` };
  }, [ceiling, focus, points, range, width]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (points.length === 0 || peak <= 0) return null;

  const dot = hover != null ? plot?.coords[hover] : null;

  return (
    <div className="grid gap-2">
      <div className="flex h-5 items-baseline justify-between gap-3 text-[11px] text-muted">
        {active ? (
          <>
            <span className="min-w-0 truncate">{bucketLabel(range, active.atMs)}</span>
            <span className="shrink-0 tabular-nums text-ink">{formatTokenCount(activeValue)}</span>
          </>
        ) : (
          <span className="ml-auto tabular-nums">peak {formatTokenCount(peak)}</span>
        )}
      </div>
      <div
        ref={frame}
        className="relative h-[148px]"
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${formatTokenCount(trend.totals.total)} tokens, peak ${formatTokenCount(peak)}`}
      >
        {plot ? (
          <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${width} ${CHART_H}`}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={plot.area} fill={`url(#${gradientId})`} />
            <path d={plot.line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {dot ? (
              <circle cx={dot.x} cy={dot.y} r="3.5" fill={color} stroke="var(--color-canvas)" strokeWidth="2" />
            ) : null}
          </svg>
        ) : null}
        <div className="absolute inset-0 flex">
          {points.map((point, index) => (
            <button
              key={point.atMs}
              type="button"
              aria-label={`${formatTokenCount(point.total)} on ${bucketLabel(range, point.atMs)}`}
              onMouseEnter={() => setHover(index)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              className="h-full min-w-0 flex-1 outline-none"
            />
          ))}
        </div>
      </div>
      <RhythmAxis points={points} range={range} />
    </div>
  );
}

function seriesColor(id: SeriesId): string {
  return SERIES.find((series) => series.id === id)?.color ?? "var(--usage-xai)";
}

function dominantSeries(points: UsageTrendPoint[]): SeriesId {
  const totals: Record<SeriesId, number> = { xai: 0, anthropic: 0, minimax: 0, openai: 0, other: 0 };
  for (const point of points) {
    const parts = stackOf(point);
    for (const series of SERIES) totals[series.id] += parts[series.id];
  }
  return SERIES.slice().sort((a, b) => totals[b.id] - totals[a.id])[0]?.id ?? "xai";
}

/** Day and hour labels sit in the middle of a column. Longer ranges pin the ends. */
function pointX(index: number, count: number, width: number, range: UsageTrendRange): number {
  if (count <= 1) return width / 2;
  if (range === 7 || range === "24h") return ((index + 0.5) / count) * width;
  return (index / (count - 1)) * width;
}

function pointY(value: number, ceiling: number): number {
  const inner = CHART_H - PAD_TOP - PAD_BOTTOM;
  if (ceiling <= 0) return PAD_TOP + inner;
  const t = Math.max(0, Math.min(1, value / ceiling));
  return PAD_TOP + (1 - t) * inner;
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
      <div className="grid text-center text-[10px] text-muted" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
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
