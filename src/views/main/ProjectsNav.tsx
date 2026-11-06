import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AccountUsageRow } from "../../components/AccountUsageRow";
import { AllProjectsList } from "../../components/AllProjectsList";
import { Symbol } from "../../components/Symbol";
import { UsageTeaser } from "../../components/UsageTeaser";
import { isMacOS } from "../../components/WindowButtons";
import { archiveTargets, chatSelectionKey, focusedProjectGroups, groupOwningPath, isSameProject, matchesSidebarQuery, nestGroupedProjects, nextChatSelection, orderSidebarChats, sidebarActivity, sidebarFocusPath, sidebarTodoKey, visibleConversations, type ChatSelection, type ProjectGroupRow, type SidebarChatOrder } from "../../lib/all-projects";
import { serverDisplayName } from "../../lib/chat-place";
import { conversationActivityLabel, projectKey, type ChatMessage } from "../../lib/core";
import { fileRefreshRevision, subscribeFileRefresh } from "../../lib/file-structure";
import { forgetPaneWorkspace } from "../../lib/pane-sessions";
import { saveConversation } from "../../lib/prefs";
import { projectGitKey, projectGitLabel, sameGitLabels, type ProjectGit } from "../../lib/project-git";
import { publishProjectGroups } from "../../lib/project-groups";
import { sidebarTodoBadge, todosInLatestTurn, type TodoBadge } from "../../lib/todo";
import * as api from "../../lib/tauri";
import type { ConversationSummary } from "../../lib/tauri";
import type { GitWorktree } from "../../lib/tauri.ts";
import { groupProjectsByWorktree, linkedWorktrees, publishWorktreeChats, publishWorktreeLists, subscribeWorktreeLists, withoutLinkedWorktrees, worktreeNameRevision, worktreeRepoKey, type WorktreeChild } from "../../lib/worktree.ts";
import { useApp } from "../../state/app-state";
import { NewChatMenu } from "./AppChrome";
import { useSidebar } from "./context";
import { ProjectConversations } from "./ProjectConversations";
import { ActivityDock, todoSignature } from "./SidebarActivity";
import { SidebarSearch } from "./SidebarSearch";
import { UpdateRow } from "./UpdateRow";

