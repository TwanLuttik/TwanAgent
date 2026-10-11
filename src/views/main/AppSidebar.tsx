import { useEffect, useMemo, useRef, useState } from "react";
import { AllProjectsList } from "../../components/AllProjectsList";
import { ConversationList } from "../../components/ConversationList";
import { SpaceCorner } from "../../components/SpaceCorner";
import { Symbol } from "../../components/Symbol";
import { AccountUsageRow } from "../../components/AccountUsageRow";
import { UsageTeaser } from "../../components/UsageTeaser";
import { headerBarClass, isMacOS, WindowButtons } from "../../components/WindowButtons";
import { visibleConversations, visibleJourneys } from "../../lib/all-projects";
import { conversationActivityLabel, projectKey, type ChatMessage } from "../../lib/core";
import { projectGitKey, projectGitLabel, type ProjectGit } from "../../lib/project-git";
import { todoBadge, todosInLatestTurn, type TodoBadge } from "../../lib/todo";
import * as api from "../../lib/tauri";
import type { JourneyColor, JourneySummary } from "../../lib/journey";
import { SIDEBAR_DEFAULT, saveSidebarWidth } from "../../lib/prefs";
import type { ConversationSummary } from "../../lib/tauri";
import { SETTINGS_TABS } from "../SettingsView";
import { NewChatMenu } from "./AppChrome";
import { useMain, useSidebar } from "./context";

