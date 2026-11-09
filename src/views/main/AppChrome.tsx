import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ChromeTab, ChromeTabStrip } from "../../components/ChromeTabs";
import { AnchoredMenu } from "../../components/ContextMenu";
import { ProjectMark } from "../../components/ProjectMark";
import { Symbol } from "../../components/Symbol";
import { MODEL_MENU_EASE } from "../../components/composer/menuEase";
import { isMacOS } from "../../components/WindowButtons";
import type { EditorState } from "../../lib/editor";
import { projectKey } from "../../lib/core";
import {
  projectChromeTabs,
  projectMenuEntries,
  rememberProjectChat,
  type ProjectTabChat,
} from "../../lib/project-tabs";
import { subagentParentLinks, subscribeSubagentParents } from "../../lib/subagent-parent";
import { type TabItem, type TabMenu } from "../../lib/split-pane";
import { chatHasRunningTurn, type RunningTurn } from "../../lib/turn";

const MENU_EASE = MODEL_MENU_EASE;
const HIDE_MS = 140;
/** Blur grows with opacity. A parent fade turns backdrop-filter off until the last frame. */
const GLASS_HIDE = { opacity: 0, y: -6, "--cloud-glass-blur": "0px" };
const GLASS_SHOW = { opacity: 1, y: 0, "--cloud-glass-blur": "24px" };
const GLASS_LEAVE = { opacity: 0, y: -4, "--cloud-glass-blur": "0px" };

export function NewChatMenu({ disabled, onNew }: { disabled: boolean; onNew: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onNew}
      title={isMacOS() ? "New chat ⌘N" : "New chat Ctrl+N"}
      className="text-[11px] font-medium text-ink disabled:opacity-35"
    >
      New chat
    </button>
  );
}

export type CenterChat = {
  id: string;
  title: string;
  running?: boolean;
};

