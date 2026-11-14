import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
import { AnchoredMenu } from "./ContextMenu";
import { Symbol } from "./Symbol";
import type { ConversationSummary } from "../lib/tauri";
import type { ChatPlace } from "../lib/chat-place";
import { formatRelativeAge, relativeAgeTickMs } from "../lib/relative-time";
import { RunningElapsed } from "./RunningElapsed";
import { providerProfile } from "../lib/provider";
import type { TodoBadge } from "../lib/todo";
import { subagentsForParent } from "../lib/subagent-parent";
import { sidebarActivityIcon, sidebarActivityText } from "../lib/core";
import { isProviderRetryStatus } from "../lib/turn";
import { formatModelName } from "../lib/usage";

export const ConversationList = memo(function ConversationList({
  conversations,
  activeId,
  runningIds,
  unseenIds,
  loadingId,
  runningPreview,
  todoFor,
  showSettings,
  onOpen,
  onSelect,
  onDelete,
  onArchive,
  archivedView,
  reorderable = true,
  selectedIds,
  onReorder,
  place,
  subagentChats = [],
}: {
  conversations: ConversationSummary[];
  activeId: string;
  runningIds: Readonly<Record<string, { startedAt?: number }>>;
  unseenIds?: ReadonlySet<string>;
  loadingId?: string;
  runningPreview: (id: string) => string;
  todoFor?: (id: string) => TodoBadge | null;
  showSettings: boolean;
  onOpen: (id: string) => void;
  /** Cmd/Ctrl toggles, Shift extends. A plain click still opens the chat. */
  onSelect?: (id: string, mods: { toggle: boolean; range: boolean }) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  archivedView?: boolean;
  /** Off while the list is sorted by finish time. Dragging would fight that view. */
  reorderable?: boolean;
  /** Chat ids in this list that are part of the multi-selection. */
  selectedIds?: ReadonlySet<string>;
  onReorder: (fromId: string, toId: string) => void;
  /** Branch, pull request, and where this project's chats live. */
  place: ChatPlace;
  /** Subagent chats hidden from this list. Each stays reachable from its parent row. */
  subagentChats?: ConversationSummary[];
}) {
  const [draggingId, setDraggingId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const [overlayWidth, setOverlayWidth] = useState<number | undefined>();
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const openRowMenu = useMemo(
    () => (ev: MouseEvent, id: string) => {
      ev.preventDefault();
      ev.stopPropagation();
      setMenu({ x: ev.clientX, y: ev.clientY, id });
    },
    [],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const sortableIds = useMemo(() => conversations.map((row) => row.id), [conversations]);
  const itemIndex = useMemo(() => {
    const index = new Map<string, number>();
    conversations.forEach((row, i) => index.set(row.id, i));
    return index;
  }, [conversations]);

  useEffect(() => {
    function onDoc() {
      setMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMenu(null);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const ageKey = conversations.map((row) => row.updated_at).join("\n");
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      const now = Date.now();
      setNowMs((prev) => (Math.abs(now - prev) < 500 ? prev : now));
      let wait = 60_000;
      for (const row of conversations) {
        if (row.id in runningIds || loadingId === row.id) continue;
        wait = Math.min(wait, relativeAgeTickMs(row.updated_at, now));
      }
      timer = window.setTimeout(arm, wait);
    };
    arm();
    return () => window.clearTimeout(timer);
    // The joined timestamps are the clock input. `conversations` is rebuilt whenever they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ageKey, runningIds, loadingId]);

  if (conversations.length === 0) return null;

  const dragging = conversations.find((row) => row.id === draggingId) ?? null;

  function onDragStart(ev: DragStartEvent) {
    setDraggingId(ev.active.id);
    setOverId(ev.active.id);
    const width = listRef.current?.getBoundingClientRect().width;
    setOverlayWidth(width && width > 0 ? width : undefined);
  }

  function onDragOver(ev: DragOverEvent) {
    setOverId(ev.over?.id ?? null);
  }

  function onDragEnd(ev: DragEndEvent) {
    const { active, over } = ev;
    setDraggingId(null);
    setOverId(null);
    if (!reorderable || !over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragCancel={() => {
        setDraggingId(null);
        setOverId(null);
      }}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div ref={listRef} className="flex flex-col gap-0.5" role="list">
          {conversations.map((row) => (
            <SortableRow
              key={row.id}
              row={row}
              selected={
                showSettings
                  ? false
                  : selectedIds && selectedIds.size > 0
                    ? selectedIds.has(row.id)
                    : row.id === activeId
              }
              onSelect={onSelect}
              running={row.id in runningIds || loadingId === row.id}
              unseen={Boolean(unseenIds?.has(row.id))}
              preview={row.id in runningIds ? runningPreview(row.id) : ""}
              todo={todoFor?.(row.id) ?? null}
              dragging={draggingId === row.id}
              insert={Boolean(draggingId && overId === row.id && draggingId !== row.id)}
              insertAfter={
                Boolean(draggingId) && (itemIndex.get(String(draggingId)) ?? -1) < (itemIndex.get(row.id) ?? -1)
              }
              age={
                !(row.id in runningIds) && loadingId !== row.id ? formatRelativeAge(row.updated_at, nowMs) : ""
              }
              startedAt={runningIds[row.id]?.startedAt}
              reorderable={reorderable}
              onOpen={onOpen}
              onDelete={onDelete}
              onContextMenu={openRowMenu}
              place={place}
              agents={subagentsForParent(row.id, subagentChats)}
              runningIds={runningIds}
              runningPreview={runningPreview}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div style={overlayWidth ? { width: overlayWidth } : undefined}>
            <ConversationCard
              row={dragging}
              selected={dragging.id === activeId && !showSettings}
              running={dragging.id in runningIds || loadingId === dragging.id}
              preview={dragging.id in runningIds ? runningPreview(dragging.id) : ""}
              todo={todoFor?.(dragging.id) ?? null}
              age={
                !(dragging.id in runningIds) && loadingId !== dragging.id
                  ? formatRelativeAge(dragging.updated_at, nowMs)
                  : ""
              }
              startedAt={runningIds[dragging.id]?.startedAt}
              place={place}
              overlay
            />
          </div>
        ) : null}
      </DragOverlay>
      {menu ? (
        <ChatContextMenu
          x={menu.x}
          y={menu.y}
          id={menu.id}
          archivedView={archivedView}
          archiveCount={selectedIds?.has(menu.id) ? selectedIds.size : 1}
          onClose={() => setMenu(null)}
          onDelete={() => {
            onDelete(menu.id);
            setMenu(null);
          }}
          onArchive={() => {
            onArchive?.(menu.id, !archivedView);
            setMenu(null);
          }}
        />
      ) : null}
    </DndContext>
  );
});

const SortableRow = memo(function SortableRow({
  row,
  selected,
  running,
  unseen,
  preview,
  todo,
  dragging,
  insert,
  insertAfter,
  age,
  startedAt,
  reorderable,
  onOpen,
  onSelect,
  onDelete,
  onContextMenu,
  place,
  agents = [],
  runningIds,
  runningPreview,
}: {
  row: ConversationSummary;
  selected: boolean;
  running: boolean;
  unseen?: boolean;
  preview: string;
  todo?: TodoBadge | null;
  dragging: boolean;
  insert: boolean;
  insertAfter: boolean;
  age: string;
  /** When this turn started. A running row shows the live elapsed time instead of its age. */
  startedAt?: number;
  reorderable: boolean;
  onOpen: (id: string) => void;
  onSelect?: (id: string, mods: { toggle: boolean; range: boolean }) => void;
  onDelete: (id: string) => void;
  onContextMenu: (ev: MouseEvent, id: string) => void;
  place: ChatPlace;
  agents?: ConversationSummary[];
  runningIds?: Readonly<Record<string, { startedAt?: number }>>;
  runningPreview?: (id: string) => string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
    disabled: !reorderable,
    // Tab would focus this drag handle and WKWebView paints that as a selection bar.
    attributes: { tabIndex: -1 },
  });
  const hidden = isDragging || dragging;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: rowDragTransform(transform), transition }}
      className="group/chat relative z-0 touch-none select-none hover:z-20 outline-none"
      {...attributes}
      {...listeners}
      onContextMenu={(ev) => onContextMenu(ev, row.id)}
    >
      {insert ? (
        <div
          className={`pointer-events-none absolute right-2 left-2 z-20 h-0.5 rounded-full bg-accent ${
            insertAfter ? "bottom-[-2px]" : "top-[-2px]"
          }`}
        />
      ) : null}
      <ConversationCard
        row={row}
        selected={selected}
        running={running}
        unseen={unseen}
        preview={preview}
        todo={todo}
        placeholder={hidden}
        age={age}
        startedAt={startedAt}
        rowId={row.id}
        onOpen={onOpen}
        onSelect={onSelect}
        onDelete={onDelete}
        place={place}
        agents={agents}
        runningIds={runningIds}
        runningPreview={runningPreview}
      />
    </div>
  );
});

const SNIPPET_EASE = [0.22, 1, 0.36, 1] as const;

/** The activity line changes while a chat runs. The new text rises as the old one leaves. */
function RisingText({ text, title }: { text: string; title: string }) {
  const reduce = useReducedMotion();
  return (
    <span className="relative block h-[14px] min-w-0 flex-1 overflow-hidden">
      <AnimatePresence initial={false}>
        <motion.span
          key={text}
          initial={reduce ? false : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -5 }}
          transition={{ duration: reduce ? 0 : 0.18, ease: SNIPPET_EASE }}
          className="absolute inset-0 truncate"
          title={title}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function RisingIcon({ name }: { name: string }) {
  const reduce = useReducedMotion();
  return (
    <span className="relative block size-3 shrink-0 overflow-hidden">
      <AnimatePresence initial={false}>
        <motion.span
          key={name}
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: reduce ? 0 : 0.18, ease: SNIPPET_EASE }}
          className="absolute inset-0"
        >
          <Symbol name={name} className="size-3" />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Move the held row without stretching it to the height of the row it passes over. */
function rowDragTransform(transform: Transform | null): string | undefined {
  if (!transform) return undefined;
  return CSS.Translate.toString({ ...transform, scaleX: 1, scaleY: 1 });
}

const ConversationCard = memo(function ConversationCard({
  row,
  selected,
  running,
  unseen,
  preview,
  todo,
  placeholder,
  overlay,
  age,
  startedAt,
  rowId = "",
  onOpen,
  onSelect,
  onDelete,
  place,
  agents = [],
  runningIds,
  runningPreview,
}: {
  row: ConversationSummary;
  selected: boolean;
  running: boolean;
  unseen?: boolean;
  preview: string;
  todo?: TodoBadge | null;
  placeholder?: boolean;
  overlay?: boolean;
  age?: string;
  startedAt?: number;
  rowId?: string;
  onOpen?: (id: string) => void;
  onSelect?: (id: string, mods: { toggle: boolean; range: boolean }) => void;
  onDelete?: (id: string) => void;
  place: ChatPlace;
  agents?: ConversationSummary[];
  runningIds?: Readonly<Record<string, { startedAt?: number }>>;
  runningPreview?: (id: string) => string;
}) {
  const caption = conversationCaption({
    running,
    activity: preview,
    todo,
    preview: row.preview,
    title: row.title,
    place,
  });
  const activityIcon = running && caption ? sidebarActivityIcon(caption) : "";
  const activityMark = activityIcon && activityIcon !== "arrow.turn.down.right" ? activityIcon : "";
  const activityText = running && caption ? sidebarActivityText(caption) : caption;
  const snippetQuiet = !running && !selected;
  const retrying = running && isProviderRetryStatus(activityText);
  const snippetClass = `mt-px flex min-w-0 items-center gap-1 text-[11px] leading-[14px] transition-colors duration-150 ease-out motion-reduce:transition-none ${
    retrying ? "text-warn" : running ? "text-ink" : snippetQuiet ? "text-muted/55 group-hover/chat:text-muted" : "text-muted"
  }`;
  const arrowClass = `size-3 shrink-0 transition-opacity duration-150 ease-out motion-reduce:transition-none ${
    snippetQuiet ? "text-muted opacity-45 group-hover/chat:opacity-70" : "opacity-70"
  }`;
  return (
    <div
      className={`group/chat relative z-0 flex items-center overflow-visible rounded-xl select-none transition-colors duration-150 ease-out motion-reduce:transition-none hover:z-10 ${
        overlay
          ? "cursor-grabbing border border-transparent bg-canvas shadow-card"
          : placeholder
            ? "border border-transparent opacity-0"
            : unseen && !selected
              ? "border border-transparent bg-warn/15 hover:bg-warn/25"
              : selected
                ? "border border-transparent bg-wash-strong"
                : "border border-transparent hover:bg-wash"
      }`}
    >
      <button
        type="button"
        tabIndex={-1}
        disabled={placeholder || overlay}
        onClick={(ev) => {
          if (onSelect && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) {
            ev.preventDefault();
            onSelect(rowId, { toggle: ev.metaKey || ev.ctrlKey, range: ev.shiftKey });
            return;
          }
          onSelect?.(rowId, { toggle: false, range: false });
          onOpen?.(rowId);
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 py-1 pr-2 pl-2 text-left text-ink outline-none disabled:cursor-default"
      >
        <ChatLogo model={row.model} />
        <span className={`min-w-0 flex-1 ${onDelete ? "transition-[padding] duration-150 ease-out group-hover/chat:pr-4" : ""}`}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`min-w-0 truncate text-[13px] leading-4 font-medium ${
                agents.length && !overlay && !placeholder ? "" : "flex-1"
              }`}
            >
              {row.title}
            </span>
            {agents.length && !overlay && !placeholder ? (
              <SubagentCount
                agents={agents}
                runningIds={runningIds}
                runningPreview={runningPreview}
                onOpen={onOpen}
              />
            ) : null}
            {running && startedAt ? (
              <RunningElapsed
                startedAt={startedAt}
                className={`shrink-0 text-[11px] leading-none tabular-nums text-muted ${
                  agents.length && !overlay && !placeholder ? "ml-auto" : ""
                }`}
              />
            ) : age ? (
              <span
                className={`shrink-0 text-[11px] leading-none tabular-nums text-muted ${
                  agents.length && !overlay && !placeholder ? "ml-auto" : ""
                }`}
                title={Number.isFinite(Date.parse(row.updated_at)) ? new Date(row.updated_at).toLocaleString() : undefined}
              >
                {age}
              </span>
            ) : null}
          </span>
          {place.worktree && place.branch.trim() ? (
            <span className={snippetClass}>
              <Symbol name="arrow.triangle.branch" className="size-3 shrink-0 text-ok" />
              <span className="max-w-[46%] shrink-0 truncate text-ok" title={place.branch.trim()}>
                {place.branch.trim()}
              </span>
              {caption ? (
                <>
                  {activityMark ? <RisingIcon name={activityMark} /> : null}
                  <Symbol name="arrow.turn.down.right" className={arrowClass} />
                  <RisingText text={activityText} title={caption} />
                </>
              ) : null}
            </span>
          ) : caption ? (
            <span className={snippetClass}>
              {activityMark ? <RisingIcon name={activityMark} /> : null}
              <Symbol name="arrow.turn.down.right" className={arrowClass} />
              <RisingText text={activityText} title={caption} />
            </span>
          ) : null}
        </span>
        {running ? (
          <span
            className={`mt-0.5 size-3.5 shrink-0 self-center animate-spin rounded-full border border-muted/55 border-t-transparent ${
              onDelete && !overlay && !placeholder ? "group-hover/chat:opacity-0" : ""
            }`}
            aria-label={preview || "Loading"}
          />
        ) : null}
      </button>
      {onDelete && !overlay && !placeholder ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Delete conversation"
          onClick={() => onDelete?.(rowId)}
          className="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 items-center justify-center text-muted opacity-0 transition-opacity duration-150 ease-out group-hover/chat:opacity-100 hover:text-ink"
        >
          <Symbol name="xmark" className="size-2.5 shrink-0" />
        </button>
      ) : null}
    </div>
  );
});

function SubagentCount({
  agents,
  runningIds,
  runningPreview,
  onOpen,
}: {
  agents: ConversationSummary[];
  runningIds?: Readonly<Record<string, { startedAt?: number }>>;
  runningPreview?: (id: string) => string;
  onOpen?: (id: string) => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const hideTimer = useRef(0);

  function place() {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 240;
    const left = rect.right + 8 + width > window.innerWidth ? Math.max(8, rect.left - width - 8) : rect.right + 8;
    setBox({ top: Math.max(8, rect.top - 4), left });
  }

  function show() {
    window.clearTimeout(hideTimer.current);
    place();
    setOpen(true);
  }

  function scheduleHide() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setOpen(false), 140);
  }

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const runningAgents: ConversationSummary[] = [];
  const finishedAgents: ConversationSummary[] = [];
  for (const agent of agents) {
    if (runningIds && agent.id in runningIds) runningAgents.push(agent);
    else finishedAgents.push(agent);
  }

  return (
    <>
      <span
        ref={anchor}
        role="button"
        tabIndex={-1}
        aria-label={`${agents.length} subagent${agents.length === 1 ? "" : "s"}`}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onFocus={show}
        onBlur={scheduleHide}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          show();
        }}
        className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 text-[11px] leading-none tabular-nums text-muted hover:text-ink"
      >
        <Symbol name="person.2" className="size-3 shrink-0" />
        {agents.length}
      </span>
      {open && box
        ? createPortal(
            <div
              role="menu"
              style={{ top: box.top, left: box.left }}
              onMouseEnter={show}
              onMouseLeave={scheduleHide}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              className="fixed z-50 w-60 rounded-xl border border-line/60 bg-panel p-1 shadow-card"
            >
              {runningAgents.map((agent) => (
                <SubagentMenuItem
                  key={agent.id}
                  agent={agent}
                  running
                  caption={runningPreview?.(agent.id) || "Working…"}
                  onPick={() => {
                    setOpen(false);
                    onOpen?.(agent.id);
                  }}
                />
              ))}
              {finishedAgents.map((agent) => (
                <SubagentMenuItem
                  key={agent.id}
                  agent={agent}
                  onPick={() => {
                    setOpen(false);
                    onOpen?.(agent.id);
                  }}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function SubagentMenuItem({
  agent,
  running = false,
  caption = "",
  onPick,
}: {
  agent: ConversationSummary;
  running?: boolean;
  caption?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
      className={`flex w-full min-w-0 cursor-pointer gap-2 rounded-lg px-1.5 text-left hover:bg-wash ${
        running ? "items-start py-1.5" : "items-center py-0.5"
      }`}
    >
      <ChatLogo model={agent.model} />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate leading-4 font-medium ${
            running ? "text-[13px] text-ink" : "text-[12px] text-ink/75"
          }`}
        >
          {agent.title}
        </span>
        {running && caption ? (
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted">{caption}</span>
        ) : null}
      </span>
      {running ? (
        <span className="mt-0.5 size-3.5 shrink-0 animate-spin rounded-full border border-muted/55 border-t-transparent" />
      ) : null}
    </button>
  );
}

function ChatContextMenu({
  x,
  y,
  id,
  onClose,
  onDelete,
  onArchive,
  archivedView,
  archiveCount = 1,
}: {
  x: number;
  y: number;
  id: string;
  onClose: () => void;
  onDelete: () => void;
  onArchive: () => void;
  archivedView?: boolean;
  archiveCount?: number;
}) {
  const archiveLabel = archivedView
    ? archiveCount > 1
      ? `Unarchive ${archiveCount}`
      : "Unarchive"
    : archiveCount > 1
      ? `Archive ${archiveCount}`
      : "Archive";
  const itemClass =
    "flex h-7 w-full cursor-pointer items-center px-2.5 text-left text-[12px] text-ink/80 transition-colors duration-150 hover:bg-wash";
  return (
    <AnchoredMenu x={x} y={y}>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void navigator.clipboard.writeText(id).catch(() => undefined);
          onClose();
        }}
        className={itemClass}
      >
        Copy ID
      </button>
      <button type="button" role="menuitem" onClick={onArchive} className={itemClass}>
        {archiveLabel}
      </button>
      <button type="button" role="menuitem" onClick={onDelete} className={itemClass}>
        Delete
      </button>
    </AnchoredMenu>
  );
}

function conversationCaption({
  running,
  activity,
  todo,
  preview,
  title,
  place,
}: {
  running: boolean;
  activity: string;
  todo?: TodoBadge | null;
  preview?: string | null;
  title: string;
  place: ChatPlace;
}): string {
  if (running && activity.trim()) return activity.trim();
  if (todo) return `${todo.done}/${todo.total}`;
  const line = (preview ?? "").replace(/\s+/g, " ").trim();
  if (line && line.toLowerCase() !== title.trim().toLowerCase()) return line;
  if (place.worktree) return "";
  return place.branch.trim();
}

export const ChatLogo = memo(function ChatLogo({ model }: { model?: string | null }) {
  const id = model?.trim() ?? "";
  const profile = providerProfile(id);
  const name = id ? formatModelName(id) : profile.agentName;
  const tone =
    profile.id === "anthropic" ? "text-[#d97757]" : profile.id === "minimax" ? "group/minimax" : "usage-mark-xai";
  return (
    <span className={`group/model relative flex size-5 shrink-0 items-center justify-center ${tone}`} data-colored="">
      <Symbol name={profile.symbol} colored={profile.id === "minimax"} className="size-4" />
      <span
        role="tooltip"
        className="model-tip pointer-events-none absolute top-1/2 left-full z-50 ml-1.5 -translate-y-1/2 rounded-md border px-1.5 py-0.5 text-[11px] leading-none whitespace-nowrap opacity-0 shadow-card transition-opacity duration-150 group-hover/model:opacity-100"
      >
        {name}
      </span>
    </span>
  );
});
