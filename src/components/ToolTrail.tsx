import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  foldToolTrailRows,
  toolTrailKind,
  toolTrailParts,
  toolTrailTypeIcon,
  type ToolFileChange,
  type ToolTrailRow,
} from "../lib/core";
import { loadExpandEdits, subscribePrefs } from "../lib/prefs";
import { lineDiffRows, type LineDiffPart, type LineDiffRow } from "../lib/line-diff";
import { toolRevealNextAt, toolRevealSteps, toolRowsVisibleOnMount } from "../lib/tool-reveal";
import { Symbol } from "./Symbol";

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
    // A folded row keeps its slot when its label changes, like "Read app.ts" becoming "Read app.ts ×2".
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
  files: _files = [],
  details = [],
  commands = [],
  live,
  conversationId = "",
}: {
  labels: string[];
  /** Kept for callers. Line counts now render on the edit row itself. */
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
    // History renders before the live trail. Writing its labels here made opening
    // a running chat look like a new batch, so every call already finished staggered in.
    return <ToolTrailRows rows={rows} />;
  }
  return <LiveToolTrail key={conversationId} rows={rows} signature={signature} conversationId={conversationId} />;
}

function LiveToolTrail({
  rows,
  signature,
  conversationId,
}: {
  rows: ReturnType<typeof foldToolTrailRows>;
  signature: string;
  conversationId: string;
}) {
  // Read before this paint records itself, so a remount can tell new rows from ones already shown.
  // No signature means we just opened this chat: calls that already ran stay still.
  const [settledOnMount] = useState(() =>
    toolRowsVisibleOnMount(rows.length, signature, seenToolSignatures.get(conversationId) ?? ""),
  );
  const shown = useStaggeredCount(rows.length, signature, settledOnMount);
  const visible = rows.slice(0, shown);
  useEffect(() => {
    seenToolSignatures.set(conversationId, signature);
  }, [conversationId, signature]);
  return <ToolTrailRows rows={visible} spinningLast animateFrom={settledOnMount} />;
}

function ToolTrailRows({
  rows,
  spinningLast = false,
  animateFrom = rows.length,
}: {
  rows: ReturnType<typeof foldToolTrailRows>;
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
              children={row.children}
              spinning={spinningLast && i === rows.length - 1}
            />
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function ToolMark({ label }: { label: string }) {
  return (
    <Symbol
      name={toolTrailTypeIcon(toolTrailKind(label))}
      className="size-3 shrink-0 text-muted/80 transition-colors duration-200 group-hover:text-ink"
    />
  );
}

/** The action stays darker than the path, so a list of reads does not look like one sentence. */
function ToolLabel({ label }: { label: string }) {
  const parts = toolTrailParts(label);
  if (!parts.detail) {
    return <span className="tool-verb min-w-0 truncate text-ink/75">{parts.verb}</span>;
  }
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="tool-verb shrink-0 text-ink/75">{parts.verb}</span>
      <span className="min-w-0 truncate text-muted/80">{parts.detail}</span>
    </span>
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
  children = [],
  spinning = false,
  counts = true,
}: {
  label: string;
  change: ToolFileChange | null;
  detail: string;
  children?: ToolTrailRow[];
  spinning?: boolean;
  /** Child calls keep their own diff, but the parent already shows the total. */
  counts?: boolean;
}) {
  const hasDiff = change != null && (change.added.length > 0 || change.removed.length > 0);
  const [expandEdits, setExpandEditsOn] = useState(() => loadExpandEdits());
  const command = detail.trim();
  const searching = label.startsWith("Web search");
  const nested = children.length > 0;
  const [open, setOpen] = useState(() => nested || searching || (hasDiff && expandEdits));
  const canOpen = nested || hasDiff || command.length > 0;
  const show = open && canOpen;

  useEffect(() => subscribePrefs(() => setExpandEditsOn(loadExpandEdits())), []);
  useEffect(() => {
    if (nested) return;
    if (searching) {
      if (command) setOpen(true);
      return;
    }
    if (!hasDiff) return;
    setOpen(expandEdits);
  }, [expandEdits, hasDiff, nested, searching, command]);
  return (
    <div className={show ? "py-0.5" : undefined}>
      <button
        type="button"
        disabled={!canOpen}
        aria-expanded={canOpen ? show : undefined}
        onClick={() => {
          if (canOpen) setOpen((value) => !value);
        }}
        className={`group flex min-w-0 items-center gap-2 text-left text-[13px] leading-5 transition-colors duration-200 hover:[&_.tool-verb]:text-ink ${
          canOpen ? "w-full rounded-md" : "cursor-default"
        }`}
      >
        <ToolMark label={label} />
        <ToolLabel label={label} />
        {counts && change && (change.additions > 0 || change.deletions > 0) ? <LineChangeCounts change={change} /> : null}
        <span className="min-w-0 flex-1" />
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
            {nested ? (
              <ToolCallTree rows={children} />
            ) : (
              <div className="mt-0.5 mb-1 ml-5 min-w-0">
                {hasDiff && change ? <InlineEditDiff change={change} /> : <ToolDetail text={command} />}
              </div>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Calls on one file, drawn under the file with a trunk and a branch per call. */
function ToolCallTree({ rows }: { rows: ToolTrailRow[] }) {
  return (
    <div className="relative mt-0.5 mb-1 ml-[5px] border-l border-line/70 pl-3">
      {rows.map((row, i) => (
        <div key={`${row.label}-${i}`} className="relative">
          <span className="absolute top-[10px] -left-3 h-px w-2.5 bg-line/70" aria-hidden />
          <ToolCallBlock label={row.label} change={row.change} detail={row.detail} counts={false} />
        </div>
      ))}
    </div>
  );
}

/** Combined additions and deletions, shown once on the edit that owns the file. */
function LineChangeCounts({ change }: { change: ToolFileChange }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1 font-mono text-[11px] leading-none tabular-nums">
      {change.additions > 0 ? <span className="text-ok">+{change.additions}</span> : null}
      {change.deletions > 0 ? <span className="text-err">-{change.deletions}</span> : null}
    </span>
  );
}

function ToolDetail({ text }: { text: string }) {
  const lines = text.replace(/^\n+|\n+$/g, "").split("\n");
  const long = lines.length > 12;
  return (
    <div
      className={`font-mono text-[11px] leading-[1.35] text-muted ${long ? "max-h-52 overflow-y-auto pr-1" : ""}`}
    >
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all [overflow-wrap:anywhere]">
          {line || " "}
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




