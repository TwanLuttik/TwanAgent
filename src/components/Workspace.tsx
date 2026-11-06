import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { afterInput } from "../lib/after-input";
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

type PaneAct = {
  toggle: (path: string) => void;
  selectRow: (path: string, kind: string, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  openFile: (path: string, mode?: "preview" | "pin", view?: "edit" | "diff") => void;
  rename: (path: string) => void;
  renameEntry: (path: string, name: string) => void;
  nameCreated: (path: string, name: string) => void;
  removeEntries: (paths: string[]) => void;
  moveEntries: (paths: string[], dest: string) => void;
  makeFolder: (parent: string) => void;
  startNewFile: (parent: string) => void;
  makeFile: (parent: string, name: string) => void;
  cancelNewFile: () => void;
  switchBranch: (name: string) => void;
  createBranch: (name: string) => void;
  stage: (paths: string[]) => void;
  unstage: (paths: string[]) => void;
  discard: (paths: string[]) => void;
  commit: (message: string) => void;
  setIdentity: (name: string, email: string) => void;
  sync: (action: "fetch" | "pull" | "push" | "publish") => void;
  stash: (action: "push" | "pop" | "list") => void;
  show: (hash: string) => Promise<string>;
  createWorktree: (branch: string) => void;
  removeWorktree: (path: string) => void;
  openChange: (change: GitChange, mode?: "preview" | "pin") => void;
  openAllDiff: () => void;
  openWorkspace?: (path: string) => void;
};

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
  // Terminals stay unmounted until the conversation can take a click. The shell
  // is created in xterm, which blocks the main thread.
  const [terminalReady, setTerminalReady] = useState(true);
  const [structureTick, setStructureTick] = useState(0);
  const refreshGen = useRef(0);
  const branchGen = useRef(0);
  const lastStatsAt = useRef<number | null>(null);
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeKindRef = useRef<string | null>(null);
  const switchedToGitRef = useRef(false);
  const act = useRef<PaneAct>(null!);
  const [boundWorkspace, setBoundWorkspace] = useState(workspace);
  let projectChanged = false;
  if (filePaneNeedsReload(boundWorkspace, workspace)) {
    // Drop the previous project's rows before paint. Doing this in an effect
    // left that tree, and its terminal, on screen for the commit that swaps.
    projectChanged = true;
    setBoundWorkspace(workspace);
    refreshGen.current += 1;
    branchGen.current += 1;
    setExpanded(openTreeState(loadOpenFileTree(workspace)));
    setPaneState(paneForWorkspace(workspace));
    setSelected([]);
    setRenaming(null);
    setCreating(null);
    setNewFileParent(null);
    setTreeReady(false);
    setTerminalReady(false);
    setChildren({});
    setChanges([]);
    setBranches({ current: null, branches: [] });
    setSummary(null);
    setIdentity(null);
    setHistory([]);
    setWorktrees([]);
    setBranchError(null);
    setError(null);
    setGitMissing(false);
  }
  const activeKind = pane.tabs.find((tab) => tab.id === pane.activeId)?.kind ?? null;
  // Set during render so the refresh this tab change recreates still requests stats.
  if (switchedOntoGitTab(activeKindRef.current, activeKind)) switchedToGitRef.current = true;
  activeKindRef.current = activeKind;
  if (projectChanged) {
    // The pass above still sees the previous pane. Stats belong to the project
    // that actually commits, which is the render after this reset.
    switchedToGitRef.current = false;
    lastStatsAt.current = null;
  }
  const fileRefresh = useSyncExternalStore(subscribeFileRefresh, fileRefreshRevision, fileRefreshRevision);

  const loadDir = useCallback(
    async (path: string) => {
      const gen = refreshGen.current;
      const rows = await api.listDir(workspace, path);
      // A listing started for the project we just left must not land on this one.
      if (gen !== refreshGen.current) return;
      startTransition(() => {
        if (gen !== refreshGen.current) return;
        setChildren((prev) => ({ ...prev, [path]: rows }));
      });
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
    let nextGit: { rows: GitChange[]; missing: boolean } | null = null;
    try {
      nextGit = await gitResult;
    } catch (e) {
      gitFailed = true;
      if (gen === refreshGen.current) {
        const text = String(e);
        startTransition(() => {
          if (gen === refreshGen.current) setError(text);
        });
      }
    }
    if (gen !== refreshGen.current) return;
    const listError = listed.find((row) => row.failed)?.failed ?? "";
    if (listError) gitFailed = true;
    const gone = listed.filter((row) => row.missing).map((row) => row.path);
    // Painting a large tree is interruptible. Typing in the conversation wins.
    startTransition(() => {
      if (gen !== refreshGen.current) return;
      if (nextGit) {
        setGitMissing(nextGit.missing);
        setChanges(nextGit.rows);
      }
      if (listError) setError(listError);
      else if (!gitFailed) setError(null);
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
      setTreeReady(true);
    });
  }, [workspace, expanded, activeKind]);

  const refreshBranches = useCallback(async () => {
    if (!workspace) return;
    const gen = ++branchGen.current;
    if (groupMembers) {
      startTransition(() => {
        if (gen !== branchGen.current) return;
        setBranches({ current: null, branches: [], repo: false });
        setSummary(null);
        setIdentity(null);
        setHistory([]);
        setWorktrees([]);
        setBranchError(null);
      });
      return;
    }
    try {
      const [next, repo, who, log, trees] = await Promise.all([
        api.gitBranches(workspace),
        api.gitSummary(workspace).catch(() => null),
        api.gitIdentity(workspace).catch(() => null),
        api.gitLog(workspace, 30).catch(() => [] as GitCommit[]),
        api.gitWorktrees(workspace).catch(() => [] as GitWorktree[]),
      ]);
      if (gen !== branchGen.current) return;
      startTransition(() => {
        if (gen !== branchGen.current) return;
        setBranches(next);
        setSummary(repo);
        setIdentity(who);
        setHistory(log);
        setWorktrees(trees);
        setBranchError(null);
      });
    } catch (e) {
      const text = String(e);
      if (gen !== branchGen.current) return;
      startTransition(() => {
        if (gen !== branchGen.current) return;
        if (text.includes("open that repository")) {
          setBranchError(null);
          return;
        }
        setBranchError(text);
      });
    }
  }, [workspace, groupMembers]);

  useEffect(() => {
    if (terminalReady) return;
    // The file list is already in flight. The terminal opens on a later idle
    // turn so creating the shell does not sit on the same frame as that list.
    return afterInput(() => setTerminalReady(true));
  }, [terminalReady, workspace]);

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

  // Files and git each keep their own snapshot. A conversation render passes new
  // callbacks, and that must not walk the tree or the diff list again.
  const fileModel = useMemo(
    () => ({
      error,
      gitMissing,
      expanded,
      children,
      selected,
      selectedPath: selectedPath ?? null,
      renaming,
      creating,
      newFileParent,
      changes,
    }),
    [error, gitMissing, expanded, children, selected, selectedPath, renaming, creating, newFileParent, changes],
  );
  const gitModel = useMemo(
    () => ({
      branches,
      summary,
      identity,
      history,
      branchError,
      switching,
      busy: gitBusy,
      grouped: Boolean(groupMembers),
      workspace,
      worktrees,
      changes,
      selectedPath: selectedPath ?? null,
    }),
    [
      branches,
      summary,
      identity,
      history,
      branchError,
      switching,
      gitBusy,
      groupMembers,
      workspace,
      worktrees,
      changes,
      selectedPath,
    ],
  );
  act.current = {
    toggle: (path) => void toggle(path),
    selectRow,
    openFile,
    rename: setRenaming,
    renameEntry: (path, name) => void renameEntry(path, name),
    nameCreated: (path, name) => void nameCreated(path, name),
    removeEntries: (paths) => void removeEntries(paths),
    moveEntries: (paths, dest) => void moveEntries(paths, dest),
    makeFolder: (parent) => void makeFolder(parent),
    startNewFile: (parent) => {
      setExpanded((prev) => {
        const next = { ...prev, [parent]: true };
        saveOpenFileTree(workspace, openTreePaths(next));
        return next;
      });
      setNewFileParent(parent);
    },
    makeFile: (parent, name) => void makeFile(parent, name),
    cancelNewFile: () => setNewFileParent(null),
    switchBranch: (name) => void switchBranch(name),
    createBranch: (name) => void runGit(() => api.gitCreateBranch(workspace, name, true)),
    stage: (paths) => void runGit(() => inMember(paths, api.gitStage)),
    unstage: (paths) => void runGit(() => inMember(paths, api.gitUnstage)),
    discard: (paths) => void runGit(() => inMember(paths, api.gitDiscard)),
    commit: (message) =>
      void runGit(async () => {
        if (!groupMembers) return api.gitCommit(workspace, message);
        const staged = changes.filter((row) => row.staged).map((row) => row.path);
        const split = oneGroupRepo(groupMembers, staged);
        if ("error" in split) throw new Error(split.error);
        return api.gitCommit(split.path, message);
      }),
    setIdentity: (name, email) => void runGit(() => api.gitSetIdentity(workspace, name, email)),
    sync: (action) => void runGit(() => api.gitSync(workspace, action)),
    stash: (action) => void runGit(() => api.gitStash(workspace, action)),
    show: (hash) => api.gitShow(workspace, hash),
    createWorktree: (branch) =>
      void runGit(async () => {
        const added = await api.gitWorktreeAdd(workspace, branch, true);
        bumpFileRefresh();
        if (added.opened && onOpenWorkspace) onOpenWorkspace(added.opened);
        return added;
      }),
    removeWorktree: (path) =>
      void runGit(async () => {
        if (!window.confirm("Remove this worktree? Uncommitted changes will keep it.")) return;
        setWorktrees(await api.gitWorktreeRemove(workspace, path));
      }),
    openChange,
    openAllDiff: () => openFile(ALL_DIFF_PATH, "pin", "diff"),
    openWorkspace: onOpenWorkspace,
  };

  return (
    <aside
      ref={asideRef}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas"
    >
      <PaneTabs pane={pane} onChange={setPane} onAdd={addKind} onCollapse={onCollapse} />
      <div className={`relative min-h-0 flex-1 ${pending || !treeReady ? "invisible" : ""}`} data-pane-pending={pending || !treeReady ? "" : undefined} inert={pending ? true : undefined}>
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
                terminalReady ? <Terminal workspace={workspace} sessionKey={tab.id} active={active} /> : null
              ) : null}
              {tab.kind === "files" ? <StableFiles model={fileModel} act={act} /> : null}
              {tab.kind === "git" ? <StableGit model={gitModel} act={act} /> : null}
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

