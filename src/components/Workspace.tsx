import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  HEAVY_DIRS,
  formatDiffCount,
  gitChangeForPath,
  gitChangeMap,
  gitChangeTotals,
  gitChangesTree,
  gitFolderHasChanges,
  gitLineStats,
  type GitChangeTreeNode,
} from "../lib/core";
import { ALL_DIFF_PATH } from "../lib/editor";
import {
  addableKinds,
  closePane,
  defaultPaneState,
  openPane,
  paneMeta,
  selectPane,
  type PaneKind,
  type PaneState,
} from "../lib/pane";
import {
  PANE_DEFAULT,
  PANE_MAX,
  PANE_MIN,
  loadPaneWidth,
  loadGitChangesView,
  loadOpenFileTree,
  savePaneWidth,
  saveGitChangesView,
  saveOpenFileTree,
  type GitChangesView,
} from "../lib/prefs";
import * as api from "../lib/tauri";
import type { Entry, GitBranches, GitChange } from "../lib/tauri";
import { Terminal } from "./Terminal";
import { FileIcon } from "./FileIcon";
import { Symbol } from "./Symbol";

export function Workspace({
  workspace,
  tick,
  selectedPath,
  onOpenFile,
  onRefresh,
}: {
  workspace: string;
  tick: number;
  selectedPath?: string | null;
  onOpenFile?: (path: string, mode?: "preview" | "pin", view?: "edit" | "diff") => void;
  onRefresh?: () => void;
}) {
  const [pane, setPane] = useState<PaneState>(defaultPaneState);
  const [width, setWidth] = useState(loadPaneWidth);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    openTreeState(loadOpenFileTree(workspace)),
  );
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [branches, setBranches] = useState<GitBranches>({ current: null, branches: [] });
  const [branchError, setBranchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      const rows = await api.listDir(workspace, path);
      setChildren((prev) => ({ ...prev, [path]: rows }));
    },
    [workspace],
  );

  const refreshTree = useCallback(async () => {
    if (!workspace) return;
    setError(null);
    try {
      const open = Object.keys(expanded).filter((k) => expanded[k]);
      const [nextChanges] = await Promise.all([
        api.gitStatus(workspace),
        ...open.map((p) => loadDir(p)),
      ]);
      setChanges(nextChanges);
    } catch (e) {
      setError(String(e));
    }
  }, [workspace, expanded, loadDir]);

  const refreshBranches = useCallback(async () => {
    if (!workspace) return;
    try {
      setBranches(await api.gitBranches(workspace));
      setBranchError(null);
    } catch (e) {
      setBranchError(String(e));
    }
  }, [workspace]);

  useEffect(() => {
    setExpanded(openTreeState(loadOpenFileTree(workspace)));
  }, [workspace]);

  useEffect(() => {
    void refreshTree();
  }, [workspace, tick, refreshTree]);

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
    setSelected(path);
    onOpenFile?.(path, mode, view);
  }

  function openChange(change: GitChange, mode: "preview" | "pin" = "preview") {
    setSelected(change.path);
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
    } catch (e) {
      setBranchError(String(e));
    } finally {
      setSwitching(false);
    }
  }

  const onResizeStart = useCallback((ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startWidth = width;
    setDragging(true);

    function onMove(move: PointerEvent) {
      const next = Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(startWidth - (move.clientX - startX))));
      setWidth(next);
    }
    function onUp(up: PointerEvent) {
      handle.releasePointerCapture(up.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setDragging(false);
      setWidth((next) => {
        savePaneWidth(next);
        return next;
      });
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, [width]);

  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col border-l border-line/35 bg-canvas"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace pane"
        title="Drag to resize"
        onPointerDown={onResizeStart}
        onDoubleClick={() => {
          setWidth(PANE_DEFAULT);
          savePaneWidth(PANE_DEFAULT);
        }}
        className="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none"
      >
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 left-0 w-0.5 ${
            dragging ? "bg-accent/40" : "group-hover:bg-accent/30"
          }`}
        />
      </div>
      <PaneTabs pane={pane} onChange={setPane} onAdd={addKind} />
      <div className="relative min-h-0 flex-1">
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeId;
          return (
            <div
              key={tab.id}
              className={`absolute inset-0 flex flex-col ${active ? "" : "invisible pointer-events-none"}`}
              aria-hidden={!active}
            >
              {tab.kind === "terminal" ? (
                <Terminal workspace={workspace} sessionKey={tab.id} active={active} />
              ) : null}
              {tab.kind === "files" ? (
                <FilesPane
                  error={error}
                  expanded={expanded}
                  childrenOf={children}
                  selected={selectedPath ?? selected}
                  changes={changes}
                  onToggle={(p) => void toggle(p)}
                  onOpen={(p, mode) => void openFile(p, mode)}
                />
              ) : null}
              {tab.kind === "git" ? (
                <GitPane
                  branches={branches}
                  branchError={branchError}
                  switching={switching}
                  onSwitch={(name) => void switchBranch(name)}
                  changes={changes}
                  selected={selectedPath ?? selected}
                  onOpen={(row, mode) => openChange(row, mode)}
                  onOpenAll={() => openFile(ALL_DIFF_PATH, "pin", "diff")}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function PaneTabs({
  pane,
  onChange,
  onAdd,
}: {
  pane: PaneState;
  onChange: (next: PaneState) => void;
  onAdd: (kind: PaneKind) => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const canClose = pane.tabs.length > 1;
  const kinds = addableKinds(pane.tabs);

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

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line/35">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist" aria-label="Pane">
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeId;
          const meta = paneMeta(tab.kind);
          return (
            <div
              key={tab.id}
              className={`group flex max-w-[11rem] min-w-0 shrink-0 items-center border-r border-line/35 ${
                active ? "bg-canvas text-ink" : "text-muted hover:bg-wash hover:text-ink"
              }`}
              onMouseDown={(ev) => {
                if (ev.button === 1) ev.preventDefault();
              }}
              onAuxClick={(ev) => {
                if (ev.button !== 1 || !canClose) return;
                ev.preventDefault();
                ev.stopPropagation();
                onChange(closePane(pane, tab.id));
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChange(selectPane(pane, tab.id))}
                className={`flex min-w-0 items-center gap-1.5 py-0 pr-1 pl-2.5 text-left text-[12px] ${
                  canClose ? "" : "pr-2.5"
                }`}
              >
                <Symbol name={meta.icon} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{tab.title}</span>
              </button>
              {canClose ? (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onChange(closePane(pane, tab.id))}
                  className={`mr-1 flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted hover:bg-wash-strong hover:text-ink ${
                    active ? "opacity-80" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <Symbol name="xmark" className="size-2.5" weight="regular" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
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
          className="flex h-full w-9 items-center justify-center text-muted hover:bg-wash hover:text-ink"
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
  expanded,
  childrenOf,
  selected,
  changes,
  onToggle,
  onOpen,
}: {
  error: string | null;
  expanded: Record<string, boolean>;
  childrenOf: Record<string, Entry[]>;
  selected: string | null;
  changes: GitChange[];
  onToggle: (path: string) => void;
  onOpen: (path: string, mode?: "preview" | "pin") => void;
}) {
  const byPath = gitChangeMap(changes);
  return (
    <div className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5">
      {error && <p className="px-2 text-[11px] text-err">{error}</p>}
      <Tree
        path=""
        depth={0}
        expanded={expanded}
        childrenOf={childrenOf}
        selected={selected}
        changes={byPath}
        onToggle={onToggle}
        onOpen={onOpen}
      />
    </div>
  );
}

