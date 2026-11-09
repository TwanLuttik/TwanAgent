import type { ChatUsage, UsageTone } from "../lib/context";
import { contextUsageSnapshot, formatContextUsage, formatTokenCount } from "../lib/context";

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
}: {
  usage: ChatUsage;
  windowSize: number;
}) {
  const snap = contextUsageSnapshot(usage, windowSize);

  return (
    <div className="pointer-events-none absolute -inset-px z-10 overflow-hidden rounded-[inherit]" aria-hidden>
      {snap.percent > 0 ? (
        <div className={`h-[2px] ${TONE_FILL[snap.tone]}`} style={{ width: `${snap.percent}%` }} />
      ) : null}
    </div>
  );
}

/** Sits outside the composer's rounded box. A label inside that corner was painted twice. */
export function ContextUsageReadout({
  usage,
  windowSize,
  expanded,
  inline = false,
}: {
  usage: ChatUsage;
  windowSize: number;
  expanded: boolean;
  /** In the todo row, beside the count, instead of over the top-right corner. */
  inline?: boolean;
}) {
  const snap = contextUsageSnapshot(usage, windowSize);
  const label = formatContextUsage(usage, windowSize);
  const title = `${snap.used.toLocaleString()} of ${snap.window.toLocaleString()} tokens in the context window`;
  const text = (
    <span className="whitespace-nowrap text-[11px] leading-none tabular-nums" aria-hidden={!expanded}>
      <span className={`font-medium ${TONE_TEXT[snap.tone]}`}>{snap.percent}%</span>
      <span className="text-muted/70">
        {` · ${formatTokenCount(snap.used)} / ${formatTokenCount(snap.window)}`}
      </span>
    </span>
  );

  if (inline) {
    // Stay in the row while hidden. Removing it on hover pushes the count and the bubbles.
    return (
      <span
        className={`pointer-events-none shrink-0 transition-opacity duration-150 ${expanded ? "opacity-100" : "opacity-0"}`}
        role="status"
        aria-label={label}
        title={title}
      >
        {text}
      </span>
    );
  }

  return (
    <div
      className={`pointer-events-none absolute top-2 right-8 z-10 transition-opacity duration-150 ${
        expanded ? "opacity-100" : "opacity-0"
      }`}
      role="status"
      aria-label={label}
      title={title}
    >
      {text}
    </div>
  );
}