type FilesModel = {
  error: string | null;
  gitMissing: boolean;
  expanded: Record<string, boolean>;
  children: Record<string, Entry[]>;
  selected: string[];
  selectedPath: string | null;
  renaming: string | null;
  creating: string | null;
  newFileParent: string | null;
  changes: GitChange[];
};

type GitModel = {
  branches: GitBranches;
  summary: GitRepoSummary | null;
  identity: GitIdentity | null;
  history: GitCommit[];
  branchError: string | null;
  switching: boolean;
  busy: boolean;
  grouped: boolean;
  workspace: string;
  worktrees: GitWorktree[];
  changes: GitChange[];
  selectedPath: string | null;
};

const StableFiles = memo(function StableFiles({ model, act }: { model: FilesModel; act: { current: PaneAct } }) {
  const picked = model.selected.filter((path) => fileNodeMap(model.children).has(path));
  return (
    <FilesPane
      error={model.error}
      gitMissing={model.gitMissing}
      expanded={model.expanded}
      childrenOf={model.children}
      selected={picked}
      activePath={model.selectedPath}
      renaming={model.renaming}
      creating={model.creating}
      newFileParent={model.newFileParent}
      changes={model.changes}
      onToggle={(path) => act.current.toggle(path)}
      onSelect={(path, kind, ev) => act.current.selectRow(path, kind, ev)}
      onOpen={(path, mode) => act.current.openFile(path, mode)}
      onRename={(path) => act.current.rename(path)}
      onRenameCommit={(path, name) => act.current.renameEntry(path, name)}
      onCreateCommit={(path, name) => act.current.nameCreated(path, name)}
      onDelete={(paths) => act.current.removeEntries(paths)}
      onMove={(paths, dest) => act.current.moveEntries(paths, dest)}
      onNewFolder={(parent) => act.current.makeFolder(parent)}
      onNewFile={(parent) => act.current.startNewFile(parent)}
      onNewFileCommit={(parent, name) => act.current.makeFile(parent, name)}
      onNewFileCancel={() => act.current.cancelNewFile()}
    />
  );
});