function GitPane({
  branches,
  branchError,
  switching,
  onSwitch,
  changes,
  selected,
  onOpen,
  onOpenAll,
}: {
  branches: GitBranches;
  branchError: string | null;
  switching: boolean;
  onSwitch: (name: string) => void;
  changes: GitChange[];
  selected: string | null;
  onOpen: (row: GitChange, mode?: "preview" | "pin") => void;
  onOpenAll: () => void;
}) {
  const [view, setView] = useState<GitChangesView>(loadGitChangesView);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const tree = view === "tree" ? gitChangesTree(changes) : [];
  const totals = gitChangeTotals(changes);

  function setChangesView(next: GitChangesView) {
    setView(next);
    saveGitChangesView(next);
  }

  return (
    <>
      <div className="px-1.5 pt-1.5">
        <BranchSwitch
          current={branches.current}
          names={branches.branches}
          switching={switching}
          onSwitch={onSwitch}
        />
        {branchError ? <p className="px-2 pt-1 text-[11px] text-err">{branchError}</p> : null}
      </div>
      {changes.length > 0 ? (
        <div className="px-1.5 pt-1">
          <button
            type="button"
            onClick={onOpenAll}
            className={`flex w-full items-center justify-center gap-1.5 rounded-[7px] px-2 py-[6px] text-[12px] ${
              selected === ALL_DIFF_PATH ? "bg-wash-strong text-ink" : "bg-wash text-ink hover:bg-wash-strong"
            }`}
          >
            <span>View Diff</span>
            {totals.additions > 0 ? (
              <span className="font-medium text-ok">+{formatDiffCount(totals.additions)}</span>
            ) : null}
            {totals.deletions > 0 ? (
              <span className="font-medium text-err">-{formatDiffCount(totals.deletions)}</span>
            ) : null}
          </button>
        </div>
      ) : null}
      <div className="flex h-7 items-center justify-between gap-2 px-3">
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
        <span className="text-[11px] text-muted">{changes.length}</span>
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
            />
          ))
        ) : (
          changes.map((row) => (
            <ChangeFileRow
              key={row.path}
              row={row}
              label={row.path}
              selected={selected === row.path}
              pad={8}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </>
  );
}

function ChangeTree({
  node,
  depth,
  selected,
  collapsed,
  onToggle,
  onOpen,
}: {
  node: GitChangeTreeNode<GitChange>;
  depth: number;
  selected: string | null;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
  onOpen: (row: GitChange, mode?: "preview" | "pin") => void;
}) {
  if (node.kind === "file") {
    return (
      <ChangeFileRow
        row={node.change}
        label={node.name}
        selected={selected === node.change.path}
        pad={8 + depth * 12}
        onOpen={onOpen}
      />
    );
  }

  const open = !collapsed[node.path];
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className="flex w-full items-center gap-1 rounded-[6px] py-[3px] pr-2 text-left text-[12px] text-ink/90 hover:bg-wash"
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
}: {
  row: GitChange;
  label: string;
  selected: boolean;
  pad: number;
  onOpen: (row: GitChange, mode?: "preview" | "pin") => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row, "preview")}
      onDoubleClick={() => onOpen(row, "pin")}
      className={`flex w-full items-center gap-2 rounded-[6px] py-[4px] pr-2 text-left text-[12px] ${
        selected ? "bg-wash-strong" : "hover:bg-wash"
      }`}
      style={{ paddingLeft: pad }}
    >
      <span className={`w-3 shrink-0 text-[10px] font-semibold ${statusTone(row.status)}`}>
        {statusMark(row.status)}
      </span>
      <FileIcon name={row.path} className="size-3.5 text-muted" />
      <span className="min-w-0 flex-1 truncate text-ok">{label}</span>
      <GitLineStats {...gitLineStats(row)} />
    </button>
  );
}

