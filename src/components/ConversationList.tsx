import { useRef, useState, type ReactNode } from "react";
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
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Symbol } from "./Symbol";
import type { DevConversationSummary } from "../lib/tauri";

export function ConversationList({
  conversations,
  activeId,
  runningId,
  runningPreview,
  showSettings,
  onOpen,
  onDelete,
  onReorder,
}: {
  conversations: DevConversationSummary[];
  activeId: string;
  runningId: string;
  runningPreview: string;
  showSettings: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
}) {
  const [draggingId, setDraggingId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [overlayWidth, setOverlayWidth] = useState<number | undefined>();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragCancel={() => {
        setDraggingId(null);
        setOverId(null);
      }}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={conversations.map((row) => row.id)} strategy={verticalListSortingStrategy}>
        <div ref={listRef} className="flex flex-col gap-0.5" role="list">
          {conversations.map((row) => (
            <SortableConversation
              key={row.id}
              row={row}
              selected={row.id === activeId && !showSettings}
              running={runningId === row.id}
              preview={runningId === row.id ? runningPreview : ""}
              dragging={draggingId === row.id}
              insert={Boolean(draggingId && overId === row.id && draggingId !== row.id)}
              insertAfter={
                Boolean(draggingId) &&
                conversations.findIndex((item) => item.id === draggingId) <
                  conversations.findIndex((item) => item.id === row.id)
              }
              onOpen={onOpen}
              onDelete={onDelete}
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
              running={runningId === dragging.id}
              preview={runningId === dragging.id ? runningPreview : ""}
              overlay
              handle={
                <div className="flex size-6 items-center justify-center text-muted">
                  <Grip />
                </div>
              }
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableConversation({
  row,
  selected,
  running,
  preview,
  dragging,
  insert,
  insertAfter,
  onOpen,
  onDelete,
}: {
  row: DevConversationSummary;
  selected: boolean;
  running: boolean;
  preview: string;
  dragging: boolean;
  insert: boolean;
  insertAfter: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
  });
  const hidden = isDragging || dragging;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="relative"
      role="listitem"
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
        preview={preview}
        placeholder={hidden}
        handle={
          <button
            type="button"
            aria-label={`Reorder ${row.title}`}
            title="Drag to reorder"
            className="flex size-6 shrink-0 touch-none items-center justify-center rounded text-muted hover:bg-wash hover:text-ink"
            {...attributes}
            {...listeners}
          >
            <Grip />
          </button>
        }
        onOpen={() => onOpen(row.id)}
        onDelete={() => onDelete(row.id)}
      />
    </div>
  );
}

function ConversationCard({
  row,
  selected,
  running,
  preview,
  placeholder,
  overlay,
  handle,
  onOpen,
  onDelete,
}: {
  row: DevConversationSummary;
  selected: boolean;
  running: boolean;
  preview: string;
  placeholder?: boolean;
  overlay?: boolean;
  handle?: ReactNode;
  onOpen?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={`group flex items-center rounded-[6px] ${running ? "py-0.5" : ""} ${
        overlay
          ? "cursor-grabbing border border-line bg-canvas shadow-card"
          : placeholder
            ? "opacity-0"
            : selected
              ? "bg-wash-strong"
              : "hover:bg-wash"
      }`}
    >
      {handle ? <div className="pl-0.5">{handle}</div> : <div className="w-1.5 shrink-0" />}
      <button
        type="button"
        disabled={placeholder || overlay}
        onClick={onOpen}
        className={`flex min-w-0 flex-1 items-center gap-2 py-[6px] pr-1 text-left text-[13px] text-ink ${
          handle ? "pl-0.5" : "pl-2"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {row.kind === "terminal" ? (
              <Symbol name="terminal" className="size-3 shrink-0 text-muted" />
            ) : null}
            <span className="block min-w-0 truncate">{row.title}</span>
          </span>
          {running && preview ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted">{preview}</span>
          ) : null}
        </span>
        {running ? (
          <span
            className="size-2.5 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
            aria-label="Running"
          />
        ) : null}
      </button>
      {onDelete && !overlay ? (
        <button
          type="button"
          aria-label="Delete conversation"
          onClick={onDelete}
          className={`mr-1 size-6 items-center justify-center rounded text-muted hover:bg-wash-strong hover:text-ink ${
            placeholder ? "hidden" : "hidden group-hover:flex"
          }`}
        >
          <Symbol name="xmark" className="size-3" />
        </button>
      ) : (
        <div className="mr-1 size-6 shrink-0" />
      )}
    </div>
  );
}

function Grip() {
  return (
    <svg viewBox="0 0 16 16" className="block size-3.5" aria-hidden>
      <circle cx="5.5" cy="3.5" r="1.05" fill="currentColor" />
      <circle cx="10.5" cy="3.5" r="1.05" fill="currentColor" />
      <circle cx="5.5" cy="8" r="1.05" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.05" fill="currentColor" />
      <circle cx="5.5" cy="12.5" r="1.05" fill="currentColor" />
      <circle cx="10.5" cy="12.5" r="1.05" fill="currentColor" />
    </svg>
  );
}