export function ProjectsNav({
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
  focusPath,
  chatOrder,
  favoritePaths = [],
  onToggleFavorite,
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
  focusPath: string;
  chatOrder: SidebarChatOrder;
  favoritePaths?: readonly string[];
  onToggleFavorite?: (path: string) => void;
}) {
  const { setFlash } = useApp();
  const {
    activeId,
    allProjectGroups,
    archiveChats,
    collapsedProjects,
    deleteProjectFromSidebar,
    forgetProjectRow,
    legacyProjectsRoot,
    messages,
    openingId,
    openProjectFromSidebar,
    rememberOpenedProject,
    openSidebarChat,
    switchToProject,
    openProjectSettings,
    projectSettings,
    projectsRoot,
    showSettings,
    runningTurns,
    unseenFinished,
    showUsage,
    showDocs,
    sidebarReady,
    reorderProjects,
    startNewChat,
    toggleProjectCollapsed,
    workspace,
  } = useSidebar();
  const fullPage = Boolean(showSettings || showUsage || showDocs || projectSettings);
  const [picked, setPicked] = useState<ChatSelection[]>([]);
  const pickAnchor = useRef<ChatSelection | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  // Tab clicks change the open chat without going through the row click, which is
  // what normally sets this selection. Follow the open chat so the highlight moves.
  useEffect(() => {
    if (!activeId || !workspace) return;
    const next = { path: workspace, id: activeId };
    const already = pickedRef.current.some((row) => row.id === activeId && isSameProject(row.path, workspace));
    if (already) return;
    pickAnchor.current = next;
    setPicked([next]);
  }, [activeId, workspace]);
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const worktreeTick = useSyncExternalStore(subscribeWorktreeLists, worktreeNameRevision, worktreeNameRevision);
  void worktreeTick;
  const sidebarGroups = withoutLinkedWorktrees(allProjectGroups);
  const [projectGroups, setProjectGroups] = useState<ProjectGroupRow[]>([]);
  const projectPaths = sidebarGroups.map((group) => group.path).join("\n");
  useEffect(() => {
    let cancelled = false;
    void api.listProjectGroups().then((rows) => {
      if (cancelled) return;
      setProjectGroups(rows);
      publishProjectGroups(rows);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectPaths]);
  const nested = useMemo(() => nestGroupedProjects(sidebarGroups, projectGroups), [sidebarGroups, projectGroups]);
  const activity = useMemo(() => {
    void worktreeTick;
    const extra = Object.entries(worktreeChats).map(([key, conversations]) => {
      const row = linkedWorktrees().find((item) => projectKey(item.path) === key);
      return { path: row?.path || key, conversations };
    });
    return sidebarActivity(allProjectGroups, runningTurns, unseenFinished, extra);
  }, [allProjectGroups, runningTurns, unseenFinished, worktreeChats, worktreeTick]);
  const activeFocus = sidebarFocusPath(focusPath, sidebarGroups);
  const focusOwner = groupOwningPath(activeFocus, projectGroups);
  const listedGroups = focusedProjectGroups(nested.top, focusOwner || activeFocus);
  const focusedName = activeFocus
    ? sidebarGroups.find((group: { path: string; name?: string }) => isSameProject(group.path, activeFocus))?.name ?? ""
    : "";
  const visibleActivity = useMemo(
    () =>
      activity.filter(
        (item) =>
          (!activeFocus || isSameProject(item.path, activeFocus)) &&
          matchesSidebarQuery(query, item.title, item.project),
      ),
    [activity, query, activeFocus],
  );
  const shownGroups = useMemo(() => {
    if (!searching) return listedGroups;
    const open = new Set(
      activity.filter((item) => matchesSidebarQuery(query, item.title)).map((item) => projectKey(item.path)),
    );
    return listedGroups.filter((group) => {
      const members = nested.byGroup.get(projectKey(group.path)) ?? [];
      return (
        matchesSidebarQuery(query, group.name, group.path) ||
        open.has(projectKey(group.path)) ||
        group.conversations.some((row) => !row.archived && matchesSidebarQuery(query, row.title)) ||
        members.some(
          (member) =>
            matchesSidebarQuery(query, member.name, member.path) ||
            member.conversations.some((row) => !row.archived && matchesSidebarQuery(query, row.title)),
        )
      );
    });
  }, [searching, listedGroups, activity, query, nested]);
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
  const logoRefresh = gitRefresh;
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
            const badge = sidebarTodoBadge(todosInLatestTurn(messagesRef.current as ChatMessage[]));
            if (badge) found[badgeKey] = badge;
            return;
          }
          if (row.id in runningRef.current) return;
          if (previous.get(key) === row.updated) return;
          try {
            const full = row.remote ? await api.getConversationById(row.id) : await api.getConversation(row.path, row.id);
            const badge = sidebarTodoBadge(todosInLatestTurn((full.messages as ChatMessage[]) ?? []));
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
          else if (
            prev[badgeKey] &&
            !prev[badgeKey].finished &&
            !isOpen &&
            previous.get(key) === row.updated &&
            !(row.id in runningRef.current)
          ) {
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

  const groupsRef = useRef(shownGroups);
  groupsRef.current = shownGroups;
  const archiveOpenRef = useRef(archiveOpen);
  archiveOpenRef.current = archiveOpen;
  const worktreeChatsRef = useRef(worktreeChats);
  worktreeChatsRef.current = worktreeChats;

  function visibleOrder(): ChatSelection[] {
    const out: ChatSelection[] = [];
    const push = (path: string, rows: ConversationSummary[]) => {
      for (const row of rows) out.push({ path, id: row.id });
    };
    for (const group of groupsRef.current) {
      const showArchived = Boolean(archiveOpenRef.current[projectKey(group.path)]);
      push(group.path, visibleConversations(group.conversations, showArchived));
      if (showArchived) continue;
      for (const child of worktreesFor(group.path) ?? []) {
        push(child.path, visibleConversations(worktreeChatsRef.current[projectKey(child.path)] ?? [], false));
      }
    }
    return out;
  }

  function selectChat(
    path: string,
    id: string,
    mods: { toggle: boolean; range: boolean },
  ) {
    const clicked = { path, id };
    const next = nextChatSelection(pickedRef.current, pickAnchor.current, clicked, visibleOrder(), mods);
    pickAnchor.current = next.anchor;
    setPicked(next.selected);
  }

  const selectedKeys = useMemo(
    () => new Set(picked.map((row) => chatSelectionKey(row.path, row.id))),
    [picked],
  );

  function archiveSelected(path: string, id: string, archived: boolean, selected: ChatSelection[]) {
    const targets = archiveTargets(selected, { path, id });
    setPicked([]);
    pickAnchor.current = null;
    void archiveChats(targets, archived).then(() => {
      const touched = new Set(targets.map((row) => projectKey(row.path)));
      setWorktreeChats((prev) => {
        if (!Object.keys(prev).some((key) => touched.has(key))) return prev;
        const next = { ...prev };
        for (const key of touched) {
          if (!next[key]) continue;
          next[key] = next[key].map((row) => {
            const hit = targets.some((target) => target.id === row.id && projectKey(target.path) === key);
            return hit ? { ...row, archived } : row;
          });
        }
        queueMicrotask(() => publishWorktreeChats(next));
        return next;
      });
    });
  }

  async function refreshGroups() {
    const next = await api.listProjectGroups();
    setProjectGroups(next);
    publishProjectGroups(next);
  }

  async function createGroup(name: string, paths: string[]) {
    try {
      const row = await api.createProjectGroup(name, paths);
      rememberOpenedProject(row.path, row.name);
      await refreshGroups();
      openProjectFromSidebar(row.path);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
    }
  }

  async function addToGroup(group: string, path: string) {
    try {
      await api.addGroupMember(group, path);
      await refreshGroups();
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
    }
  }

  async function removeMember(group: string, path: string) {
    try {
      await api.removeGroupMember(group, path);
      await refreshGroups();
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
    }
  }

  async function deleteGroup(path: string) {
    try {
      await api.deleteProjectGroup(path);
      await forgetProjectRow(path);
      await refreshGroups();
      if (isSameProject(path, workspace)) {
        const next = sidebarGroups.find((group) => !isSameProject(group.path, path));
        if (next) openProjectFromSidebar(next.path);
      }
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
    }
  }

  return (
    <>
      <SidebarSearch query={query} onQuery={setQuery} />
      <div className="relative z-20 flex items-center justify-between gap-2 px-4 pt-1.5 pb-1">
        <span
          className={`min-w-0 truncate text-[11px] font-semibold tracking-[0.04em] text-muted ${focusedName ? "" : "uppercase"}`}
        >
          {focusedName || "Projects"}
        </span>
        <NewChatMenu
          disabled={!activeFocus && !workspace}
          onPick={(kind) => void startNewChat(kind, activeFocus || undefined)}
        />
      </div>
      <div className="no-scrollbar relative z-10 min-h-0 flex-1 overflow-auto px-2">
        {sidebarReady ? <AllProjectsList
          groups={shownGroups}
          focusPath={activeFocus}
          favoritePaths={favoritePaths}
          onToggleFavorite={onToggleFavorite}
          activeWorkspace={workspace}
          projectsRoot={projectsRoot}
          legacyProjectsRoot={legacyProjectsRoot}
          collapsed={collapsedProjects}
          onToggleCollapsed={toggleProjectCollapsed}
          onOpenProject={openProjectFromSidebar}
          onNewChat={(path) => void startNewChat("chat", path)}
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
          chatQuery={searching ? query : ""}
          logoRefresh={logoRefresh}
          membersFor={(path) => nested.byGroup.get(projectKey(path)) ?? []}
          projectGroups={projectGroups}
          onCreateGroup={(name, paths) => void createGroup(name, paths)}
          onAddToGroup={(group, path) => void addToGroup(group, path)}
          onRemoveMember={(group, path) => void removeMember(group, path)}
          onDeleteGroup={(path) => void deleteGroup(path)}
          worktreesFor={worktreesFor}
          onRemoveWorktree={removeWorktree}
          renderWorktree={(child, owner) => (
            <div>
              <ProjectConversations
                conversations={orderSidebarChats(
                  visibleConversations(worktreeChats[projectKey(child.path)] ?? [], false),
                  chatOrder,
                )}
                path={child.path}
                place={{
                  branch: child.branch,
                  worktree: true,
                  server: Boolean(owner.remote || owner.server),
                  serverName: serverDisplayName(owner.server),
                  ahead: gitByProject[projectGitKey(child.path)]?.ahead,
                  behind: gitByProject[projectGitKey(child.path)]?.behind,
                  dirty: gitByProject[projectGitKey(child.path)]?.dirty,
                }}
                dimmed={fullPage}
                reorderable={chatOrder !== "finished"}
                todoByChat={todoByChat}
                loadingId={isSameProject(child.path, workspace) ? openingId : ""}
                selectedKeys={selectedKeys}
                onSelectChat={selectChat}
                onArchiveSelected={(id, archived) =>
                  archiveSelected(child.path, id, archived, pickedRef.current)
                }
              />
            </div>
          )}
          renderList={(group, { showArchived, place }) => (
            <ProjectConversations
              conversations={orderSidebarChats(visibleConversations(group.conversations, showArchived), chatOrder)}
              path={group.path}
              place={place}
              dimmed={fullPage}
              archivedView={showArchived}
              reorderable={chatOrder !== "finished"}
              todoByChat={todoByChat}
              loadingId={isSameProject(group.path, workspace) ? openingId : ""}
              selectedKeys={selectedKeys}
              onSelectChat={selectChat}
              onArchiveSelected={(id, archived) =>
                archiveSelected(group.path, id, archived, pickedRef.current)
              }
            />
          )}
        /> : null}
      </div>
      <div className="sidebar-dock relative z-20 mx-2 mb-2 flex flex-col gap-0.5 px-1.5 py-1.5">
        <ActivityDock
          items={visibleActivity}
          activeId={activeId}
          runningPreview={(id) => conversationActivityLabel(runningTurns[id]?.activity)}
          runningStartedAt={(id) => runningTurns[id]?.startedAt ?? 0}
          onOpen={(path, id) => void openSidebarChat(path, id)}
        />
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
        <div className="flex items-center gap-1">
          <button
            type="button"
            title={isMacOS() ? "Settings ⌘," : "Settings Ctrl+,"}
            onClick={openSettings}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] ${
              showSettings ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
            }`}
          >
            <Symbol name="gearshape" className="size-4 text-muted" />
            <span>Settings</span>
          </button>
          <UpdateRow />
        </div>
      </div>
    </>
  );
}
