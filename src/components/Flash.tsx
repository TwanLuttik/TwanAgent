import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "../state/app-state";

export function Flash() {
  const { flash, setFlash } = useApp();

  useEffect(() => {
    if (!flash) return;
    const ms = flash.kind === "err" ? 6500 : 4000;
    const id = window.setTimeout(() => setFlash(null), ms);
    return () => window.clearTimeout(id);
  }, [flash, setFlash]);

  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-40 flex w-[min(360px,calc(100vw-2rem))] justify-end">
      <AnimatePresence>
        {flash && (
          <motion.div
            key={`${flash.kind}:${flash.text}`}
            role="status"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className={`pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border bg-canvas px-3 py-2.5 text-[13px] shadow-card ${
              flash.kind === "err" ? "border-err/25 text-err" : "border-ok/25 text-ok"
            }`}
          >
            <span
              className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                flash.kind === "err" ? "bg-err" : "bg-ok"
              }`}
              aria-hidden
            />
            <p className="m-0 min-w-0 flex-1 leading-snug">{flash.text}</p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setFlash(null)}
              className="shrink-0 rounded px-1 text-[15px] leading-none text-muted hover:bg-inset hover:text-ink"
            >
              ×
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
