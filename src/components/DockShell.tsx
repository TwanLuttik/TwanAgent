import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Symbol } from "./Symbol";

const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.4;

export function DockShell({
  summary,
  meta,
  icon,
  hint,
  children,
}: {
  summary: string;
  meta: string;
  icon: string;
  hint: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setWide(true);
    setOpen(true);
  }

  return (
    <div className="pointer-events-auto w-max max-w-full min-w-0">
      <motion.div
        initial={false}
        animate={{ scale: 1 }}
        whileHover={open || wide ? undefined : { scale: 1.03 }}
        transition={{ duration: DURATION, ease: EASE }}
        className={`origin-top-right overflow-hidden border border-line/35 bg-canvas ${
          wide
            ? "min-w-[min(26rem,calc(100vw-2rem))] rounded-2xl shadow-card"
            : "rounded-full"
        }`}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={`${summary} ${meta}`}
          className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left"
        >
          <Symbol name={icon} className="size-3 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">{summary}</span>
          {wide ? <span className="shrink-0 text-[11px] text-muted">{meta}</span> : null}
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: DURATION, ease: EASE }}
            className="flex size-3 shrink-0 items-center justify-center text-muted"
          >
            <Symbol name="chevron.down" className="size-3" />
          </motion.span>
        </button>
        <AnimatePresence initial={false} onExitComplete={() => setWide(false)}>
          {open ? (
            <motion.div
              key="body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: DURATION, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="max-h-72 overflow-auto border-t border-line/35 px-3 py-2.5">
                <div className="mb-2 px-1 text-[12px] text-muted">{hint}</div>
                {children}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
