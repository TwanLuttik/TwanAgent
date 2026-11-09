import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { RunningElapsed } from "../../components/RunningElapsed";
import { Symbol } from "../../components/Symbol";
import type { SidebarActivityItem } from "../../lib/all-projects";
import { sidebarActivityIcon, type ChatMessage } from "../../lib/core";
import { providerProfile } from "../../lib/provider";

const TIP_EASE = [0.22, 1, 0.36, 1] as const;

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
  const one = running.length === 1 ? running[0] : null;
  return (
    <div className="absolute bottom-[calc(100%-2px)] left-3 z-30 flex flex-col items-start gap-1">
      {running.length ? (
        <DockPill
          items={running}
          activeId={activeId}
          label={one ? one.title : `${running.length} running`}
          ariaLabel={one ? one.title : `${running.length} running chats`}
          clock={one ? runningStartedAt(one.id) : 0}
          running
          previewFor={runningPreview}
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
  running = false,
  previewFor,
  onOpen,
}: {
  items: SidebarActivityItem[];
  activeId: string;
  label: string;
  ariaLabel: string;
  clock: number;
  running?: boolean;
  previewFor: (id: string) => string;
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
    openTimer.current = window.setTimeout(() => setOpen(true), 280);
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
            className="absolute bottom-full left-0 z-40 pb-1.5"
          >
            <div
              role="tooltip"
              className="w-[15.5rem] rounded-2xl border border-line/55 bg-panel p-1 shadow-card"
            >
              {items.length > 1 ? (
                <div className="px-2 pt-1 pb-0.5 text-[10px] font-medium text-muted">
                  {running ? `${items.length} running` : `${items.length} finished`}
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                {items.map((item) => (
                  <RunningTipRow
                    key={`${item.path}\t${item.id}`}
                    item={item}
                    selected={item.id === activeId}
                    preview={previewFor(item.id)}
                    running={running}
                    onOpen={onOpen}
                  />
                ))}
              </div>
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
        className={`flex h-[22px] max-w-[11rem] items-center gap-1.5 rounded-full border bg-panel px-2 text-ink ${
          open ? "border-line shadow-card" : "border-line/70"
        }`}
      >
        {running ? (
          <span className="size-3 shrink-0 animate-spin rounded-full border border-ok border-t-transparent" />
        ) : model != null ? (
          <ProviderMark model={model} />
        ) : null}
        <span className="min-w-0 truncate text-[11px] leading-none font-medium">{label}</span>
        {clock > 0 ? (
          <RunningElapsed startedAt={clock} className="shrink-0 text-[11px] leading-none tabular-nums text-muted" />
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

function ProviderMark({ model, large = false }: { model: string; large?: boolean }) {
  const profile = providerProfile(model);
  const tone = profile.id === "anthropic" ? "text-[#d97757]" : profile.id === "minimax" ? "" : "usage-mark-xai";
  const size = large ? "size-4" : "size-3";
  return (
    <span className={`flex ${large ? "size-5" : "size-3"} shrink-0 items-center justify-center ${tone}`}>
      <Symbol name={profile.symbol} colored={profile.id === "minimax"} className={`${size} shrink-0`} />
    </span>
  );
}

function RunningTipRow({
  item,
  selected,
  preview,
  running = false,
  onOpen,
}: {
  item: SidebarActivityItem;
  selected: boolean;
  preview: string;
  running?: boolean;
  onOpen: (path: string, id: string) => void;
}) {
  const caption = preview.replace(/(…|\.\.\.)$/u, "").trim() || item.project;
  const activityIcon = preview.trim() ? sidebarActivityIcon(caption) : "arrow.turn.down.right";
  return (
    <button
      type="button"
      onClick={() => onOpen(item.path, item.id)}
      className={`flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left ${
        selected ? "bg-wash" : "hover:bg-wash/80"
      }`}
    >
      <ProviderMark model={item.model} large />
      <span className="min-w-0 flex-1">
        <span className="block min-w-0 truncate text-[13px] leading-4 font-medium text-ink">{item.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-ink">
          <Symbol name={activityIcon} className="size-3 shrink-0" />
          <span className="min-w-0 truncate" title={caption}>
            {caption}
          </span>
        </span>
      </span>
      {running ? (
        <span
          className="mt-0.5 size-3.5 shrink-0 self-center animate-spin rounded-full border-2 border-ok border-t-transparent"
          aria-hidden
        />
      ) : null}
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
