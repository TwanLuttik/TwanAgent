import { useLayoutEffect, useRef, useState } from "react";
import { Symbol } from "./Symbol";

/**
 * A thought is two lines until it is opened. While it is still arriving, those
 * two lines scroll upward. The full note stays in the page, not its own scroller.
 */
const HOVER_INK =
  "transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-hover:text-ink";

export function ThinkingTrace({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-start gap-2 text-left"
      >
        <Symbol
          name="brain"
          className={`mt-0.5 size-3 shrink-0 text-muted/80 ${HOVER_INK} ${live ? "thinking-live" : ""}`}
        />
        {open ? (
          <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 text-muted ${HOVER_INK}`}>Thinking</span>
        ) : live ? (
          <LiveThought text={preview} />
        ) : (
          <span className={`line-clamp-2 max-h-10 min-w-0 flex-1 text-[13px] leading-5 text-muted/80 ${HOVER_INK}`}>
            {preview}
          </span>
        )}
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="pt-1 pl-5 text-[13px] leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
            {text}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Two lines, pinned to the latest words. New text eases the block upward. */
function LiveThought({ text }: { text: string }) {
  const frame = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const box = frame.current;
    const content = body.current;
    if (!box || !content) return;
    setOffset(Math.max(0, content.offsetHeight - box.clientHeight));
  }, [text]);

  return (
    <span
      ref={frame}
      className={`thinking-tail relative block h-10 min-w-0 flex-1 overflow-hidden text-[13px] leading-5 text-muted/80 ${HOVER_INK}`}
    >
      <span
        ref={body}
        className="thinking-scroll block"
        style={{ transform: offset ? `translateY(-${offset}px)` : undefined }}
      >
        {text}
      </span>
    </span>
  );
}
