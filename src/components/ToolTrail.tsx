import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
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
import { isSubagentLabel, subagentCardTitle, type SubagentRun } from "../lib/subagent";
import { providerProfile } from "../lib/provider";
import { formatModelName } from "../lib/usage";
import { ChatLogo } from "./ConversationList";
import { RunningElapsed } from "./RunningElapsed";
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
  openIds = [],
  live,
  conversationId = "",
  model = "",
  modelName = "",
  runningOpenIds,
  runs,
  onOpen,
}: {
  labels: string[];
  /** Kept for callers. Line counts now render on the edit row itself. */
  files?: ToolFileChange[];
  details?: (ToolFileChange | null)[];
  commands?: string[];
  /** Conversation ids aligned with `labels`. A subagent row opens that chat. */
  openIds?: string[];
  live: boolean;
  /** Scopes the "already shown" rows to this chat, so switching chats starts fresh. */
  conversationId?: string;
  model?: string;
  modelName?: string;
  runningOpenIds?: ReadonlySet<string>;
  /** Live tool label and start time, keyed by the subagent conversation id. */
  runs?: Readonly<Record<string, SubagentRun>>;
  onOpen?: (id: string) => void;
}) {
  const rows = foldToolTrailRows(labels, details, commands, openIds);
  const signature = rows.map((row) => row.label).join("\n");
  if (rows.length === 0) return null;
  const trail = { model, modelName, runningOpenIds, runs, onOpen };
  if (!live) {
    // History renders before the live trail. Writing its labels here made opening
    // a running chat look like a new batch, so every call already finished staggered in.
    return <ToolTrailRows rows={rows} trail={trail} />;
  }
  return (
    <LiveToolTrail
      key={conversationId}
      rows={rows}
      signature={signature}
      conversationId={conversationId}
      trail={trail}
    />
  );
}

type SubagentTrail = {
  model: string;
  modelName: string;
  runningOpenIds?: ReadonlySet<string>;
  runs?: Readonly<Record<string, SubagentRun>>;
  onOpen?: (id: string) => void;
};

function LiveToolTrail({
  rows,
  signature,
  conversationId,
  trail,
}: {
  rows: ReturnType<typeof foldToolTrailRows>;
  signature: string;
  conversationId: string;
  trail: SubagentTrail;
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
  return <ToolTrailRows rows={visible} spinningLast animateFrom={settledOnMount} trail={trail} />;
}

function ToolTrailRows({
  rows,
  spinningLast = false,
  animateFrom = rows.length,
  trail,
}: {
  rows: ReturnType<typeof foldToolTrailRows>;
  spinningLast?: boolean;
  /** First row index that should fade in. Earlier rows render in place. */
  animateFrom?: number;
  trail: SubagentTrail;
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
              openId={row.openId}
              children={row.children}
              spinning={spinningLast && i === rows.length - 1 && !isSubagentLabel(row.label)}
              trail={trail}
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
  openId = "",
  children = [],
  spinning = false,
  counts = true,
  trail,
}: {
  label: string;
  change: ToolFileChange | null;
  detail: string;
  openId?: string;
  children?: ToolTrailRow[];
  spinning?: boolean;
  /** Child calls keep their own diff, but the parent already shows the total. */
  counts?: boolean;
  trail?: SubagentTrail;
}) {
  if (isSubagentLabel(label)) {
    return (
      <SubagentConversationCard
        title={subagentCardTitle(label)}
        model={trail?.model ?? ""}
        modelName={trail?.modelName ?? ""}
        openId={openId}
        running={Boolean(openId && trail?.runningOpenIds?.has(openId))}
        activity={openId ? trail?.runs?.[openId]?.activity ?? "" : ""}
        startedAt={openId ? trail?.runs?.[openId]?.startedAt ?? 0 : 0}
        onOpen={trail?.onOpen}
      />
    );
  }
  return (
    <ExpandableToolCall
      label={label}
      change={change}
      detail={detail}
      children={children}
      spinning={spinning}
      counts={counts}
      trail={trail}
    />
  );
}

function ExpandableToolCall({
  label,
  change,
  detail,
  children = [],
  spinning = false,
  counts = true,
  trail,
}: {
  label: string;
  change: ToolFileChange | null;
  detail: string;
  children?: ToolTrailRow[];
  spinning?: boolean;
  counts?: boolean;
  trail?: SubagentTrail;
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
    <div>
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
      {canOpen ? (
        <ToolCallBody show={show}>
          {() =>
            nested ? (
              <ToolCallTree rows={children} trail={trail} />
            ) : (
              <div className="mt-0.5 mb-1 ml-5 min-w-0">
                {hasDiff && change ? <InlineEditDiff change={change} /> : <ToolDetail text={command} />}
              </div>
            )
          }
        </ToolCallBody>
      ) : null}
    </div>
  );
}

const TOOL_BODY_MS = 220;

/**
 * The detail stays unmounted while the row is closed. A chat that writes a project
 * otherwise keeps every file's diff in the hidden panel, and the window stops keeping up.
 * Grid rows grow it without padding the header, so the title does not jump.
 */
function ToolCallBody({ show, children }: { show: boolean; children: () => ReactNode }) {
  const [held, setHeld] = useState(show);
  const [grown, setGrown] = useState(show);
  useEffect(() => {
    if (show) {
      setHeld(true);
      const frame = requestAnimationFrame(() => setGrown(true));
      return () => cancelAnimationFrame(frame);
    }
    setGrown(false);
    if (!held) return;
    const timer = window.setTimeout(() => setHeld(false), TOOL_BODY_MS);
    return () => window.clearTimeout(timer);
  }, [show, held]);
  if (!held) return null;
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        grown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
      inert={!show}
      aria-hidden={!show}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
        if (!show) setHeld(false);
      }}
    >
      <div className="min-h-0 overflow-hidden">{children()}</div>
    </div>
  );
}