export function CenterTabs({
  editor,
  chats,
  items,
  activeChatId,
  runningTurns,
  tabHomes,
  projectGroups,
  menu,
  onChat,
  onCloseChat,
  onCloseProject,
  onCode,
  onMenu,
  onSplit,
  onSplitSelected,
  onUnsplit,
  onCloseMenu,
}: {
  editor: EditorState;
  chats: CenterChat[];
  items: TabItem[];
  activeChatId: string;
  runningTurns?: Readonly<Record<string, RunningTurn>>;
  /** Workspace path for each open chat, used to keep one project's tabs together. */
  tabHomes: Readonly<Record<string, string>>;
  /** Sidebar rows, so a project tab matches the project list. */
  projectGroups?: readonly {
    path: string;
    name: string;
    remote?: boolean;
    conversations?: readonly { id?: string; kind?: string | null }[];
  }[];
  menu: TabMenu | null;
  onChat: (id: string) => void;
  onCloseChat: (id: string) => void;
  /** Middle-click on the project tab closes every conversation it has open. */
  onCloseProject: (ids: string[]) => void;
  onCode: () => void;
  onMenu: (menu: TabMenu) => void;
  onSplit: (id: string) => void;
  onSplitSelected: (ids: string[]) => void;
  onUnsplit: (groupId: string) => void;
  onCloseMenu: () => void;
}) {
  const codeOn = editor.focus === "file";
  const names = useMemo(() => namesFromGroups(projectGroups), [projectGroups]);
  const remoteProjects = useMemo(() => remoteProjectKeys(projectGroups), [projectGroups]);
  const subagentIds = useMemo(() => subagentIdsFromGroups(projectGroups), [projectGroups]);
  const parents = useSyncExternalStore(subscribeSubagentParents, subagentParentLinks, subagentParentLinks);
  const titles = useMemo(() => {
    const out: Record<string, string> = {};
    for (const chat of chats) out[chat.id] = chat.title;
    return out;
  }, [chats]);
  const runningIds = useMemo(() => {
    const ids = new Set<string>();
    for (const chat of chats) {
      if (chat.running || chatHasRunningTurn(runningTurns, chat.id)) ids.add(chat.id);
    }
    for (const id of Object.keys(runningTurns ?? {})) ids.add(id);
    return ids;
  }, [chats, runningTurns]);
  const [lastOpen, setLastOpen] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const pointerInside = useRef(false);
  const hideTimer = useRef(0);

  useEffect(() => {
    setLastOpen((prev) => rememberProjectChat(prev, tabHomes, activeChatId));
  }, [activeChatId, tabHomes]);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      setPicked([]);
      setHoverId(null);
    }
    function onPointer(ev: MouseEvent) {
      const target = ev.target;
      if (!(target instanceof Element)) {
        setPicked([]);
        return;
      }
      const onTab = Boolean(target.closest("[data-tab-key], .chrome-tab, [data-project-chat]"));
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

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (menu || pointerInside.current) return;
    setHoverId(null);
  }, [menu]);

  const entries = projectChromeTabs({
    items,
    homes: tabHomes,
    titles,
    runningIds,
    activeChatId,
    lastOpen,
    codeFocused: codeOn,
    names,
  });
  const hovered = entries.find((entry) => entry.kind === "project" && entry.id === hoverId);
  const hoveredProject = hovered?.kind === "project" ? hovered : null;
  const projectIds = entries.flatMap((entry) => (entry.kind === "project" ? [entry.id] : [])).join("\0");

  useEffect(() => {
    if (hoverId && !projectIds.split("\0").includes(hoverId)) setHoverId(null);
  }, [projectIds, hoverId]);

  function clearHide() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = 0;
  }

  function showProject(id: string) {
    pointerInside.current = true;
    clearHide();
    setHoverId(id);
  }

  function scheduleHide() {
    pointerInside.current = false;
    clearHide();
    if (menu) return;
    hideTimer.current = window.setTimeout(() => {
      if (!pointerInside.current) setHoverId(null);
    }, HIDE_MS);
  }

  function togglePick(id: string) {
    setPicked((current) => (current.includes(id) ? current.filter((row) => row !== id) : [...current, id]));
  }

  function choose(id: string) {
    setPicked([]);
    setHoverId(null);
    onChat(id);
  }

  return (
    <ChromeTabStrip>
      {entries.map((entry) =>
        entry.kind === "code" ? (
          <ChromeTab
            key={entry.id}
            selected={codeOn}
            label="Code"
            icon={<Symbol name="doc.fill" className="size-3.5 shrink-0" />}
            onClick={onCode}
          />
        ) : (
          <div
            key={entry.id}
            ref={(node) => {
              if (node) anchors.current.set(entry.id, node);
              else anchors.current.delete(entry.id);
            }}
            className="group shrink-0"
            data-tauri-drag-region="false"
            onMouseEnter={() => showProject(entry.id)}
            onMouseLeave={scheduleHide}
            onMouseDown={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              onCloseProject(entry.chats.map((chat) => chat.id));
            }}
          >
            <ChromeTab
              selected={entry.selected}
              label={entry.name}
              tip=""
              expanded={hoverId === entry.id}
              running={entry.running}
              icon={
                <ProjectMark
                  path={entry.path}
                  remote={remoteProjects.has(entry.key)}
                  active={entry.selected}
                  className="size-3.5"
                />
              }
              accessory={<ProjectTabCue count={entry.chats.length} open={hoverId === entry.id} />}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || !entry.openId) return;
                setPicked([]);
                onChat(entry.openId);
              }}
            />
          </div>
        ),
      )}
      <ProjectChatMenu
        open={Boolean(hoveredProject)}
        anchor={hoveredProject ? anchors.current.get(hoveredProject.id) ?? null : null}
        label={hoveredProject ? `${hoveredProject.name} conversations` : "Conversations"}
        onEnter={() => {
          pointerInside.current = true;
          clearHide();
        }}
        onLeave={scheduleHide}
      >
        <ProjectMenuRows
          chats={hoveredProject?.chats ?? []}
          parents={parents}
          subagentIds={subagentIds}
          picked={picked}
          onChoose={(id, event) => {
            if (event.metaKey || event.ctrlKey) {
              togglePick(id);
              return;
            }
            choose(id);
          }}
          onClose={onCloseChat}
          onMenu={onMenu}
        />
      </ProjectChatMenu>
      {menu ? (
        <ChatTabMenu
          menu={menu}
          canSplit={
            menu.kind === "chat" && (picked.includes(menu.id) ? picked.length > 1 : chats.length > 1)
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
          onCloseMenu={onCloseMenu}
          copyId={menu.kind === "chat" ? menu.id : splitPaneChatId(items, menu.groupId, menu.pane)}
        />
      ) : null}
    </ChromeTabStrip>
  );
}

