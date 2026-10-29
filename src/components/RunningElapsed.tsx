import { memo, useEffect, useState } from "react";
import { formatElapsed } from "../lib/relative-time";

/** Live turn length. Same clock as the transcript status line: `12s`, then `1:05`. */
export const RunningElapsed = memo(function RunningElapsed({
  startedAt,
  className = "tabular-nums text-muted/40",
}: {
  /** Epoch ms when this turn started. Nothing is shown when it is missing. */
  startedAt?: number;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  return <span className={className}>{formatElapsed(Math.max(0, now - startedAt))}</span>;
});
