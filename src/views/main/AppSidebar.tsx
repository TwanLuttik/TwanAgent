import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AllProjectsList } from "../../components/AllProjectsList";
import { ConversationList } from "../../components/ConversationList";
import { Symbol } from "../../components/Symbol";
import { AccountUsageRow } from "../../components/AccountUsageRow";
import { UsageTeaser } from "../../components/UsageTeaser";
import { headerBarClass, isMacOS, isWindows, WindowButtons } from "../../components/WindowButtons";
import { isSameProject, sidebarTodoKey, visibleConversations, visibleJourneys } from "../../lib/all-projects";
import { conversationActivityLabel, projectKey, type ChatMessage } from "../../lib/core";
import { fileRefreshRevision, subscribeFileRefresh } from "../../lib/file-structure";
import { projectGitKey, projectGitLabel, sameGitLabels, type ProjectGit } from "../../lib/project-git";
import { groupProjectsByWorktree, linkedWorktrees, publishWorktreeChats, publishWorktreeLists, subscribeWorktreeLists, worktreeNameRevision, worktreeRepoKey, type WorktreeChild } from "../../lib/worktree.ts";
import { forgetPaneWorkspace } from "../../lib/pane-sessions";
import { saveConversation } from "../../lib/prefs";
import type { GitWorktree } from "../../lib/tauri.ts";
import { todoBadge, todosInLatestTurn, type TodoBadge } from "../../lib/todo";
import * as api from "../../lib/tauri";
import type { JourneyColor, JourneySummary } from "../../lib/journey";
import { SIDEBAR_DEFAULT, saveSidebarWidth } from "../../lib/prefs";
import type { ConversationSummary } from "../../lib/tauri";
import { installAppUpdate, relaunchAppUpdate, useAppUpdate } from "../../lib/update-store";
import { updateButtonLabel, updateNote } from "../../lib/update";
import { SETTINGS_TABS } from "../SettingsView";
import { NewChatMenu } from "./AppChrome";
import { useApp } from "../../state/app-state";
import { useMain, useSidebar } from "./context";

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
        <div className="min-w-0 flex-1" data-tauri-drag-region />
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
        />
      </div>
      </div>
    </aside>
  );
}