function subagentIdsFromGroups(
  groups: readonly { conversations?: readonly { id?: string; kind?: string | null }[] }[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(groups)) return ids;
  for (const group of groups) {
    for (const row of group?.conversations ?? []) {
      if (row?.kind === "subagent" && row.id) ids.add(row.id);
    }
  }
  return ids;
}

function namesFromGroups(
  groups: readonly { path: string; name: string; remote?: boolean }[] | undefined,
): Record<string, string> {
  const names: Record<string, string> = {};
  if (!Array.isArray(groups)) return names;
  for (const group of groups) {
    const name = group?.name?.trim();
    if (!group?.path || !name) continue;
    const key = projectKey(group.path);
    if (!names[key]) names[key] = name;
  }
  return names;
}

function remoteProjectKeys(
  groups: readonly { path: string; name: string; remote?: boolean }[] | undefined,
): Set<string> {
  const remote = new Set<string>();
  if (!Array.isArray(groups)) return remote;
  for (const group of groups) {
    if (!group?.remote || !group.path) continue;
    remote.add(projectKey(group.path));
  }
  return remote;
}

function ProjectTabCue({ count, open }: { count: number; open: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {count > 1 ? <span className="text-[11px] tabular-nums text-muted">{count}</span> : null}
      <Symbol
        name="chevron.down"
        className={`size-2.5 text-muted transition-transform duration-150 ${open ? "rotate-180 opacity-80" : "opacity-40 group-hover:opacity-70"}`}
      />
    </span>
  );
}

function ProjectMenuRows({
  chats,
  parents,
  subagentIds,
  picked,
  onChoose,
  onClose,
  onMenu,
}: {
  chats: ProjectTabChat[];
  parents: Readonly<Record<string, string>>;
  subagentIds: ReadonlySet<string>;
  picked: readonly string[];
  onChoose: (id: string, event: ReactMouseEvent<HTMLElement>) => void;
  onClose: (id: string) => void;
  onMenu: (menu: TabMenu) => void;
}) {
  const entries = projectMenuEntries(
    chats,
    (id) => parents[id] ?? "",
    (id) => subagentIds.has(id) || Boolean(parents[id]),
  );
  return entries.map((entry) => {
    if (entry.kind === "chat") {
      return (
        <ProjectChatRow
          key={entry.chat.id}
          chat={entry.chat}
          depth={entry.depth}
          marked={picked.includes(entry.chat.id)}
          onChoose={onChoose}
          onClose={() => onClose(entry.chat.id)}
          onMenu={(event) => openChatMenu(onMenu, entry.chat, event)}
        />
      );
    }
    return (
      <div key={entry.groupId} role="group" aria-label="Split panes" className="mx-1 my-0.5 overflow-hidden rounded-md border border-line/35">
        {entry.rows.map((row, index) => (
          <ProjectChatRow
            key={row.chat.id}
            chat={row.chat}
            depth={row.depth}
            divided={index > 0 && row.depth === 0}
            marked={picked.includes(row.chat.id)}
            onChoose={onChoose}
            onClose={() => onClose(row.chat.id)}
            onMenu={(event) => openChatMenu(onMenu, row.chat, event)}
          />
        ))}
      </div>
    );
  });
}

function openChatMenu(
  onMenu: (menu: TabMenu) => void,
  chat: ProjectTabChat,
  event: ReactMouseEvent<HTMLElement>,
) {
  if (chat.split) {
    onMenu({ kind: "split", groupId: chat.split.groupId, pane: chat.split.pane, x: event.clientX, y: event.clientY });
    return;
  }
  onMenu({ kind: "chat", id: chat.id, x: event.clientX, y: event.clientY });
}

