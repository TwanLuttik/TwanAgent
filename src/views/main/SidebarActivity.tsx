import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { RunningElapsed } from "../../components/RunningElapsed";
import { Symbol } from "../../components/Symbol";
import type { SidebarActivityItem } from "../../lib/all-projects";
import type { ChatMessage } from "../../lib/core";
import { providerProfile } from "../../lib/provider";

const TIP_EASE = [0.22, 1, 0.36, 1] as const;

/** First word of an activity line, for the pill. "Skill personal-…" becomes "Skill". */
function activityParts(preview: string): { badge: string; detail: string } {
  const clean = preview.replace(/(…|\.\.\.)$/u, "").trim();
  if (!clean) return { badge: "Running", detail: "" };
  const space = clean.indexOf(" ");
  const head = space === -1 ? clean : clean.slice(0, space);
  const detail = space === -1 ? "" : clean.slice(space + 1).trim();
  return { badge: head.length > 16 ? `${head.slice(0, 15)}…` : head, detail };
}

/** Running and finished chats, stacked on the top edge of the usage card. Finished sits under running. */
export function ActivityDock({
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
  const running = items.filter((item) => item.status === "running");
  const finished = items.filter((item) => item.status === "finished");
  if (!running.length && !finished.length) return null;
  return (
    <div className="absolute bottom-[calc(100%-2px)] left-3 z-30 flex flex-col items-start gap-1">
      {running.length ? (
        <DockPill
          items={running}
          activeId={activeId}
          label={running.length === 1 ? activityParts(runningPreview(running[0]!.id)).badge : `${running.length} running`}
          ariaLabel={running.length === 1 ? running[0]!.title : `${running.length} running chats`}
          clock={running.length === 1 ? runningStartedAt(running[0]!.id) : 0}
          previewFor={runningPreview}
          startedAtFor={runningStartedAt}
          onOpen={onOpen}
        />
      ) : null}
      {finished.length ? (
        <DockPill
          items={finished}
          activeId={activeId}
          label={finished.length === 1 ? finished[0]!.title : `${finished.length} finished`}
          ariaLabel={finished.length === 1 ? finished[0]!.title : `${finished.length} finished chats`}
          clock={0}
          previewFor={() => ""}
          startedAtFor={() => 0}
          onOpen={onOpen}
        />
      ) : null}
    </div>
  );
}

function DockPill({
  items,
  activeId,
  label,
  ariaLabel,
  clock,
  previewFor,
  startedAtFor,
  onOpen,
}: {
  items: SidebarActivityItem[];
  activeId: string;
  label: string;
  ariaLabel: string;
  clock: number;
  previewFor: (id: string) => string;
  startedAtFor: (id: string) => number;
  onOpen: (path: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const openTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(openTimer.current), []);
  const only = items.length === 1 ? items[0] : null;
  const model = badgeModel(items);
  function arm() {
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setOpen(true), 160);
  }
  function disarm() {
    window.clearTimeout(openTimer.current);
    setOpen(false);
  }
  return (
    <div className="relative" onMouseEnter={arm} onMouseLeave={disarm}>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
            transition={{ duration: reduceMotion ? 0 : 0.15, ease: TIP_EASE }}
            className="absolute bottom-full left-0 z-40 pb-2.5"
          >
            <div className="relative">
              <div role="tooltip" className="model-tip running-tip w-max max-w-[15rem] rounded-lg border px-0.5 py-0.5 shadow-card">
                {items.map((item) => (
                  <RunningTipRow
                    key={`${item.path}\t${item.id}`}
                    item={item}
                    selected={item.id === activeId}
                    preview={previewFor(item.id)}
                    startedAt={startedAtFor(item.id)}
                    onOpen={onOpen}
                  />
                ))}
              </div>
              <span aria-hidden className="running-notch pointer-events-none absolute top-full left-4" />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (only) onOpen(only.path, only.id);
        }}
        className={`flex h-[22px] max-w-[190px] items-center gap-1.5 rounded-full border bg-canvas px-2 shadow-card ${
          items.some((item) => item.id === activeId) ? "border-ink/55" : "border-line"
        }`}
      >
        {model != null ? <ProviderMark model={model} /> : null}
        <span className="min-w-0 truncate text-[11px] font-medium text-ink">{label}</span>
        {clock > 0 ? (
          <RunningElapsed startedAt={clock} className="shrink-0 text-[11px] tabular-nums text-muted" />
        ) : null}
      </button>
    </div>
  );
}

/** One provider mark when every running chat uses it. Null when they differ. */
function badgeModel(running: SidebarActivityItem[]): string | null {
  const ids = new Set(running.map((item) => providerProfile(item.model).id));
  if (ids.size !== 1) return null;
  return running.find((item) => item.model.trim())?.model ?? "";
}

function ProviderMark({ model }: { model: string }) {
  const profile = providerProfile(model);
  const tone = profile.id === "anthropic" ? "text-[#d97757]" : profile.id === "minimax" ? "" : "text-ink";
  return <Symbol name={profile.symbol} colored={profile.id === "minimax"} className={`size-3 shrink-0 ${tone}`} />;
}

function RunningTipRow({
  item,
  selected,
  preview,
  startedAt,
  onOpen,
}: {
  item: SidebarActivityItem;
  selected: boolean;
  preview: string;
  startedAt: number;
  onOpen: (path: string, id: string) => void;
}) {
  const detail = activityParts(preview).detail;
  const place = detail ? `${item.project} · ${detail}` : item.project;
  return (
    <button
      type="button"
      onClick={() => onOpen(item.path, item.id)}
      className={`block w-full rounded-[6px] px-2 py-1 text-left ${selected ? "bg-current/10" : "hover:bg-current/10"}`}
    >
      <span className="block max-w-[14rem] truncate text-[12px] leading-4 font-medium">{item.title}</span>
      <span className="block max-w-[14rem] truncate text-[11px] leading-4 opacity-65">
        {place}
        {startedAt > 0 ? (
          <>
            {" · "}
            <RunningElapsed startedAt={startedAt} className="tabular-nums" />
          </>
        ) : null}
      </span>
    </button>
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