const StableGit = memo(function StableGit({ model, act }: { model: GitModel; act: { current: PaneAct } }) {
  return (
    <GitPane
      branches={model.branches}
      summary={model.summary}
      identity={model.identity}
      history={model.history}
      branchError={model.branchError}
      switching={model.switching}
      busy={model.busy}
      onSwitch={(name) => act.current.switchBranch(name)}
      onCreate={(name) => act.current.createBranch(name)}
      grouped={model.grouped}
      onStage={(paths) => act.current.stage(paths)}
      onUnstage={(paths) => act.current.unstage(paths)}
      onDiscard={(paths) => act.current.discard(paths)}
      onCommit={(message) => act.current.commit(message)}
      onIdentity={(name, email) => act.current.setIdentity(name, email)}
      onSync={(action) => act.current.sync(action)}
      onStash={(action) => act.current.stash(action)}
      onShow={(hash) => act.current.show(hash)}
      workspacePath={model.workspace}
      worktrees={model.worktrees}
      onOpenWorkspace={(path) => act.current.openWorkspace?.(path)}
      onCreateWorktree={(branch) => act.current.createWorktree(branch)}
      onRemoveWorktree={(path) => act.current.removeWorktree(path)}
      changes={model.changes}
      selected={model.selectedPath}
      onOpen={(row, mode) => act.current.openChange(row, mode)}
      onOpenAll={() => act.current.openAllDiff()}
    />
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
