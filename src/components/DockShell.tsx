import { useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Symbol } from "./Symbol";

const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.42;
const CARD_REM = 26;

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
  const [width, setWidth] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const shell = useRef<HTMLDivElement>(null);
  const pill = useRef(0);
  const openRef = useRef(false);
  openRef.current = open;

  useLayoutEffect(() => {
    const el = shell.current;
    // Only a settled pill has the width we want to return to. Mid-animation it is wrong.
    if (!el || open || width != null) return;
    pill.current = Math.round(el.getBoundingClientRect().width);
  });

  function toggle() {
    if (openRef.current) {
      openRef.current = false;
      setOpen(false);
      setWidth(pill.current || null);
      return;
    }
    openRef.current = true;
    const from = pill.current || Math.round(shell.current?.getBoundingClientRect().width ?? 0);
    if (from) pill.current = from;
    setWidth(from || null);
    setOpen(true);
    const target = cardWidth(shell.current);
    setContentWidth(target);
    requestAnimationFrame(() => {
      if (openRef.current) setWidth(target);
    });
  }

  function settleClosed() {
    if (openRef.current) return;
    setWidth(null);
  }

  const card = open || width != null;

  return (
    <motion.div
      ref={shell}
      initial={false}
      animate={{
        width: width ?? "auto",
        borderRadius: card ? 16 : 999,
        scale: 1,
      }}
      whileHover={card ? undefined : { scale: 1.03 }}
      transition={{
        width: { duration: DURATION, ease: EASE },
        borderRadius: { duration: 0 },
        scale: { duration: DURATION, ease: EASE },
      }}
      onAnimationComplete={settleClosed}
      style={{ maxWidth: "100%" }}
      className={`pointer-events-auto origin-top-right overflow-hidden border border-line/35 bg-canvas ${
        card ? "rounded-2xl shadow-card" : "rounded-full"
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
        {card ? <span className="shrink-0 text-[11px] text-muted">{meta}</span> : null}
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: DURATION, ease: EASE }}
          className="flex size-3 shrink-0 items-center justify-center text-muted"
        >
          <Symbol name="chevron.down" className="size-3" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: DURATION, ease: EASE }}
            className="overflow-hidden"
          >
            <DockScroll width={contentWidth} hint={hint}>
              {children}
            </DockScroll>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function DockScroll({
  width,
  hint,
  children,
}: {
  width: number;
  hint: string;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });

  function read(el: HTMLDivElement) {
    const above = el.scrollTop > 2;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((prev) => (prev.above === above && prev.below === below ? prev : { above, below }));
  }

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    read(el);
    const ro = new ResizeObserver(() => read(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, [children, width]);

  return (
    <div className="relative border-t border-line/35">
      <div
        ref={scroller}
        onScroll={(event: UIEvent<HTMLDivElement>) => read(event.currentTarget)}
        className="no-scrollbar max-h-72 overflow-x-hidden overflow-y-auto"
      >
        <div className="px-3 py-2.5" style={width ? { width, boxSizing: "border-box" } : undefined}>
          <div className="mb-2 px-1 text-[12px] leading-relaxed text-muted">{hint}</div>
          {children}
        </div>
      </div>
      <MoreEdge edge="top" on={edges.above} />
      <MoreEdge edge="bottom" on={edges.below} />
    </div>
  );
}

function MoreEdge({ edge, on }: { edge: "top" | "bottom"; on: boolean }) {
  const top = edge === "top";
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 flex justify-center transition-opacity duration-200 ${
        top ? "top-0 pt-1" : "bottom-0 pb-1"
      } ${on ? "opacity-100" : "opacity-0"}`}
    >
      <span className="h-1 w-8 rounded-full bg-ink/25" />
    </div>
  );
}

/**
 * Open width. The dock column shrinks to the pill, so its own box is not the room available.
 * Use the chat strip behind it, and never grow past the card.
 */
function cardWidth(node: HTMLElement | null): number {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const card = CARD_REM * rem;
  let room = window.innerWidth - 48;
  let el = node?.parentElement ?? null;
  while (el) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect().width;
    if ((style.position === "absolute" || style.position === "fixed") && box > 0) {
      room = box - 32;
      break;
    }
    el = el.parentElement;
  }
  if (!(room > 0)) room = card;
  return Math.round(Math.min(card, room));
}
