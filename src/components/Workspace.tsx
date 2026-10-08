import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";
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
import { CSS } from "@dnd-kit/utilities";
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
  canDropOnDir,
  canMoveSelection,
  canRenameSelection,
  fileName,
  fileParent,
  isInsidePath,
  nextFolderName,
  topLevelPaths,
  validEntryName,
} from "../lib/file-actions";
import {
  closedTerminalTabs,
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
  const [pane, setPaneState] = useState<PaneState>(() => paneForWorkspace(workspace));
  const [width, setWidth] = useState(loadPaneWidth);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    openTreeState(loadOpenFileTree(workspace)),
  );
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
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
    setPaneState(paneForWorkspace(workspace));
    setSelected([]);
    setRenaming(null);
    setCreating(null);
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

  useEffect(() => {
    void refreshTree();
  }, [workspace, tick, refreshTree]);

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
                  selected={picked}
                  activePath={selectedPath ?? null}
                  renaming={renaming}
                  creating={creating}
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
                />
              ) : null}
              {tab.kind === "git" ? (
                <GitPane
                  branches={branches}
                  branchError={branchError}
                  switching={switching}
                  onSwitch={(name) => void switchBranch(name)}
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
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Pane">
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
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
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
      className={`group flex h-6 max-w-[11rem] min-w-0 shrink-0 items-center rounded-[6px] ${
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
  expanded,
  childrenOf,
  selected,
  activePath,
  renaming,
  creating,
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
}: {
  error: string | null;
  expanded: Record<string, boolean>;
  childrenOf: Record<string, Entry[]>;
  selected: string[];
  activePath: string | null;
  renaming: string | null;
  creating: string | null;
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
}) {
  const byPath = gitChangeMap(changes);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; paths: string[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragPaths, setDragPaths] = useState<string[] | null>(null);
  const nodeMap = fileNodeMap(childrenOf);
  const menuPaths = menu?.paths ?? [];
  const menuNodes = fileNodeMap(childrenOf);
  const allowRename = canRenameSelection(menuPaths, menuNodes);
  const allowMove = canMoveSelection(menuPaths, menuNodes);

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMenu(null);
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  function pathsFor(path: string) {
    return selected.includes(path) ? selected : [path];
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5"
      onDragOver={(ev) => {
        if (!dragPaths) return;
        ev.preventDefault();
        setDropTarget("");
      }}
      onDragLeave={(ev) => {
        if (ev.currentTarget.contains(ev.relatedTarget as Node)) return;
        setDropTarget(null);
      }}
      onDrop={(ev) => {
        const paths = dragPaths ?? ev.dataTransfer.getData(FILE_DRAG_TYPE).split("\n").filter(Boolean);
        setDropTarget(null);
        setDragPaths(null);
        if (!paths.length || ev.defaultPrevented) return;
        ev.preventDefault();
        if (canDropOnDir(paths, "", nodeMap)) onMove(paths, "");
      }}
    >
      {error && <p className="px-2 text-[11px] text-err">{error}</p>}
      {dropTarget === "" ? <div className="mx-1 mb-1 h-0.5 rounded-full bg-accent" /> : null}
      <Tree
        path=""
        depth={0}
        expanded={expanded}
        childrenOf={childrenOf}
        selected={selected}
        activePath={activePath}
        renaming={renaming}
        creating={creating}
        dropTarget={dropTarget}
        changes={byPath}
        nodeMap={nodeMap}
        onToggle={onToggle}
        onSelect={onSelect}
        onOpen={onOpen}
        onRenameCommit={onRenameCommit}
        onCreateCommit={onCreateCommit}
        onContext={(path, x, y) => {
          const paths = selected.includes(path) ? selected : [path];
          if (!selected.includes(path)) onSelect(path, nodeMap.get(path)?.kind ?? "file", { metaKey: false, ctrlKey: false, shiftKey: false });
          setMenu({ path, x, y, paths });
        }}
        onDragPaths={pathsFor}
        onDragChange={setDragPaths}
        onDropTarget={setDropTarget}
        onMove={onMove}
      />
      {menu ? (
        <div
          role="menu"
          className="fixed z-50 min-w-[168px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-card"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(ev) => ev.stopPropagation()}
        >
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
        </div>
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
  activePath,
  renaming,
  creating,
  dropTarget,
  changes,
  nodeMap,
  onToggle,
  onSelect,
  onOpen,
  onRenameCommit,
  onCreateCommit,
  onContext,
  onDragPaths,
  onDragChange,
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
  dropTarget: string | null;
  changes: ReturnType<typeof gitChangeMap>;
  nodeMap: Map<string, Entry>;
  onToggle: (path: string) => void;
  onSelect: (path: string, kind: string, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  onOpen: (path: string, mode?: "preview" | "pin") => void;
  onRenameCommit: (path: string, name: string) => void;
  onCreateCommit: (path: string, name: string) => void;
  onContext: (path: string, x: number, y: number) => void;
  onDragPaths: (path: string) => string[];
  onDragChange: (paths: string[] | null) => void;
  onDropTarget: (path: string | null) => void;
  onMove: (paths: string[], dest: string) => void;
}) {
  const rows = (childrenOf[path] ?? []).filter((row) => !HEAVY_DIRS.has(row.name));
  return (
    <div className="flex flex-col gap-px">
      {rows.map((row, index) => {
        const isDir = row.kind === "dir";
        const open = Boolean(expanded[row.path]);
        const change = isDir ? undefined : gitChangeForPath(changes, row.path);
        const dirty = Boolean(change) || (isDir && gitFolderHasChanges(changes, row.path));
        const stats = gitLineStats(change);
        const on = selected.includes(row.path) || activePath === row.path;
        const prev = rows[index - 1];
        const separated = on && Boolean(prev && (selected.includes(prev.path) || activePath === prev.path));
        const editing = renaming === row.path || creating === row.path;
        return (
          <div key={row.path} className={separated ? "mt-1" : undefined}>
            <div
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
                onDragChange(paths);
              }}
              onDragEnd={() => {
                onDragChange(null);
                onDropTarget(null);
              }}
              onDragOver={(ev) => {
                if (!isDir) return;
                ev.preventDefault();
                ev.stopPropagation();
                onDropTarget(row.path);
              }}
              onDrop={(ev) => {
                if (!isDir) return;
                const raw = ev.dataTransfer.getData(FILE_DRAG_TYPE) || ev.dataTransfer.getData("text/plain");
                ev.preventDefault();
                ev.stopPropagation();
                onDropTarget(null);
                onDragChange(null);
                const paths = raw.split("\n").filter(Boolean);
                if (canDropOnDir(paths, row.path, nodeMap)) onMove(paths, row.path);
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
              className={`flex w-full cursor-default items-center gap-1 rounded-[6px] py-[3px] pr-2 text-left text-[12px] hover:bg-wash ${
                on ? "bg-wash-strong" : ""
              } ${dropTarget === row.path ? "bg-accent/15 ring-1 ring-accent" : ""} ${dirty ? "text-ok" : "text-ink/90"}`}
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
                dropTarget={dropTarget}
                changes={changes}
                nodeMap={nodeMap}
                onToggle={onToggle}
                onSelect={onSelect}
                onOpen={onOpen}
                onRenameCommit={onRenameCommit}
                onCreateCommit={onCreateCommit}
                onContext={onContext}
                onDragPaths={onDragPaths}
                onDragChange={onDragChange}
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
      className="min-w-0 flex-1 rounded bg-canvas px-1 text-[12px] text-ink outline-none ring-1 ring-accent"
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
