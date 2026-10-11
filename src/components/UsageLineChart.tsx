import { useEffect, useMemo, useRef, useState } from "react";
import { formatTokenCount } from "../lib/context";
import {
  formatModelName,
  modelColorIndex,
  sumTrendRange,
  trendBucketSpan,
  type UsageTrend,
  type UsageTrendPoint,
  type UsageTrendRange,
} from "../lib/usage";

const H = 168;
const PAD_X = 2;
const PAD_TOP = 18;
const PAD_BOTTOM = 24;

export function UsageLineChart({
  trend,
  range,
  focusModel = null,
}: {
  trend: UsageTrend;
  range: UsageTrendRange;
  focusModel?: string | null;
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
  }, [range, focusModel]);

  useEffect(() => {
    function endDrag() {
      drag.current = null;
    }
    window.addEventListener("mouseup", endDrag);
    return () => window.removeEventListener("mouseup", endDrag);
  }, []);
  const valueOf = (point: UsageTrendPoint) =>
    focusModel ? (point.models.find((row) => row.model === focusModel)?.total ?? 0) : point.total;
  const max = Math.max(0, ...points.map(valueOf));
  const innerW = Math.max(0, width - PAD_X * 2);
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const floor = PAD_TOP + innerH;
  const coords = useMemo(
    () =>
      points.map((point, i) => {
        const x = points.length < 2 ? PAD_X : PAD_X + (i / (points.length - 1)) * innerW;
        const y = max <= 0 ? floor - innerH * 0.08 : floor - (valueOf(point) / max) * innerH;
        return { x, y };
      }),
    [floor, focusModel, innerH, innerW, max, points],
  );
  const line = smooth(coords, floor);
  const area = coords.length > 1 ? `${line} L ${coords[coords.length - 1].x.toFixed(1)} ${floor} L ${coords[0].x.toFixed(1)} ${floor} Z` : "";
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
  const band =
    hover == null || !activeBox
      ? null
      : {
          x: Math.max(0, activeBox.x - slot / 2),
          w: Math.min(width, activeBox.x + slot / 2) - Math.max(0, activeBox.x - slot / 2),
        };
  const ticks = tickIndexes(points);
  const peak = max > 0 ? nicePeak(max) : 0;
  const focusClass = focusModel ? `usage-swatch-${modelColorIndex(focusModel)}` : "";

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
          <linearGradient id="usage-line-fill" x1="0" y1="0" x2="0" y2="1">
            {focusModel ? (
              <>
                <stop offset="0%" className={focusClass} stopOpacity="0.32" />
                <stop offset="72%" className={focusClass} stopOpacity="0.06" />
                <stop offset="100%" className={focusClass} stopOpacity="0" />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor="var(--color-ok)" stopOpacity="0.28" />
                <stop offset="70%" stopColor="var(--color-ok)" stopOpacity="0.06" />
                <stop offset="100%" stopColor="var(--color-ok)" stopOpacity="0" />
              </>
            )}
          </linearGradient>
        </defs>
        {span ? (
          <rect
            x={span.x}
            y={PAD_TOP}
            width={Math.max(1, span.end - span.x)}
            height={innerH}
            className="fill-ok"
            opacity="0.14"
          />
        ) : null}
        {band && !selected ? (
          <rect x={band.x} y={PAD_TOP} width={Math.max(1, band.w)} height={innerH} className="fill-ink" opacity="0.06" />
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
              opacity="0.8"
            />
            <text x={PAD_X} y={PAD_TOP - 5} className="fill-muted text-[10px]">
              {formatTokenCount(peak)}
            </text>
          </g>
        ) : null}
        {area ? <path d={area} fill="url(#usage-line-fill)" /> : null}
        {line ? (
          <path
            d={line}
            fill="none"
            className={focusClass || undefined}
            stroke={focusModel ? undefined : "var(--color-ok)"}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
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
          <circle
            cx={activeBox.x}
            cy={activeBox.y}
            r="3.5"
            className={focusClass || undefined}
            fill={focusModel ? undefined : "var(--color-ok)"}
          />
        ) : null}
      </svg>
      {selected && span ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-[10px] border border-line bg-canvas/95 px-2.5 py-1.5 text-[11px] text-ink shadow-card backdrop-blur-sm"
          style={{ left: `${clampTip(width > 0 ? ((span.x + span.end) / 2 / width) * 100 : 50)}%`, top: 4 }}
        >
          <div className="font-medium tabular-nums">{formatTokenCount(focusModel ? selectedFocusTotal(points, selected.from, selected.to, focusModel) : selected.totals.total)}</div>
          <div className="text-muted">
            {trendBucketSpan(range, points[selected.from].atMs).split(" – ")[0]} – {rangeLabelEnd(range, points[selected.to].atMs)}
          </div>
        </div>
      ) : null}
      {active && activeBox && !selected ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 min-w-[9.5rem] -translate-x-1/2 rounded-[10px] border border-line bg-canvas/95 px-2.5 py-1.5 text-[11px] text-ink shadow-card backdrop-blur-sm"
          style={{ left: `${clampTip(width > 0 ? (activeBox.x / width) * 100 : 50)}%`, top: 0 }}
        >
          <div className="font-medium tabular-nums">{formatTokenCount(focusModel ? valueOf(active) : active.total)}</div>
          <div className="text-muted">{trendBucketSpan(range, active.atMs)}</div>
          {active.models.length > 0 ? (
            <div className="mt-1 grid gap-0.5 border-t border-line/70 pt-1">
              {active.models.map((row) => (
                <div
                  key={row.model || "unknown"}
                  className={`flex items-center justify-between gap-3 ${
                    focusModel && focusModel !== row.model ? "opacity-35" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`usage-dot usage-swatch-${modelColorIndex(row.model)}`} />
                    <span className="min-w-0 truncate text-muted">{formatModelName(row.model)}</span>
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
  model: string,
): number {
  let total = 0;
  for (let i = from; i <= to; i++) {
    total += points[i].models.find((row) => row.model === model)?.total ?? 0;
  }
  return total;
}

function rangeLabelEnd(range: UsageTrendRange, atMs: number): string {
  const span = trendBucketSpan(range, atMs);
  const parts = span.split(" – ");
  return parts[parts.length - 1] ?? span;
}

function nicePeak(max: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, max)));
  const n = max / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

function tickIndexes(points: UsageTrendPoint[]): number[] {
  if (points.length === 0) return [];
  if (points.length <= 8) return points.map((_, i) => i);
  const mid = Math.floor((points.length - 1) / 2);
  return [0, mid, points.length - 1];
}

function chartLabel(trend: UsageTrend): string {
  const first = trend.points[0]?.label ?? "";
  const last = trend.points[trend.points.length - 1]?.label ?? "";
  return `${formatTokenCount(trend.totals.total)} tokens from ${first} to ${last}`;
}

function clampTip(percent: number): number {
  return Math.min(84, Math.max(16, percent));
}
