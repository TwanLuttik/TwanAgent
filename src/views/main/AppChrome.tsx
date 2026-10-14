import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
import { ChromeTab, ChromeTabGroup, ChromeTabStrip } from "../../components/ChromeTabs";
import { AnchoredMenu } from "../../components/ContextMenu";
import { Symbol } from "../../components/Symbol";
import { isMacOS } from "../../components/WindowButtons";
import type { EditorState } from "../../lib/editor";
import { CODE_TAB_KEY, tabItemKey, type TabItem, type TabMenu } from "../../lib/split-pane";
import { chatHasRunningTurn, type RunningTurn } from "../../lib/turn";
import type { ConversationKind } from "../../lib/terminal-chat";

export function NewChatMenu({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (kind: ConversationKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={isMacOS() ? "New chat ⌘N" : "New chat Ctrl+N"}
        className="text-[11px] text-muted hover:text-ink disabled:opacity-35"
      >
        New chat
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 min-w-[148px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-card"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPick("chat");
              setOpen(false);
            }}
            className="flex w-full items-center justify-between gap-4 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
          >
            <span className="flex items-center gap-2">
              <Symbol name="bubble.left" className="size-3.5 text-muted" />
              Chat
            </span>
            <span className="text-[11px] text-muted">{isMacOS() ? "⌘N" : "Ctrl+N"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPick("terminal");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
          >
            <Symbol name="terminal" className="size-3.5 text-muted" />
            Terminal (deprecated)
          </button>
        </div>
      ) : null}
    </div>
  );
}

export type CenterChat = {
  id: string;
  title: string;
  kind: ConversationKind;
  running?: boolean;
};

export function CenterTabs({
  editor,
  chats,
  items,
  activeChatId,
  splitChatIds,
  runningTurns,
  menu,
  onChat,
  onCloseChat,
  onCode,
  onMenu,
  onSplit,
  onSplitSelected,
  onMoveTab,
  onUnsplit,
  onCloseMenu,
}: {
  editor: EditorState;
  chats: CenterChat[];
  items: TabItem[];
  activeChatId: string;
  /** Both chats in the open split, when one is showing. */
  splitChatIds?: readonly string[];
  runningTurns?: Readonly<Record<string, RunningTurn>>;
  menu: TabMenu | null;
  onChat: (id: string) => void;
  onCloseChat: (id: string) => void;
  onCode: () => void;
  onMenu: (menu: TabMenu) => void;
  onSplit: (id: string) => void;
  onSplitSelected: (ids: string[]) => void;
  onMoveTab: (fromKey: string, toKey: string) => void;
  onUnsplit: (groupId: string) => void;
  onCloseMenu: () => void;
}) {
  const chatOn = editor.focus === "chat";
  const codeOn = editor.focus === "file";
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const splitOpen = Boolean(splitChatIds && splitChatIds.length > 1);
  const [picked, setPicked] = useState<string[]>([]);
  const [draggingKey, setDraggingKey] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setPicked([]);
    }
    function onPointer(ev: MouseEvent) {
      const target = ev.target;
      if (!(target instanceof Element)) {
        setPicked([]);
        return;
      }
      const onTab = Boolean(target.closest("[data-tab-key], .chrome-tab"));
      if (ev.button === 2 && onTab) return;
      if (onTab && (ev.metaKey || ev.ctrlKey)) return;
      setPicked([]);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer, true);
    };
  }, []);

  function togglePick(id: string) {
    setPicked((current) => (current.includes(id) ? current.filter((row) => row !== id) : [...current, id]));
  }

  function onDragStart(event: DragStartEvent) {
    setDraggingKey(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setDraggingKey("");
    if (!over || active.id === over.id) return;
    onMoveTab(String(active.id), String(over.id));
  }

  const keys = items.map((item) => tabItemKey(item));

  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
      onDragStart={onDragStart}
      onDragCancel={() => setDraggingKey("")}
      onDragEnd={onDragEnd}
    >
    <SortableContext items={keys} strategy={horizontalListSortingStrategy}>
    <ChromeTabStrip>
      {items.map((item) => {
        if (item.kind === "split") {
          const [leftId, rightId] = item.group.chatIds;
          const groupOn = chatOn && splitOpen && splitChatIds?.includes(leftId) && splitChatIds.includes(rightId);
          return (
            <SortableTab key={item.group.id} id={tabItemKey(item)} dragging={draggingKey === tabItemKey(item)}>
              <ChromeTabGroup selected={Boolean(groupOn)}>
                <SplitTab
                  chat={byId.get(leftId)}
                  id={leftId}
                  selected={Boolean(groupOn) && leftId === activeChatId}
                  running={chatHasRunningTurn(runningTurns, leftId)}
                  onChat={onChat}
                  onClose={() => onCloseChat(leftId)}
                  onMenu={(event) =>
                    onMenu({ kind: "split", groupId: item.group.id, pane: 0, x: event.clientX, y: event.clientY })
                  }
                />
                <SplitTab
                  chat={byId.get(rightId)}
                  id={rightId}
                  selected={Boolean(groupOn) && rightId === activeChatId}
                  running={chatHasRunningTurn(runningTurns, rightId)}
                  onChat={onChat}
                  onClose={() => onCloseChat(rightId)}
                  onMenu={(event) =>
                    onMenu({ kind: "split", groupId: item.group.id, pane: 1, x: event.clientX, y: event.clientY })
                  }
                />
              </ChromeTabGroup>
            </SortableTab>
          );
        }
        if (item.kind === "code") {
          return (
            <SortableTab key={CODE_TAB_KEY} id={CODE_TAB_KEY} dragging={draggingKey === CODE_TAB_KEY}>
              <ChromeTab
                selected={codeOn}
                label="Code"
                icon={<Symbol name="doc.fill" className="size-3.5 shrink-0" />}
                onClick={onCode}
              />
            </SortableTab>
          );
        }
        const chat = byId.get(item.id);
        return (
          <SortableTab key={item.id} id={tabItemKey(item)} dragging={draggingKey === tabItemKey(item)}>
            <ChatChromeTab
              chat={chat}
              id={item.id}
              selected={chatOn && item.id === activeChatId && !splitOpen}
              marked={picked.includes(item.id)}
              running={chat?.running ?? chatHasRunningTurn(runningTurns, item.id)}
              onChat={(id, event) => {
                if (event.metaKey && chat?.kind !== "terminal") {
                  togglePick(id);
                  return;
                }
                setPicked([]);
                onChat(id);
              }}
              onClose={() => onCloseChat(item.id)}
              onMenu={(event) => onMenu({ kind: "chat", id: item.id, x: event.clientX, y: event.clientY })}
            />
          </SortableTab>
        );
      })}
      {menu ? (
        <ChatTabMenu
          menu={menu}
          canSplit={
            menu.kind === "chat" &&
            (picked.includes(menu.id)
              ? picked.length > 1
              : chats.filter((chat) => chat.kind !== "terminal").length > 1)
          }
          onSplit={() => {
            if (menu.kind !== "chat") return;
            const ids = picked.includes(menu.id) ? picked : [menu.id];
            if (ids.length > 1) onSplitSelected(ids);
            else onSplit(menu.id);
            setPicked([]);
            onCloseMenu();
          }}
          onUnsplit={() => {
            if (menu.kind === "split") onUnsplit(menu.groupId);
            onCloseMenu();
          }}
          onCloseTab={() => {
            if (menu.kind === "chat") onCloseChat(menu.id);
            else onCloseChat(splitPaneChatId(items, menu.groupId, menu.pane));
            onCloseMenu();
          }}
        />
      ) : null}
    </ChromeTabStrip>
    </SortableContext>
    </DndContext>
  );
}

