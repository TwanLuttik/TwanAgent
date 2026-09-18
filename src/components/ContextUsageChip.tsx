import type { ChatUsage, UsageTone } from "../lib/dev-context";
import { contextUsageSnapshot, formatContextUsage, formatTokenCount } from "../lib/dev-context";

const TONE_TEXT: Record<UsageTone, string> = {
  ok: "text-muted",
  warn: "text-warn",
  high: "text-err",
};

const TONE_FILL: Record<UsageTone, string> = {
  ok: "bg-accent",
  warn: "bg-warn",
  high: "bg-err",
};

export function ContextUsageChip({
  usage,
  windowSize,
  expanded,
}: {
  usage: ChatUsage;
  windowSize: number;
  expanded: boolean;
}) {
  const snap = contextUsageSnapshot(usage, windowSize);
  const label = formatContextUsage(usage, windowSize);
  const title = `${snap.used.toLocaleString()} of ${snap.window.toLocaleString()} tokens in the context window`;

  return (
    <div
      className="pointer-events-none absolute -inset-px z-10 overflow-hidden rounded-[inherit]"
      role="status"
      aria-label={label}
      title={title}
    >
      <div className="h-[2px] w-full">
        {snap.percent > 0 ? (
          <div
            className={`h-full ${TONE_FILL[snap.tone]}`}
            style={{ width: `${snap.percent}%` }}
          />
        ) : null}
      </div>
      <div
        className={`flex justify-end px-3.5 pt-1.5 transition-opacity duration-150 ${
          expanded ? "opacity-100" : "opacity-0"
        }`}
      >
        <span className="whitespace-nowrap text-[11px] leading-none tabular-nums" aria-hidden={!expanded}>
          <span className={`font-medium ${TONE_TEXT[snap.tone]}`}>{snap.percent}%</span>
          <span className="text-muted/70">
            {` · ${formatTokenCount(snap.used)} / ${formatTokenCount(snap.window)}`}
          </span>
        </span>
      </div>
    </div>
  );
}
