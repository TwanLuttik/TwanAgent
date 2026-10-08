import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
import { CSS } from "@dnd-kit/utilities";
import { Symbol } from "./Symbol";
import type { ConversationSummary } from "../lib/tauri";
import {
  buildSidebar,
  JOURNEY_COLORS,
  journeyWash,
  parseJourneyColor,
  type JourneyColor,
  type JourneySummary,
  type SidebarNode,
} from "../lib/journey";
import type { ConversationKind } from "../lib/terminal-chat";
import { formatRelativeAge } from "../lib/relative-time";

type MenuTarget =
  | { type: "chat"; id: string; journeyId?: string | null }
  | { type: "journey"; id: string };

export function ConversationList({
  conversations,
  journeys,
  activeId,
  runningIds,
  loadingId,
  runningPreview,
  showSettings,
  onOpen,
  onDelete,
  onArchive,
  archivedView,
  onReorder,
  onReorderSidebar,
  onCreateJourney,
  onOpenKnowledge,
  onNewChat,
  onToggleCollapse,
  onRenameJourney,
  onDeleteJourney,
  onRemoveFromJourney,
  onMoveToJourney,
  onSetColor,
}: {
  conversations: ConversationSummary[];
  journeys: JourneySummary[];
  activeId: string;
  runningIds: Record<string, unknown>;
  loadingId?: string;
  runningPreview: (id: string) => string;
  showSettings: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  archivedView?: boolean;
  onReorder: (fromId: string, toId: string) => void;
  onReorderSidebar: (fromId: string, fromKind: "journey" | "conversation", toId: string, toKind: "journey" | "conversation") => void;
  onCreateJourney: (id: string) => void;
  onOpenKnowledge: (id: string) => void;
  onNewChat: (journeyId: string, kind: ConversationKind) => void;
  onToggleCollapse: (id: string) => void;
  onRenameJourney: (id: string, title: string) => void;
  onDeleteJourney: (id: string, deleteChats: boolean) => void;
  onRemoveFromJourney: (id: string) => void;
  onMoveToJourney: (id: string, journeyId: string) => void;
  onSetColor: (id: string, color: JourneyColor) => void;
}) {
  const [draggingId, setDraggingId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const [overlayWidth, setOverlayWidth] = useState<number | undefined>();
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const nodes = buildSidebar(conversations, journeys);
  const items = flattenNodes(nodes);
  const groups = groupItems(items);
  const sortableIds = items.map((item) => item.key);

  useEffect(() => {
    function onDoc() {
      setMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setMenu(null);
        setDeleteId(null);
      }
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    const tick = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.clearInterval(tick);
    };
  }, []);

  if (conversations.length === 0 && journeys.length === 0) return null;

  const dragging = items.find((row) => row.key === draggingId) ?? null;

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
    const from = parseItemKey(String(active.id));
    const to = parseItemKey(String(over.id));
    if (!from || !to) return;
    if (from.kind === "conversation" && to.kind === "journey") {
      onMoveToJourney(from.id, to.id);
      return;
    }
    if (from.kind === "conversation" && to.kind === "conversation") {
      const fromRow = conversations.find((c) => c.id === from.id);
      const toRow = conversations.find((c) => c.id === to.id);
      if (fromRow?.journey_id && !toRow?.journey_id) {
        onRemoveFromJourney(from.id);
        return;
      }
      if (fromRow?.journey_id === toRow?.journey_id) {
        onReorder(from.id, to.id);
        return;
      }
      if (toRow?.journey_id) {
        onMoveToJourney(from.id, toRow.journey_id);
        return;
      }
    }
    onReorderSidebar(from.id, from.kind, to.id, to.kind);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // Group wrappers are each row's DOM parent. restrictToParentElement would
      // trap the collision rect inside a single item so nothing can be reordered.
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
          {groups.map((group) => (
            <div
              key={group.key}
              className={group.wash ? "rounded-[8px] py-0.5" : undefined}
              style={group.wash ? { background: group.wash } : undefined}
            >
              {group.items.map((item) => (
                <SortableRow
                  key={item.key}
                  item={item}
                  selected={item.kind === "chat" && item.conversation.id === activeId && !showSettings}
                  running={
                    item.kind === "chat" &&
                    (item.conversation.id in runningIds || loadingId === item.conversation.id)
                  }
                  preview={
                    item.kind === "chat" && item.conversation.id in runningIds
                      ? runningPreview(item.conversation.id)
                      : ""
                  }
                  dragging={draggingId === item.key}
                  insert={Boolean(draggingId && overId === item.key && draggingId !== item.key)}
                  insertAfter={
                    Boolean(draggingId) &&
                    items.findIndex((row) => row.key === draggingId) < items.findIndex((row) => row.key === item.key)
                  }
                  renaming={item.kind === "journey" && renameId === item.journey.id}
                  age={
                    item.kind === "chat" &&
                    !(item.conversation.id in runningIds) &&
                    loadingId !== item.conversation.id
                      ? formatRelativeAge(item.conversation.updated_at, nowMs)
                      : ""
                  }
                  onOpen={onOpen}
                  onDelete={onDelete}
                  onToggle={onToggleCollapse}
                  onOpenKnowledge={onOpenKnowledge}
                  onNewChat={onNewChat}
                  onRename={(id, title) => {
                    onRenameJourney(id, title);
                    setRenameId(null);
                  }}
                  onContext={(ev, target) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setMenu({ x: ev.clientX, y: ev.clientY, target });
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div style={overlayWidth ? { width: overlayWidth } : undefined}>
            {dragging.kind === "journey" ? (
              <JourneyCard
                journey={dragging.journey}
                overlay
                handle={
                  <div className="flex size-6 items-center justify-center text-muted">
                    <Grip />
                  </div>
                }
              />
            ) : (
              <ConversationCard
                row={dragging.conversation}
                selected={dragging.conversation.id === activeId && !showSettings}
                running={
                  dragging.conversation.id in runningIds || loadingId === dragging.conversation.id
                }
                preview={
                  dragging.conversation.id in runningIds ? runningPreview(dragging.conversation.id) : ""
                }
                indent={dragging.indent}
                age={
                  !(dragging.conversation.id in runningIds) && loadingId !== dragging.conversation.id
                    ? formatRelativeAge(dragging.conversation.updated_at, nowMs)
                    : ""
                }
                overlay
                handle={
                  <div className="flex size-6 items-center justify-center text-muted">
                    <Grip />
                  </div>
                }
              />
            )}
          </div>
        ) : null}
      </DragOverlay>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.target}
          runningIds={runningIds}
          onClose={() => setMenu(null)}
          onCreateJourney={() => {
            if (menu.target.type === "chat") onCreateJourney(menu.target.id);
            setMenu(null);
          }}
          onDeleteChat={() => {
            if (menu.target.type === "chat") onDelete(menu.target.id);
            setMenu(null);
          }}
          archivedView={archivedView}
          onArchiveChat={() => {
            if (menu.target.type === "chat" && onArchive) {
              onArchive(menu.target.id, !archivedView);
            }
            setMenu(null);
          }}
          onRemove={() => {
            if (menu.target.type === "chat") onRemoveFromJourney(menu.target.id);
            setMenu(null);
          }}
          color={
            menu.target.type === "journey"
              ? parseJourneyColor(journeys.find((row) => row.id === menu.target.id)?.color)
              : ""
          }
          onRename={() => {
            if (menu.target.type === "journey") setRenameId(menu.target.id);
            setMenu(null);
          }}
          onSetColor={(color) => {
            if (menu.target.type === "journey") onSetColor(menu.target.id, color);
          }}
          onDeleteJourney={() => {
            if (menu.target.type === "journey") setDeleteId(menu.target.id);
            setMenu(null);
          }}
        />
      ) : null}
      {deleteId ? (
        <DeleteJourneyDialog
          title={journeys.find((j) => j.id === deleteId)?.title ?? "Journey"}
          onCancel={() => setDeleteId(null)}
          onKeep={() => {
            onDeleteJourney(deleteId, false);
            setDeleteId(null);
          }}
          onDelete={() => {
            onDeleteJourney(deleteId, true);
            setDeleteId(null);
          }}
        />
      ) : null}
    </DndContext>
  );
}

type FlatItem =
  | { key: string; kind: "journey"; journey: JourneySummary; indent: boolean }
  | { key: string; kind: "chat"; conversation: ConversationSummary; indent: boolean };

function groupItems(items: FlatItem[]): { key: string; wash?: string; items: FlatItem[] }[] {
  const groups: { key: string; wash?: string; items: FlatItem[] }[] = [];
  for (const item of items) {
    if (item.kind === "journey") {
      groups.push({
        key: item.key,
        wash: journeyWash(item.journey.color),
        items: [item],
      });
      continue;
    }
    const last = groups[groups.length - 1];
    if (item.indent && last) {
      last.items.push(item);
    } else {
      groups.push({ key: item.key, items: [item] });
    }
  }
  return groups;
}

function flattenNodes(nodes: SidebarNode[]): FlatItem[] {
  const out: FlatItem[] = [];
  for (const node of nodes) {
    if (node.kind === "journey") {
      out.push({ key: itemKey("journey", node.journey.id), kind: "journey", journey: node.journey, indent: false });
      if (!node.journey.collapsed) {
        for (const child of node.children) {
          out.push({ key: itemKey("chat", child.id), kind: "chat", conversation: child, indent: true });
        }
      }
    } else {
      out.push({
        key: itemKey("chat", node.conversation.id),
        kind: "chat",
        conversation: node.conversation,
        indent: false,
      });
    }
  }
  return out;
}

function itemKey(kind: "journey" | "chat", id: string) {
  return `${kind}:${id}`;
}

function parseItemKey(key: string): { kind: "journey" | "conversation"; id: string } | null {
  if (key.startsWith("journey:")) return { kind: "journey", id: key.slice("journey:".length) };
  if (key.startsWith("chat:")) return { kind: "conversation", id: key.slice("chat:".length) };
  return null;
}

function SortableRow({
  item,
  selected,
  running,
  preview,
  dragging,
  insert,
  insertAfter,
  renaming,
  age,
  onOpen,
  onDelete,
  onToggle,
  onOpenKnowledge,
  onNewChat,
  onRename,
  onContext,
}: {
  item: FlatItem;
  selected: boolean;
  running: boolean;
  preview: string;
  dragging: boolean;
  insert: boolean;
  insertAfter: boolean;
  renaming: boolean;
  age: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  onOpenKnowledge: (id: string) => void;
  onNewChat: (journeyId: string, kind: ConversationKind) => void;
  onRename: (id: string, title: string) => void;
  onContext: (ev: MouseEvent, target: MenuTarget) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.key,
  });
  const hidden = isDragging || dragging;
  const handle = (
    <button
      type="button"
      aria-label="Drag to reorder"
      title="Drag to reorder"
      className="flex size-6 shrink-0 touch-none items-center justify-center rounded text-muted hover:bg-wash hover:text-ink"
      {...attributes}
      {...listeners}
    >
      <Grip />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="relative"
      role="listitem"
      onContextMenu={(ev) => {
        if (item.kind === "journey") onContext(ev, { type: "journey", id: item.journey.id });
        else onContext(ev, { type: "chat", id: item.conversation.id, journeyId: item.conversation.journey_id });
      }}
    >
      {insert ? (
        <div
          className={`pointer-events-none absolute right-2 left-2 z-20 h-0.5 rounded-full bg-accent ${
            insertAfter ? "bottom-[-2px]" : "top-[-2px]"
          }`}
        />
      ) : null}
      {item.kind === "journey" ? (
        <JourneyCard
          journey={item.journey}
          placeholder={hidden}
          renaming={renaming}
          handle={handle}
          onToggle={() => onToggle(item.journey.id)}
          onOpenKnowledge={() => onOpenKnowledge(item.journey.id)}
          onNewChat={(kind) => onNewChat(item.journey.id, kind)}
          onRename={(title) => onRename(item.journey.id, title)}
        />
      ) : (
        <ConversationCard
          row={item.conversation}
          selected={selected}
          running={running}
          preview={preview}
          indent={item.indent}
          placeholder={hidden}
          age={age}
          handle={handle}
          onOpen={() => onOpen(item.conversation.id)}
          onDelete={() => onDelete(item.conversation.id)}
        />
      )}
    </div>
  );
}

