import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  foldToolTrailRows,
  type ToolFileChange,
} from "../lib/core";
import { loadExpandEdits, subscribePrefs } from "../lib/prefs";
import { compactDiffRows, lineDiffRows, type LineDiffPart, type LineDiffRow } from "../lib/line-diff";
import { toolRevealNextAt, toolRevealSteps, toolRowsAlreadyShown } from "../lib/tool-reveal";
import { FileIcon } from "./FileIcon";
import { useWorkspaceFileLinks } from "./ChatMarkdown";

const PEEK_DELAY = 220;
const PEEK_LINES = 6;
const PEEK_EASE = [0.22, 1, 0.36, 1] as const;
const REVEAL = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Folded-row labels already painted, keyed by conversation. A live trail
 * remounts when text lands between tool batches, so this survives that remount.
 * Missing until the first paint, which is how selecting a running chat stays still.
 */
const seenToolSignatures = new Map<string, string>();

export function resetSeenToolSignatures(): void {
  seenToolSignatures.clear();
}

/** Drop one chat so the next time it opens, its current rows do not animate in. */
export function forgetSeenToolSignature(conversationId: string): void {
  if (conversationId) seenToolSignatures.delete(conversationId);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Reveal rows one at a time. A burst waits 200ms between rows; a row that arrives on its own does not.
 * Rows already present on mount render immediately. Only rows that arrive while this trail is open stagger in.
 */
function useStaggeredCount(total: number, signature: string, seen: number): number {
  const [shown, setShown] = useState(seen);
  const shownRef = useRef(seen);
  const queuedRef = useRef(seen);
  const nextAt = useRef(0);
  const signatureRef = useRef(signature);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const previous = signatureRef.current;
    const previousCount = previous ? previous.split("\n").length : 0;
    // A folded row keeps its slot when its label changes, like "Read 1 file" becoming "Read 2 files".
    const appended =
      total >= queuedRef.current &&
      (signature === previous ||
        (previous.length > 0 && signature.startsWith(`${previous}\n`)) ||
        (previousCount > 0 && total === previousCount));
    signatureRef.current = signature;
    if (!appended) {
      for (const id of timers.current) window.clearTimeout(id);
      timers.current = [];
      queuedRef.current = total;
      shownRef.current = total;
      nextAt.current = 0;
      setShown(total);
      return;
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
    const from = queuedRef.current;
    const steps = toolRevealSteps(total, from, now, nextAt.current);
    queuedRef.current = total;
    nextAt.current = toolRevealNextAt(total, from, now, nextAt.current);
    for (const step of steps) {
      const timer = window.setTimeout(() => {
        shownRef.current = Math.max(shownRef.current, step.index + 1);
        setShown(shownRef.current);
      }, step.delay);
      timers.current.push(timer);
    }
  }, [total, signature, seen]);

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
  conversationId = "",
}: {
  labels: string[];
  files?: ToolFileChange[];
  details?: (ToolFileChange | null)[];
  commands?: string[];
  live: boolean;
  /** Scopes the "already shown" rows to this chat, so switching chats starts fresh. */
  conversationId?: string;
}) {
  const rows = foldToolTrailRows(labels, details, commands);
  const signature = rows.map((row) => row.label).join("\n");
  if (rows.length === 0) return null;
  if (!live) {
    if (signature) seenToolSignatures.set(conversationId, signature);
    return <ToolTrailRows rows={rows} files={files} />;
  }
  return <LiveToolTrail rows={rows} files={files} signature={signature} conversationId={conversationId} />;
}

function LiveToolTrail({
  rows,
  files,
  signature,
  conversationId,
}: {
  rows: ReturnType<typeof foldToolTrailRows>;
  files: ToolFileChange[];
  signature: string;
  conversationId: string;
}) {
  // Read before this paint records itself, so a remount can tell new rows from ones already shown.
  const [settledOnMount] = useState(() => toolRowsAlreadyShown(signature, seenToolSignatures.get(conversationId) ?? ""));
  const shown = useStaggeredCount(rows.length, signature, settledOnMount);
  const visible = rows.slice(0, shown);
  useEffect(() => {
    seenToolSignatures.set(conversationId, signature);
  }, [conversationId, signature]);
  return (
    <ToolTrailRows
      rows={visible}
      files={shown > 0 ? files : []}
      spinningLast
      animateFrom={settledOnMount}
    />
  );
}

function ToolTrailRows({
  rows,
  files,
  spinningLast = false,
  animateFrom = rows.length,
}: {
  rows: ReturnType<typeof foldToolTrailRows>;
  files: ToolFileChange[];
  spinningLast?: boolean;
  /** First row index that should fade in. Earlier rows render in place. */
  animateFrom?: number;
}) {
  return (
    <div className="mb-3" aria-label="Tool activity">
      <div>
        {rows.map((row, i) => (
          <motion.div
            key={`${row.label}-${i}`}
            initial={i >= animateFrom ? { opacity: 0, y: 6 } : false}
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
  const hasDiff = change != null && (change.added.length > 0 || change.removed.length > 0);
  const [expandEdits, setExpandEditsOn] = useState(() => loadExpandEdits());
  const command = detail.trim();
  const searching = label.startsWith("Web search");
  const [open, setOpen] = useState(() => searching || (hasDiff && expandEdits));
  const canOpen = hasDiff || command.length > 0;
  const show = open && canOpen;

  useEffect(() => subscribePrefs(() => setExpandEditsOn(loadExpandEdits())), []);
  useEffect(() => {
    if (searching) {
      if (command) setOpen(true);
      return;
    }
    if (!hasDiff) return;
    setOpen(expandEdits);
  }, [expandEdits, hasDiff, searching, command]);
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
        <div key={i} className="whitespace-pre-wrap break-all [overflow-wrap:anywhere]">
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
    if (!open || !wrap.current) return;
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
      {createPortal(
        <AnimatePresence>
          {open && pos ? (
            <motion.div
              key={file.path}
              role="tooltip"
              initial={{ opacity: 0, y: pos.above ? 6 : -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: pos.above ? 4 : -4 }}
              transition={{ duration: 0.16, ease: PEEK_EASE }}
              className="fixed z-50 w-[300px] overflow-hidden rounded-md border border-line/80 bg-canvas shadow-card"
              style={{
                left: pos.left,
                top: pos.top,
                transform: pos.above ? "translateY(-100%)" : undefined,
              }}
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              <FileChangePeek file={file} />
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}

function FileChangePeek({ file }: { file: ToolFileChange }) {
  const rows = compactDiffRows(file.removed, file.added, PEEK_LINES);
  const changed = lineDiffRows(file.removed, file.added).filter((row) => row.kind !== "same").length;
  const more = Math.max(0, changed - rows.length);
  if (rows.length === 0) {
    return <div className="px-2 py-1.5 text-[11px] text-muted">No line changes</div>;
  }
  return (
    <div className="max-h-[168px] overflow-hidden bg-panel py-1 font-mono text-[11px] leading-[1.45]">
      {rows.map((row, i) => (
        <InlineDiffRow key={i} row={row} />
      ))}
      {more > 0 ? <div className="px-2 pt-0.5 text-[10px] text-muted">+{more} more</div> : null}
    </div>
  );
}


