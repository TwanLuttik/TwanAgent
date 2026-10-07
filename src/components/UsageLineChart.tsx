import { useMemo, useState } from "react";
import { formatTokenCount } from "../lib/context";
import type { UsageTrend, UsageTrendPoint } from "../lib/usage";

const W = 640;
const H = 148;
const PAD_X = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 22;

export function UsageLineChart({ trend }: { trend: UsageTrend }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = trend.points;
  const max = Math.max(0, ...points.map((point) => point.total));
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const coords = useMemo(
    () =>
      points.map((point, i) => {
        const x = points.length < 2 ? W / 2 : PAD_X + (i / (points.length - 1)) * innerW;
        const y = max <= 0 ? PAD_TOP + innerH / 2 : PAD_TOP + innerH - (point.total / max) * innerH;
        return { x, y };
      }),
    [innerH, innerW, max, points],
  );
  const path = coords.map((dot, i) => `${i === 0 ? "M" : "L"} ${dot.x.toFixed(1)} ${dot.y.toFixed(1)}`).join(" ");
  const floor = PAD_TOP + innerH;
  const area =
    coords.length > 1
      ? `${path} L ${coords[coords.length - 1].x.toFixed(1)} ${floor.toFixed(1)} L ${coords[0].x.toFixed(1)} ${floor.toFixed(1)} Z`
      : "";
  const active = hover == null ? null : points[hover];
  const activeBox = hover == null ? null : coords[hover];
  const ticks = tickIndexes(points);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-[148px] w-full"
        role="img"
        aria-label={chartLabel(trend)}
        onMouseLeave={() => setHover(null)}
      >
        <path d={area} className="fill-ok/10" />
        <path
          d={path}
          fill="none"
          className="stroke-ok"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
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
          width={W}
          height={H - PAD_BOTTOM}
          fill="transparent"
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            if (box.width <= 0 || coords.length === 0) return;
            const x = ((event.clientX - box.left) / box.width) * W;
            let nearest = 0;
            let best = Infinity;
            coords.forEach((dot, index) => {
              const distance = Math.abs(dot.x - x);
              if (distance < best) {
                best = distance;
                nearest = index;
              }
            });
            setHover(nearest);
          }}
        />
        {active && activeBox ? (
          <g>
            <line
              x1={activeBox.x}
              x2={activeBox.x}
              y1={PAD_TOP}
              y2={PAD_TOP + innerH}
              className="stroke-line"
              strokeWidth="1"
            />
            <circle cx={activeBox.x} cy={activeBox.y} r="3" className="fill-ok stroke-canvas" strokeWidth="1.5" />
          </g>
        ) : null}
      </svg>
      {active && activeBox ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink shadow-card"
          style={{ left: `${(activeBox.x / W) * 100}%`, top: 0 }}
        >
          <span className="font-medium tabular-nums">{formatTokenCount(active.total)}</span>
          {` · ${active.label}`}
        </div>
      ) : null}
    </div>
  );
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