export function AppSidebar() {
  const {
    closeSettings,
    onSidebarResizeStart,
    openFolder,
    setSidebarWidth,
    settingsTab,
    setSettingsTab,
    openSettings,
    openUsage,
    sidebarDragging,
    sidebarWidth,
    usageTick,
  } = useMain();
  const { showSettings } = useSidebar();
  const [usageHover, setUsageHover] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState<Record<string, boolean>>({});
  const [gitByProject, setGitByProject] = useState<Record<string, ProjectGit>>({});
  const [todoByChat, setTodoByChat] = useState<Record<string, TodoBadge>>({});

  return (
    <aside className="relative flex shrink-0 flex-col bg-sidebar" style={{ width: sidebarWidth }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize"
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
      {!showSettings ? <SpaceCorner /> : null}
      <div className={`relative z-10 flex shrink-0 items-center ${headerBarClass()}`} data-tauri-drag-region>
        <WindowButtons />
        <div className="min-w-0 flex-1" data-tauri-drag-region />
        {!showSettings ? (
          <button
            type="button"
            aria-label="Open project"
            title="Open project"
            onClick={openFolder}
            className="mr-2 flex size-7 items-center justify-center rounded-[6px] text-ink hover:bg-wash"
          >
            <Symbol name="plus" className="size-3.5" />
          </button>
        ) : null}
      </div>
      {showSettings ? (
        <SettingsNav tab={settingsTab} onTab={setSettingsTab} onBack={closeSettings} />
      ) : (
        <ProjectsNav
          usageHover={usageHover}
          setUsageHover={setUsageHover}
          archiveOpen={archiveOpen}
          setArchiveOpen={setArchiveOpen}
          gitByProject={gitByProject}
          setGitByProject={setGitByProject}
          todoByChat={todoByChat}
          setTodoByChat={setTodoByChat}
          openSettings={openSettings}
          openUsage={openUsage}
          usageTick={usageTick}
        />
      )}
    </aside>
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
        <div className="mt-auto px-2 pt-4">
          <div className="text-[12px] font-medium text-ink">TwanAgent {__APP_VERSION_LABEL__}</div>
          <div className="text-[11px] text-muted">Desktop workspace</div>
        </div>
      </nav>
    </>
  );
}

function ProjectsNav({
  usageHover,
  setUsageHover,
  archiveOpen,
  setArchiveOpen,
  gitByProject,
  setGitByProject,
  todoByChat,
  setTodoByChat,
  openSettings,
  openUsage,
  usageTick,
}: {
  usageHover: boolean;
  setUsageHover: (hover: boolean) => void;
  archiveOpen: Record<string, boolean>;
  setArchiveOpen: (next: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void;
  gitByProject: Record<string, ProjectGit>;
  setGitByProject: (next: Record<string, ProjectGit> | ((prev: Record<string, ProjectGit>) => Record<string, ProjectGit>)) => void;
  todoByChat: Record<string, TodoBadge>;
  setTodoByChat: (next: Record<string, TodoBadge> | ((prev: Record<string, TodoBadge>) => Record<string, TodoBadge>)) => void;
  openSettings: () => void;
  openUsage: () => void;
  usageTick: number;
}) {
  const {
    activeId,
    allProjectGroups,
    collapsedProjects,
    deleteProjectFromSidebar,
    legacyProjectsRoot,
    messages,
    openProjectFromSidebar,
    openProjectSettings,
    projectSettings,
    projectsRoot,
    showSettings,
    runningTurns,
    showUsage,
    reorderProjects,
    startNewChat,
    toggleProjectCollapsed,
    workspace,
  } = useSidebar();
  const fullPage = Boolean(showSettings || showUsage || projectSettings);
  const gitPaths = allProjectGroups.map((group: { path: string }) => group.path).join("\n");
  useEffect(() => {
    const paths = gitPaths.split("\n").filter(Boolean);
    if (!paths.length) {
      setGitByProject({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const found: Record<string, ProjectGit> = {};
      await Promise.all(
        paths.map(async (path: string) => {
          try {
            await api.openFolder(path);
            const label = projectGitLabel(await api.gitBranches(path));
            if (label) found[projectGitKey(path)] = label;
          } catch {
            /* a missing folder or closed workspace just stays unlabeled */
          }
        }),
      );
      if (!cancelled) setGitByProject(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [gitPaths, setGitByProject]);

  const todoWatch = allProjectGroups
    .flatMap((group: { path: string; conversations: ConversationSummary[] }) =>
      group.conversations.map((row) => `${group.path}\t${row.id}\t${row.updated_at}`),
    )
    .join("\n");
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const openTodoKey = `${workspace}\t${activeId}\t${todoSignature(messages as ChatMessage[])}`;
  const openTodo = useRef({ workspace, activeId });
  openTodo.current = { workspace, activeId };
  const runningRef = useRef(runningTurns);
  runningRef.current = runningTurns;
  const todoRowsRef = useRef<{ path: string; id: string; updated: string }[]>([]);
  useEffect(() => {
    const rows = todoWatch
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const [path, id, updated] = line.split("\t");
        return { path, id, updated };
      })
      .filter((row: { path: string; id: string }) => row.path && row.id);
    const previous = new Map(todoRowsRef.current.map((row) => [`${row.path}\t${row.id}`, row.updated]));
    todoRowsRef.current = rows;
    if (!rows.length) {
      setTodoByChat({});
      return;
    }
    const { workspace: openWorkspace, activeId: openId } = openTodo.current;
    const openKey = openWorkspace && openId ? `${projectKey(openWorkspace)}\t${openId}` : "";
    let cancelled = false;
    void (async () => {
      const found: Record<string, TodoBadge> = {};
      await Promise.all(
        rows.map(async (row: { path: string; id: string; updated: string }) => {
          const key = `${row.path}\t${row.id}`;
          const isOpen = openKey === `${projectKey(row.path)}\t${row.id}`;
          if (isOpen) {
            const badge = todoBadge(todosInLatestTurn(messagesRef.current as ChatMessage[]));
            if (badge) found[row.id] = badge;
            return;
          }
          if (row.id in runningRef.current) return;
          if (previous.get(key) === row.updated) return;
          try {
            const full = await api.getConversation(row.path, row.id);
            const badge = todoBadge(todosInLatestTurn((full.messages as ChatMessage[]) ?? []));
            if (badge) found[row.id] = badge;
          } catch {
            /* a chat that cannot be read just has no todo chip */
          }
        }),
      );
      if (cancelled) return;
      setTodoByChat((prev) => {
        const next: Record<string, TodoBadge> = {};
        for (const row of rows) {
          const key = `${row.path}\t${row.id}`;
          const isOpen = openKey === `${projectKey(row.path)}\t${row.id}`;
          if (row.id in found) next[row.id] = found[row.id];
          else if (prev[row.id] && !isOpen && previous.get(key) === row.updated && !(row.id in runningRef.current)) {
            next[row.id] = prev[row.id];
          }
        }
        const prevIds = Object.keys(prev);
        const nextIds = Object.keys(next);
        if (prevIds.length === nextIds.length && nextIds.every((id) => prev[id] === next[id])) return prev;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [todoWatch, openTodoKey, setTodoByChat]);

  function toggleArchive(path: string) {
    const key = projectKey(path);
    setArchiveOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <>
      <div className="relative z-20 flex items-center justify-between gap-2 px-4 pt-1.5 pb-1">
        <span className="min-w-0 truncate text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
          All
        </span>
        <NewChatMenu disabled={!workspace} onPick={(kind) => void startNewChat(kind)} />
      </div>
      <div className="no-scrollbar relative z-10 min-h-0 flex-1 overflow-auto px-2 pb-2">
        <AllProjectsList
          groups={allProjectGroups}
          activeWorkspace={workspace}
          projectsRoot={projectsRoot}
          legacyProjectsRoot={legacyProjectsRoot}
          collapsed={collapsedProjects}
          onToggleCollapsed={toggleProjectCollapsed}
          onOpenProject={openProjectFromSidebar}
          onNewChat={(path) => void startNewChat("chat", undefined, path)}
          onOpenSettings={openProjectSettings}
          onDeleteProject={(path) => void deleteProjectFromSidebar(path)}
          onReorderProject={(fromPath, toPath) => void reorderProjects(fromPath, toPath)}
          archiveOpen={archiveOpen}
          onToggleArchive={toggleArchive}
          gitByProject={gitByProject}
          renderList={(group, { showArchived }) => (
            <ProjectConversations
              conversations={visibleConversations(group.conversations, showArchived)}
              journeys={visibleJourneys(group.journeys, group.conversations, showArchived)}
              path={group.path}
              dimmed={fullPage}
              archivedView={showArchived}
              todoByChat={todoByChat}
            />
          )}
        />
      </div>
      <div className="relative z-10 flex flex-col gap-1 px-2.5 pb-3">
        <p className="px-2 pb-0.5 text-[11px] tabular-nums text-muted/55" title={`TwanAgent ${__APP_VERSION_LABEL__}`}>
          {__APP_VERSION_LABEL__}
        </p>
        <button
          type="button"
          onClick={openUsage}
          onMouseEnter={() => setUsageHover(true)}
          onMouseLeave={() => setUsageHover(false)}
          className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] ${
            showUsage ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
          }`}
        >
          <Symbol name="chart.xyaxis.line" className="size-4 shrink-0 text-muted" />
          <span>Usage</span>
          <UsageTeaser refresh={usageTick} hover={usageHover} />
        </button>
        <AccountUsageRow refresh={usageTick} />
        <button
          type="button"
          title={isMacOS() ? "Settings ⌘," : "Settings Ctrl+,"}
          onClick={openSettings}
          className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] ${
            showSettings ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
          }`}
        >
          <Symbol name="gearshape" className="size-4 text-muted" />
          <span>Settings</span>
        </button>
      </div>
    </>
  );
}

function todoSignature(messages: ChatMessage[]): string {
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

function ProjectConversations({
  conversations,
  journeys,
  path,
  dimmed,
  archivedView,
  todoByChat,
}: {
  conversations: ConversationSummary[];
  journeys: JourneySummary[];
  path?: string;
  dimmed: boolean;
  archivedView?: boolean;
  todoByChat: Record<string, TodoBadge>;
}) {
  const {
    activeId,
    archiveChat,
    createJourneyFromChat,
    deleteJourney,
    moveConversation,
    openChat,
    openJourneyKnowledge,
    openSidebarChat,
    openingId,
    removeChat,
    renameJourney,
    reorderChats,
    reorderSidebar,
    runningTurns,
    unseenFinished,
    setJourneyColor,
    startNewChat,
    toggleJourney,
  } = useSidebar();
  const actions = useRef({
    archiveChat,
    createJourneyFromChat,
    deleteJourney,
    moveConversation,
    openChat,
    openJourneyKnowledge,
    openSidebarChat,
    removeChat,
    renameJourney,
    reorderChats,
    reorderSidebar,
    setJourneyColor,
    startNewChat,
    toggleJourney,
  });
  actions.current = {
    archiveChat,
    createJourneyFromChat,
    deleteJourney,
    moveConversation,
    openChat,
    openJourneyKnowledge,
    openSidebarChat,
    removeChat,
    renameJourney,
    reorderChats,
    reorderSidebar,
    setJourneyColor,
    startNewChat,
    toggleJourney,
  };
  const handlers = useMemo(
    () => ({
      onOpen: (id: string) => (path ? void actions.current.openSidebarChat(path, id) : void actions.current.openChat(id)),
      onDelete: (id: string) => void actions.current.removeChat(id, path),
      onArchive: (id: string, archived: boolean) => void actions.current.archiveChat(id, archived, path),
      onReorder: (fromId: string, toId: string) => void actions.current.reorderChats(fromId, toId, path),
      onReorderSidebar: (
        fromId: string,
        fromKind: "journey" | "conversation",
        toId: string,
        toKind: "journey" | "conversation",
      ) => void actions.current.reorderSidebar(fromId, fromKind, toId, toKind, path),
      onCreateJourney: (id: string) => void actions.current.createJourneyFromChat(id, path),
      onOpenKnowledge: (id: string) => void actions.current.openJourneyKnowledge(id, path),
      onNewChat: (journeyId: string, kind: "chat" | "terminal") =>
        void actions.current.startNewChat(kind, journeyId, path),
      onToggleCollapse: (id: string) => void actions.current.toggleJourney(id, path),
      onRenameJourney: (id: string, title: string) => void actions.current.renameJourney(id, title, path),
      onDeleteJourney: (id: string, deleteChats: boolean) => void actions.current.deleteJourney(id, deleteChats, path),
      onRemoveFromJourney: (id: string) => void actions.current.moveConversation(id, null, path),
      onMoveToJourney: (id: string, journeyId: string) => void actions.current.moveConversation(id, journeyId, path),
      onSetColor: (id: string, color: JourneyColor) => void actions.current.setJourneyColor(id, color, path),
    }),
    [path],
  );
  const runningPreview = useMemo(
    () => (id: string) => conversationActivityLabel(runningTurns[id]?.activity),
    [runningTurns],
  );
  const todoFor = useMemo(
    () => (id: string) => {
      const live = runningTurns[id]?.todo;
      if (live) return { done: live.done, total: live.total, finished: false };
      if (id in runningTurns) return null;
      return todoByChat[id] ?? null;
    },
    [runningTurns, todoByChat],
  );

  return (
    <ConversationList
      conversations={conversations}
      journeys={journeys}
      activeId={activeId}
      runningIds={runningTurns}
      unseenIds={unseenFinished}
      loadingId={openingId}
      runningPreview={runningPreview}
      todoFor={todoFor}
      showSettings={dimmed}
      archivedView={archivedView}
      {...handlers}
    />
  );
}
