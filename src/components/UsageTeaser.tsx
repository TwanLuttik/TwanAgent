import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { formatTokenCount } from "../lib/context";
import {
  linePath,
  USAGE_TEASER_WINDOWS,
  usageSeries,
  usageTotalSince,
  type UsageEvent,
} from "../lib/usage";
import * as api from "../lib/tauri";

const EASE = [0.22, 1, 0.36, 1] as const;
const ROTATE_MS = 5000;
const WINDOW_MS = USAGE_TEASER_WINDOWS[USAGE_TEASER_WINDOWS.length - 1].ms;
const SPARK_MS = USAGE_TEASER_WINDOWS[0].ms;
const SPARK_W = 36;
const SPARK_H = 15;
const SPARK_PAD = 1.5;
const SPARK_BUCKETS = 15;

export function UsageTeaser({ refresh = 0, hover = false }: { refresh?: number; hover?: boolean }) {
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let gone = false;
    function load() {
      const since = new Date(Date.now() - WINDOW_MS).toISOString();
      void api
        .usageList(since)
        .then((rows) => {
          if (!gone) setEvents(rows);
        })
        .catch(() => undefined);
    }
    load();
    const poll = globalThis.setInterval(load, 20_000);
    return () => {
      gone = true;
      globalThis.clearInterval(poll);
    };
  }, [refresh]);

  useEffect(() => {
    const id = globalThis.setInterval(() => {
      setIndex((value) => (value + 1) % USAGE_TEASER_WINDOWS.length);
    }, ROTATE_MS);
    return () => globalThis.clearInterval(id);
  }, []);

  const slot = hover ? USAGE_TEASER_WINDOWS[0] : (USAGE_TEASER_WINDOWS[index] ?? USAGE_TEASER_WINDOWS[0]);
  const now = Date.now();
  const total = usageTotalSince(events, now - slot.ms, now);
  const spark = linePath(usageSeries(events, now - SPARK_MS, now, SPARK_BUCKETS), SPARK_W, SPARK_H, SPARK_PAD);

  return (
    <span className="ml-auto flex items-center justify-end gap-1.5">
      <svg
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        className="pointer-events-none shrink-0 text-muted"
        aria-hidden
      >
        {spark ? (
          <path
            d={spark}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
      <span className="relative block h-[15px] min-w-[4.25rem] overflow-hidden text-right">
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            key={slot.id}
            initial={{ opacity: 0, y: 7 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -7 }}
            transition={{ duration: 0.38, ease: EASE }}
            className="absolute inset-0 tabular-nums text-[11px] leading-[15px] text-muted"
          >
            {formatTokenCount(total)} · {slot.label}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  );
}