function JourneyCard({
  journey,
  placeholder,
  overlay,
  renaming,
  handle,
  onToggle,
  onOpenKnowledge,
  onNewChat,
  onRename,
}: {
  journey: JourneySummary;
  placeholder?: boolean;
  overlay?: boolean;
  renaming?: boolean;
  handle?: ReactNode;
  onToggle?: () => void;
  onOpenKnowledge?: () => void;
  onNewChat?: (kind: ConversationKind) => void;
  onRename?: (title: string) => void;
}) {
  const [draft, setDraft] = useState(journey.title);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    setDraft(journey.title);
  }, [journey.title, renaming]);

  return (
    <div
      className={`group flex items-center rounded-[6px] py-0.5 ${
        overlay
          ? "cursor-grabbing border border-line bg-canvas shadow-card"
          : placeholder
            ? "opacity-0"
            : "hover:bg-wash"
      }`}
    >
      {handle ? <div className="pl-0.5">{handle}</div> : <div className="w-1.5 shrink-0" />}
      <button
        type="button"
        disabled={placeholder || overlay || renaming}
        onClick={onToggle}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-wash hover:text-ink"
        aria-label={journey.collapsed ? "Expand journey" : "Collapse journey"}
      >
        <Symbol name={journey.collapsed ? "chevron.right" : "chevron.down"} className="size-3" />
      </button>
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          onBlur={() => onRename?.(draft.trim() || journey.title)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") onRename?.(draft.trim() || journey.title);
            if (ev.key === "Escape") onRename?.(journey.title);
          }}
          className="mr-1 min-w-0 flex-1 rounded bg-canvas px-1 py-[5px] text-[13px] text-ink outline-none"
        />
      ) : (
        <button
          type="button"
          disabled={placeholder || overlay}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center py-[7px] pr-1 text-left text-[13px] font-medium text-ink"
        >
          <span className="block min-w-0 truncate">{journey.title}</span>
        </button>
      )}
      {!overlay ? (
        <div className={`mr-1 flex shrink-0 items-center gap-0.5 ${placeholder ? "hidden" : ""}`}>
          <button
            type="button"
            aria-label="Open journey knowledge"
            title="Knowledge"
            onClick={onOpenKnowledge}
            className="flex size-6 items-center justify-center rounded text-muted hover:bg-wash-strong hover:text-ink"
          >
            <Symbol name="doc.fill" className="size-3.5" />
          </button>
          <div className="relative">
            <button
              type="button"
              aria-label="New conversation in journey"
              title="New chat"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex size-6 items-center justify-center rounded text-muted hover:bg-wash-strong hover:text-ink"
            >
              <Symbol name="plus" className="size-3" />
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="absolute top-full right-0 z-30 mt-1 min-w-[132px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-card"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onNewChat?.("chat");
                    setMenuOpen(false);
                  }}
                  className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
                >
                  Chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onNewChat?.("terminal");
                    setMenuOpen(false);
                  }}
                  className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
                >
                  Terminal
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mr-1 size-6 shrink-0" />
      )}
    </div>
  );
}

