import { useMemo, useState } from "react";
import { formatTokenCount } from "../lib/context";
import {
  buildUsageGrid,
  type UsageDay,
  type UsageGridCell,
  type UsageLevel,
} from "../lib/usage";

const LEVELS: UsageLevel[] = [0, 1, 2, 3, 4];
const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

export function UsageChart({ days }: { days: UsageDay[] }) {
  const weeks = useMemo(() => buildUsageGrid(days), [days]);
  const [tip, setTip] = useState<{ cell: UsageGridCell; x: number; y: number } | null>(null);

  return (
    <div className="relative w-full">
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        <div className="flex w-7 shrink-0 flex-col gap-[3px]">
          <div className="h-3" />
          {DAY_LABELS.map((label, i) => (
            <div key={i} className="flex h-[13px] items-center text-[10px] leading-none text-muted">
              {label}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week.cells[0].date} className="flex w-[13px] shrink-0 flex-col gap-[3px]">
            <div className="h-3 overflow-visible text-[10px] leading-none whitespace-nowrap text-muted">
              {week.monthLabel ?? ""}
            </div>
            {week.cells.map((cell) => (
              <button
                key={cell.date}
                type="button"
                tabIndex={cell.inRange ? 0 : -1}
                disabled={!cell.inRange}
                aria-label={cellLabel(cell)}
                className={`usage-cell usage-cell-${cell.level} ${
                  cell.inRange ? "cursor-default hover:brightness-110" : "invisible"
                }`}
                onMouseEnter={(ev) => {
                  if (!cell.inRange) return;
                  const box = ev.currentTarget.getBoundingClientRect();
                  setTip({ cell, x: box.left + box.width / 2, y: box.top });
                }}
                onMouseLeave={() => setTip(null)}
                onFocus={(ev) => {
                  if (!cell.inRange) return;
                  const box = ev.currentTarget.getBoundingClientRect();
                  setTip({ cell, x: box.left + box.width / 2, y: box.top });
                }}
                onBlur={() => setTip(null)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-muted">
        <span>Less</span>
        {LEVELS.map((level) => (
          <span key={level} className={`usage-cell usage-cell-${level}`} />
        ))}
        <span>More</span>
      </div>
      {tip ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink shadow-card"
          style={{ left: tip.x, top: tip.y - 6 }}
        >
          <span className="font-medium">{formatTokenCount(tip.cell.total)}</span>
          {` tokens on ${formatTipDate(tip.cell.date)}`}
        </div>
      ) : null}
    </div>
  );
}

function cellLabel(cell: UsageGridCell): string {
  return `${formatTokenCount(cell.total)} tokens on ${formatTipDate(cell.date)}`;
}

function formatTipDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
