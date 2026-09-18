import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import {
  TOOL_TRAIL_LIVE_ROWS,
  toolTrailSummary,
  toolTrailTypeCountText,
  toolTrailTypeCounts,
  type ToolFileChange,
} from "../lib/dev";
import { FileIcon } from "./FileIcon";
import { useWorkspaceFileLinks } from "./ChatMarkdown";

const ROW = 18;
const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.32;
const EXPANDED_ROWS = 12;
const PEEK_DELAY = 220;
const PEEK_LINES = 10;

export function ToolTrail({
  labels,
  files = [],
  live,
}: {
  labels: string[];
  files?: ToolFileChange[];
  live: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tip, setTip] = useState(false);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const [tipPos, setTipPos] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (live) setExpanded(false);
  }, [live]);

  useLayoutEffect(() => {
    if (!tip || !summaryRef.current) return;
    const box = summaryRef.current.getBoundingClientRect();
    setTipPos({
      left: Math.min(Math.max(8, box.left), window.innerWidth - 16),
      bottom: window.innerHeight - box.top + 6,
    });
  }, [tip]);

  if (labels.length === 0) return null;

  const summary = toolTrailSummary(labels.length);
  const typeCounts = toolTrailTypeCounts(labels);
  const showTip = tip && !expanded && tipPos && typeCounts.length > 0;

  return (
    <div className="mb-3 px-0.5" aria-label="Tool activity">
      {live ? (
        <LiveStack labels={labels} files={files} />
      ) : (
        <>
          {createPortal(
            <AnimatePresence>
              {showTip ? (
                <motion.div
                  key="tool-type-badges"
                  role="tooltip"
                  initial={{ opacity: 0, y: 8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.98 }}
                  transition={{ duration: DURATION, ease: EASE }}
                  className="pointer-events-none fixed z-50 flex max-w-[min(20rem,calc(100vw-16px))] flex-wrap gap-1"
                  style={{ left: tipPos.left, bottom: tipPos.bottom, transformOrigin: "bottom left" }}
                >
                  {typeCounts.map(({ type, count }) => (
                    <span
                      key={type}
                      className="inline-flex items-center rounded-full bg-inset px-2 py-0.5 font-mono text-[10px] leading-none text-ink/80 tabular-nums"
                    >
                      {toolTrailTypeCountText(type, count)}
                    </span>
                  ))}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )}
          <button
            ref={summaryRef}
            type="button"
            aria-expanded={expanded}
            aria-label={summary}
            onClick={() => setExpanded((open) => !open)}
            onMouseEnter={() => setTip(true)}
            onMouseLeave={() => setTip(false)}
            onFocus={() => setTip(true)}
            onBlur={() => setTip(false)}
            className="block h-[18px] w-full truncate text-left text-[11px] leading-[18px] text-muted/55 hover:text-muted"
          >
            {summary}
          </button>
          <FileChangeBadges files={files} />
          <AnimatePresence initial={false}>
            {expanded ? (
              <motion.div
                key="labels"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: DURATION, ease: EASE }}
                className="overflow-hidden"
              >
                <div className="overflow-auto" style={{ maxHeight: EXPANDED_ROWS * ROW }}>
                  {labels.map((label, i) => (
                    <div
                      key={`${label}-${i}`}
                      className="truncate text-[11px] text-muted/55"
                      style={{ height: ROW, lineHeight: `${ROW}px` }}
                    >
                      {label}
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

function LiveStack({ labels, files }: { labels: string[]; files: ToolFileChange[] }) {
  const offset = Math.max(0, labels.length - TOOL_TRAIL_LIVE_ROWS);
  const rows = Math.min(labels.length, TOOL_TRAIL_LIVE_ROWS);
  return (
    <div>
      <FileChangeBadges files={files} />
      <div
        className={
          offset > 0
            ? "overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_12px)]"
            : "overflow-hidden"
        }
        style={{ height: rows * ROW }}
      >
        <motion.div
          initial={false}
          animate={{ y: -offset * ROW }}
          transition={{ duration: DURATION, ease: EASE }}
        >
          {labels.map((label, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 truncate text-[11px] text-muted/55"
              style={{ height: ROW, lineHeight: `${ROW}px` }}
            >
              <span className="min-w-0 truncate">{label}</span>
              {i === labels.length - 1 ? (
                <span
                  className="size-2 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
                  aria-hidden
                />
              ) : null}
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  );
}

function FileChangeBadges({ files }: { files: ToolFileChange[] }) {
  const { onOpenFile } = useWorkspaceFileLinks();
  if (files.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap content-start gap-1 py-[3px]">
      {files.map((file) => (
        <FileChangeBadge key={file.path} file={file} onOpen={onOpenFile} />
      ))}
    </div>
  );
}

function FileChangeBadge({ file, onOpen }: { file: ToolFileChange; onOpen?: (path: string) => void }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);

  function clearTimers() {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  }

  function show() {
    clearTimers();
    showTimer.current = window.setTimeout(() => setOpen(true), PEEK_DELAY);
  }

  function hide() {
    clearTimers();
    hideTimer.current = window.setTimeout(() => setOpen(false), 120);
  }

  useEffect(() => () => clearTimers(), []);

  useLayoutEffect(() => {
    if (!open || !wrap.current) {
      setPos(null);
      return;
    }
    const box = wrap.current.getBoundingClientRect();
    const width = 320;
    const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
    const spaceBelow = window.innerHeight - box.bottom;
    const above = spaceBelow < 200 && box.top > spaceBelow;
    setPos({
      left,
      top: above ? box.top - 8 : box.bottom + 8,
      above,
    });
  }, [open]);

  return (
    <span
      ref={wrap}
      className="inline-flex max-w-full"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <button
        type="button"
        aria-label={`${file.path} +${file.additions} -${file.deletions}`}
        onClick={(ev) => {
          ev.stopPropagation();
          onOpen?.(file.path);
        }}
        className="inline-flex max-w-full items-center gap-1 rounded-[5px] bg-inset px-[5px] py-px font-mono text-[10px] leading-none text-ink/80 hover:bg-wash-strong"
      >
        <FileIcon name={file.path} className="size-2.5 shrink-0" />
        <span className="min-w-0 truncate">{file.name}</span>
        {file.additions > 0 ? <span className="shrink-0 text-ok">+{file.additions}</span> : null}
        {file.deletions > 0 ? <span className="shrink-0 text-err">-{file.deletions}</span> : null}
      </button>
      {open && pos
        ? createPortal(
            <div
              role="tooltip"
              className="fixed z-50 w-[320px] overflow-hidden rounded-lg border border-line bg-canvas shadow-card"
              style={{
                left: pos.left,
                top: pos.top,
                transform: pos.above ? "translateY(-100%)" : undefined,
              }}
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              <FileChangePeek file={file} onOpen={onOpen} />
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function FileChangePeek({ file, onOpen }: { file: ToolFileChange; onOpen?: (path: string) => void }) {
  const removed = file.removed.slice(0, PEEK_LINES);
  const added = file.added.slice(0, PEEK_LINES);
  const more =
    Math.max(0, file.removed.length - removed.length) + Math.max(0, file.added.length - added.length);
  return (
    <>
      <div className="flex items-center gap-2 px-2.5 pt-2 pb-1.5">
        <FileIcon name={file.path} className="size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-ink">{file.name}</div>
          <div className="truncate font-mono text-[11px] text-muted">{file.path}</div>
        </div>
        <div className="shrink-0 font-mono text-[11px] tabular-nums">
          {file.additions > 0 ? <span className="text-ok">+{file.additions}</span> : null}
          {file.additions > 0 && file.deletions > 0 ? " " : null}
          {file.deletions > 0 ? <span className="text-err">-{file.deletions}</span> : null}
        </div>
      </div>
      {removed.length === 0 && added.length === 0 ? (
        <div className="px-2.5 pb-2 text-[11px] text-muted">No line preview</div>
      ) : (
        <pre className="max-h-[180px] overflow-auto border-t border-line bg-panel px-0 py-1 font-mono text-[11px] leading-[1.45]">
          {removed.map((line, i) => (
            <div key={`-${i}`} className="flex gap-2 px-2.5 text-err">
              <span className="w-3 shrink-0 select-none">−</span>
              <span className="min-w-0 whitespace-pre-wrap break-all">{line || " "}</span>
            </div>
          ))}
          {added.map((line, i) => (
            <div key={`+${i}`} className="flex gap-2 px-2.5 text-ok">
              <span className="w-3 shrink-0 select-none">+</span>
              <span className="min-w-0 whitespace-pre-wrap break-all">{line || " "}</span>
            </div>
          ))}
          {more > 0 ? (
            <div className="px-2.5 pt-1 text-[10px] text-muted">+{more} more</div>
          ) : null}
        </pre>
      )}
      {onOpen ? (
        <div className="border-t border-line px-2 py-1">
          <button
            type="button"
            className="w-full rounded-md px-2 py-1 text-left text-[11px] text-accent hover:bg-wash"
            onClick={() => onOpen(file.path)}
          >
            Open file
          </button>
        </div>
      ) : null}
    </>
  );
}


