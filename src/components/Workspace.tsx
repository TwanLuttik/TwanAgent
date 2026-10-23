import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
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
  HEAVY_DIRS,
  formatDiffCount,
  gitChangeForPath,
  gitChangeMap,
  gitChangeTotals,
  gitChangesTree,
  gitDirtyDirs,
  gitLineStats,
  type GitChangeTreeNode,
} from "../lib/core";
import { ALL_DIFF_PATH } from "../lib/editor";
import {
  canDropOnDir,
  canMoveSelection,
  canRenameSelection,
  fileName,
  fileParent,
  isInsidePath,
  joinFilePath,
  nextFolderName,
  topLevelPaths,
  validEntryName,
  validNewFileName,
} from "../lib/file-actions";
import { bumpFileRefresh, dirsToList, fileRefreshRevision, fileStructureDirs, subscribeFileRefresh, subscribeFileStructure } from "../lib/file-structure";
import { planGitStatusRefresh, switchedOntoGitTab } from "../lib/git-status-refresh";
import {
  closedTerminalTabs,
  filePaneNeedsReload,
  paneForWorkspace,
  savePaneForWorkspace,
} from "../lib/pane-sessions";
import {
  addableKinds,
  closePane,
  movePane,
  openPane,
  paneMeta,
  selectPane,
  type PaneKind,
  type PaneState,
  type PaneTab,
} from "../lib/pane";
import { shellSessionId } from "../lib/shell-sessions";
import { shellSessions } from "../lib/shell-terminal";
import {
  loadGitChangesView,
  loadOpenFileTree,
  saveGitChangesView,
  saveOpenFileTree,
  type GitChangesView,
} from "../lib/prefs";
import * as api from "../lib/tauri";
import type { Entry, GitBranches, GitChange, GitCommit, GitIdentity, GitRepoSummary, GitWorktree } from "../lib/tauri";
import { Terminal } from "./Terminal";
import { AnchoredMenu } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import { Symbol } from "./Symbol";

