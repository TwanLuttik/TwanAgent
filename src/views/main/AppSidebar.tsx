import { useEffect, useState } from "react";
import { AllProjectsList } from "../../components/AllProjectsList";
import { ConversationList } from "../../components/ConversationList";
import { SpaceCorner } from "../../components/SpaceCorner";
import { Symbol } from "../../components/Symbol";
import { UsageTeaser } from "../../components/UsageTeaser";
import { headerBarClass, isMacOS, WindowButtons } from "../../components/WindowButtons";
import { projectHasArchived, visibleConversations, visibleJourneys } from "../../lib/all-projects";
import { conversationActivityLabel, folderName, projectKey, type ChatMessage } from "../../lib/core";
import { projectGitKey, projectGitLabel, type ProjectGit } from "../../lib/project-git";
import { todoBadge, todosInLatestTurn, type TodoBadge } from "../../lib/todo";
import * as api from "../../lib/tauri";
import type { JourneySummary } from "../../lib/journey";
import { SIDEBAR_DEFAULT, saveSidebarWidth } from "../../lib/prefs";
import type { ConversationSummary } from "../../lib/tauri";
import { SETTINGS_TABS } from "../SettingsView";
import { NewChatMenu } from "./AppChrome";
import { useMain } from "./context";

export function AppSidebar() {
  const {
    closeSettings,
    onSidebarResizeStart,
    openFolder,
    setSidebarWidth,
    settingsTab,
    setSettingsTab,
    showSettings,
    sidebarDragging,
    sidebarWidth,
  } = useMain();
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
}: {
  usageHover: boolean;
  setUsageHover: (hover: boolean) => void;
  archiveOpen: Record<string, boolean>;
  setArchiveOpen: (next: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void;
  gitByProject: Record<string, ProjectGit>;
  setGitByProject: (next: Record<string, ProjectGit> | ((prev: Record<string, ProjectGit>) => Record<string, ProjectGit>)) => void;
  todoByChat: Record<string, TodoBadge>;
  setTodoByChat: (next: Record<string, TodoBadge> | ((prev: Record<string, TodoBadge>) => Record<string, TodoBadge>)) => void;
}) {
  const {
    activeId,
    allProjectGroups,
    collapsedProjects,
    conversations,
    deleteProjectFromSidebar,
    legacyProjectsRoot,
    messages,
    openFolder,
    openProjectFromSidebar,
    openProjectSettings,
    openSettings,
    openUsage,
    projectSettings,
    projectsRoot,
    setProjectMenu,
    showSettings,
    runningTurns,
    showUsage,
    startNewChat,
    toggleProjectCollapsed,
    usageTick,
    workspace,
  } = useMain();
  const fullPage = Boolean(showSettings || showUsage || projectSettings);
  const currentArchiveOpen = Boolean(workspace && archiveOpen[projectKey(workspace)]);
  const currentHasArchived = projectHasArchived(conversations);
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
  const openTodoKey = `${workspace}\t${activeId}\t${messages.length}`;
  useEffect(() => {
    const rows = todoWatch
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const [path, id, updated] = line.split("\t");
        return { path, id, updated };
      })
      .filter((row: { path: string; id: string }) => row.path && row.id);
    if (!rows.length) {
      setTodoByChat({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const found: Record<string, TodoBadge> = {};
      await Promise.all(
        rows.map(async (row: { path: string; id: string }) => {
          if (workspace && projectKey(row.path) === projectKey(workspace) && row.id === activeId) {
            const badge = todoBadge(todosInLatestTurn(messages as ChatMessage[]));
            if (badge) found[row.id] = badge;
            return;
          }
          if (row.id in runningTurns) return;
          try {
            const full = await api.getConversation(row.path, row.id);
            const badge = todoBadge(todosInLatestTurn((full.messages as ChatMessage[]) ?? []));
            if (badge) found[row.id] = badge;
          } catch {
            /* a chat that cannot be read just has no todo chip */
          }
        }),
      );
      if (!cancelled) setTodoByChat(found);
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
          onClick={openFolder}
          onContextMenu={(ev) => {
            if (!workspace) return;
            ev.preventDefault();
            ev.stopPropagation();
            setProjectMenu({
              x: ev.clientX,
              y: ev.clientY,
              path: workspace,
              name: allProjectGroups.find((group: { path: string; name: string }) => projectKey(group.path) === projectKey(workspace))?.name || folderName(workspace),
            });
          }}
          className="flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] text-ink/90 hover:bg-wash"
          title={workspace || "Open folder"}
        >
          <Symbol name="folder.fill" className="size-4 text-accent" />
          <span className="min-w-0 flex-1 truncate">
            {workspace
              ? allProjectGroups.find((group: { path: string; name: string }) => projectKey(group.path) === projectKey(workspace))?.name || folderName(workspace)
              : "Open folder"}
          </span>
          {currentHasArchived ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={currentArchiveOpen ? "Hide archived chats" : "Show archived chats"}
              aria-pressed={currentArchiveOpen}
              title={currentArchiveOpen ? "Hide archive" : "Archived chats"}
              onClick={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (workspace) toggleArchive(workspace);
              }}
              onKeyDown={(ev) => {
                if (ev.key !== "Enter" && ev.key !== " ") return;
                ev.preventDefault();
                ev.stopPropagation();
                if (workspace) toggleArchive(workspace);
              }}
              className={`flex size-6 shrink-0 items-center justify-center rounded ${
                currentArchiveOpen
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-wash-strong hover:text-ink"
              }`}
            >
              <Symbol name="archivebox" className="size-3.5" />
            </span>
          ) : null}
        </button>
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
    createJourneyFromChat,
    deleteJourney,
    moveConversation,
    openChat,
    openJourneyKnowledge,
    openSidebarChat,
    openingId,
    archiveChat,
    removeChat,
    renameJourney,
    reorderChats,
    reorderSidebar,
    runningTurns,
    unseenFinished,
    setJourneyColor,
    startNewChat,
    toggleJourney,
  } = useMain();

  return (
    <ConversationList
      conversations={conversations}
      journeys={journeys}
      activeId={activeId}
      runningIds={runningTurns}
      unseenIds={unseenFinished}
      loadingId={openingId}
      runningPreview={(id) => conversationActivityLabel(runningTurns[id]?.activity)}
      todoFor={(id) => {
        const live = runningTurns[id]?.todo;
        if (live) return { done: live.done, total: live.total, finished: false };
        if (id in runningTurns) return null;
        return todoByChat[id] ?? null;
      }}
      showSettings={dimmed}
      onOpen={(id) => (path ? void openSidebarChat(path, id) : void openChat(id))}
      onDelete={(id) => void removeChat(id, path)}
      onArchive={(id, archived) => void archiveChat(id, archived, path)}
      archivedView={archivedView}
      onReorder={(fromId, toId) => void reorderChats(fromId, toId, path)}
      onReorderSidebar={(fromId, fromKind, toId, toKind) =>
        void reorderSidebar(fromId, fromKind, toId, toKind, path)
      }
      onCreateJourney={(id) => void createJourneyFromChat(id, path)}
      onOpenKnowledge={(id) => void openJourneyKnowledge(id, path)}
      onNewChat={(journeyId, kind) => void startNewChat(kind, journeyId, path)}
      onToggleCollapse={(id) => void toggleJourney(id, path)}
      onRenameJourney={(id, title) => void renameJourney(id, title, path)}
      onDeleteJourney={(id, deleteChats) => void deleteJourney(id, deleteChats, path)}
      onRemoveFromJourney={(id) => void moveConversation(id, null, path)}
      onMoveToJourney={(id, journeyId) => void moveConversation(id, journeyId, path)}
      onSetColor={(id, color) => void setJourneyColor(id, color, path)}
    />
  );
}