function BranchSwitch({
  current,
  names,
  switching,
  onSwitch,
}: {
  current: string | null;
  names: string[];
  switching: boolean;
  onSwitch: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = current || (names.length ? "Detached HEAD" : "No git repo");
  const canSwitch = names.length > 0 && !switching;

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

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={!canSwitch}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? `Branch ${current}` : label}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-[5px] text-left text-[12px] text-ink hover:bg-wash disabled:opacity-50"
      >
        <Symbol name="arrow.triangle.branch" className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-medium">{switching ? "Switching…" : label}</span>
        {canSwitch ? <Symbol name="chevron.down" className="size-3 shrink-0 text-muted" /> : null}
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Branches"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-56 overflow-auto rounded-md border border-line bg-canvas py-1 shadow-card"
        >
          {names.map((name) => {
            const selected = name === current;
            return (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false);
                  onSwitch(name);
                }}
                className={`flex w-full items-center px-2.5 py-1.5 text-left text-[12px] hover:bg-inset ${
                  selected ? "font-medium text-ink" : "text-ink/80"
                }`}
              >
                <span className="min-w-0 truncate">{name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Tree({
  path,
  depth,
  expanded,
  childrenOf,
  selected,
  changes,
  onToggle,
  onOpen,
}: {
  path: string;
  depth: number;
  expanded: Record<string, boolean>;
  childrenOf: Record<string, Entry[]>;
  selected: string | null;
  changes: ReturnType<typeof gitChangeMap>;
  onToggle: (path: string) => void;
  onOpen: (path: string, mode?: "preview" | "pin") => void;
}) {
  const rows = (childrenOf[path] ?? []).filter((row) => !HEAVY_DIRS.has(row.name));
  return (
    <div>
      {rows.map((row) => {
        const isDir = row.kind === "dir";
        const open = Boolean(expanded[row.path]);
        const change = isDir ? undefined : gitChangeForPath(changes, row.path);
        const dirty = Boolean(change) || (isDir && gitFolderHasChanges(changes, row.path));
        const stats = gitLineStats(change);
        return (
          <div key={row.path}>
            <button
              type="button"
              onClick={() => (isDir ? onToggle(row.path) : onOpen(row.path, "preview"))}
              onDoubleClick={() => {
                if (!isDir) onOpen(row.path, "pin");
              }}
              className={`flex w-full items-center gap-1 rounded-[6px] py-[3px] pr-2 text-left text-[12px] hover:bg-wash ${
                selected === row.path ? "bg-wash-strong" : ""
              } ${dirty ? "text-ok" : "text-ink/90"}`}
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              {isDir ? (
                <Symbol name={open ? "chevron.down" : "chevron.right"} className="size-3 text-muted" />
              ) : (
                <span className="inline-block w-3" />
              )}
              {isDir ? (
                <Symbol
                  name="folder.fill"
                  className={`size-3.5 ${dirty ? "text-ok" : "text-accent"}`}
                />
              ) : (
                <FileIcon name={row.name} className="size-3.5 text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {!isDir ? <GitLineStats additions={stats.additions} deletions={stats.deletions} /> : null}
            </button>
            {isDir && open && (
              <Tree
                path={row.path}
                depth={depth + 1}
                expanded={expanded}
                childrenOf={childrenOf}
                selected={selected}
                changes={changes}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
    </div>
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

function statusMark(status: string): string {
  if (status === "added" || status === "untracked") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  if (status === "conflict") return "!";
  return "M";
}

function statusTone(status: string): string {
  if (status === "added" || status === "untracked") return "text-ok";
  if (status === "deleted" || status === "conflict") return "text-err";
  return "text-warn";
}