function ConversationCard({
  row,
  selected,
  running,
  preview,
  indent,
  placeholder,
  overlay,
  age,
  handle,
  onOpen,
  onDelete,
}: {
  row: ConversationSummary;
  selected: boolean;
  running: boolean;
  preview: string;
  indent?: boolean;
  placeholder?: boolean;
  overlay?: boolean;
  age?: string;
  handle?: ReactNode;
  onOpen?: () => void;
  onDelete?: () => void;
}) {
  const showPreview = Boolean(running && preview);
  return (
    <div
      className={`group flex items-center rounded-[6px] ${indent ? "pl-3" : ""} ${
        overlay
          ? "cursor-grabbing border border-transparent bg-canvas shadow-card"
          : placeholder
            ? "border border-transparent opacity-0"
            : selected
              ? "border border-transparent bg-wash-strong"
              : "border border-transparent hover:bg-wash"
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
            {running ? (
              <span
                className="size-2.5 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
                aria-label={preview || "Loading"}
              />
            ) : null}
          </span>
          {showPreview ? (
            <span className="mt-0.5 block h-[14px] truncate text-[11px] leading-[14px] text-muted">{preview}</span>
          ) : null}
        </span>
      </button>
      <span
        className={`mr-1.5 w-7 shrink-0 text-right text-[11px] tabular-nums text-muted ${
          onDelete && !overlay && !placeholder ? "group-hover:hidden" : ""
        }`}
        title={
          age && Number.isFinite(Date.parse(row.updated_at)) ? new Date(row.updated_at).toLocaleString() : undefined
        }
      >
        {age || ""}
      </span>
      {onDelete && !overlay ? (
        <button
          type="button"
          aria-label="Delete conversation"
          onClick={onDelete}
          className={`mr-1 hidden size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-wash-strong hover:text-ink ${
            placeholder ? "" : "group-hover:flex"
          }`}
        >
          <Symbol name="xmark" className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function ContextMenu({
  x,
  y,
  target,
  runningIds,
  onClose,
  onCreateJourney,
  onDeleteChat,
  onArchiveChat,
  archivedView,
  onRemove,
  onRename,
  onDeleteJourney,
  color,
  onSetColor,
}: {
  x: number;
  y: number;
  target: MenuTarget;
  runningIds: Record<string, unknown>;
  onClose: () => void;
  onCreateJourney: () => void;
  onDeleteChat: () => void;
  onArchiveChat: () => void;
  archivedView?: boolean;
  onRemove: () => void;
  onRename: () => void;
  onDeleteJourney: () => void;
  color: JourneyColor;
  onSetColor: (color: JourneyColor) => void;
}) {
  const items =
    target.type === "journey"
      ? [
          { label: "Rename", onClick: onRename },
          { label: "Delete", onClick: onDeleteJourney },
        ]
      : [
          ...(!archivedView && !target.journeyId && !(target.id in runningIds)
            ? [{ label: "Create Journey", onClick: onCreateJourney }]
            : []),
          ...(!archivedView && target.journeyId ? [{ label: "Remove from Journey", onClick: onRemove }] : []),
          { label: archivedView ? "Unarchive" : "Archive", onClick: onArchiveChat },
          { label: "Delete", onClick: onDeleteChat },
        ];

  return (
    <div
      role="menu"
      className="fixed z-50 min-w-[168px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-card"
      style={{ left: x, top: y }}
      onMouseDown={(ev) => ev.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={item.onClick}
          className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
        >
          {item.label}
        </button>
      ))}
      {target.type === "journey" ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5" role="group" aria-label="Journey color">
          {JOURNEY_COLORS.map((opt) => {
            const selected = color === opt.id;
            return (
              <button
                key={opt.id || "none"}
                type="button"
                title={opt.label}
                aria-label={opt.label}
                aria-pressed={selected}
                onClick={() => onSetColor(opt.id)}
                className={`size-3.5 rounded-full border ${
                  selected ? "border-ink" : "border-line"
                } ${opt.id ? "" : "bg-canvas"}`}
                style={opt.wash ? { background: opt.swatch } : undefined}
              />
            );
          })}
        </div>
      ) : null}
      {items.length === 0 ? (
        <button type="button" className="hidden" onClick={onClose}>
          Close
        </button>
      ) : null}
    </div>
  );
}

function DeleteJourneyDialog({
  title,
  onCancel,
  onKeep,
  onDelete,
}: {
  title: string;
  onCancel: () => void;
  onKeep: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20" onMouseDown={onCancel}>
      <div
        className="w-[280px] rounded-lg border border-line bg-canvas p-3 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="text-[13px] font-medium text-ink">Delete {title}?</div>
        <p className="mt-1 text-[12px] text-muted">Keep the conversations or delete them with this Journey.</p>
        <div className="mt-3 flex flex-col gap-1">
          <button
            type="button"
            onClick={onKeep}
            className="rounded-[6px] px-2 py-1.5 text-left text-[13px] text-ink hover:bg-wash"
          >
            Keep conversations
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-[6px] px-2 py-1.5 text-left text-[13px] text-err hover:bg-wash"
          >
            Delete conversations
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[6px] px-2 py-1.5 text-left text-[13px] text-muted hover:bg-wash"
          >
            Cancel
          </button>
        </div>
      </div>
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
