import { RunningElapsed } from "../../components/RunningElapsed";
import type { SidebarActivityItem } from "../../lib/all-projects";
import type { ChatMessage } from "../../lib/core";

export function SidebarActivity({
  items,
  activeId,
  runningPreview,
  runningStartedAt,
  onOpen,
}: {
  items: SidebarActivityItem[];
  activeId: string;
  runningPreview: (id: string) => string;
  runningStartedAt: (id: string) => number;
  onOpen: (path: string, id: string) => void;
}) {
  if (!items.length) return null;
  const running = items.filter((item) => item.status === "running");
  const finished = items.filter((item) => item.status === "finished");
  return (
    <div className="relative z-20 flex max-h-[38%] shrink-0 flex-col px-2 pb-1">
      <div className="no-scrollbar min-h-0 overflow-auto">
        {running.length ? (
          <ActivityGroup
            label="Running"
            items={running}
            activeId={activeId}
            runningPreview={runningPreview}
            runningStartedAt={runningStartedAt}
            onOpen={onOpen}
          />
        ) : null}
        {finished.length ? (
          <ActivityGroup
            label="Finished"
            items={finished}
            activeId={activeId}
            runningPreview={runningPreview}
            runningStartedAt={runningStartedAt}
            onOpen={onOpen}
          />
        ) : null}
      </div>
    </div>
  );
}

function ActivityGroup({
  label,
  items,
  activeId,
  runningPreview,
  runningStartedAt,
  onOpen,
}: {
  label: string;
  items: SidebarActivityItem[];
  activeId: string;
  runningPreview: (id: string) => string;
  runningStartedAt: (id: string) => number;
  onOpen: (path: string, id: string) => void;
}) {
  return (
    <div className="pb-1">
      <p className="px-2 pt-1 pb-0.5 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">{label}</p>
      {items.map((item) => {
        const selected = item.id === activeId;
        const preview = item.status === "running" ? runningPreview(item.id) : "";
        const startedAt = item.status === "running" ? runningStartedAt(item.id) : 0;
        return (
          <button
            key={`${item.path}\t${item.id}`}
            type="button"
            onClick={() => onOpen(item.path, item.id)}
            className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left ${
              selected ? "bg-wash-strong" : "hover:bg-wash"
            }`}
          >
            {item.status === "running" ? (
              <span
                className="size-3 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
                aria-label={preview || "Running"}
              />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-ink">{item.title}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                <span className="min-w-0 truncate">{preview ? `${item.project} · ${preview}` : item.project}</span>
                {startedAt > 0 ? <RunningElapsed startedAt={startedAt} className="shrink-0 tabular-nums" /> : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function todoSignature(messages: ChatMessage[]): string {
  let sig = "";
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (call.name !== "todo_write") continue;
      sig += `${call.id}:${call.arguments}\n`;
    }
  }
  return sig;
}
