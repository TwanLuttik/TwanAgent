import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
import { formatRelativeAge, relativeAgeTickMs } from "../lib/relative-time";
import { providerProfile } from "../lib/provider";
import type { TodoBadge } from "../lib/todo";
import { formatModelName } from "../lib/usage";

export function ConversationList({
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
  selectedIds,
  onReorder,
}: {
  conversations: ConversationSummary[];
  activeId: string;
  runningIds: Record<string, unknown>;
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
  /** Chat ids in this list that are part of the multi-selection. */
  selectedIds?: ReadonlySet<string>;
  onReorder: (fromId: string, toId: string) => void;
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
    if (!over || active.id === over.id) return;
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
              selected={selectedIds ? selectedIds.has(row.id) : row.id === activeId && !showSettings}
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
              onOpen={onOpen}
              onDelete={onDelete}
              onContextMenu={openRowMenu}
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
}

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
  onOpen,
  onSelect,
  onDelete,
  onContextMenu,
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
  onOpen: (id: string) => void;
  onSelect?: (id: string, mods: { toggle: boolean; range: boolean }) => void;
  onDelete: (id: string) => void;
  onContextMenu: (ev: MouseEvent, id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
  });
  const hidden = isDragging || dragging;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: rowDragTransform(transform), transition }}
      className="group/chat relative touch-none"
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
        rowId={row.id}
        onOpen={onOpen}
        onSelect={onSelect}
        onDelete={onDelete}
      />
    </div>
  );
});

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
  rowId = "",
  onOpen,
  onSelect,
  onDelete,
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
  rowId?: string;
  onOpen?: (id: string) => void;
  onSelect?: (id: string, mods: { toggle: boolean; range: boolean }) => void;
  onDelete?: (id: string) => void;
}) {
  const showPreview = Boolean(running && preview);
  return (
    <div
      className={`group/chat relative flex items-center rounded-[6px] select-none ${
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
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-[6px] pr-1 pl-2 text-left text-[13px] text-ink disabled:cursor-default"
      >
        <span className="min-w-0 flex-1">
          <span className="block min-w-0 truncate">{row.title}</span>
          {showPreview ? (
            <span className="mt-0.5 block h-[14px] truncate text-[11px] leading-[14px] text-muted">{preview}</span>
          ) : todo ? (
            <TodoMark badge={todo} />
          ) : null}
        </span>
      </button>
      <span className="flex shrink-0 items-center">
        {age ? (
          <span
            className="mr-1.5 w-6 shrink-0 text-right text-[11px] leading-none tabular-nums text-muted"
            title={Number.isFinite(Date.parse(row.updated_at)) ? new Date(row.updated_at).toLocaleString() : undefined}
          >
            {age}
          </span>
        ) : null}
        {row.kind === "terminal" ? (
          <Symbol name="terminal" className="mr-1 size-3 shrink-0 text-muted" />
        ) : (
          <ModelMark model={row.model} />
        )}
        {running ? (
          <span
            className="mr-1.5 size-3 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
            aria-label={preview || "Loading"}
          />
        ) : null}
      </span>
      {onDelete && !overlay && !placeholder ? (
        <button
          type="button"
          aria-label="Delete conversation"
          onClick={() => onDelete?.(rowId)}
          className="flex w-0 shrink-0 items-center justify-center overflow-hidden text-muted opacity-0 transition-all duration-150 ease-out group-hover/chat:mr-1 group-hover/chat:w-4 group-hover/chat:opacity-100 hover:text-ink"
        >
          <Symbol name="xmark" className="size-2.5 shrink-0" />
        </button>
      ) : null}
    </div>
  );
});

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

function TodoMark({ badge }: { badge: TodoBadge }) {
  if (badge.finished) {
    return (
      <span className="mt-0.5 flex h-[14px] items-center gap-1 text-[11px] leading-[14px] text-ok" title="Todos finished">
        <Symbol name="checkmark" className="size-2.5" />
        <span>
          {badge.done}/{badge.total}
        </span>
      </span>
    );
  }
  return (
    <span className="mt-0.5 block h-[14px] truncate text-[11px] leading-[14px] text-muted" title="Todo progress">
      {badge.done}/{badge.total}
    </span>
  );
}

const ModelMark = memo(function ModelMark({ model }: { model?: string | null }) {
  const id = model?.trim() ?? "";
  if (!id) return null;
  const profile = providerProfile(id);
  const name = formatModelName(id);
  const mark = profile.id === "anthropic" ? "model-mark-claude" : profile.id === "minimax" ? "model-mark-minimax" : "model-mark-xai";
  return (
    <span
      className={`model-mark group/model group/minimax relative mr-1 flex size-4 shrink-0 items-center justify-center text-muted transition-[margin] duration-150 ease-out group-hover/minimax:mr-0.5 ${mark}`}
    >
      <Symbol name={profile.symbol} className="size-3" />
      <span
        role="tooltip"
        className="model-tip pointer-events-none absolute top-1/2 right-full z-30 mr-1.5 -translate-y-1/2 rounded-md border px-1.5 py-0.5 text-[11px] whitespace-nowrap opacity-0 shadow-card transition-opacity duration-150 group-hover/model:opacity-100"
      >
        {name}
      </span>
    </span>
  );
});
