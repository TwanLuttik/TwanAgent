import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChatMarkdown } from "./ChatMarkdown";
import { Symbol } from "./Symbol";
import { foldToolTrailRows, liveTranscriptItems, toolTrailKind, toolTrailTypeIcon, type ToolTrailRow } from "../lib/core";
import { subagentTypeLabel, type SubagentRecord } from "../lib/subagent";

const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.32;

export function ConversationDocks({
  children,
  align = "center",
  insetEnd = false,
}: {
  children: ReactNode;
  align?: "center" | "end";
  /** Pull the trailing pills off the window edge, where a closed pane leaves them. */
  insetEnd?: boolean;
}) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-0 z-20 flex px-4 pt-3 transition-[padding] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        align === "end" ? "justify-end" : "justify-center"
      }`}
      style={align === "end" ? { paddingRight: insetEnd ? "2.75rem" : "1rem" } : undefined}
    >
      <div
        className={`flex flex-col gap-1.5 ${
          align === "end" ? "max-w-[min(26rem,calc(100%-0.5rem))] items-end" : "w-full max-w-[32rem] items-center"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function SubagentDock({
  agents,
  expanded,
  onToggle,
}: {
  agents: SubagentRecord[];
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  if (agents.length === 0) return null;
  const openAgents = agents.filter((agent) => expanded[agent.id]);
  return (
    <div className="relative z-20 h-11 shrink-0 overflow-visible px-6 pt-2">
      <div className="no-scrollbar mx-auto h-9 w-full max-w-[720px] overflow-x-auto overflow-y-hidden">
        <div className="flex h-9 w-max min-w-full items-center gap-1.5">
          <AnimatePresence initial={false}>
            {agents.map((agent) => (
              <SubagentChip
                key={agent.id}
                agent={agent}
                open={Boolean(expanded[agent.id])}
                onToggle={() => onToggle(agent.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-6 top-full z-30">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-1.5 pt-1.5">
          <AnimatePresence initial={false}>
            {openAgents.map((agent) => (
              <SubagentWindow key={agent.id} agent={agent} />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function SubagentChip({
  agent,
  open,
  onToggle,
}: {
  agent: SubagentRecord;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: DURATION, ease: EASE }}
      className="pointer-events-auto w-max max-w-[15rem] shrink-0"
    >
      <motion.button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        initial={false}
        animate={{ scale: 1 }}
        whileHover={{ scale: 1.03 }}
        transition={{ duration: DURATION, ease: EASE }}
        className={`flex h-8 w-full origin-top items-center gap-2 rounded-full border px-3 text-left shadow-card ${
          open ? "border-ink/25 bg-wash" : "border-line/55 bg-panel"
        }`}
      >
        <StatusMark status={agent.status} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{agent.description}</span>
        <span className="shrink-0 text-[12px] text-muted">{subagentTypeLabel(agent.type)}</span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: DURATION, ease: EASE }}
          className="flex size-3.5 shrink-0 items-center justify-center text-muted"
        >
          <Symbol name="chevron.down" className="size-3.5" />
        </motion.span>
      </motion.button>
    </motion.div>
  );
}

function SubagentWindow({ agent }: { agent: SubagentRecord }) {
  const live = agent.status === "running";
  const items = liveTranscriptItems(
    agent.messages.filter((message) => message.role !== "user"),
    agent.streamText,
    agent.tools,
    agent.streamReasoning,
  );
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = body.current;
    if (!el || !stick.current) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max - el.scrollTop < 1) return;
    el.scrollTop = el.scrollHeight;
  }, [items, agent.tools.length, agent.streamText, agent.streamReasoning]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: DURATION, ease: EASE }}
      className="pointer-events-auto w-full max-w-[32rem] overflow-hidden rounded-2xl border border-line/55 bg-panel shadow-card"
    >
      <div
        ref={body}
        onScroll={() => {
          const el = body.current;
          if (!el) return;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-56 w-full min-w-0 overflow-auto bg-canvas px-4 py-2.5"
      >
        {items.length ? (
          <div className="space-y-2">
            {items.map((item, i) => {
              if (item.kind === "thinking") {
                return (
                  <div
                    key={i}
                    className="whitespace-pre-wrap border-l border-line pl-2 text-[12px] leading-relaxed text-muted [overflow-wrap:anywhere]"
                  >
                    {item.content}
                  </div>
                );
              }
              if (item.kind === "tools") {
                return (
                  <div key={i} className="space-y-0.5">
                    {foldToolTrailRows(item.labels, item.details, item.commands).map((row, rowIndex) => (
                      <SubagentToolRow key={rowIndex} row={row} />
                    ))}
                  </div>
                );
              }
              if (item.kind === "error") {
                return (
                  <div key={i} className="text-[12px] text-err">
                    {item.content}
                  </div>
                );
              }
              if (item.kind !== "assistant") return null;
              return <ChatMarkdown key={i} text={item.content} />;
            })}
          </div>
        ) : (
          <div className="text-[12px] text-muted">{live ? "Working…" : "No output yet."}</div>
        )}
        {agent.error && agent.status !== "done" ? (
          <div className="mt-1 text-[12px] text-err">{agent.error}</div>
        ) : null}
      </div>
    </motion.div>
  );
}

function SubagentToolRow({ row, nested = false }: { row: ToolTrailRow; nested?: boolean }) {
  const [open, setOpen] = useState(Boolean(row.children?.length));
  const nestedRows = row.children ?? [];
  return (
    <div>
      <button
        type="button"
        disabled={nestedRows.length === 0}
        aria-expanded={nestedRows.length ? open : undefined}
        onClick={() => {
          if (nestedRows.length) setOpen((value) => !value);
        }}
        className={`flex w-full min-w-0 items-center gap-2 text-left text-[13px] leading-5 text-muted ${
          nestedRows.length ? "hover:text-ink" : "cursor-default"
        }`}
      >
        <Symbol name={toolTrailTypeIcon(toolTrailKind(row.label))} className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{row.label}</span>
      </button>
      {open && nestedRows.length ? (
        <div className={`relative ml-[5px] border-l border-line/70 pl-3 ${nested ? "" : "mt-0.5"}`}>
          {nestedRows.map((child, index) => (
            <div key={`${child.label}-${index}`} className="relative">
              <span className="absolute top-[10px] -left-3 h-px w-2.5 bg-line/70" aria-hidden />
              <SubagentToolRow row={child} nested />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusMark({ status }: { status: SubagentRecord["status"] }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      {status === "running" ? (
        <span
          className="size-3 animate-spin rounded-full border border-ink/35 border-t-transparent"
          aria-label="Running"
        />
      ) : status === "done" ? (
        <Symbol name="checkmark" className="size-3.5 text-ok" />
      ) : (
        <Symbol name="xmark" className="size-3.5 text-err" />
      )}
    </span>
  );
}
