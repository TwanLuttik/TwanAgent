import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  foldToolTrailRows,
  type ToolFileChange,
} from "../lib/core";
import { lineDiffRows, type LineDiffPart, type LineDiffRow } from "../lib/line-diff";
import { FileIcon } from "./FileIcon";
import { useWorkspaceFileLinks } from "./ChatMarkdown";

const PEEK_DELAY = 220;
const PEEK_LINES = 8;
const ROW_STAGGER_MS = 200;
const REVEAL = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Reveal rows one at a time. A burst waits 200ms between rows; a row that arrives on its own does not. */
function useStaggeredCount(total: number, signature: string): number {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  const queuedRef = useRef(0);
  const nextAt = useRef(0);
  const signatureRef = useRef(signature);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const previous = signatureRef.current;
    const appended =
      total >= queuedRef.current &&
      (signature === previous || (previous.length > 0 && signature.startsWith(`${previous}\n`)));
    signatureRef.current = signature;
    if (!appended) {
      for (const id of timers.current) window.clearTimeout(id);
      timers.current = [];
      queuedRef.current = 0;
      shownRef.current = 0;
      nextAt.current = 0;
      setShown(0);
    }
    if (total <= queuedRef.current) return;
    if (prefersReducedMotion()) {
      queuedRef.current = total;
      shownRef.current = total;
      nextAt.current = 0;
      setShown(total);
      return;
    }
    const now = performance.now();
    let at = nextAt.current > now ? nextAt.current : now;
    const from = queuedRef.current;
    queuedRef.current = total;
    for (let i = from; i < total; i++) {
      const delay = at - now;
      const timer = window.setTimeout(() => {
        shownRef.current = Math.max(shownRef.current, i + 1);
        setShown(shownRef.current);
      }, delay);
      timers.current.push(timer);
      at += ROW_STAGGER_MS;
    }
    nextAt.current = at;
  }, [total, signature]);

  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
    },
    [],
  );

  return shown;
}

export function ToolTrail({
  labels,
  files = [],
  details = [],
  commands = [],
  live,
}: {
  labels: string[];
  files?: ToolFileChange[];
  details?: (ToolFileChange | null)[];
  commands?: string[];
  live: boolean;
}) {
  const rows = foldToolTrailRows(labels, details, commands);
  if (rows.length === 0) return null;
  if (!live) return <ToolTrailRows rows={rows} files={files} />;
  return <LiveToolTrail rows={rows} files={files} signature={labels.join("\n")} />;
}

function LiveToolTrail({
  rows,
  files,
  signature,
}: {
  rows: ReturnType<typeof foldToolTrailRows>;
  files: ToolFileChange[];
  signature: string;
}) {
  const shown = useStaggeredCount(rows.length, signature);
  const visible = rows.slice(0, shown);
  return (
    <ToolTrailRows
      rows={visible}
      files={shown > 0 ? files : []}
      spinningLast
    />
  );
}

function ToolTrailRows({
  rows,
  files,
  spinningLast = false,
}: {
  rows: ReturnType<typeof foldToolTrailRows>;
  files: ToolFileChange[];
  spinningLast?: boolean;
}) {
  return (
    <div className="mb-3" aria-label="Tool activity">
      <div>
        {rows.map((row, i) => (
          <motion.div
            key={`${row.label}-${i}`}
            initial={spinningLast ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={REVEAL}
          >
            <ToolCallBlock
              label={row.label}
              change={row.change}
              detail={row.detail}
              spinning={spinningLast && i === rows.length - 1}
            />
          </motion.div>
        ))}
      </div>
      <FileChangeBadges files={files} />
    </div>
  );
}

function LiveSpinner() {
  return (
    <span
      className="size-2 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
      aria-hidden
    />
  );
}

function ToolCallBlock({
  label,
  change,
  detail,
  spinning = false,
}: {
  label: string;
  change: ToolFileChange | null;
  detail: string;
  spinning?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasDiff = change != null && (change.added.length > 0 || change.removed.length > 0);
  const command = detail.trim();
  const canOpen = hasDiff || command.length > 0;
  const show = open && canOpen;
  return (
    <div className={show ? "py-0.5" : undefined}>
      <button
        type="button"
        disabled={!canOpen}
        aria-expanded={canOpen ? show : undefined}
        onClick={() => {
          if (canOpen) setOpen((value) => !value);
        }}
        className={`group flex min-w-0 items-center gap-2 text-left text-[13px] leading-5 text-muted transition-colors duration-200 ${
          canOpen ? "w-full rounded-md hover:text-ink" : "cursor-default"
        }`}
      >
        <span
          className="w-3 shrink-0 text-center text-[11px] text-muted/80 transition-colors duration-200 group-hover:text-ink"
          aria-hidden
        >
          ◆
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {spinning ? <LiveSpinner /> : null}
      </button>
      <AnimatePresence initial={false}>
        {show ? (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={REVEAL}
            className="overflow-hidden"
          >
            <div className="mt-0.5 mb-1 ml-5 min-w-0">
              {hasDiff && change ? <InlineEditDiff change={change} /> : <ToolDetail text={command} />}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ToolDetail({ text }: { text: string }) {
  const lines = text.split("\n").filter((line) => line.trim());
  return (
    <div className="font-mono text-[11px] leading-[1.35] text-muted">
      {lines.map((line, i) => (
        <div key={i} className="truncate">
          {line}
        </div>
      ))}
    </div>
  );
}

function InlineEditDiff({ change }: { change: ToolFileChange }) {
  const rows = lineDiffRows(change.removed, change.added);
  return (
    <pre className="overflow-x-hidden font-mono text-[11px] leading-[1.45]">
      {rows.map((row, i) => (
        <InlineDiffRow key={i} row={row} />
      ))}
    </pre>
  );
}

function InlineDiffRow({ row }: { row: LineDiffRow }) {
  if (row.kind === "same") {
    return (
      <div className="px-1.5 whitespace-pre-wrap break-all text-muted/80">{row.text || " "}</div>
    );
  }
  if (row.kind === "change") {
    return (
      <>
        <DiffToneLine tone="del" parts={row.removed} />
        <DiffToneLine tone="add" parts={row.added} />
      </>
    );
  }
  return <DiffToneLine tone={row.kind === "del" ? "del" : "add"} text={row.text} />;
}

function DiffToneLine({
  tone,
  text,
  parts,
}: {
  tone: "add" | "del";
  text?: string;
  parts?: LineDiffPart[];
}) {
  const removed = tone === "del";
  return (
    <div className={`px-1.5 whitespace-pre-wrap break-all ${removed ? "bg-err/10 text-err" : "bg-ok/10 text-ok"}`}>
      {parts ? (
        parts.map((part, i) =>
          part.changed ? (
            <span key={i} className={removed ? "bg-err/20" : "bg-ok/25"}>
              {part.text}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )
      ) : (
        text || " "
      )}
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