function ProjectChatRow({
  chat,
  depth = 0,
  divided = false,
  marked,
  onChoose,
  onClose,
  onMenu,
}: {
  chat: ProjectTabChat;
  /** 0 for a normal chat. Subagents sit one step in for each parent. */
  depth?: number;
  /** A rule above this pane, separating it from the other side of the split. */
  divided?: boolean;
  marked: boolean;
  onChoose: (id: string, event: ReactMouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <div
      role="menuitem"
      data-project-chat=""
      title={chat.title}
      aria-current={chat.selected ? "true" : undefined}
      style={depth > 0 ? { paddingLeft: 10 + depth * 14 } : undefined}
      onClick={(event) => onChoose(chat.id, event)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event);
      }}
      onMouseDown={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className={`group/row relative flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
        divided ? "border-t border-line/30 " : ""
      }${chat.selected || marked ? "bg-wash text-ink" : "text-ink/80 hover:bg-wash hover:text-ink"}`}
    >
      {chat.running ? (
        <span
          className="size-3.5 shrink-0 animate-spin rounded-full border border-current/40 border-t-transparent"
          aria-label="Running"
        />
      ) : (
        <Symbol name={chat.split ? "rectangle.split.2x1" : "bubble.dots"} className="size-3.5 shrink-0 text-muted" />
      )}
      <span className="min-w-0 flex-1 truncate pr-4">{chat.title}</span>
      {chat.selected ? (
        <Symbol
          name="checkmark.thick"
          className="pointer-events-none absolute right-2 size-3 text-muted group-hover/row:opacity-0"
        />
      ) : null}
      <button
        type="button"
        aria-label={`Close ${chat.title}`}
        title={`Close ${chat.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="pointer-events-none absolute right-1.5 flex size-4 items-center justify-center rounded text-[13px] leading-none text-muted opacity-0 hover:bg-inset hover:text-ink group-hover/row:pointer-events-auto group-hover/row:opacity-80"
      >
        <span aria-hidden>×</span>
      </button>
    </div>
  );
}

function ProjectChatMenu({
  open,
  anchor,
  label,
  onEnter,
  onLeave,
  children,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  label: string;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const reduce = useRef(false);

  useLayoutEffect(() => {
    reduce.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const node = anchor;
      const menu = panel.current;
      if (!node || !menu) return;
      const frame = node.getBoundingClientRect();
      const width = menu.getBoundingClientRect().width;
      const left = Math.min(Math.max(8, frame.left), Math.max(8, window.innerWidth - width - 8));
      const top = frame.bottom + 5;
      setBox((current) => (current && current.left === left && current.top === top ? current : { left, top }));
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, children]);

  useLayoutEffect(() => {
    if (!open || !box) return;
    const list = panel.current?.querySelector("[data-project-list]");
    const row = list?.querySelector<HTMLElement>("[aria-current='true']");
    if (!(list instanceof HTMLElement) || !row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top;
    else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
  }, [open, box, children]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={panel}
          role="menu"
          aria-label={label}
          data-tauri-drag-region="false"
          initial={GLASS_HIDE}
          animate={GLASS_SHOW}
          exit={GLASS_LEAVE}
          transition={{ duration: reduce.current ? 0 : 0.16, ease: MENU_EASE }}
          style={{ left: box?.left ?? -9999, top: box?.top ?? 0, visibility: box ? "visible" : "hidden" }}
          className="cloud-card fixed z-50 min-w-[14rem] max-w-[18rem] rounded-xl bg-canvas/60"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          onContextMenu={(event) => event.preventDefault()}
        >
          {/* Covers the gap to the tab. Kept outside overflow clip so the pointer can travel. */}
          <div className="absolute inset-x-0 -top-1.5 h-1.5" aria-hidden />
          <div data-project-list="" className="max-h-72 overflow-y-auto overscroll-contain rounded-[inherit]">
            {children}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function splitPaneChatId(items: TabItem[], groupId: string, pane: 0 | 1): string {
  for (const item of items) {
    if (item.kind === "split" && item.group.id === groupId) return item.group.chatIds[pane];
  }
  return "";
}

function ChatTabMenu({
  menu,
  canSplit,
  copyId,
  onSplit,
  onUnsplit,
  onCloseTab,
  onCloseMenu,
}: {
  menu: TabMenu;
  canSplit: boolean;
  copyId: string;
  onSplit: () => void;
  onUnsplit: () => void;
  onCloseTab: () => void;
  onCloseMenu: () => void;
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
      {copyId ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            void navigator.clipboard.writeText(copyId).catch(() => undefined);
            onCloseMenu();
          }}
          className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
        >
          Copy ID
        </button>
      ) : null}
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
