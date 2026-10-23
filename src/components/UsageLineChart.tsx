import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatTokenCount } from "../lib/context";
import { providerFor, type ProviderId } from "../lib/provider";
import {
  sumTrendRange,
  trendBucketSpan,
  type UsageTrend,
  type UsageTrendPoint,
  type UsageTrendRange,
} from "../lib/usage";

/** One stacked area. Same hues as the provider marks in the rest of the app. */
const SERIES: { id: ProviderId | "other"; label: string; color: string }[] = [
  { id: "xai", label: "Grok", color: "var(--usage-xai)" },
  { id: "anthropic", label: "Claude", color: "#d97757" },
  { id: "minimax", label: "MiniMax", color: "#e21680" },
  { id: "other", label: "Other", color: "#8d8d92" },
];

function seriesId(model: string): ProviderId | "other" {
  const id = model.trim();
  if (!id) return "other";
  if (providerFor(id) === "xai" && !id.toLowerCase().startsWith("grok")) return "other";
  return providerFor(id);
}

const H = 168;
const PAD_X = 2;
const PAD_TOP = 18;
const PAD_BOTTOM = 24;

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
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; index: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  const points = trend.points;

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(1, Math.round(el.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSelection(null);
  }, [range, focusModel, focusProvider]);

  useEffect(() => {
    function endDrag() {
      drag.current = null;
    }
    window.addEventListener("mouseup", endDrag);
    return () => window.removeEventListener("mouseup", endDrag);
  }, []);
  const valueOf = (point: UsageTrendPoint) => pointFocusTotal(point, focusModel, focusProvider);
  const layers = useMemo(() => providerLayers(points), [points]);
  const max = Math.max(0, ...points.map(valueOf));
  const innerW = Math.max(0, width - PAD_X * 2);
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const floor = PAD_TOP + innerH;
  const xAt = (i: number) => (points.length < 2 ? PAD_X : PAD_X + (i / (points.length - 1)) * innerW);
  // A day past the labelled peak stays at the top instead of leaving the chart.
  const yAt = (value: number) => {
    if (max <= 0) return floor - innerH * 0.08;
    return floor - (Math.min(value, max) / max) * innerH;
  };
  const coords = useMemo(
    () => points.map((point, i) => ({ x: xAt(i), y: yAt(valueOf(point)) })),
    // xAt and yAt close over the measured box. Recomputing when those change is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [floor, focusModel, focusProvider, innerH, innerW, max, points],
  );
  const focusSeries = focusModel
    ? seriesId(focusModel)
    : focusProvider && SERIES.some((row) => row.id === focusProvider)
      ? (focusProvider as ProviderId | "other")
      : null;
  const focusColor = SERIES.find((row) => row.id === focusSeries)?.color ?? "var(--usage-xai)";
  const focused = focusSeries != null;
  const areas = layers.map((layer) => {
    const isolated = focused && layer.id === focusSeries;
    return {
      ...layer,
      d: bandPath(
        points.map((_, i) => {
          const top = isolated ? (layer.values[i] ?? 0) : focused ? 0 : (layer.top[i] ?? 0);
          const bottom = isolated ? 0 : focused ? 0 : (layer.bottom[i] ?? 0);
          return { x: xAt(i), top: yAt(top), bottom: yAt(bottom) };
        }),
        floor,
      ),
      edge: isolated
        ? smooth(
            points.map((_, i) => ({ x: xAt(i), y: yAt(layer.values[i] ?? 0) })),
            floor,
          )
        : focused
          ? ""
          : smooth(
              points.map((_, i) => ({ x: xAt(i), y: yAt(layer.top[i] ?? 0) })),
              floor,
            ),
    };
  });
  const fillId = useId();
  const slot = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const selected = selection
    ? {
        from: Math.min(selection.from, selection.to),
        to: Math.max(selection.from, selection.to),
        totals: sumTrendRange(points, selection.from, selection.to),
      }
    : null;
  const span = selected && coords[selected.from] && coords[selected.to]
    ? {
        x: Math.max(0, coords[selected.from].x - slot / 2),
        end: Math.min(width, coords[selected.to].x + slot / 2),
      }
    : null;
  const active = hover == null ? null : points[hover];
  const activeBox = hover == null ? null : coords[hover];
  const ticks = tickIndexes(points, range);
  const peak = max > 0 ? Math.min(max, nicePeak(max)) : 0;

  return (
    <div ref={frame} className="relative w-full">
      <svg
        viewBox={`0 0 ${Math.max(1, width)} ${H}`}
        className="block h-[168px] w-full overflow-visible"
        role="img"
        aria-label={chartLabel(trend)}
        onMouseLeave={() => {
          setHover(null);
          drag.current = null;
        }}
        onDoubleClick={() => setSelection(null)}
      >
        <defs>
          {SERIES.map((series) => (
            <linearGradient key={series.id} id={`${fillId}-${series.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series.color} stopOpacity="0.38" />
              <stop offset="72%" stopColor={series.color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={series.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {span ? (
          <rect
            x={span.x}
            y={PAD_TOP}
            width={Math.max(1, span.end - span.x)}
            height={innerH}
            className="fill-ink"
            opacity="0.08"
          />
        ) : null}
        {activeBox && !selected ? (
          <line
            x1={activeBox.x}
            x2={activeBox.x}
            y1={activeBox.y}
            y2={floor}
            className="stroke-ink"
            strokeWidth="1"
            opacity="0.28"
          />
        ) : null}
        {peak > 0 ? (
          <g>
            <line
              x1={PAD_X}
              x2={Math.max(PAD_X, width - PAD_X)}
              y1={PAD_TOP}
              y2={PAD_TOP}
              className="stroke-line"
              strokeWidth="1"
              strokeDasharray="1.5 5"
              opacity="0.55"
            />
            <line
              x1={PAD_X}
              x2={Math.max(PAD_X, width - PAD_X)}
              y1={floor}
              y2={floor}
              className="stroke-line"
              strokeWidth="1"
              opacity="0.35"
            />
            <text x={PAD_X} y={PAD_TOP - 5} className="fill-muted text-[10px]">
              {formatTokenCount(peak)}
            </text>
          </g>
        ) : null}
        {areas.map((layer) =>
          layer.d ? <path key={`${layer.id}-fill`} d={layer.d} fill={`url(#${fillId}-${layer.id})`} /> : null,
        )}
        {areas.map((layer) =>
          layer.edge ? (
            <path
              key={`${layer.id}-line`}
              d={layer.edge}
              fill="none"
              stroke={layer.color}
              strokeWidth="1.85"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null,
        )}
        {ticks.map((index) => (
          <text
            key={points[index].atMs}
            x={coords[index]?.x ?? 0}
            y={H - 4}
            textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
            className="fill-muted text-[11px]"
          >
            {points[index].label}
          </text>
        ))}
        <rect
          x={0}
          y={0}
          width={Math.max(1, width)}
          height={H - PAD_BOTTOM}
          fill="transparent"
          className="cursor-crosshair"
          onMouseDown={(event) => {
            const index = nearestIndex(event.currentTarget, event.clientX, coords, width);
            if (index == null) return;
            drag.current = { x: event.clientX, index };
            setSelection(null);
          }}
          onMouseMove={(event) => {
            const index = nearestIndex(event.currentTarget, event.clientX, coords, width);
            if (index == null) return;
            const start = drag.current;
            if (start && Math.abs(event.clientX - start.x) > 3) {
              setSelection({ from: start.index, to: index });
              setHover(null);
              return;
            }
            if (!start) setHover(index);
          }}
          onMouseUp={() => {
            drag.current = null;
          }}
        />
        {active && activeBox ? (
          <>
            <circle cx={activeBox.x} cy={activeBox.y} r="5.5" fill="var(--color-canvas)" />
            <circle cx={activeBox.x} cy={activeBox.y} r="3.5" fill={focusColor} />
          </>
        ) : null}
      </svg>
      {selected && span ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-[10px] border border-line bg-canvas/95 px-2.5 py-1.5 text-[11px] text-ink shadow-card backdrop-blur-sm"
          style={{ left: `${clampTip(width > 0 ? ((span.x + span.end) / 2 / width) * 100 : 50)}%`, top: 4 }}
        >
          <div className="font-medium tabular-nums">
            {formatTokenCount(selectedFocusTotal(points, selected.from, selected.to, focusModel, focusProvider))}
          </div>
          <div className="text-muted">
            {trendBucketSpan(range, points[selected.from].atMs).split(" – ")[0]} – {rangeLabelEnd(range, points[selected.to].atMs)}
          </div>
        </div>
      ) : null}
      {active && activeBox && !selected ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 min-w-[9.5rem] rounded-[10px] border border-line bg-canvas/95 px-2.5 py-1.5 text-[11px] text-ink shadow-card backdrop-blur-sm"
          style={{
            left: `${clampTip(width > 0 ? (activeBox.x / width) * 100 : 50)}%`,
            top: Math.max(0, activeBox.y - 8),
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="font-medium tabular-nums">{formatTokenCount(valueOf(active))}</div>
          <div className="text-muted">{trendBucketSpan(range, active.atMs)}</div>
          {active.models.length > 0 ? (
            <div className="mt-1 grid gap-0.5 border-t border-line/70 pt-1">
              {providerRows(active).map((row) => (
                <div
                  key={row.id}
                  className={`flex items-center justify-between gap-3 ${
                    focusSeries && focusSeries !== row.id ? "opacity-35" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="usage-dot" style={{ background: row.color }} />
                    <span className="min-w-0 truncate text-muted">{row.label}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatTokenCount(row.total)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-0.5 text-muted">No tokens</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

type Layer = {
  id: ProviderId | "other";
  label: string;
  color: string;
  /** Tokens in this series at each point. */
  values: number[];
  /** Running total at the top of this band. */
  top: number[];
  bottom: number[];
};

/** Stack providers that actually recorded tokens. The largest sits on the bottom. */
function providerLayers(points: UsageTrendPoint[]): Layer[] {
  const totals = new Map<ProviderId | "other", number>();
  for (const point of points) {
    for (const row of point.models) {
      const id = seriesId(row.model);
      totals.set(id, (totals.get(id) ?? 0) + row.total);
    }
  }
  const order = SERIES.filter((series) => (totals.get(series.id) ?? 0) > 0).sort(
    (a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0),
  );
  let running = points.map(() => 0);
  return order.map((series) => {
    const bottom = running;
    const values = points.map((point) =>
      point.models.reduce((sum, row) => {
        if (seriesId(row.model) !== series.id) return sum;
        return sum + row.total;
      }, 0),
    );
    const top = values.map((mine, i) => bottom[i] + mine);
    running = top;
    return { ...series, values, top, bottom };
  });
}

function pointFocusTotal(point: UsageTrendPoint, focusModel: string | null, focusProvider: string | null): number {
  if (focusModel) return point.models.find((row) => row.model === focusModel)?.total ?? 0;
  if (focusProvider) {
    return point.models.reduce((sum, row) => (seriesId(row.model) === focusProvider ? sum + row.total : sum), 0);
  }
  return point.total;
}

function providerRows(point: UsageTrendPoint): { id: string; label: string; color: string; total: number }[] {
  const totals = new Map<ProviderId | "other", number>();
  for (const row of point.models) {
    const id = seriesId(row.model);
    totals.set(id, (totals.get(id) ?? 0) + row.total);
  }
  return SERIES.filter((series) => (totals.get(series.id) ?? 0) > 0)
    .map((series) => ({ ...series, total: totals.get(series.id) ?? 0 }))
    .sort((a, b) => b.total - a.total);
}

/** A filled band between two smoothed edges. A flat band is skipped. */
function bandPath(rows: { x: number; top: number; bottom: number }[], floor: number): string {
  if (rows.length < 2) return "";
  if (rows.every((row) => row.top - row.bottom < 0.5)) return "";
  const upper = smooth(rows.map((row) => ({ x: row.x, y: row.top })), floor);
  const lower = smooth([...rows].reverse().map((row) => ({ x: row.x, y: row.bottom })), floor);
  return `${upper} L ${lower.replace(/^M /, "")} Z`;
}

/**
 * Catmull-Rom through the samples. A control point that would pass the
 * neighbours is pulled back, so a spike cannot drag the curve below the floor
 * or above the peak.
 */
function smooth(coords: { x: number; y: number }[], floor: number): string {
  if (coords.length === 0) return "";
  if (coords.length === 1) return `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  const top = Math.min(...coords.map((point) => point.y));
  let d = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i === 0 ? i : i - 1];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] ?? p2;
    const low = Math.max(p1.y, p2.y);
    const high = Math.min(p1.y, p2.y);
    const c1y = Math.min(floor, Math.max(top, clamp(p1.y + (p2.y - p0.y) / 6, high, low)));
    const c2y = Math.min(floor, Math.max(top, clamp(p2.y - (p3.y - p1.y) / 6, high, low)));
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nearestIndex(
  node: SVGRectElement,
  clientX: number,
  coords: { x: number }[],
  width: number,
): number | null {
  const box = node.getBoundingClientRect();
  if (box.width <= 0 || coords.length === 0) return null;
  const x = ((clientX - box.left) / box.width) * width;
  let nearest = 0;
  let best = Infinity;
  coords.forEach((dot, index) => {
    const distance = Math.abs(dot.x - x);
    if (distance < best) {
      best = distance;
      nearest = index;
    }
  });
  return nearest;
}

function selectedFocusTotal(
  points: UsageTrendPoint[],
  from: number,
  to: number,
  model: string | null,
  provider: string | null,
): number {
  let total = 0;
  for (let i = from; i <= to; i++) {
    total += pointFocusTotal(points[i], model, provider);
  }
  return total;
}

function rangeLabelEnd(range: UsageTrendRange, atMs: number): string {
  const span = trendBucketSpan(range, atMs);
  const parts = span.split(" – ");
  return parts[parts.length - 1] ?? span;
}

/**
 * The gridline sits on a round number at or below the peak.
 * Rounding up put the label above every real point, so the line left the chart.
 */
function nicePeak(max: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, max)));
  const n = max / pow;
  const steps = [1, 2, 2.5, 5, 10];
  const step = [...steps].reverse().find((value) => value <= n + 1e-9) ?? 1;
  return step * pow;
}

function tickIndexes(points: UsageTrendPoint[], range: UsageTrendRange): number[] {
  if (points.length === 0) return [];
  if (points.length <= 8) return points.map((_, i) => i);
  const mid = Math.floor((points.length - 1) / 2);
  const last = points.length - 1;
  if (range !== "24h") return [0, mid, last];
  // Start, middle, and the hour we are in. The last bucket is only partway through.
  const indexes = [0, mid, last];
  return indexes.filter((index, i) => indexes.indexOf(index) === i);
}

function chartLabel(trend: UsageTrend): string {
  const first = trend.points[0]?.label ?? "";
  const last = trend.points[trend.points.length - 1]?.label ?? "";
  return `${formatTokenCount(trend.totals.total)} tokens from ${first} to ${last}`;
}

function clampTip(percent: number): number {
  return Math.min(84, Math.max(16, percent));
}
