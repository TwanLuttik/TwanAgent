import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnchoredMenu } from "../../components/ContextMenu";
import { Symbol } from "../../components/Symbol";
import { headerBarClass, isWindows, WindowButtons } from "../../components/WindowButtons";
import { isSameProject, nestGroupedProjects, type SidebarChatOrder } from "../../lib/all-projects";
import { projectKey } from "../../lib/core";
import { fileRefreshRevision, subscribeFileRefresh } from "../../lib/file-structure";
import { ProjectMark } from "../../components/ProjectMark";
import type { ProjectGit } from "../../lib/project-git";
import { useProjectGroups } from "../../lib/project-groups";
import type { GitWorktree } from "../../lib/tauri.ts";
import type { TodoBadge } from "../../lib/todo";
import { SIDEBAR_DEFAULT, loadSidebarChatOrder, loadSidebarFocus, saveSidebarChatOrder, saveSidebarFocus, saveSidebarWidth } from "../../lib/prefs";
import type { ConversationSummary } from "../../lib/tauri";
import { SETTINGS_TABS } from "../SettingsView";
import { ProjectFocusButton } from "./ProjectFocusButton";
import { useMain, useSidebar } from "./context";
import { ProjectsNav } from "./ProjectsNav";

export function AppSidebar() {
  const {
    closeServers,
    closeSettings,
    onSidebarResizeStart,
    openFolder,
    openServers,
    showServers,
    setSidebarWidth,
    settingsTab,
    setSettingsTab,
    openSettings,
    openUsage,
    openDocs,
    sidebarDragging,
    sidebarWidth,
    sidebarCollapsed,
    setSidebarCollapsed,
    usageTick,
  } = useMain();
  const { showSettings } = useSidebar();
  const [usageHover, setUsageHover] = useState(false);
  const [chatOrder, setChatOrder] = useState<SidebarChatOrder>(loadSidebarChatOrder);
  const chooseChatOrder = useCallback((next: SidebarChatOrder) => {
    setChatOrder(next);
    saveSidebarChatOrder(next);
  }, []);
  const [focusPath, setFocusPath] = useState(loadSidebarFocus);
  const chooseFocus = useCallback((path: string) => {
    setFocusPath(path);
    saveSidebarFocus(path);
  }, []);
  const [archiveOpen, setArchiveOpen] = useState<Record<string, boolean>>({});
  const [gitByProject, setGitByProject] = useState<Record<string, ProjectGit>>({});
  const [worktreesByRepo, setWorktreesByRepo] = useState<Record<string, GitWorktree[]>>({});
  const [worktreeChats, setWorktreeChats] = useState<Record<string, ConversationSummary[]>>({});
  const [todoByChat, setTodoByChat] = useState<Record<string, TodoBadge>>({});

  return (
    <aside
      className={`relative flex shrink-0 flex-col overflow-hidden bg-transparent ${sidebarCollapsed ? "z-10" : "z-0"} ${sidebarDragging ? "" : "transition-[width] duration-200 ease-out"}`}
      style={{ width: sidebarCollapsed ? 44 : sidebarWidth }}
    >
      {sidebarCollapsed ? <CollapsedRail /> : null}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize"
        hidden={sidebarCollapsed}
        onPointerDown={onSidebarResizeStart}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT);
          saveSidebarWidth(SIDEBAR_DEFAULT);
        }}
        className="group absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize touch-none"
      >
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 right-0 w-0.5 ${
            sidebarDragging ? "bg-accent/40" : "group-hover:bg-accent/30"
          }`}
        />
      </div>
      <div className={sidebarCollapsed ? "hidden" : "contents"}>
      <div className={`relative z-30 flex shrink-0 items-center ${headerBarClass()}`} data-tauri-drag-region>
        {isWindows() ? null : <WindowButtons />}
        <SidebarOrderButton order={chatOrder} onChange={chooseChatOrder} />
        <div className="min-w-0 flex-1" data-tauri-drag-region />
        {!showSettings ? (
          <ProjectFocusButton focusPath={focusPath} onFocus={chooseFocus} hidden={sidebarCollapsed} />
        ) : null}
        <PanelToggle
          label="Hide sidebar"
          icon="sidebar.left"
          pressed
          onClick={() => setSidebarCollapsed(true)}
        />
        {!showSettings ? (
          <>
            <button
              type="button"
              aria-label="Servers"
              aria-pressed={showServers}
              title="Servers"
              onClick={showServers ? closeServers : openServers}
              className={`flex size-7 items-center justify-center rounded-[6px] hover:bg-wash ${
                showServers ? "bg-wash-strong text-ink" : "text-ink"
              }`}
            >
              <Symbol name="server.rack" className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Open project"
              title="Open project"
              onClick={openFolder}
              className="mr-2 flex size-7 items-center justify-center rounded-[6px] text-ink hover:bg-wash"
            >
              <Symbol name="plus" className="size-3.5" />
            </button>
          </>
        ) : null}
      </div>
      {showSettings ? <SettingsNav tab={settingsTab} onTab={setSettingsTab} onBack={closeSettings} /> : null}
      {/* Stay mounted while settings covers it. Unmounting restarts the account
          usage poll and rebuilds the project list, which is the pause on Escape. */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col" style={showSettings ? { display: "none" } : undefined}>
        <ProjectsNav
          usageHover={usageHover}
          setUsageHover={setUsageHover}
          archiveOpen={archiveOpen}
          setArchiveOpen={setArchiveOpen}
          gitByProject={gitByProject}
          setGitByProject={setGitByProject}
          worktreesByRepo={worktreesByRepo}
          setWorktreesByRepo={setWorktreesByRepo}
          worktreeChats={worktreeChats}
          setWorktreeChats={setWorktreeChats}
          todoByChat={todoByChat}
          setTodoByChat={setTodoByChat}
          openSettings={openSettings}
          openUsage={openUsage}
          openDocs={openDocs}
          usageTick={usageTick}
          focusPath={focusPath}
          chatOrder={chatOrder}
        />
      </div>
      </div>
    </aside>
  );
}

function CollapsedRail() {
  const { allProjectGroups, openProjectFromSidebar, workspace } = useSidebar();
  const projectGroups = useProjectGroups();
  const railGroups = nestGroupedProjects(allProjectGroups, projectGroups).top;
  const logoRefresh = useSyncExternalStore(subscribeFileRefresh, fileRefreshRevision, fileRefreshRevision);
  const [tip, setTip] = useState<{ name: string; top: number; left: number } | null>(null);
  return (
    <div className="absolute inset-0 z-30 flex flex-col">
      <div className="h-11 shrink-0" />
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-auto px-1 pb-2">
        {railGroups.map((group) => {
          const current = isSameProject(group.path, workspace);
          return (
            <button
              key={projectKey(group.path)}
              type="button"
              aria-label={group.name}
              aria-current={current ? "true" : undefined}
              onClick={() => openProjectFromSidebar(group.path)}
              onMouseEnter={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setTip({ name: group.name, top: box.top + box.height / 2, left: box.right + 10 });
              }}
              onMouseLeave={() => setTip((current) => (current?.name === group.name ? null : current))}
              className={`flex size-8 items-center justify-center rounded-[8px] ${
                current ? "bg-wash-strong text-accent" : "text-muted hover:bg-wash hover:text-ink"
              }`}
            >
              <ProjectMark
                path={group.path}
                remote={Boolean(group.remote)}
                refresh={logoRefresh}
                active={current}
                className="size-4"
              />
            </button>
          );
        })}
      </div>
      {tip
        ? createPortal(
            <span
              role="tooltip"
              className="rail-tip pointer-events-none fixed z-50 -translate-y-1/2 rounded-md border border-line/25 bg-canvas px-2 py-1 text-[12px] whitespace-nowrap text-ink shadow-card"
              style={{ top: tip.top, left: tip.left }}
            >
              {tip.name}
            </span>,
            document.body,
          )
        : null}
    </div>
  );
}

function SidebarOrderButton({
  order,
  onChange,
}: {
  order: SidebarChatOrder;
  onChange: (next: SidebarChatOrder) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (buttonRef.current?.contains(ev.target as Node)) return;
      setOpen(false);
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
  }, [open]);
  const finished = order === "finished";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Chat order"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Chat order"
        onClick={() => {
          const box = buttonRef.current?.getBoundingClientRect();
          if (box) setPos({ x: box.left, y: box.bottom + 4 });
          setOpen((value) => !value);
        }}
        className={`flex size-7 items-center justify-center rounded-[6px] hover:bg-wash ${
          finished ? "text-accent" : "text-ink"
        }`}
      >
        <Symbol name="ellipsis" className="size-3.5" />
      </button>
      {open && pos ? (
        <AnchoredMenu x={pos.x} y={pos.y} label="Chat order">
          {(
            [
              ["manual", "Manual order"],
              ["finished", "Newest finished"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={order === value}
              onClick={() => {
                onChange(value);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-4 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
            >
              <span>{label}</span>
              {order === value ? <Symbol name="checkmark" className="size-3.5 text-accent" /> : null}
            </button>
          ))}
        </AnchoredMenu>
      ) : null}
    </>
  );
}

function PanelToggle({
  label,
  icon,
  pressed = false,
  onClick,
}: {
  label: string;
  icon: "sidebar.left" | "sidebar.right";
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-[6px] hover:bg-wash ${
        pressed ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      <Symbol name={icon} className="size-3.5" />
    </button>
  );
}

function SettingsNav({
  tab,
  onTab,
  onBack,
}: {
  tab: string;
  onTab: (id: (typeof SETTINGS_TABS)[number]["id"]) => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="relative z-20 flex items-center gap-1 px-2 pt-1.5 pb-1">
        <button
          type="button"
          onClick={onBack}
          className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
          aria-label="Back to projects"
          title="Back"
        >
          <Symbol name="chevron.left" className="size-3.5" />
        </button>
        <span className="min-w-0 truncate text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
          Settings
        </span>
      </div>
      <nav className="relative z-10 flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2 pb-3" aria-label="Settings">
        {SETTINGS_TABS.map((opt) => {
          const on = tab === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => onTab(opt.id)}
              className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left ${
                on ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
              }`}
            >
              <Symbol name={opt.icon} className={`size-4 shrink-0 ${on ? "text-ink" : "text-muted"}`} />
              <span className="min-w-0">
                <span className="block truncate text-[13px]">{opt.label}</span>
                <span className="block truncate text-[11px] text-muted">{opt.hint}</span>
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