export const Workspace = memo(function Workspace({
  workspace,
  selectedPath,
  onOpenFile,
  onRefresh,
  onOpenWorkspace,
  onCollapse,
  pending = false,
}: {
  workspace: string;
  selectedPath?: string | null;
  onOpenFile?: (path: string, mode?: "preview" | "pin", view?: "edit" | "diff") => void;
  onRefresh?: () => void;
  onOpenWorkspace?: (path: string) => void;
  onCollapse?: () => void;
  /** The project is still opening. Keep the pane frame and cover its contents. */
  pending?: boolean;
}) {
  const [pane, setPaneState] = useState<PaneState>(() => paneForWorkspace(workspace));
  const asideRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    openTreeState(loadOpenFileTree(workspace)),
  );
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [newFileParent, setNewFileParent] = useState<string | null>(null);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [branches, setBranches] = useState<GitBranches>({ current: null, branches: [] });
  const [summary, setSummary] = useState<GitRepoSummary | null>(null);
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [history, setHistory] = useState<GitCommit[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gitMissing, setGitMissing] = useState(false);
  const [treeReady, setTreeReady] = useState(false);
  const [structureTick, setStructureTick] = useState(0);
  const refreshGen = useRef(0);
  const lastStatsAt = useRef<number | null>(null);
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeKindRef = useRef<string | null>(null);
  const switchedToGitRef = useRef(false);
  const activeKind = pane.tabs.find((tab) => tab.id === pane.activeId)?.kind ?? null;
  // Set during render so the refresh this tab change recreates still requests stats.
  if (switchedOntoGitTab(activeKindRef.current, activeKind)) switchedToGitRef.current = true;
  activeKindRef.current = activeKind;
  const fileRefresh = useSyncExternalStore(subscribeFileRefresh, fileRefreshRevision, fileRefreshRevision);

  const loadDir = useCallback(
    async (path: string) => {
      const rows = await api.listDir(workspace, path);
      setChildren((prev) => ({ ...prev, [path]: rows }));
    },
    [workspace],
  );

  const refreshTree = useCallback(async () => {
    if (!workspace) return;
    const gen = ++refreshGen.current;
    setError(null);
    const switchedToGit = switchedToGitRef.current;
    switchedToGitRef.current = false;
    const plan = planGitStatusRefresh({
      activeKind,
      lastStatsAt: lastStatsAt.current,
      now: Date.now(),
      switchedToGit,
    });
    // A burst while git is open still fetches paths. Numstat waits for one trailing pass.
    if (!plan.run && statsTimer.current == null) {
      statsTimer.current = setTimeout(() => {
        statsTimer.current = null;
        void refreshTree();
      }, plan.delayMs);
    } else if (plan.run && plan.stats && statsTimer.current != null) {
      clearTimeout(statsTimer.current);
      statsTimer.current = null;
    }
    const wantStats = plan.run && plan.stats;
    if (wantStats) lastStatsAt.current = Date.now();
    // Git and the file tree are independent. A missing remembered folder must
    // not throw away a status that already came back.
    const gitResult = api.gitStatus(workspace, wantStats).then(
      (rows) => ({ rows, missing: false }),
      (err: unknown) => {
        const text = String(err).toLowerCase();
        if (text.includes("git: command not found") || text.includes("git: not found") || text.includes("git is not available")) {
          return { rows: [] as GitChange[], missing: true };
        }
        throw err;
      },
    );
    const open = dirsToList(expanded, fileStructureDirs(workspace));
    const listed = await Promise.all(
      open.map(async (path) => {
        try {
          return { path, rows: await api.listDir(workspace, path), missing: false, failed: "" };
        } catch (err) {
          const text = String(err);
          // A remembered folder that was deleted or renamed is not a file. Drop it.
          // Anything else, including a real file, stays on screen.
          const gone = text.toLowerCase().includes("not a folder");
          return { path, rows: [] as Entry[], missing: gone, failed: gone ? "" : text };
        }
      }),
    );
    let gitFailed = false;
    try {
      const nextGit = await gitResult;
      if (gen !== refreshGen.current) return;
      setGitMissing(nextGit.missing);
      setChanges(nextGit.rows);
    } catch (e) {
      gitFailed = true;
      if (gen === refreshGen.current) setError(String(e));
    }
    const listError = listed.find((row) => row.failed)?.failed ?? "";
    if (listError && gen === refreshGen.current) {
      gitFailed = true;
      setError(listError);
    }
    if (gen !== refreshGen.current) return;
    const gone = listed.filter((row) => row.missing).map((row) => row.path);
    if (gone.length) {
      setExpanded((prev) => {
        if (!gone.some((path) => prev[path])) return prev;
        const next = { ...prev };
        for (const path of gone) delete next[path];
        saveOpenFileTree(workspace, openTreePaths(next));
        return next;
      });
    }
    setChildren((prev) => {
      const next = { ...prev };
      for (const listing of listed) {
        if (listing.missing) {
          delete next[listing.path];
          continue;
        }
        next[listing.path] = listing.rows;
      }
      const live = new Set(
        listed.filter((listing) => !listing.missing).flatMap((listing) => listing.rows.map((row) => row.path)),
      );
      for (const path of Object.keys(next)) {
        if (path && !live.has(path)) delete next[path];
      }
      return next;
    });
    if (gen === refreshGen.current) setTreeReady(true);
    if (!gitFailed && gen === refreshGen.current) setError(null);
  }, [workspace, expanded, activeKind]);

  const refreshBranches = useCallback(async () => {
    if (!workspace) return;
    try {
      const [next, repo, who, log] = await Promise.all([
        api.gitBranches(workspace),
        api.gitSummary(workspace).catch(() => null),
        api.gitIdentity(workspace).catch(() => null),
        api.gitLog(workspace, 30).catch(() => [] as GitCommit[]),
      ]);
      setBranches(next);
      setSummary(repo);
      setIdentity(who);
      setHistory(log);
      setWorktrees(await api.gitWorktrees(workspace).catch(() => [] as GitWorktree[]));
      setBranchError(null);
    } catch (e) {
      setBranchError(String(e));
    }
  }, [workspace]);

  const treeProjectRef = useRef(workspace);
  useEffect(() => {
    // A canonical rewrite of the open folder is still this project. Resetting
    // here covers the tree with the spinner while a chat in it is opening.
    if (!filePaneNeedsReload(treeProjectRef.current, workspace)) {
      treeProjectRef.current = workspace;
      return;
    }
    treeProjectRef.current = workspace;
    activeKindRef.current = null;
    switchedToGitRef.current = false;
    lastStatsAt.current = null;
    setExpanded(openTreeState(loadOpenFileTree(workspace)));
    setPaneState(paneForWorkspace(workspace));
    setSelected([]);
    setRenaming(null);
    setCreating(null);
    setNewFileParent(null);
    setTreeReady(false);
  }, [workspace]);

  const setPane = useCallback(
    (next: PaneState | ((prev: PaneState) => PaneState)) => {
      setPaneState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        for (const tab of closedTerminalTabs(prev, resolved)) {
          void shellSessions.dispose(shellSessionId(workspace, tab.id));
        }
        savePaneForWorkspace(workspace, resolved);
        return resolved;
      });
    },
    [workspace],
  );

  useEffect(() => subscribeFileStructure(() => setStructureTick((n) => n + 1)), []);

  useEffect(() => {
    return () => {
      if (statsTimer.current != null) clearTimeout(statsTimer.current);
      statsTimer.current = null;
    };
  }, [workspace]);

  useEffect(() => {
    void refreshTree();
  }, [workspace, fileRefresh, structureTick, refreshTree]);

  useEffect(() => {
    void loadDir("").catch((e) => setError(String(e)));
  }, [workspace, loadDir]);

  useEffect(() => {
    void refreshBranches();
  }, [workspace, refreshBranches]);

  async function toggle(path: string) {
    setExpanded((prev) => {
      const next = { ...prev, [path]: !prev[path] };
      saveOpenFileTree(workspace, openTreePaths(next));
      return next;
    });
    if (!expanded[path]) {
      try {
        await loadDir(path);
      } catch (e) {
        setError(String(e));
      }
    }
  }

  function openFile(path: string, mode: "preview" | "pin" = "pin", view: "edit" | "diff" = "edit") {
    setSelected([path]);
    onOpenFile?.(path, mode, view);
  }

  const nodeMap = fileNodeMap(children);
  const picked = selected.filter((path) => nodeMap.has(path));

  function selectRow(path: string, kind: string, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) {
    const multi = ev.metaKey || ev.ctrlKey;
    setSelected((prev) => {
      if (ev.shiftKey && prev.length) {
        const anchor = prev[prev.length - 1];
        const range = visibleRange(children, expanded, anchor, path);
        const base = multi ? prev : [];
        return [...new Set([...base, ...range])];
      }
      if (multi) {
        return prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path];
      }
      return [path];
    });
    if (!multi && !ev.shiftKey && kind !== "dir") onOpenFile?.(path, "preview");
  }

  async function reveal(path: string) {
    const parent = fileParent(path);
    if (parent && !expanded[parent]) {
      setExpanded((prev) => {
        const next = { ...prev, [parent]: true };
        saveOpenFileTree(workspace, openTreePaths(next));
        return next;
      });
    }
    if (!children[parent]) {
      try {
        await loadDir(parent);
      } catch (e) {
        setError(String(e));
      }
    }
  }

  async function renameEntry(path: string, name: string) {
    const next = name.trim();
    setRenaming(null);
    if (!validEntryName(next) || next === fileName(path)) return;
    try {
      const moved = await api.renamePath(workspace, path, next);
      setSelected([moved]);
      await reveal(moved);
      await refreshTree();
      onRefresh?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function nameCreated(path: string, name: string) {
    const next = name.trim();
    setCreating(null);
    if (!validEntryName(next) || next === fileName(path)) return;
    try {
      const named = await api.renamePath(workspace, path, next);
      setSelected([named]);
      await refreshTree();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeEntries(paths: string[]) {
    const tops = topLevelPaths(paths);
    if (!tops.length) return;
    const label = tops.length === 1 ? fileName(tops[0]) : `${tops.length} items`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await api.deletePaths(workspace, tops);
      setSelected((prev) => prev.filter((path) => !tops.some((top) => isInsidePath(path, top))));
      await refreshTree();
      onRefresh?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function moveEntries(paths: string[], dest: string) {
    const tops = topLevelPaths(paths);
    if (!canDropOnDir(tops, dest, nodeMap)) return;
    try {
      const moved = await api.movePaths(workspace, tops, dest);
      setSelected(moved);
      setExpanded((prev) => {
        const next = { ...prev, [dest]: true };
        saveOpenFileTree(workspace, openTreePaths(next));
        return next;
      });
      await loadDir(dest);
      await refreshTree();
      onRefresh?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function makeFile(parent: string, name: string) {
    const next = name.trim();
    if (!validNewFileName(next)) return;
    const path = joinFilePath(parent, next);
    try {
      await api.writeFile(workspace, path, "");
      setExpanded((prev) => {
        const nextOpen = { ...prev, [parent]: true };
        saveOpenFileTree(workspace, openTreePaths(nextOpen));
        return nextOpen;
      });
      setNewFileParent(null);
      setSelected([path]);
      onOpenFile?.(path, "pin");
      await loadDir(parent);
      await refreshTree();
      onRefresh?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function makeFolder(parent: string) {
    const rows = children[parent] ?? [];
    const name = nextFolderName(rows.map((row) => row.name));
    try {
      const created = await api.createDir(workspace, parent, name);
      setExpanded((prev) => {
        const next = { ...prev, [parent]: true };
        saveOpenFileTree(workspace, openTreePaths(next));
        return next;
      });
      await loadDir(parent);
      setCreating(created);
      setSelected([created]);
      await refreshTree();
    } catch (e) {
      setError(String(e));
    }
  }

  function openChange(change: GitChange, mode: "preview" | "pin" = "preview") {
    setSelected([change.path]);
    onOpenFile?.(change.path, mode, "diff");
  }

  function addKind(kind: PaneKind) {
    setPane((prev) => openPane(prev, kind));
  }

  async function switchBranch(name: string) {
    if (!workspace || switching || name === branches.current) return;
    setSwitching(true);
    try {
      const next = await api.gitSwitch(workspace, name);
      setBranches(next);
      setChanges(await api.gitStatus(workspace));
      setBranchError(null);
      onRefresh?.();
      void refreshBranches();
    } catch (e) {
      setBranchError(String(e));
    } finally {
      setSwitching(false);
    }
  }

  async function runGit(work: () => Promise<unknown>) {
    if (!workspace || gitBusy) return;
    setGitBusy(true);
    try {
      await work();
      setChanges(await api.gitStatus(workspace));
      setBranchError(null);
      onRefresh?.();
      void refreshBranches();
    } catch (e) {
      setBranchError(String(e));
    } finally {
      setGitBusy(false);
    }
  }

  return (
    <aside
      ref={asideRef}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[12px] border border-line/35 bg-canvas"
    >
      <PaneTabs pane={pane} onChange={setPane} onAdd={addKind} onCollapse={onCollapse} />
      <div className={`relative min-h-0 flex-1 ${pending || !treeReady ? "invisible" : ""}`} data-pane-pending={pending || !treeReady ? "" : undefined}>
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeId;
          return (
            <div
              key={tab.id}
              className={`absolute inset-0 flex flex-col ${active ? "" : "invisible pointer-events-none"}`}
              {...(active ? {} : { inert: true })}
              aria-hidden={!active}
            >
              {tab.kind === "terminal" ? (
                <Terminal workspace={workspace} sessionKey={tab.id} active={active} />
              ) : null}
              {tab.kind === "files" ? (
                <FilesPane
                  error={error}
                  gitMissing={gitMissing}
                  expanded={expanded}
                  childrenOf={children}
                  selected={picked}
                  activePath={selectedPath ?? null}
                  renaming={renaming}
                  creating={creating}
                  newFileParent={newFileParent}
                  changes={changes}
                  onToggle={(p) => void toggle(p)}
                  onSelect={(path, kind, ev) => selectRow(path, kind, ev)}
                  onOpen={(p, mode) => void openFile(p, mode)}
                  onRename={(path) => setRenaming(path)}
                  onRenameCommit={(path, name) => void renameEntry(path, name)}
                  onCreateCommit={(path, name) => void nameCreated(path, name)}
                  onDelete={(paths) => void removeEntries(paths)}
                  onMove={(paths, dest) => void moveEntries(paths, dest)}
                  onNewFolder={(parent) => void makeFolder(parent)}
                  onNewFile={(parent) => {
                    setExpanded((prev) => {
                      const next = { ...prev, [parent]: true };
                      saveOpenFileTree(workspace, openTreePaths(next));
                      return next;
                    });
                    setNewFileParent(parent);
                  }}
                  onNewFileCommit={(parent, name) => void makeFile(parent, name)}
                  onNewFileCancel={() => setNewFileParent(null)}
                />
              ) : null}
              {tab.kind === "git" ? (
                <GitPane
                  branches={branches}
                  summary={summary}
                  identity={identity}
                  history={history}
                  branchError={branchError}
                  switching={switching}
                  busy={gitBusy}
                  onSwitch={(name) => void switchBranch(name)}
                  onCreate={(name) => void runGit(() => api.gitCreateBranch(workspace, name, true))}
                  onStage={(paths) => void runGit(() => api.gitStage(workspace, paths))}
                  onUnstage={(paths) => void runGit(() => api.gitUnstage(workspace, paths))}
                  onDiscard={(paths) => void runGit(() => api.gitDiscard(workspace, paths))}
                  onCommit={(message) => void runGit(() => api.gitCommit(workspace, message))}
                  onIdentity={(name, email) => void runGit(() => api.gitSetIdentity(workspace, name, email))}
                  onSync={(action) => void runGit(() => api.gitSync(workspace, action))}
                  onStash={(action) => void runGit(() => api.gitStash(workspace, action))}
                  onShow={(hash) => api.gitShow(workspace, hash)}
                  workspacePath={workspace}
                  worktrees={worktrees}
                  onOpenWorkspace={onOpenWorkspace}
                  onCreateWorktree={(branch) =>
                    void runGit(async () => {
                      const added = await api.gitWorktreeAdd(workspace, branch, true);
                      bumpFileRefresh();
                      if (added.opened && onOpenWorkspace) onOpenWorkspace(added.opened);
                      return added;
                    })
                  }
                  onRemoveWorktree={(path) =>
                    void runGit(async () => {
                      if (!window.confirm("Remove this worktree? Uncommitted changes will keep it.")) return;
                      setWorktrees(await api.gitWorktreeRemove(workspace, path));
                    })
                  }
                  changes={changes}
                  selected={selectedPath ?? null}
                  onOpen={(row, mode) => openChange(row, mode)}
                  onOpenAll={() => openFile(ALL_DIFF_PATH, "pin", "diff")}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {pending || !treeReady ? (
        <div className="absolute inset-0 top-9 z-20 flex items-center justify-center bg-canvas" data-pane-loading>
          <span className="size-4 animate-spin rounded-full border border-muted/40 border-t-transparent" aria-label="Loading" />
        </div>
      ) : null}
    </aside>
  );
});

function PaneTabs({
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
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line/35 px-1.5">
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

function openTreeState(paths: string[]): Record<string, boolean> {
  const state: Record<string, boolean> = { "": true };
  for (const path of paths) {
    if (path) state[path] = true;
  }
  return state;
}

function openTreePaths(state: Record<string, boolean>): string[] {
  return Object.keys(state).filter((path) => path && state[path]);
}

function FilesPane({
  error,
  gitMissing = false,
  expanded,
  childrenOf,
  selected,
  activePath,
  renaming,
  creating,
  newFileParent,
  changes,
  onToggle,
  onSelect,
  onOpen,
  onRename,
  onRenameCommit,
  onCreateCommit,
  onDelete,
  onMove,
  onNewFolder,
  onNewFile,
  onNewFileCommit,
  onNewFileCancel,
}: {
  error: string | null;
  gitMissing?: boolean;
  expanded: Record<string, boolean>;
  childrenOf: Record<string, Entry[]>;
  selected: string[];
  activePath: string | null;
  renaming: string | null;
  creating: string | null;
  newFileParent: string | null;
  changes: GitChange[];
  onToggle: (path: string) => void;
  onSelect: (path: string, kind: string, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  onOpen: (path: string, mode?: "preview" | "pin") => void;
  onRename: (path: string) => void;
  onRenameCommit: (path: string, name: string) => void;
  onCreateCommit: (path: string, name: string) => void;
  onDelete: (paths: string[]) => void;
  onMove: (paths: string[], dest: string) => void;
  onNewFolder: (parent: string) => void;
  onNewFile: (parent: string) => void;
  onNewFileCommit: (parent: string, name: string) => void;
  onNewFileCancel: () => void;
}) {
  const byPath = gitChangeMap(changes);
  const dirtyDirs = gitDirtyDirs(byPath);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; paths: string[] } | null>(null);
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragPaths, setDragPaths] = useState<string[] | null>(null);
  const dragPathsRef = useRef<string[] | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const nodeMapRef = useRef(fileNodeMap(childrenOf));
  const listRef = useRef<HTMLDivElement>(null);
  const nodeMap = fileNodeMap(childrenOf);
  nodeMapRef.current = nodeMap;
  const menuPaths = menu?.paths ?? [];
  const menuNodes = fileNodeMap(childrenOf);
  const allowRename = canRenameSelection(menuPaths, menuNodes);
  const allowMove = canMoveSelection(menuPaths, menuNodes);

  useEffect(() => {
    if (!menu && !blankMenu) return;
    function close() {
      setMenu(null);
      setBlankMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") close();
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu, blankMenu]);

  function pathsFor(path: string) {
    return selected.includes(path) ? selected : [path];
  }

  function setDraggingPaths(paths: string[] | null) {
    dragPathsRef.current = paths;
    setDragPaths(paths);
    if (!paths) {
      dropTargetRef.current = null;
      markFileDrop(null);
    }
  }

  function aimDrop(dest: string | null, row: HTMLElement | null = null) {
    markFileDrop(dest && dest !== "" ? row : null);
    if (dropTargetRef.current === dest) return;
    dropTargetRef.current = dest;
    setDropTarget(dest);
  }

  function placeFromPoint(x: number, y: number) {
    const paths = dragPathsRef.current;
    if (!paths || (!x && !y)) return;
    const list = listRef.current;
    const hit = rowAtPoint(x, y);
    const raw = hit?.dataset.path ?? "";
    const kind = hit?.dataset.kind;
    const dest = !hit || !list?.contains(hit) ? "" : kind === "dir" ? raw : fileParent(raw);
    const nodes = nodeMapRef.current;
    const blocked = paths.some((item) => item === dest || isInsidePath(dest, item));
    if (blocked || !canDropOnDir(paths, dest, nodes)) {
      aimDrop(null);
      return;
    }
    const folder = dest
      ? document.querySelector<HTMLElement>(`.file-row[data-path="${cssEscape(dest)}"]`)
      : null;
    aimDrop(dest, folder);
  }

  useEffect(() => {
    if (!dragPaths) return;
    let frame = 0;
    const point = { x: 0, y: 0 };
    function tick() {
      frame = 0;
      placeFromPoint(point.x, point.y);
    }
    function onPointer(ev: PointerEvent | MouseEvent) {
      if (!ev.clientX && !ev.clientY) return;
      point.x = ev.clientX;
      point.y = ev.clientY;
      if (!frame) frame = requestAnimationFrame(tick);
    }
    document.addEventListener("dragover", onPointer, true);
    document.addEventListener("pointermove", onPointer, true);
    document.addEventListener("mousemove", onPointer, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("dragover", onPointer, true);
      document.removeEventListener("pointermove", onPointer, true);
      document.removeEventListener("mousemove", onPointer, true);
    };
  }, [dragPaths]);

  return (
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5"
      onDragOver={(ev) => {
        const paths = dragPathsRef.current;
        if (!paths && !ev.dataTransfer.types.includes(FILE_DRAG_TYPE)) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        if (ev.clientX || ev.clientY) placeFromPoint(ev.clientX, ev.clientY);
      }}
      onDragLeave={(ev) => {
        const next = ev.relatedTarget;
        if (!(next instanceof Node) || ev.currentTarget.contains(next)) return;
        aimDrop(null);
      }}
      onDrop={(ev) => {
        const paths = dragPathsRef.current ?? ev.dataTransfer.getData(FILE_DRAG_TYPE).split("\n").filter(Boolean);
        const dest = dropTargetRef.current;
        aimDrop(null);
        setDraggingPaths(null);
        if (!paths.length || dest == null || ev.defaultPrevented) return;
        ev.preventDefault();
        if (canDropOnDir(paths, dest, nodeMap)) onMove(paths, dest);
      }}
      onContextMenu={(ev) => {
        if ((ev.target as HTMLElement).closest(".file-row")) return;
        ev.preventDefault();
        setMenu(null);
        setBlankMenu({ x: ev.clientX, y: ev.clientY });
      }}
    >
      {error && <p className="px-2 text-[11px] text-err">{error}</p>}
      {gitMissing ? (
        <span className="group/git relative mx-2 mb-1 flex w-fit items-center" title="Git is not installed on this server">
          <Symbol name="exclamationmark.triangle.fill" className="size-3.5 text-warn" />
          <span
            role="tooltip"
            className="pointer-events-none absolute top-full left-0 z-10 mt-1 hidden w-max rounded-md border border-line/25 bg-canvas px-2 py-1 text-[11px] text-ink shadow-card group-hover/git:block"
          >
            Git is not installed on this server
          </span>
        </span>
      ) : null}
      {dropTarget === "" ? (
        <div className="sticky top-0 z-10 mx-1 mb-1 flex items-center gap-1.5 rounded-[6px] bg-accent/20 px-2 py-[5px] text-[12px] font-medium text-accent ring-1 ring-inset ring-accent">
          <Symbol name="arrow.down.to.line" className="size-3.5" />
          <span>Move to project root</span>
        </div>
      ) : null}
      <Tree
        path=""
        depth={0}
        expanded={expanded}
        childrenOf={childrenOf}
        selected={selected}
        activePath={activePath}
        renaming={renaming}
        creating={creating}
        newFileParent={newFileParent}
        dropTarget={dropTarget}
        dragPaths={dragPaths}
        changes={byPath}
        dirtyDirs={dirtyDirs}
        nodeMap={nodeMap}
        onToggle={onToggle}
        onSelect={onSelect}
        onOpen={onOpen}
        onRenameCommit={onRenameCommit}
        onCreateCommit={onCreateCommit}
        onNewFileCommit={onNewFileCommit}
        onNewFileCancel={onNewFileCancel}
        onContext={(path, x, y) => {
          const paths = selected.includes(path) ? selected : [path];
          if (!selected.includes(path)) onSelect(path, nodeMap.get(path)?.kind ?? "file", { metaKey: false, ctrlKey: false, shiftKey: false });
          setMenu({ path, x, y, paths });
        }}
        onDragPaths={pathsFor}
        onDragChange={setDraggingPaths}
        dragPathsRef={dragPathsRef}
        onDropTarget={aimDrop}
        onMove={onMove}
      />
      {menu ? (
        <AnchoredMenu x={menu.x} y={menu.y}>
          <MenuItem
            label="New file"
            onClick={() => {
              const parent = menuNodes.get(menu.path)?.kind === "dir" ? menu.path : fileParent(menu.path);
              onNewFile(parent);
              setMenu(null);
            }}
          />
          <MenuItem
            label="New folder"
            onClick={() => {
              const parent = menuNodes.get(menu.path)?.kind === "dir" ? menu.path : fileParent(menu.path);
              onNewFolder(parent);
              setMenu(null);
            }}
          />
          <MenuItem
            label="Rename"
            disabled={!allowRename}
            onClick={() => {
              onRename(menuPaths[0]);
              setMenu(null);
            }}
          />
          <MenuItem
            label={menuPaths.length > 1 ? `Delete ${menuPaths.length}` : "Delete"}
            danger
            onClick={() => {
              onDelete(menuPaths);
              setMenu(null);
            }}
          />
          {!allowMove && menuPaths.length > 1 ? (
            <p className="m-0 px-2.5 py-1 text-[11px] text-muted">Move and rename need files or folders, not both.</p>
          ) : null}
        </AnchoredMenu>
      ) : null}
      {blankMenu ? (
        <AnchoredMenu x={blankMenu.x} y={blankMenu.y}>
          <MenuItem
            label="New file"
            onClick={() => {
              onNewFile("");
              setBlankMenu(null);
            }}
          />
          <MenuItem
            label="New folder"
            onClick={() => {
              onNewFolder("");
              setBlankMenu(null);
            }}
          />
        </AnchoredMenu>
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  disabled,
  danger,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full px-2.5 py-1.5 text-left text-[12px] disabled:cursor-default disabled:opacity-40 ${
        danger ? "text-err hover:bg-inset" : "text-ink hover:bg-inset"
      }`}
    >
      {label}
    </button>
  );
}

const FILE_DRAG_TYPE = "application/x-twanagent-paths";
const FILE_DROP_CLASS = "file-drop-target";

function markFileDrop(row: HTMLElement | null) {
  const prev = document.querySelector(`.${FILE_DROP_CLASS}`);
  if (prev === row) return;
  prev?.classList.remove(FILE_DROP_CLASS);
  row?.classList.add(FILE_DROP_CLASS);
}

function cssEscape(value: string): string {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function rowAtPoint(x: number, y: number): HTMLElement | null {
  const stack = document.elementsFromPoint(x, y);
  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    const row = node.closest<HTMLElement>(".file-row");
    if (row) return row;
  }
  return null;
}

function dragPreviewLabel(paths: string[], nodes: Map<string, Entry>): { name: string; kind: string; count: number } {
  const tops = topLevelPaths(paths);
  const first = tops[0] ?? paths[0] ?? "";
  return {
    name: fileName(first),
    kind: nodes.get(first)?.kind ?? "file",
    count: tops.length,
  };
}

function setFileDragImage(data: DataTransfer, source: HTMLElement, label: string) {
  const node = document.createElement("div");
  node.className = "file-drag-image";
  const icons = source.querySelectorAll("svg");
  const glyph = icons[icons.length - 1];
  if (glyph) {
    const clone = glyph.cloneNode(true) as SVGElement;
    clone.style.width = "14px";
    clone.style.height = "14px";
    node.append(clone);
  }
  const text = document.createElement("span");
  text.className = "file-drag-image-name";
  text.textContent = label;
  node.append(text);
  // WKWebView does not deliver pointer or drag coordinates while a native drag
  // is running, so a DOM chip cannot follow the cursor. The system drag image can.
  // Keep the source in the viewport until the snapshot is taken.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;z-index:80;pointer-events:none;";
  host.append(node);
  document.body.append(host);
  const height = node.offsetHeight || 28;
  try {
    data.setDragImage(node, 14, Math.max(14, Math.round(height / 2)));
  } catch {
    // A missing drag image should not cancel the move.
  }
  setTimeout(() => host.remove(), 0);
}

function fileNodeMap(childrenOf: Record<string, Entry[]>): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (const rows of Object.values(childrenOf)) {
    for (const row of rows) map.set(row.path, row);
  }
  return map;
}

function visibleRows(childrenOf: Record<string, Entry[]>, expanded: Record<string, boolean>): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string) => {
    for (const row of childrenOf[dir] ?? []) {
      if (HEAVY_DIRS.has(row.name)) continue;
      out.push(row);
      if (row.kind === "dir" && expanded[row.path]) walk(row.path);
    }
  };
  walk("");
  return out;
}

function visibleRange(
  childrenOf: Record<string, Entry[]>,
  expanded: Record<string, boolean>,
  from: string,
  to: string,
): string[] {
  const rows = visibleRows(childrenOf, expanded);
  const a = rows.findIndex((row) => row.path === from);
  const b = rows.findIndex((row) => row.path === to);
  if (a < 0 || b < 0) return [to];
  const [start, end] = a < b ? [a, b] : [b, a];
  return rows.slice(start, end + 1).map((row) => row.path);
}

function GitPane({
  branches,
  summary,
  identity,
  history,
  branchError,
  switching,
  busy,
  onSwitch,
  onCreate,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onIdentity,
  onSync,
  onStash,
  onShow,
  workspacePath,
  worktrees,
  onOpenWorkspace,
  onCreateWorktree,
  onRemoveWorktree,
  changes,
  selected,
  onOpen,
  onOpenAll,
}: {
  branches: GitBranches;
  summary: GitRepoSummary | null;
  identity: GitIdentity | null;
  history: GitCommit[];
  branchError: string | null;
  switching: boolean;
  busy: boolean;
  onSwitch: (name: string) => void;
  onCreate: (name: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onCommit: (message: string) => void;
  onIdentity: (name: string, email: string) => void;
  onSync: (action: "fetch" | "pull" | "push" | "publish") => void;
  onStash: (action: "push" | "pop" | "list") => void;
  onShow: (hash: string) => Promise<string>;
  workspacePath: string;
  worktrees: GitWorktree[];
  onOpenWorkspace?: (path: string) => void;
  onCreateWorktree: (branch: string) => void;
  onRemoveWorktree: (path: string) => void;
  changes: GitChange[];
  selected: string | null;
  onOpen: (row: GitChange, mode?: "preview" | "pin") => void;
  onOpenAll: () => void;
}) {
  const [view, setView] = useState<GitChangesView>(loadGitChangesView);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [commitText, setCommitText] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const tree = view === "tree" ? gitChangesTree(changes) : [];
  const totals = gitChangeTotals(changes);
  const staged = changes.filter((row) => row.staged);
  const unstaged = changes.filter((row) => !row.staged || row.unstaged || row.status === "untracked");
  const repo = branches.repo !== false && (summary?.repo !== false);

  useEffect(() => {
    if (!identity) return;
    setName(identity.name);
    setEmail(identity.email);
  }, [identity]);

  useEffect(() => {
    if (!moreOpen) return;
    function onDoc(ev: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(ev.target as Node)) setMoreOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  function setChangesView(next: GitChangesView) {
    setView(next);
    saveGitChangesView(next);
  }

  return (
    <>
      <div className="shrink-0 px-1.5 pt-1">
        <BranchSwitch
          current={summary?.detached ? summary.commit : branches.current}
          names={branches.branches}
          switching={switching}
          onSwitch={onSwitch}
          upstream={summary?.upstream ?? null}
          ahead={summary?.ahead ?? 0}
          behind={summary?.behind ?? 0}
          workspace={workspacePath}
          worktrees={repo ? worktrees : []}
          busy={busy}
          onOpenWorktree={(path) => onOpenWorkspace?.(path)}
          onCreateWorktree={onCreateWorktree}
          onRemoveWorktree={onRemoveWorktree}
        />
        {branchError ? <p className="px-2 pt-1 text-[11px] text-err">{branchError}</p> : null}
        {repo ? (
          <div className="mt-0.5 flex items-center gap-0.5 rounded-[8px] bg-wash/70 px-0.5 py-0.5">
            <GitIconButton label="Fetch" icon="arrow.2.circlepath" disabled={busy} onClick={() => onSync("fetch")} />
            <GitIconButton label="Pull" icon="square.and.arrow.down" disabled={busy} onClick={() => onSync("pull")} />
            <GitIconButton
              label={summary?.upstream ? "Push" : "Publish branch"}
              icon="square.and.arrow.up"
              disabled={busy}
              onClick={() => onSync(summary?.upstream ? "push" : "publish")}
            />
            <div className="relative ml-auto" ref={moreRef}>
              <GitIconButton
                label="More"
                icon="ellipsis"
                pressed={moreOpen}
                disabled={busy}
                onClick={() => setMoreOpen((open) => !open)}
              />
              {moreOpen ? (
                <div
                  role="menu"
                  aria-label="Git actions"
                  className="absolute top-full right-0 z-20 mt-1 min-w-[148px] rounded-md border border-line bg-canvas py-1 shadow-card"
                >
                  <GitMenuItem
                    label="Stash changes"
                    disabled={changes.length === 0}
                    onClick={() => {
                      setMoreOpen(false);
                      onStash("push");
                    }}
                  />
                  <GitMenuItem
                    label="Pop stash"
                    onClick={() => {
                      setMoreOpen(false);
                      onStash("pop");
                    }}
                  />
                  <GitMenuItem
                    label="New branch"
                    onClick={() => {
                      setMoreOpen(false);
                      setShowNew(true);
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {showNew ? (
          <form
            className="flex gap-1 px-0.5 pt-1"
            onSubmit={(ev) => {
              ev.preventDefault();
              const next = newBranch.trim();
              if (!next) return;
              onCreate(next);
              setNewBranch("");
              setShowNew(false);
            }}
          >
            <input
              value={newBranch}
              onChange={(ev) => setNewBranch(ev.target.value)}
              placeholder="feature/name"
              className="min-w-0 flex-1 rounded-[6px] bg-wash px-2 py-1 text-[12px] text-ink outline-none placeholder:text-muted/70"
            />
            <GitAction label="Create" disabled={busy || !newBranch.trim()} onClick={() => undefined} submit />
            <button
              type="button"
              onClick={() => {
                setShowNew(false);
                setNewBranch("");
              }}
              className="rounded-[6px] px-1.5 text-[11px] text-muted hover:bg-wash hover:text-ink"
            >
              Cancel
            </button>
          </form>
        ) : null}
      </div>
      {repo && identity && !identity.configured ? (
        <form
          className="grid gap-1 px-2.5 pt-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (name.trim() && email.trim()) onIdentity(name.trim(), email.trim());
          }}
        >
          <p className="text-[11px] text-muted">Set a name and email for this repo before committing.</p>
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Name" className="rounded-[6px] bg-wash px-2 py-1 text-[12px] outline-none" />
          <input value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="Email" className="rounded-[6px] bg-wash px-2 py-1 text-[12px] outline-none" />
          <GitAction label="Save identity" disabled={busy || !name.trim() || !email.trim()} onClick={() => undefined} submit />
        </form>
      ) : null}
      {changes.length > 0 ? (
        <div className="shrink-0 px-1.5 pt-1.5">
          <button
            type="button"
            onClick={onOpenAll}
            className={`flex w-full items-center gap-1.5 rounded-[7px] px-2 py-[5px] text-left text-[12px] ${
              selected === ALL_DIFF_PATH ? "bg-wash-strong text-ink" : "text-ink hover:bg-wash"
            }`}
          >
            <Symbol name="doc" className="size-3.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate font-medium">View diff</span>
            {totals.additions > 0 ? (
              <span className="rounded bg-ok/12 px-1 font-mono text-[10px] font-medium text-ok tabular-nums">+{formatDiffCount(totals.additions)}</span>
            ) : null}
            {totals.deletions > 0 ? (
              <span className="rounded bg-err/12 px-1 font-mono text-[10px] font-medium text-err tabular-nums">-{formatDiffCount(totals.deletions)}</span>
            ) : null}
          </button>
          <form
            className="mt-1 grid gap-1"
            onSubmit={(ev) => {
              ev.preventDefault();
              const text = message.trim();
              if (!text || staged.length === 0) return;
              onCommit(text);
              setMessage("");
            }}
          >
            <textarea
              value={message}
              onChange={(ev) => setMessage(ev.target.value)}
              placeholder={staged.length ? "Commit message" : "Stage files to commit"}
              rows={2}
              className="resize-none rounded-[6px] bg-wash px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-muted/70"
            />
            <div className="flex items-center gap-1">
              <GitAction label={unstaged.length ? `Stage ${unstaged.length}` : "Stage"} disabled={busy || unstaged.length === 0} onClick={() => onStage(unstaged.map((row) => row.path))} />
              <GitAction label="Unstage" disabled={busy || staged.length === 0} onClick={() => onUnstage(staged.map((row) => row.path))} />
              <span className="ml-auto">
                <GitIconButton
                  label="Discard all changes"
                  icon="trash"
                  disabled={busy || changes.length === 0}
                  onClick={() => {
                    if (window.confirm("Discard all local changes? This cannot be undone.")) onDiscard(changes.map((row) => row.path));
                  }}
                />
              </span>
              <button
                type="submit"
                disabled={busy || !message.trim() || staged.length === 0}
                className="rounded-[6px] bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:bg-wash disabled:text-muted disabled:opacity-100"
              >
                {busy ? "Working…" : "Commit"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      <div className="mt-1 flex h-7 shrink-0 items-center justify-between gap-2 border-t border-line/40 px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">Changes</span>
          <div className="flex items-center rounded-[6px] bg-wash p-px" role="group" aria-label="Change list layout">
            <button
              type="button"
              aria-pressed={view === "list"}
              aria-label="List view"
              title="List"
              onClick={() => setChangesView("list")}
              className={`flex size-5 items-center justify-center rounded-[5px] ${
                view === "list" ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              <Symbol name="list.bullet" className="size-3" />
            </button>
            <button
              type="button"
              aria-pressed={view === "tree"}
              aria-label="Tree view"
              title="Tree"
              onClick={() => setChangesView("tree")}
              className={`flex size-5 items-center justify-center rounded-[5px] ${
                view === "tree" ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              <Symbol name="list.tree" className="size-3" />
            </button>
          </div>
        </div>
        <span className="rounded-full bg-wash px-1.5 py-px text-[10px] font-medium text-muted tabular-nums">{changes.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {changes.length === 0 ? (
          <p className="px-2 py-1 text-[12px] text-muted">No changes</p>
        ) : view === "tree" ? (
          tree.map((node) => (
            <ChangeTree
              key={node.kind === "dir" ? node.path : node.change.path}
              node={node}
              depth={0}
              selected={selected}
              collapsed={collapsed}
              onToggle={(path) => setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))}
              onOpen={onOpen}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))
        ) : (
          changes.map((row) => (
            <ChangeFileRow
              key={`${row.path}-${row.staged}`}
              row={row}
              label={changeLabel(row)}
              selected={selected === row.path}
              pad={8}
              onOpen={onOpen}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))
        )}
      </div>
      {history.length ? (
        <div className="mt-auto flex h-[7.25rem] max-h-[32%] shrink-0 flex-col border-t border-line/60 bg-canvas/30">
          <div className="flex h-6 shrink-0 items-center justify-between px-3">
            <span className="text-[10px] font-semibold tracking-[0.06em] text-muted uppercase">History</span>
            <span className="text-[10px] text-muted/80 tabular-nums">{history.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-1.5">
            {history.map((row) => {
              const open = commitText !== null && commitHash === row.hash;
              const when = relativeCommitTime(row.at);
              return (
                <button
                  key={row.hash}
                  type="button"
                  title={`${row.short} ${row.subject}\n${row.author}${when ? ` · ${when}` : ""}`}
                  onClick={() => {
                    if (open) {
                      setCommitHash(null);
                      setCommitText(null);
                      return;
                    }
                    setCommitHash(row.hash);
                    void onShow(row.hash).then(setCommitText).catch((e) => setCommitText(String(e)));
                  }}
                  className={`flex w-full items-center gap-1.5 rounded-[5px] px-1.5 py-[2px] text-left text-[11px] leading-4 ${
                    open ? "bg-wash-strong" : "hover:bg-wash"
                  }`}
                >
                  <span className="w-12 shrink-0 font-mono text-[10px] text-accent/80">{row.short}</span>
                  <span className="min-w-0 flex-1 truncate text-ink/85">{row.subject}</span>
                  {when ? <span className="shrink-0 text-[10px] text-muted/70">{when}</span> : null}
                </button>
              );
            })}
            {commitText ? (
              <pre className="mt-1 max-h-32 overflow-auto rounded-[6px] bg-wash px-2 py-1 font-mono text-[10px] leading-snug whitespace-pre-wrap text-ink/75">{commitText}</pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function GitIconButton({
  label,
  icon,
  disabled,
  pressed,
  onClick,
}: {
  label: string;
  icon: "arrow.2.circlepath" | "square.and.arrow.down" | "square.and.arrow.up" | "ellipsis" | "trash";
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <span className="group/tip relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={`flex size-6 items-center justify-center rounded-[6px] hover:bg-wash hover:text-ink disabled:opacity-40 ${
          pressed ? "bg-wash-strong text-ink" : "text-muted"
        }`}
      >
        <Symbol name={icon} className="size-3.5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full left-1/2 z-30 mt-1 hidden -translate-x-1/2 rounded-md border border-line/25 bg-canvas px-2 py-1 text-[11px] whitespace-nowrap text-ink shadow-card group-hover/tip:block"
      >
        {label}
      </span>
    </span>
  );
}

function GitMenuItem({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-inset disabled:cursor-default disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function GitAction({
  label,
  disabled,
  onClick,
  submit,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  submit?: boolean;
}) {
  return (
    <button
      type={submit ? "submit" : "button"}
      disabled={disabled}
      onClick={submit ? undefined : onClick}
      className="rounded-[6px] border border-line/50 bg-panel px-2 py-1 text-[11px] font-medium text-ink hover:border-line hover:bg-wash-strong disabled:border-transparent disabled:bg-wash disabled:text-muted disabled:opacity-100"
    >
      {label}
    </button>
  );
}

function changeLabel(row: GitChange): string {
  if (row.original && row.original !== row.path) return `${row.original} → ${row.path}`;
  return row.path;
}

function ChangeTree({
  node,
  depth,
  selected,
  collapsed,
  onToggle,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
}: {
  node: GitChangeTreeNode<GitChange>;
  depth: number;
  selected: string | null;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
  onOpen: (row: GitChange, mode?: "preview" | "pin") => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
}) {
  if (node.kind === "file") {
    return (
      <ChangeFileRow
        row={node.change}
        label={node.name}
        selected={selected === node.change.path}
        pad={8 + depth * 12}
        onOpen={onOpen}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
      />
    );
  }

  const open = !collapsed[node.path];
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className="flex w-full items-center gap-1 rounded-[6px] py-[3px] pr-2 text-left text-[12px] text-ink/90 select-none hover:bg-wash"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <Symbol name={open ? "chevron.down" : "chevron.right"} className="size-3 text-muted" />
        <Symbol name="folder.fill" className="size-3.5 text-ok" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      {open
        ? node.children.map((child) => (
            <ChangeTree
              key={child.kind === "dir" ? child.path : child.change.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))
        : null}
    </div>
  );
}

function ChangeFileRow({
  row,
  label,
  selected,
  pad,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
}: {
  row: GitChange;
  label: string;
  selected: boolean;
  pad: number;
  onOpen: (row: GitChange, mode?: "preview" | "pin") => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
}) {
  return (
    <div
      className={`group/change flex w-full items-center gap-1 rounded-[6px] py-[2px] pr-1 text-left text-[12px] select-none ${
        selected ? "bg-wash-strong" : "hover:bg-wash"
      }`}
      style={{ paddingLeft: pad }}
    >
      <button
        type="button"
        onClick={() => onOpen(row, "preview")}
        onDoubleClick={() => onOpen(row, "pin")}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-[2px] text-left"
      >
        <span className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] text-[9px] font-semibold ${statusChip(row.status)}`}>
          {statusMark(row.status)}
        </span>
        <FileIcon name={row.path} className="size-3.5 text-muted" />
        <span className="min-w-0 flex-1 truncate text-ink/90" title={row.original ? `${row.original} → ${row.path}` : row.path}>
          {label}
        </span>
        {row.staged ? <span className="shrink-0 rounded bg-accent/12 px-1 text-[9px] font-medium text-accent">staged</span> : null}
        <GitLineStats {...gitLineStats(row)} />
      </button>
      <button
        type="button"
        title={row.staged && !row.unstaged ? "Unstage" : "Stage"}
        aria-label={row.staged && !row.unstaged ? "Unstage" : "Stage"}
        onClick={() => (row.staged && !row.unstaged ? onUnstage([row.path]) : onStage([row.path]))}
        className="hidden size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-wash-strong hover:text-ink group-hover/change:flex"
      >
        <Symbol name={row.staged && !row.unstaged ? "xmark" : "plus"} className="size-3" />
      </button>
      <button
        type="button"
        title="Discard"
        aria-label="Discard"
        onClick={() => {
          if (window.confirm(`Discard changes in ${row.path}?`)) onDiscard([row.path]);
        }}
        className="hidden size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-wash-strong hover:text-err group-hover/change:flex"
      >
        <Symbol name="arrow.2.circlepath" className="size-3" />
      </button>
    </div>
  );
}

const GIT_MENU_EASE = [0.22, 1, 0.36, 1] as const;

function BranchSwitch({
  current,
  names,
  switching,
  onSwitch,
  upstream,
  ahead,
  behind,
  workspace,
  worktrees,
  busy,
  onOpenWorktree,
  onCreateWorktree,
  onRemoveWorktree,
}: {
  current: string | null;
  names: string[];
  switching: boolean;
  onSwitch: (name: string) => void;
  upstream: string | null;
  ahead: number;
  behind: number;
  workspace: string;
  worktrees: GitWorktree[];
  busy: boolean;
  onOpenWorktree: (path: string) => void;
  onCreateWorktree: (branch: string) => void;
  onRemoveWorktree: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const here = worktrees.find((row) => sameGitPath(row.path, workspace)) ?? null;
  const label = here
    ? here.detached
      ? "detached"
      : here.branch || current || folderName(here.path)
    : current || (names.length ? "Detached HEAD" : "No git repo");
  const canOpen = (names.length > 0 || worktrees.length > 0) && !switching;
  const checkedOut = new Set(
    worktrees.map((row) => (row.detached ? "" : row.branch || "")).filter(Boolean),
  );
  const otherBranches = names.filter((name) => name !== current && !checkedOut.has(name));

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  function close() {
    setOpen(false);
    setNaming(false);
    setDraft("");
  }

  function createWorktree() {
    const name = draft.trim();
    if (!name || busy) return;
    close();
    onCreateWorktree(name);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        ref={button}
        type="button"
        disabled={!canOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        title={here?.path || (current ? `Branch ${current}` : label)}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        className={`flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] hover:bg-wash disabled:opacity-50 ${
          open ? "bg-wash text-ink" : "text-ink"
        }`}
      >
        <Symbol name="arrow.triangle.branch" className="size-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate font-medium">{switching ? "Switching…" : label}</span>
        {ahead > 0 ? <span className="shrink-0 text-[10px] font-medium text-ok">↑{ahead}</span> : null}
        {behind > 0 ? <span className="shrink-0 text-[10px] font-medium text-warn">↓{behind}</span> : null}
        {canOpen ? <Symbol name="chevron.down" className={`size-2.5 shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`} /> : null}
      </button>
      <GitPopMenu open={open} anchor={button} label="Branches and worktrees">
        <div className="max-h-72 overflow-auto py-1">
          {worktrees.length ? (
            <>
              <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-[0.04em] text-muted uppercase">Worktrees</p>
              {worktrees.map((row) => {
                const selected = sameGitPath(row.path, workspace);
                const name = row.detached ? "detached" : row.branch || folderName(row.path);
                return (
                  <div key={row.path} className="group/wt flex items-center pr-1 hover:bg-wash">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      title={row.path}
                      disabled={selected}
                      onClick={() => {
                        close();
                        onOpenWorktree(row.path);
                      }}
                      className={`flex h-7 min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-[12px] disabled:opacity-100 ${
                        selected ? "font-medium text-ink" : "text-ink/80"
                      }`}
                    >
                      <Symbol name="arrow.triangle.branch" className={`size-3.5 shrink-0 ${selected ? "text-accent" : "text-muted"}`} />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-[10px] font-normal text-muted">{row.main ? "main" : folderName(row.path)}</span>
                      <Symbol name="checkmark" className={`size-3 shrink-0 text-accent ${selected ? "opacity-100" : "opacity-0"}`} />
                    </button>
                    {!row.main && !selected ? (
                      <button
                        type="button"
                        aria-label={`Remove worktree ${name}`}
                        title="Remove worktree"
                        disabled={busy}
                        onClick={() => onRemoveWorktree(row.path)}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-wash-strong hover:text-err group-hover/wt:opacity-100 disabled:opacity-40"
                      >
                        <Symbol name="xmark" className="size-3" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : null}
          {otherBranches.length ? (
            <>
              <p className={`px-2.5 pb-0.5 text-[10px] font-semibold tracking-[0.04em] text-muted uppercase ${worktrees.length ? "pt-2" : "pt-1"}`}>
                Branches
              </p>
              {otherBranches.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="menuitem"
                  title={upstream && name === current ? upstream : undefined}
                  onClick={() => {
                    close();
                    onSwitch(name);
                  }}
                  className="flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px] text-ink/80 transition-colors duration-150 hover:bg-wash"
                >
                  <Symbol name="arrow.triangle.branch" className="size-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </button>
              ))}
            </>
          ) : null}
          {!worktrees.length && !otherBranches.length ? (
            <p className="px-2.5 py-2 text-[12px] text-muted">No other branches</p>
          ) : null}
        </div>
        <div className="border-t border-line/20 p-1">
          {naming ? (
            <div className="px-1 py-0.5">
              <input
                ref={field}
                value={draft}
                aria-label="New worktree name"
                placeholder="feat/name"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    createWorktree();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setNaming(false);
                    setDraft("");
                  }
                }}
                className="h-7 w-full bg-transparent px-1.5 text-[12px] text-ink outline-none placeholder:text-muted"
              />
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => setNaming(true)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink/80 hover:bg-wash disabled:opacity-40"
            >
              <Symbol name="plus" className="size-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">New worktree</span>
            </button>
          )}
        </div>
      </GitPopMenu>
    </div>
  );
}

function GitPopMenu({
  open,
  anchor,
  label,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  children: ReactNode;
}) {
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const frame = anchor.current?.getBoundingClientRect();
    if (!frame) return;
    setAbove(frame.bottom + 280 > window.innerHeight && frame.top > 280);
  }, [open, anchor]);
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="menu"
          aria-label={label}
          initial={{ opacity: 0, y: above ? 6 : -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: above ? 6 : -6 }}
          transition={{ duration: 0.16, ease: GIT_MENU_EASE }}
          className={`absolute right-0 left-0 z-30 overflow-hidden rounded-lg border border-line/25 bg-canvas shadow-card ${
            above ? "bottom-full mb-1 origin-bottom" : "top-full mt-1 origin-top"
          }`}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function sameGitPath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function Tree({
  path,
  depth,
  expanded,
  childrenOf,
  selected,
  activePath,
  renaming,
  creating,
  newFileParent,
  dropTarget,
  dragPaths,
  changes,
  dirtyDirs,
  nodeMap,
  onToggle,
  onSelect,
  onOpen,
  onRenameCommit,
  onCreateCommit,
  onNewFileCommit,
  onNewFileCancel,
  onContext,
  onDragPaths,
  onDragChange,
  dragPathsRef,
  onDropTarget,
  onMove,
}: {
  path: string;
  depth: number;
  expanded: Record<string, boolean>;
  childrenOf: Record<string, Entry[]>;
  selected: string[];
  activePath: string | null;
  renaming: string | null;
  creating: string | null;
  newFileParent: string | null;
  dropTarget: string | null;
  dragPaths: string[] | null;
  changes: ReturnType<typeof gitChangeMap>;
  dirtyDirs: Set<string>;
  nodeMap: Map<string, Entry>;
  onToggle: (path: string) => void;
  onSelect: (path: string, kind: string, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  onOpen: (path: string, mode?: "preview" | "pin") => void;
  onRenameCommit: (path: string, name: string) => void;
  onCreateCommit: (path: string, name: string) => void;
  onNewFileCommit: (parent: string, name: string) => void;
  onNewFileCancel: () => void;
  onContext: (path: string, x: number, y: number) => void;
  onDragPaths: (path: string) => string[];
  onDragChange: (paths: string[] | null) => void;
  dragPathsRef: RefObject<string[] | null>;
  onDropTarget: (path: string | null) => void;
  onMove: (paths: string[], dest: string) => void;
}) {
  const rows = (childrenOf[path] ?? []).filter((row) => !HEAVY_DIRS.has(row.name));

  return (
    <div className="flex flex-col gap-px">
      {newFileParent === path ? (
        <NewFileRow depth={depth} onCommit={(name) => onNewFileCommit(path, name)} onCancel={onNewFileCancel} />
      ) : null}
      {rows.map((row, index) => {
        const isDir = row.kind === "dir";
        const open = Boolean(expanded[row.path]);
        const change = isDir ? undefined : gitChangeForPath(changes, row.path);
        const dirty = Boolean(change) || (isDir && dirtyDirs.has(row.path));
        const stats = gitLineStats(change);
        const on = selected.includes(row.path) || activePath === row.path;
        const prev = rows[index - 1];
        const separated = on && Boolean(prev && (selected.includes(prev.path) || activePath === prev.path));
        const editing = renaming === row.path || creating === row.path;
        const dragging = Boolean(dragPaths?.includes(row.path));
        const dropHere = Boolean(isDir && dropTarget === row.path);
        return (
          <div key={row.path} className={`file-branch ${separated ? "mt-1" : ""}`}>
            <div
              data-path={row.path}
              data-kind={row.kind}
              draggable={!editing}
              onDragStart={(ev) => {
                const paths = onDragPaths(row.path);
                if (!canMoveSelection(paths, nodeMap)) {
                  ev.preventDefault();
                  return;
                }
                ev.dataTransfer.setData(FILE_DRAG_TYPE, paths.join("\n"));
                ev.dataTransfer.setData("text/plain", paths.join("\n"));
                ev.dataTransfer.effectAllowed = "move";
                const preview = dragPreviewLabel(paths, nodeMap);
                setFileDragImage(
                  ev.dataTransfer,
                  ev.currentTarget,
                  preview.count > 1 ? `${preview.count} items` : preview.name,
                );
                onDragChange(paths);
              }}
              onDragEnd={() => {
                markFileDrop(null);
                onDragChange(null);
                onDropTarget(null);
              }}
              onContextMenu={(ev) => {
                ev.preventDefault();
                onContext(row.path, ev.clientX, ev.clientY);
              }}
              onClick={(ev) => {
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey) {
                  onSelect(row.path, row.kind, ev);
                  return;
                }
                if (isDir) onToggle(row.path);
                else onSelect(row.path, row.kind, ev);
              }}
              onDoubleClick={() => {
                if (!isDir) onOpen(row.path, "pin");
              }}
              className={`file-row flex w-full items-center gap-1 rounded-[6px] py-[3px] pr-2 text-left text-[12px] select-none hover:bg-wash ${
                editing ? "cursor-text" : "cursor-grab"
              } ${on ? "bg-wash-strong" : ""} ${dragging ? "opacity-40" : ""} ${
                dropHere ? FILE_DROP_CLASS : ""
              } ${dirty && !dropHere ? "text-ok" : "text-ink/90"}`}
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-1">
                {isDir ? (
                  <Symbol name={open ? "chevron.down" : "chevron.right"} className="size-3 text-muted" />
                ) : (
                  <span className="inline-block w-3" />
                )}
                {isDir ? (
                  <Symbol name="folder.fill" className={`size-3.5 ${dirty ? "text-ok" : "text-accent"}`} />
                ) : (
                  <FileIcon name={row.name} className="size-3.5 text-muted" />
                )}
                {editing ? (
                  <NameField
                    value={row.name}
                    onCommit={(name) => (creating === row.path ? onCreateCommit(row.path, name) : onRenameCommit(row.path, name))}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                )}
              </span>
              {isDir ? <span className="file-drop-label">Move here</span> : null}
              {!isDir && !editing ? <GitLineStats additions={stats.additions} deletions={stats.deletions} /> : null}
            </div>
            {isDir && open && (
              <Tree
                path={row.path}
                depth={depth + 1}
                expanded={expanded}
                childrenOf={childrenOf}
                selected={selected}
                activePath={activePath}
                renaming={renaming}
                creating={creating}
                newFileParent={newFileParent}
                dropTarget={dropTarget}
                dragPaths={dragPaths}
                changes={changes}
                dirtyDirs={dirtyDirs}
                nodeMap={nodeMap}
                onToggle={onToggle}
                onSelect={onSelect}
                onOpen={onOpen}
                onRenameCommit={onRenameCommit}
                onCreateCommit={onCreateCommit}
                onNewFileCommit={onNewFileCommit}
                onNewFileCancel={onNewFileCancel}
                onContext={onContext}
                onDragPaths={onDragPaths}
                onDragChange={onDragChange}
                dragPathsRef={dragPathsRef}
                onDropTarget={onDropTarget}
                onMove={onMove}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function NewFileRow({
  depth,
  onCommit,
  onCancel,
}: {
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  function commit() {
    if (done.current) return;
    const name = draft.trim();
    if (!name) {
      done.current = true;
      onCancel();
      return;
    }
    if (!validNewFileName(name)) {
      setInvalid(true);
      ref.current?.focus();
      return;
    }
    done.current = true;
    onCommit(name);
  }
  return (
    <div
      className="file-row flex w-full items-center gap-1 rounded-[6px] bg-wash-strong py-[3px] pr-2 text-left text-[12px]"
      style={{ paddingLeft: 8 + depth * 12 }}
      onMouseDown={(ev) => ev.stopPropagation()}
    >
      <span className="inline-block w-3" />
      <FileIcon name={draft.trim() || "file.txt"} className="size-3.5 text-muted" />
      <input
        ref={ref}
        value={draft}
        aria-label="New file name"
        aria-invalid={invalid}
        placeholder="name.ext"
        onChange={(ev) => {
          setDraft(ev.target.value);
          setInvalid(false);
        }}
        onClick={(ev) => ev.stopPropagation()}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            commit();
          }
          if (ev.key === "Escape") {
            ev.preventDefault();
            onCancel();
          }
        }}
        className={`min-w-0 flex-1 rounded bg-canvas px-1 text-[12px] text-ink outline-none ring-1 select-text placeholder:text-muted ${
          invalid ? "ring-err" : "ring-accent"
        }`}
      />
    </div>
  );
}

function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  }, [value]);
  return (
    <input
      ref={ref}
      value={draft}
      onChange={(ev) => setDraft(ev.target.value)}
      onClick={(ev) => ev.stopPropagation()}
      onDoubleClick={(ev) => ev.stopPropagation()}
      onBlur={() => onCommit(draft)}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") onCommit(draft);
        if (ev.key === "Escape") onCommit(value);
      }}
      className="min-w-0 flex-1 rounded bg-canvas px-1 text-[12px] text-ink outline-none ring-1 ring-accent select-text"
    />
  );
}

function GitLineStats({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions <= 0 && deletions <= 0) return null;
  const parts = [
    additions > 0 ? `+${additions}` : "",
    deletions > 0 ? `-${deletions}` : "",
  ].filter(Boolean);
  return (
    <span
      className="flex shrink-0 items-baseline gap-1 font-mono text-[10px] leading-none tabular-nums"
      title={parts.join(" ")}
    >
      {additions > 0 ? <span className="text-ok">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-err">-{deletions}</span> : null}
    </span>
  );
}

function relativeCommitTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}

function statusMark(status: string): string {
  if (status === "added" || status === "untracked") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  if (status === "conflict") return "!";
  return "M";
}

function statusChip(status: string): string {
  if (status === "added" || status === "untracked") return "bg-ok/15 text-ok";
  if (status === "deleted" || status === "conflict") return "bg-err/15 text-err";
  if (status === "renamed") return "bg-accent/15 text-accent";
  return "bg-warn/15 text-warn";
}
