import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  HEAVY_DIRS,
  gitChangeForPath,
  gitChangeMap,
  gitFolderHasChanges,
  gitLineStats,
} from "../lib/dev";
import {
  addableKinds,
  closePane,
  defaultPaneState,
  openPane,
  paneMeta,
  selectPane,
  type PaneKind,
  type PaneState,
} from "../lib/dev-pane";
import {
  DEV_PANE_DEFAULT,
  DEV_PANE_MAX,
  DEV_PANE_MIN,
  loadDevPaneWidth,
  saveDevPaneWidth,
} from "../lib/prefs";
import * as api from "../lib/tauri";
import type { DevEntry, DevGitBranches, DevGitChange } from "../lib/tauri";
import { DevTerminal } from "./DevTerminal";
import { FileIcon } from "./FileIcon";
import { Symbol } from "./Symbol";

export function DevWorkspace({
  workspace,
  tick,
  selectedPath,
  onOpenFile,
  onRefresh,
}: {
  workspace: string;
  tick: number;
  selectedPath?: string | null;
  onOpenFile?: (path: string, mode?: "preview" | "pin") => void;
  onRefresh?: () => void;
}) {
  const [pane, setPane] = useState<PaneState>(defaultPaneState);
  const [width, setWidth] = useState(loadDevPaneWidth);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "": true });
  const [children, setChildren] = useState<Record<string, DevEntry[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string; kind: "file" | "diff" } | null>(
    null,
  );
  const [changes, setChanges] = useState<DevGitChange[]>([]);
  const [branches, setBranches] = useState<DevGitBranches>({ current: null, branches: [] });
  const [branchError, setBranchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      const rows = await api.devListDir(workspace, path);
      setChildren((prev) => ({ ...prev, [path]: rows }));
    },
    [workspace],
  );

  const refresh = useCallback(async () => {
    if (!workspace) return;
    setError(null);
    try {
      const open = Object.keys(expanded).filter((k) => expanded[k]);
      await Promise.all(open.map((p) => loadDir(p)));
      const [nextChanges, nextBranches] = await Promise.all([
        api.devGitStatus(workspace),
        api.devGitBranches(workspace),
      ]);
      setChanges(nextChanges);
      setBranches(nextBranches);
      setBranchError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [workspace, expanded, loadDir]);

  useEffect(() => {
    void refresh();
  }, [workspace, tick, refresh]);

  async function toggle(path: string) {
    setExpanded((prev) => {
      const next = { ...prev, [path]: !prev[path] };
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

  function openFile(path: string, mode: "preview" | "pin" = "pin") {
    setSelected(path);
    onOpenFile?.(path, mode);
  }

  async function openChange(change: DevGitChange) {
    setSelected(change.path);
    try {
      const text = await api.devGitDiff(workspace, change.path);
      setPreview({ path: change.path, text: text || "(no diff)", kind: "diff" });
    } catch (e) {
      setPreview({ path: change.path, text: String(e), kind: "diff" });
    }
  }

  function addKind(kind: PaneKind) {
    setPane((prev) => openPane(prev, kind));
  }

  async function switchBranch(name: string) {
    if (!workspace || switching || name === branches.current) return;
    setSwitching(true);
    try {
      const next = await api.devGitSwitch(workspace, name);
      setBranches(next);
      setChanges(await api.devGitStatus(workspace));
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
      const next = Math.min(DEV_PANE_MAX, Math.max(DEV_PANE_MIN, Math.round(startWidth - (move.clientX - startX))));
      setWidth(next);
    }
    function onUp(up: PointerEvent) {
      handle.releasePointerCapture(up.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setDragging(false);
      setWidth((next) => {
        saveDevPaneWidth(next);
        return next;
      });
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, [width]);

  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col border-l border-line bg-panel"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace pane"
        title="Drag to resize"
        onPointerDown={onResizeStart}
        onDoubleClick={() => {
          setWidth(DEV_PANE_DEFAULT);
          saveDevPaneWidth(DEV_PANE_DEFAULT);
        }}
        className={`absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none ${
          dragging ? "bg-accent/20" : "hover:bg-accent/15"
        }`}
      />
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
                <DevTerminal workspace={workspace} sessionKey={tab.id} active={active} />
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
                  selected={selected}
                  preview={preview?.kind === "diff" ? preview : null}
                  onOpen={(row) => void openChange(row)}
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
    <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-1.5 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Pane">
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeId;
          const meta = paneMeta(tab.kind);
          return (
            <div
              key={tab.id}
              className={`group flex max-w-[9.5rem] shrink-0 items-center rounded-[7px] ${
                active ? "bg-wash-strong text-ink" : "text-muted hover:text-ink"
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
                className="flex min-w-0 items-center gap-1 py-[3px] pr-0.5 pl-1.5 text-left text-[12px]"
              >
                <Symbol name={meta.icon} className="size-3 shrink-0" />
                <span className="min-w-0 truncate">{tab.title}</span>
              </button>
              {canClose ? (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onChange(closePane(pane, tab.id))}
                  className={`mr-0.5 flex size-4 items-center justify-center rounded text-muted hover:bg-wash hover:text-ink ${
                    active ? "opacity-70" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <Symbol name="xmark" className="size-2.5" />
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
          className="flex size-6 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="plus" className="size-3" />
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
  childrenOf: Record<string, DevEntry[]>;
  selected: string | null;
  changes: DevGitChange[];
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
  preview,
  onOpen,
}: {
  branches: DevGitBranches;
  branchError: string | null;
  switching: boolean;
  onSwitch: (name: string) => void;
  changes: DevGitChange[];
  selected: string | null;
  preview: { path: string; text: string } | null;
  onOpen: (row: DevGitChange) => void;
}) {
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
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">Changes</span>
        <span className="text-[11px] text-muted">{changes.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {changes.length === 0 ? (
          <p className="px-2 py-1 text-[12px] text-muted">No changes</p>
        ) : (
          changes.map((row) => (
            <button
              key={row.path}
              type="button"
              onClick={() => onOpen(row)}
              className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-[4px] text-left text-[12px] ${
                selected === row.path ? "bg-wash-strong" : "hover:bg-wash"
              }`}
            >
              <span className={`w-3 shrink-0 text-[10px] font-semibold ${statusTone(row.status)}`}>
                {statusMark(row.status)}
              </span>
              <FileIcon name={row.path} className="size-3.5 text-muted" />
              <GitLineStats {...gitLineStats(row)} />
              <span className="min-w-0 flex-1 truncate text-ok">{row.path}</span>
            </button>
          ))
        )}
      </div>
      {preview ? <PreviewBlock kind="Diff" path={preview.path} text={preview.text} /> : null}
    </>
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

function PreviewBlock({ kind, path, text }: { kind: string; path: string; text: string }) {
  return (
    <div className="max-h-[40%] min-h-[96px] overflow-auto border-t border-line bg-canvas px-3 py-2">
      <div className="mb-1 truncate text-[11px] text-muted">
        {kind} · {path}
      </div>
      <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-ink">
        {text.length > 12000 ? `${text.slice(0, 12000)}\n…` : text}
      </pre>
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
  childrenOf: Record<string, DevEntry[]>;
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
              {!isDir ? <GitLineStats additions={stats.additions} deletions={stats.deletions} /> : null}
              <span className="min-w-0 truncate">{row.name}</span>
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
