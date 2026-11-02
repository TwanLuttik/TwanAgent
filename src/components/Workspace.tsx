import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { oneGroupRepo } from "../lib/all-projects";
import { useGroupMembers } from "../lib/project-groups";
import { ALL_DIFF_PATH } from "../lib/editor";
import {
  canDropOnDir,
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
import { openPane, type PaneKind, type PaneState } from "../lib/pane";
import { shellSessionId } from "../lib/shell-sessions";
import { shellSessions } from "../lib/shell-terminal";
import { loadOpenFileTree, saveOpenFileTree } from "../lib/prefs";
import * as api from "../lib/tauri";
import type { Entry, GitBranches, GitChange, GitCommit, GitIdentity, GitRepoSummary, GitWorktree } from "../lib/tauri";
import { Terminal } from "./Terminal";
import { fileNodeMap } from "./workspace/fileNodes";
import { FilesPane, visibleRange } from "./workspace/FilesPane";
import { GitPane } from "./workspace/GitPane";
import { PaneTabs } from "./workspace/PaneTabs";

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
  const groupMembers = useGroupMembers(workspace);
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
    if (groupMembers) {
      setBranches({ current: null, branches: [], repo: false });
      setSummary(null);
      setIdentity(null);
      setHistory([]);
      setWorktrees([]);
      setBranchError(null);
      return;
    }
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
      const text = String(e);
      if (text.includes("open that repository")) {
        setBranchError(null);
        return;
      }
      setBranchError(text);
    }
  }, [workspace, groupMembers]);

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

  async function inMember(paths: string[], run: (root: string, paths: string[]) => Promise<unknown>) {
    if (!groupMembers) return run(workspace, paths);
    const split = oneGroupRepo(groupMembers, paths);
    if ("error" in split) throw new Error(split.error);
    return run(split.path, split.paths);
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
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas"
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
                  grouped={Boolean(groupMembers)}
                  onStage={(paths) => void runGit(() => inMember(paths, api.gitStage))}
                  onUnstage={(paths) => void runGit(() => inMember(paths, api.gitUnstage))}
                  onDiscard={(paths) => void runGit(() => inMember(paths, api.gitDiscard))}
                  onCommit={(message) => void runGit(async () => {
                    if (!groupMembers) return api.gitCommit(workspace, message);
                    const staged = changes.filter((row) => row.staged).map((row) => row.path);
                    const split = oneGroupRepo(groupMembers, staged);
                    if ("error" in split) throw new Error(split.error);
                    return api.gitCommit(split.path, message);
                  })}
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