function CollapsedRail() {
  const { allProjectGroups, openProjectFromSidebar, workspace } = useSidebar();
  const [tip, setTip] = useState<{ name: string; top: number; left: number } | null>(null);
  return (
    <div className="absolute inset-0 z-30 flex flex-col">
      <div className="h-11 shrink-0" />
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-auto px-1 pb-2">
        {allProjectGroups.map((group) => {
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
              <Symbol name="folder.fill" className="size-4" />
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
        <div className="mt-auto px-2 pt-4">
          <UpdateRow />
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
  worktreesByRepo,
  setWorktreesByRepo,
  worktreeChats,
  setWorktreeChats,
  todoByChat,
  setTodoByChat,
  openSettings,
  openUsage,
  openDocs,
  usageTick,
}: {
  usageHover: boolean;
  setUsageHover: (hover: boolean) => void;
  archiveOpen: Record<string, boolean>;
  setArchiveOpen: (next: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void;
  gitByProject: Record<string, ProjectGit>;
  setGitByProject: (next: Record<string, ProjectGit> | ((prev: Record<string, ProjectGit>) => Record<string, ProjectGit>)) => void;
  worktreesByRepo: Record<string, GitWorktree[]>;
  setWorktreesByRepo: (
    next: Record<string, GitWorktree[]> | ((prev: Record<string, GitWorktree[]>) => Record<string, GitWorktree[]>),
  ) => void;
  worktreeChats: Record<string, ConversationSummary[]>;
  setWorktreeChats: (
    next: Record<string, ConversationSummary[]> | ((prev: Record<string, ConversationSummary[]>) => Record<string, ConversationSummary[]>),
  ) => void;
  todoByChat: Record<string, TodoBadge>;
  setTodoByChat: (next: Record<string, TodoBadge> | ((prev: Record<string, TodoBadge>) => Record<string, TodoBadge>)) => void;
  openSettings: () => void;
  openUsage: () => void;
  openDocs: () => void;
  usageTick: number;
}) {
  const { setFlash } = useApp();
  const {
    activeId,
    allProjectGroups,
    collapsedProjects,
    deleteProjectFromSidebar,
    forgetProjectRow,
    legacyProjectsRoot,
    messages,
    openingId,
    openProjectFromSidebar,
    switchToProject,
    openProjectSettings,
    projectSettings,
    projectsRoot,
    showSettings,
    runningTurns,
    showUsage,
    showDocs,
    reorderProjects,
    startNewChat,
    toggleProjectCollapsed,
    workspace,
  } = useSidebar();
  const fullPage = Boolean(showSettings || showUsage || showDocs || projectSettings);
  const worktreeTick = useSyncExternalStore(subscribeWorktreeLists, worktreeNameRevision, worktreeNameRevision);
  const sidebarGroups = allProjectGroups.filter((group: { path: string }) => {
    void worktreeTick;
    return !linkedWorktrees().some((row) => projectKey(row.path) === projectKey(group.path));
  });
  const gitRows = allProjectGroups
    .map((group: { path: string; remote?: boolean }) => `${group.remote ? "1" : "0"}\t${group.path}`)
    .join("\n");
  const gitRowsRef = useRef(gitRows);
  gitRowsRef.current = gitRows;
  const knownGit = useRef(new Map<string, ProjectGit | null>());
  const gitGeneration = useRef(0);
  const loadGitLabels = useRef<(refresh: boolean) => void>(() => {});
  loadGitLabels.current = (refresh: boolean) => {
    const rows = gitRowsRef.current
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const tab = line.indexOf("\t");
        return { remote: line.slice(0, tab) === "1", path: line.slice(tab + 1) };
      })
      .filter((row: { path: string }) => row.path);
    if (refresh) knownGit.current.clear();
    for (const key of [...knownGit.current.keys()]) {
      if (!rows.some((row: { path: string }) => projectGitKey(row.path) === key)) knownGit.current.delete(key);
    }
    const pending = rows.filter((row: { remote: boolean; path: string }) => !row.remote && !knownGit.current.has(projectGitKey(row.path)));
    const generation = ++gitGeneration.current;
    const publish = () => {
      if (generation !== gitGeneration.current) return;
      const found: Record<string, ProjectGit> = {};
      for (const [key, label] of knownGit.current) {
        if (label) found[key] = label;
      }
      setGitByProject((prev) => (sameGitLabels(prev, found) ? prev : found));
    };
    if (!pending.length) {
      publish();
      return;
    }
    void Promise.all(
      pending.map(async (row: { path: string }) => {
        const key = projectGitKey(row.path);
        try {
          knownGit.current.set(key, projectGitLabel(await api.gitProjectSummary(row.path)));
        } catch {
          knownGit.current.set(key, null);
        }
      }),
    ).then(publish);
  };
  useEffect(() => {
    loadGitLabels.current(false);
  }, [gitRows]);
  const gitRefresh = useSyncExternalStore(subscribeFileRefresh, fileRefreshRevision, fileRefreshRevision);
  const seenGitRefresh = useRef(gitRefresh);
  useEffect(() => {
    if (gitRefresh === seenGitRefresh.current) return;
    seenGitRefresh.current = gitRefresh;
    loadGitLabels.current(true);
  }, [gitRefresh]);

  const worktreePaths = allProjectGroups
    .filter((group: { remote?: boolean; server?: unknown }) => !group.remote && !group.server)
    .map((group: { path: string }) => group.path)
    .join("\n");
  const worktreePathsRef = useRef(worktreePaths);
  worktreePathsRef.current = worktreePaths;
  const worktreeGeneration = useRef(0);
  const loadWorktrees = useRef<() => void>(() => {});
  loadWorktrees.current = () => {
    const paths = worktreePathsRef.current.split("\n").filter(Boolean);
    if (!paths.length) {
      setWorktreesByRepo((prev) => {
        if (!Object.keys(prev).length) return prev;
        publishWorktreeLists({});
        return {};
      });
      return;
    }
    const generation = ++worktreeGeneration.current;
    void Promise.all(
      paths.map(async (path) => {
        try {
          return [path, await api.gitWorktrees(path)] as const;
        } catch {
          return [path, [] as GitWorktree[]] as const;
        }
      }),
    ).then((rows) => {
      if (generation !== worktreeGeneration.current) return;
      const next: Record<string, GitWorktree[]> = {};
      for (const [path, list] of rows) {
        if (!list.length) continue;
        const key = worktreeRepoKey(path, list);
        if (!next[key] || list.length > next[key].length) next[key] = list;
      }
      setWorktreesByRepo((prev) => (sameWorktreeMap(prev, next) ? prev : next));
      publishWorktreeLists(next);
      // A linked checkout used to be saved as its own project. It stays a child of the main repo.
      const linked = new Set<string>();
      for (const list of Object.values(next)) {
        for (const row of list) {
          if (!row.main && !row.bare) linked.add(projectKey(row.path));
        }
      }
      for (const path of paths) {
        if (linked.has(projectKey(path))) void forgetProjectRow(path);
      }
    });
  };
  useEffect(() => {
    loadWorktrees.current();
  }, [worktreePaths, gitRefresh]);

  const worktreeChatPaths = Object.values(worktreesByRepo)
    .flatMap((list) => list.filter((row) => !row.main && !row.bare).map((row) => row.path))
    .join("\n");
  useEffect(() => {
    const paths = worktreeChatPaths.split("\n").filter(Boolean);
    // The main checkout is not in that list. Its titles still belong on the shared strip.
    const asked = workspace && !paths.some((path) => projectKey(path) === projectKey(workspace))
      ? [...paths, workspace]
      : paths;
    if (!asked.length) {
      setWorktreeChats((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    let cancelled = false;
    void Promise.all(
      asked.map(async (path) => {
        try {
          return [projectKey(path), await api.listConversations(path)] as const;
        } catch {
          return [projectKey(path), [] as ConversationSummary[]] as const;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      const next: Record<string, ConversationSummary[]> = {};
      for (const [key, chats] of rows) next[key] = chats;
      setWorktreeChats((prev) => (sameWorktreeChats(prev, next) ? prev : next));
      publishWorktreeChats(next);
    });
    return () => {
      cancelled = true;
    };
  }, [worktreeChatPaths, workspace, setWorktreeChats]);

  function sameWorktreeChats(
    prev: Record<string, ConversationSummary[]>,
    next: Record<string, ConversationSummary[]>,
  ): boolean {
    const keys = Object.keys(next);
    if (keys.length !== Object.keys(prev).length) return false;
    return keys.every((key) => {
      const left = prev[key] ?? [];
      const right = next[key] ?? [];
      return (
        left.length === right.length &&
        left.every((row, index) => row.id === right[index]?.id && row.title === right[index]?.title && row.updated_at === right[index]?.updated_at)
      );
    });
  }

  function sameWorktreeMap(a: Record<string, GitWorktree[]>, b: Record<string, GitWorktree[]>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return bKeys.every((key) => {
    const left = a[key] ?? [];
    const right = b[key] ?? [];
    return (
      left.length === right.length &&
      left.every(
        (row, index) =>
          projectKey(row.path) === projectKey(right[index]?.path ?? "") &&
          (row.branch ?? "") === (right[index]?.branch ?? "") &&
          row.main === right[index]?.main,
      )
    );
  });
}

  function worktreesFor(path: string): WorktreeChild[] {
    const key = projectKey(path);
    const list =
      worktreesByRepo[key] ??
      Object.values(worktreesByRepo).find((rows) => rows.some((row) => row.main && projectKey(row.path) === key));
    if (!list) return [];
    return groupProjectsByWorktree([{ name: "", path }], { [key]: list })[0]?.children ?? [];
  }

  function removeWorktree(path: string) {
    const list = Object.values(worktreesByRepo).find((rows) =>
      rows.some((row) => projectKey(row.path) === projectKey(path)),
    );
    const owner = list?.find((row) => row.main)?.path || workspace;
    // The open folder is the one being deleted. Leave it before git removes the directory.
    if (isSameProject(path, workspace) && owner && !isSameProject(owner, path)) switchToProject(owner);
    void api
      .gitWorktreeRemove(owner, path)
      .then(() => {
        // The server deleted this checkout's chats. Drop the copy the sidebar is showing.
        const gone = projectKey(path);
        setWorktreeChats((prev) => {
          if (!(gone in prev)) return prev;
          const next = { ...prev };
          delete next[gone];
          queueMicrotask(() => publishWorktreeChats(next));
          return next;
        });
        saveConversation(path, "");
        forgetPaneWorkspace(path);
        loadWorktrees.current();
      })
      .catch((err) => setFlash({ kind: "err", text: String(err) }));
  }

  const todoWatch = allProjectGroups
    .flatMap((group: { remote?: boolean; path: string; conversations: ConversationSummary[] }) =>
      group.conversations.map((row) => `${group.remote ? "1" : "0"}\t${group.path}\t${row.id}\t${row.updated_at}`),
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
        const tab = line.indexOf("\t");
        const remote = line.slice(0, tab) === "1";
        const rest = line.slice(tab + 1);
        const pathEnd = rest.indexOf("\t");
        const path = rest.slice(0, pathEnd);
        const tail = rest.slice(pathEnd + 1);
        const idEnd = tail.indexOf("\t");
        return { remote, path, id: tail.slice(0, idEnd), updated: tail.slice(idEnd + 1) };
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
        rows.map(async (row: { remote: boolean; path: string; id: string; updated: string }) => {
          const key = `${row.path}\t${row.id}`;
          const isOpen = openKey === `${projectKey(row.path)}\t${row.id}`;
          const badgeKey = sidebarTodoKey(row.path, row.id);
          if (isOpen) {
            const badge = todoBadge(todosInLatestTurn(messagesRef.current as ChatMessage[]));
            if (badge) found[badgeKey] = badge;
            return;
          }
          if (row.id in runningRef.current) return;
          if (previous.get(key) === row.updated) return;
          try {
            const full = row.remote ? await api.getConversationById(row.id) : await api.getConversation(row.path, row.id);
            const badge = todoBadge(todosInLatestTurn((full.messages as ChatMessage[]) ?? []));
            if (badge) found[badgeKey] = badge;
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
          const badgeKey = sidebarTodoKey(row.path, row.id);
          const isOpen = openKey === `${projectKey(row.path)}\t${row.id}`;
          if (badgeKey in found) next[badgeKey] = found[badgeKey];
          else if (prev[badgeKey] && !isOpen && previous.get(key) === row.updated && !(row.id in runningRef.current)) {
            next[badgeKey] = prev[badgeKey];
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
          groups={sidebarGroups}
          activeWorkspace={workspace}
          projectsRoot={projectsRoot}
          legacyProjectsRoot={legacyProjectsRoot}
          collapsed={collapsedProjects}
          onToggleCollapsed={toggleProjectCollapsed}
          onOpenProject={openProjectFromSidebar}
          onNewChat={(path) => void startNewChat("chat", undefined, path)}
          onOpenSettings={openProjectSettings}
          onDeleteProject={(path, mode) => {
            const gone = mode === "worktrees"
              ? (worktreesFor(path) ?? []).map((child) => projectKey(child.path))
              : [];
            void deleteProjectFromSidebar(path, mode).then(() => {
              if (mode !== "worktrees") return;
              if (gone.length) {
                setWorktreeChats((prev) => {
                  if (!gone.some((key) => key in prev)) return prev;
                  const next = { ...prev };
                  for (const key of gone) delete next[key];
                  queueMicrotask(() => publishWorktreeChats(next));
                  return next;
                });
              }
              loadWorktrees.current();
            });
          }}
          onReorderProject={(fromPath, toPath) => void reorderProjects(fromPath, toPath)}
          archiveOpen={archiveOpen}
          onToggleArchive={toggleArchive}
          gitByProject={gitByProject}
          worktreesFor={worktreesFor}
          onRemoveWorktree={removeWorktree}
          renderWorktree={(child) => (
            <div className="pl-4">
              <ProjectConversations
                conversations={visibleConversations(worktreeChats[projectKey(child.path)] ?? [], false)}
                journeys={[]}
                path={child.path}
                dimmed={fullPage}
                todoByChat={todoByChat}
                loadingId={isSameProject(child.path, workspace) ? openingId : ""}
              />
            </div>
          )}
          renderList={(group, { showArchived }) => (
            <ProjectConversations
              conversations={visibleConversations(group.conversations, showArchived)}
              journeys={visibleJourneys(group.journeys, group.conversations, showArchived)}
              path={group.path}
              dimmed={fullPage}
              archivedView={showArchived}
              todoByChat={todoByChat}
              loadingId={isSameProject(group.path, workspace) ? openingId : ""}
            />
          )}
        />
      </div>
      <div className="relative z-10 flex flex-col gap-1 px-2.5 pb-3">
        <UpdateRow />
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
          onClick={openDocs}
          className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] ${
            showDocs ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
          }`}
        >
          <Symbol name="book" className="size-4 text-muted" />
          <span>Docs</span>
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

function UpdateRow() {
  const { setFlash } = useApp();
  const { update, phase, received, total, dev } = useAppUpdate();
  const busy = phase === "downloading" || phase === "installing";
  const note = update ? updateNote(update.notes) : "";

  function install() {
    if (!update || busy) return;
    void installAppUpdate().then((error) => {
      if (error) setFlash({ kind: "err", text: error });
    });
  }

  function restart() {
    void relaunchAppUpdate().catch((err) => setFlash({ kind: "err", text: String(err) }));
  }

  return (
    <div className="px-2 pb-0.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 truncate text-[11px] tabular-nums text-muted/55" title={`TwanAgent ${__APP_VERSION_LABEL__}`}>
          <span className="truncate">{__APP_VERSION_LABEL__}</span>
          {dev ? (
            <span className="shrink-0 rounded-[4px] bg-wash px-1 py-px text-[10px] font-semibold tracking-wide text-muted uppercase">
              Dev
            </span>
          ) : null}
        </p>
        {update ? (
          <button
            type="button"
            disabled={busy}
            onClick={phase === "ready" ? restart : install}
            className="shrink-0 rounded-[6px] bg-accent px-1.5 py-0.5 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
          >
            {updateButtonLabel(phase, received, total || update.bytes)}
          </button>
        ) : null}
      </div>
      {update ? (
        <p className="mt-0.5 text-[11px] leading-snug text-muted" title={update.notes || update.version}>
          {phase === "ready" ? `${update.version} is installed. Restart to open it.` : note || `${update.version} is available.`}
        </p>
      ) : null}
    </div>
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
  loadingId = "",
}: {
  conversations: ConversationSummary[];
  journeys: JourneySummary[];
  path?: string;
  dimmed: boolean;
  archivedView?: boolean;
  todoByChat: Record<string, TodoBadge>;
  loadingId?: string;
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
    removeChat,
    renameJourney,
    reorderChats,
    reorderSidebar,
    runningTurns,
    unseenFinished,
    setJourneyColor,
    startNewChat,
    toggleJourney,
    openListedChat,
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
    openListedChat,
  });
  actions.current = {
    archiveChat,
    createJourneyFromChat,
    deleteJourney,
    moveConversation,
    openChat,
    openListedChat,
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
      onOpen: (id: string) =>
        path ? void actions.current.openSidebarChat(path, id) : actions.current.openListedChat(id),
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
      return todoByChat[sidebarTodoKey(path || "", id)] ?? null;
    },
    [runningTurns, todoByChat, path],
  );

  return (
    <ConversationList
      conversations={conversations}
      journeys={journeys}
      activeId={activeId}
      runningIds={runningTurns}
      unseenIds={unseenFinished}
      loadingId={loadingId}
      runningPreview={runningPreview}
      todoFor={todoFor}
      showSettings={dimmed}
      archivedView={archivedView}
      {...handlers}
    />
  );
}
