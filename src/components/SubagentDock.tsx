import { ChatMarkdown } from "./ChatMarkdown";
import { Symbol } from "./Symbol";
import { subagentTypeLabel, type SubagentRecord } from "../lib/dev-subagent";

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
    <div className="shrink-0 border-b border-line bg-panel/80 px-6 py-2.5">
      <div className="mx-auto w-full min-w-0 max-w-[720px]">
        <div className="mb-1.5 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
          Subagents
        </div>
        <div className="grid gap-1">
          {agents.map((agent) => (
            <SubagentRow
              key={agent.id}
              agent={agent}
              open={Boolean(expanded[agent.id])}
              onToggle={() => onToggle(agent.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SubagentRow({
  agent,
  open,
  onToggle,
}: {
  agent: SubagentRecord;
  open: boolean;
  onToggle: () => void;
}) {
  const live = agent.status === "running";
  return (
    <div className={`rounded-md border border-line ${open ? "bg-canvas" : "bg-canvas/60"}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <StatusMark status={agent.status} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{agent.description}</span>
        <span className="shrink-0 text-[11px] text-muted">{subagentTypeLabel(agent.type)}</span>
        {live ? <span className="shrink-0 text-[11px] text-muted">Running</span> : null}
        <Symbol name={open ? "chevron.down" : "chevron.right"} className="size-3 text-muted" />
      </button>
      {open ? (
        <div className="max-h-40 overflow-auto border-t border-line px-2.5 py-2">
          {agent.tools.length > 0 ? (
            <div className="mb-2 space-y-0.5">
              {agent.tools.map((label, i) => (
                <div key={`${label}-${i}`} className="truncate text-[11px] text-muted/70">
                  {label}
                </div>
              ))}
            </div>
          ) : null}
          {agent.streamText ? (
            <ChatMarkdown text={agent.streamText} />
          ) : agent.summary ? (
            <ChatMarkdown text={agent.summary} />
          ) : (
            <div className="text-[12px] text-muted">{live ? "Working…" : "No output yet."}</div>
          )}
          {agent.error && agent.status !== "done" ? (
            <div className="mt-1 text-[12px] text-err">{agent.error}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusMark({ status }: { status: SubagentRecord["status"] }) {
  if (status === "running") {
    return (
      <span
        className="size-2.5 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
        aria-label="Running"
      />
    );
  }
  if (status === "done") {
    return <Symbol name="checkmark" className="size-3 shrink-0 text-ok" />;
  }
  return <Symbol name="xmark" className="size-3 shrink-0 text-err" />;
}