/** Move the held tab without scaling it to the tab it passes over. */
function tabDragTransform(transform: Transform | null): string | undefined {
  if (!transform) return undefined;
  return CSS.Translate.toString({ ...transform, scaleX: 1, scaleY: 1 });
}

function SortableTab({
  id,
  dragging,
  children,
}: {
  id: string;
  dragging: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const [heldWidth, setHeldWidth] = useState(0);
  return (
    <div
      ref={setNodeRef}
      data-tab-key={id}
      data-tauri-drag-region="false"
      draggable={false}
      style={{
        transform: tabDragTransform(transform),
        transition,
        touchAction: "none",
        width: dragging && heldWidth > 0 ? heldWidth : undefined,
        flexShrink: 0,
      }}
      className={dragging ? "chrome-tab-holding cursor-grabbing opacity-60" : "cursor-grab"}
      {...attributes}
      {...listeners}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.target instanceof Element && event.target.closest(".chrome-tab-close")) return;
        const width = event.currentTarget.getBoundingClientRect().width;
        if (width > 0) setHeldWidth(width);
        listeners?.onPointerDown?.(event);
      }}
    >
      {children}
    </div>
  );
}

function splitPaneChatId(items: TabItem[], groupId: string, pane: 0 | 1): string {
  for (const item of items) {
    if (item.kind === "split" && item.group.id === groupId) return item.group.chatIds[pane];
  }
  return "";
}

function SplitTab({
  chat,
  id,
  selected,
  running,
  onChat,
  onClose,
  onMenu,
}: {
  chat: CenterChat | undefined;
  id: string;
  selected: boolean;
  running: boolean;
  onChat: (id: string, event: ReactMouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <ChatChromeTab
      chat={chat}
      id={id}
      selected={selected}
      running={running}
      grouped
      onChat={onChat}
      onClose={onClose}
      onMenu={onMenu}
    />
  );
}

function ChatChromeTab({
  chat,
  id,
  selected,
  marked = false,
  running,
  grouped = false,
  onChat,
  onClose,
  onMenu,
}: {
  chat: CenterChat | undefined;
  id: string;
  selected: boolean;
  marked?: boolean;
  running: boolean;
  grouped?: boolean;
  onChat: (id: string, event: ReactMouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const terminal = chat?.kind === "terminal";
  const raw = chat?.title?.trim() || "";
  const label = terminal ? raw || "Terminal" : raw && raw !== "New chat" ? raw : "New thread";
  return (
    <ChromeTab
      selected={selected}
      label={label}
      icon={<Symbol name={terminal ? "terminal.fill" : "bubble.left.fill"} className="size-3.5 shrink-0" />}
      running={running}
      grouped={grouped}
      marked={marked}
      onClick={(event) => onChat(id, event)}
      onClose={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event);
      }}
    />
  );
}

function ChatTabMenu({
  menu,
  canSplit,
  onSplit,
  onUnsplit,
  onCloseTab,
}: {
  menu: TabMenu;
  canSplit: boolean;
  onSplit: () => void;
  onUnsplit: () => void;
  onCloseTab: () => void;
}) {
  return (
    <AnchoredMenu x={menu.x} y={menu.y} label="Conversation tab">
      {menu.kind === "chat" ? (
        <button
          type="button"
          role="menuitem"
          disabled={!canSplit}
          onClick={onSplit}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset disabled:cursor-default disabled:opacity-40"
        >
          <Symbol name="rectangle.split.2x1" className="size-3.5 text-muted" />
          Split pane
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          onClick={onUnsplit}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
        >
          <Symbol name="rectangle.split.2x1" className="size-3.5 text-muted" />
          Unsplit
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={onCloseTab}
        className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
      >
        Close
      </button>
    </AnchoredMenu>
  );
}
