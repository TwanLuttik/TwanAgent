import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
import {
  addableKinds,
  closePane,
  movePane,
  paneMeta,
  selectPane,
  type PaneKind,
  type PaneState,
  type PaneTab,
} from "../../lib/pane";
import { Symbol } from "../Symbol";

export function PaneTabs({
  pane,
  onChange,
  onAdd,
  onCollapse,
}: {
  pane: PaneState;
  onChange: (next: PaneState) => void;
  onAdd: (kind: PaneKind) => void;
  onCollapse?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const canClose = pane.tabs.length > 1;
  const kinds = addableKinds(pane.tabs);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    if (!menu) return;
    function onDoc(ev: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) setMenu(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMenu(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function add(kind: PaneKind) {
    onAdd(kind);
    setMenu(false);
  }

  function onDragStart(ev: DragStartEvent) {
    setDraggingId(String(ev.active.id));
  }

  function onDragEnd(ev: DragEndEvent) {
    const { active, over } = ev;
    setDraggingId(null);
    if (!over || active.id === over.id) return;
    onChange(movePane(pane, String(active.id), String(over.id)));
  }

  const dragging = pane.tabs.find((tab) => tab.id === draggingId) ?? null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-1.5">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
        onDragStart={onDragStart}
        onDragCancel={() => setDraggingId(null)}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={pane.tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" role="tablist" aria-label="Pane">
            {pane.tabs.map((tab) => (
              <PaneTabButton
                key={tab.id}
                tab={tab}
                active={tab.id === pane.activeId}
                canClose={canClose}
                onSelect={() => onChange(selectPane(pane, tab.id))}
                onClose={() => onChange(closePane(pane, tab.id))}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {dragging ? <PaneTabFace tab={dragging} active={dragging.id === pane.activeId} canClose={canClose} overlay /> : null}
        </DragOverlay>
      </DndContext>
      {onCollapse ? (
        <button
          type="button"
          aria-label="Hide files"
          aria-pressed
          title="Hide files"
          onClick={onCollapse}
          className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="sidebar.right" className="size-3.5" weight="regular" />
        </button>
      ) : null}
      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          aria-label="Open pane"
          aria-haspopup="menu"
          aria-expanded={menu}
          title="Open pane"
          onClick={() => {
            if (kinds.length === 1) add(kinds[0]);
            else setMenu((open) => !open);
          }}
          className="flex size-6 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="plus" className="size-3.5" weight="regular" />
        </button>
        {menu ? (
          <div
            role="menu"
            className="absolute top-full right-0 z-20 mt-1 min-w-[132px] rounded-md border border-line bg-canvas py-1 shadow-card"
          >
            {kinds.map((kind) => {
              const meta = paneMeta(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  onClick={() => add(kind)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-inset"
                >
                  <Symbol name={meta.icon} className="size-3.5 text-muted" />
                  <span>{meta.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Move the held tab without stretching it to the tab it passes over. */
function paneDragTransform(transform: Transform | null): string | undefined {
  if (!transform) return undefined;
  return CSS.Translate.toString({ ...transform, scaleX: 1, scaleY: 1 });
}

function PaneTabButton({
  tab,
  active,
  canClose,
  onSelect,
  onClose,
}: {
  tab: PaneTab;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: paneDragTransform(transform), transition }}
      className={`min-w-0 ${isDragging ? "opacity-40" : ""}`}
    >
      <PaneTabFace
        tab={tab}
        active={active}
        canClose={canClose}
        drag={{ ...attributes, ...listeners }}
        onSelect={onSelect}
        onClose={onClose}
      />
    </div>
  );
}

function PaneTabFace({
  tab,
  active,
  canClose,
  overlay,
  drag,
  onSelect,
  onClose,
}: {
  tab: PaneTab;
  active: boolean;
  canClose: boolean;
  overlay?: boolean;
  drag?: HTMLAttributes<HTMLButtonElement>;
  onSelect?: () => void;
  onClose?: () => void;
}) {
  const meta = paneMeta(tab.kind);
  return (
    <div
      className={`group flex h-6 max-w-[11rem] min-w-0 items-center rounded-[6px] ${
        overlay ? "cursor-grabbing shadow-card" : ""
      } ${active ? "bg-wash-strong text-ink" : "text-muted hover:bg-wash hover:text-ink"}`}
      onMouseDown={(ev) => {
        if (ev.button === 1) ev.preventDefault();
      }}
      onAuxClick={(ev) => {
        if (ev.button !== 1 || !canClose || !onClose) return;
        ev.preventDefault();
        ev.stopPropagation();
        onClose();
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        {...drag}
        className={`flex h-6 min-w-0 touch-none items-center gap-1 py-0 pr-1.5 pl-1.5 text-left ${
          overlay ? "cursor-grabbing" : "cursor-grab active:cursor-grabbing"
        } ${canClose ? "" : "pr-2"}`}
      >
        <Symbol
          name={meta.icon}
          weight="regular"
          className={`size-[13px] shrink-0 ${paneIconNudge(tab.kind)}`}
        />
        <span className="min-w-0 truncate text-[11px] leading-none">{tab.title}</span>
      </button>
      {canClose && onClose ? (
        <button
          type="button"
          aria-label={`Close ${tab.title}`}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={onClose}
          className={`mr-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-wash-strong hover:text-ink ${
            active ? "opacity-80" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <Symbol name="xmark" className="size-2.5" weight="regular" />
        </button>
      ) : null}
    </div>
  );
}

function paneIconNudge(kind: PaneKind): string {
  if (kind === "terminal") return "translate-y-px";
  if (kind === "files") return "-translate-y-px";
  return "";
}
