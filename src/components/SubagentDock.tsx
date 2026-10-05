import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChatMarkdown } from "./ChatMarkdown";
import { Symbol } from "./Symbol";
import { foldToolTrailRows, liveTranscriptItems } from "../lib/dev";
import { subagentTypeLabel, type SubagentRecord } from "../lib/dev-subagent";

const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.32;

export function ConversationDocks({
  children,
  align = "center",
}: {
  children: ReactNode;
  align?: "center" | "end";
}) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-0 z-20 flex px-4 pt-3 ${
        align === "end" ? "justify-end" : "justify-center"
      }`}
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
  return (
    <AnimatePresence initial={false}>
      {agents.map((agent) => (
        <SubagentPill
          key={agent.id}
          agent={agent}
          open={Boolean(expanded[agent.id])}
          onToggle={() => onToggle(agent.id)}
        />
      ))}
    </AnimatePresence>
  );
}

function SubagentPill({
  agent,
  open,
  onToggle,
}: {
  agent: SubagentRecord;
  open: boolean;
  onToggle: () => void;
}) {
  const live = agent.status === "running";
  const foldedTools = foldToolTrailRows(agent.tools);
  const latestTool = foldedTools[foldedTools.length - 1]?.label ?? "";
  const items = liveTranscriptItems(
    agent.messages.filter((message) => message.role !== "user"),
    agent.streamText,
    agent.tools,
    agent.streamReasoning,
  );
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = body.current;
    if (!el || !open) return;
    el.scrollTop = el.scrollHeight;
  }, [open, items, agent.tools.length]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: DURATION, ease: EASE }}
      className="pointer-events-auto w-max max-w-full min-w-0"
    >
      <motion.div
        layout
        initial={false}
        animate={{ scale: 1 }}
        whileHover={open ? undefined : { scale: 1.03 }}
        transition={{ duration: DURATION, ease: EASE }}
        className={`origin-top overflow-hidden border border-line/35 bg-canvas/92 shadow-card backdrop-blur-md ${
          open ? "rounded-2xl" : "rounded-full"
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 px-4 py-2 text-left"
        >
          <StatusMark status={agent.status} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {agent.description}
          </span>
          {live && latestTool && !open ? (
            <span className="hidden max-w-[11rem] truncate text-[12px] text-muted sm:inline">
              {latestTool}
            </span>
          ) : null}
          <span className="shrink-0 text-[12px] text-muted">{subagentTypeLabel(agent.type)}</span>
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: DURATION, ease: EASE }}
            className="flex size-3.5 shrink-0 items-center justify-center text-muted"
          >
            <Symbol name="chevron.down" className="size-3.5" />
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
              <div ref={body} className="max-h-56 min-w-[22rem] overflow-auto border-t border-line/35 px-4 py-2.5">
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
                              <div key={rowIndex} className="flex min-w-0 items-center gap-2 text-[13px] leading-5 text-muted">
                                <span className="w-3 shrink-0 text-center text-[11px]" aria-hidden>
                                  ◆
                                </span>
                                <span className="min-w-0 truncate">{row.label}</span>
                              </div>
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
          ) : null}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

function StatusMark({ status }: { status: SubagentRecord["status"] }) {
  if (status === "running") {
    return (
      <span
        className="size-3 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
        aria-label="Running"
      />
    );
  }
  if (status === "done") {
    return <Symbol name="checkmark" className="size-3.5 shrink-0 text-ok" />;
  }
  return <Symbol name="xmark" className="size-3.5 shrink-0 text-err" />;
}
