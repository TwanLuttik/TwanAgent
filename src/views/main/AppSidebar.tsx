import { useState } from "react";
import { AllProjectsList } from "../../components/AllProjectsList";
import { ConversationList } from "../../components/ConversationList";
import { SpaceCorner } from "../../components/SpaceCorner";
import { Symbol } from "../../components/Symbol";
import { UsageTeaser } from "../../components/UsageTeaser";
import { headerBarClass, isMacOS, WindowButtons } from "../../components/WindowButtons";
import { projectHasArchived, visibleConversations, visibleJourneys } from "../../lib/all-projects";
import { conversationActivityLabel, folderName, projectKey } from "../../lib/core";
import type { JourneySummary } from "../../lib/journey";
import { SIDEBAR_DEFAULT, saveSidebarWidth } from "../../lib/prefs";
import type { ConversationSummary } from "../../lib/tauri";
import { NewChatMenu } from "./AppChrome";
import { useMain } from "./context";

export function AppSidebar() {
  const {
    allProjectGroups,
    collapsedProjects,
    conversations,
    deleteProjectFromSidebar,
    legacyProjectsRoot,
    onSidebarResizeStart,
    openFolder,
    openProjectFromSidebar,
    openProjectSettings,
    openSettings,
    openUsage,
    projectsRoot,
    setProjectMenu,
    setSidebarWidth,
    showSettings,
    showUsage,
    sidebarDragging,
    sidebarWidth,
    projectSettings,
    startNewChat,
    toggleProjectCollapsed,
    usageTick,
    workspace,
  } = useMain();
  const [usageHover, setUsageHover] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState<Record<string, boolean>>({});
  const fullPage = Boolean(showSettings || showUsage || projectSettings);
  const currentArchiveOpen = Boolean(workspace && archiveOpen[projectKey(workspace)]);
  const currentHasArchived = projectHasArchived(conversations);

  function toggleArchive(path: string) {
    const key = projectKey(path);
    setArchiveOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

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
      <SpaceCorner />
      <div className={`relative z-10 flex shrink-0 items-center ${headerBarClass()}`} data-tauri-drag-region>
        <WindowButtons />
        <div className="min-w-0 flex-1" data-tauri-drag-region />
        <button
          type="button"
          aria-label="Open project"
          title="Open project"
          onClick={openFolder}
          className="mr-2 flex size-7 items-center justify-center rounded-[6px] text-ink hover:bg-wash"
        >
          <Symbol name="plus" className="size-3.5" />
        </button>
      </div>
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
          renderList={(group, { showArchived }) => (
            <ProjectConversations
              conversations={visibleConversations(group.conversations, showArchived)}
              journeys={visibleJourneys(group.journeys, group.conversations, showArchived)}
              path={group.path}
              dimmed={fullPage}
              archivedView={showArchived}
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
    </aside>
  );
}

function ProjectConversations({
  conversations,
  journeys,
  path,
  dimmed,
  archivedView,
}: {
  conversations: ConversationSummary[];
  journeys: JourneySummary[];
  path?: string;
  dimmed: boolean;
  archivedView?: boolean;
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