/** Calls on one file, drawn under the file with a trunk and a branch per call. */
function ToolCallTree({ rows, trail }: { rows: ToolTrailRow[]; trail?: SubagentTrail }) {
  return (
    <div className="relative mt-0.5 mb-1 ml-[5px] border-l border-line/70 pl-3">
      {rows.map((row, i) => (
        <div key={`${row.label}-${i}`} className="relative">
          <span className="absolute top-[10px] -left-3 h-px w-2.5 bg-line/70" aria-hidden />
          <ToolCallBlock
            label={row.label}
            change={row.change}
            detail={row.detail}
            openId={row.openId}
            counts={false}
            trail={trail}
          />
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

function SubagentConversationCard({
  title,
  model,
  modelName,
  openId,
  running,
  activity,
  startedAt,
  onOpen,
}: {
  title: string;
  model: string;
  modelName: string;
  openId: string;
  running: boolean;
  activity: string;
  startedAt: number;
  onOpen?: (id: string) => void;
}) {
  const caption = modelName.trim() || (model.trim() ? formatModelName(model) : "Subagent");
  const tool = activity.trim();
  const open = Boolean(openId && onOpen);
  return (
    <div className="group/chat my-0.5 flex items-center overflow-visible rounded-xl select-none hover:bg-wash">
      <button
        type="button"
        disabled={!open}
        onClick={() => {
          if (openId && onOpen) onOpen(openId);
        }}
        className={`flex min-w-0 flex-1 items-start gap-2 py-1.5 pr-2 pl-2 text-left text-ink ${
          open ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <ChatLogo model={model} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] leading-4 font-medium">{title}</span>
            {running && startedAt ? (
              <RunningElapsed
                startedAt={startedAt}
                className="shrink-0 text-[11px] leading-none tabular-nums text-muted"
              />
            ) : null}
          </span>
          {running && tool ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted">
              <Symbol name="arrow.turn.down.right" className="size-2.5 shrink-0 opacity-70" />
              <span className="min-w-0 truncate" title={tool}>
                {tool}
              </span>
            </span>
          ) : null}
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted">
            <ModelLineMark model={model} />
            <span className="min-w-0 truncate" title={caption}>
              {caption}
            </span>
          </span>
        </span>
        {running ? (
          <span
            className="mt-0.5 size-3.5 shrink-0 self-center animate-spin rounded-full border border-muted/55 border-t-transparent"
            aria-label="Running"
          />
        ) : null}
      </button>
    </div>
  );
}

/** Provider mark for the model line. The activity above keeps the turn arrow. */
function ModelLineMark({ model }: { model: string }) {
  if (!model.trim()) return <Symbol name="sparkles" className="size-2.5 shrink-0 opacity-70" />;
  const profile = providerProfile(model);
  const tone =
    profile.id === "anthropic" ? "text-[#d97757]" : profile.id === "minimax" ? "group/minimax" : "usage-mark-xai";
  return (
    <span className={`flex size-3 shrink-0 items-center justify-center ${tone}`} data-colored="">
      <Symbol name={profile.symbol} colored={profile.id === "minimax"} className="size-3" />
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




