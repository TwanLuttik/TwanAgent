import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { snapCenterToCursor } from "@dnd-kit/modifiers";
import { HEAVY_DIRS, gitChangeMap, gitDirtyDirs } from "../../lib/core";
import {
  canMoveSelection,
  canRenameSelection,
  fileDirDropId,
  fileDirPathFromDropId,
  fileDropDest,
  fileDropTarget,
  fileName,
  fileParent,
  topLevelPaths,
} from "../../lib/file-actions";
import type { Entry, GitChange } from "../../lib/tauri";
import { AnchoredMenu, MenuItem } from "../ContextMenu";
import { FileIcon } from "../FileIcon";
import { Symbol } from "../Symbol";
import { Tree } from "./FileTree";
import { fileNodeMap } from "./fileNodes";

export function FilesPane({
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
  const nodeMapRef = useRef(fileNodeMap(childrenOf));
  const listRef = useRef<HTMLDivElement>(null);
  const nodeMap = fileNodeMap(childrenOf);
  nodeMapRef.current = nodeMap;
  const menuPaths = menu?.paths ?? [];
  const menuNodes = fileNodeMap(childrenOf);
  const allowRename = canRenameSelection(menuPaths, menuNodes);
  const allowMove = canMoveSelection(menuPaths, menuNodes);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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

  function clearDrag() {
    dragPathsRef.current = null;
    setDragPaths(null);
    setDropTarget(null);
  }

  function onDragStart(ev: DragStartEvent) {
    const paths = dragPathsOf(ev.active.data.current);
    if (!paths?.length || !canMoveSelection(paths, nodeMapRef.current)) return;
    dragPathsRef.current = paths;
    setDragPaths(paths);
  }

  function onDragMove(ev: DragMoveEvent) {
    const point = pointerFromDrag(ev.activatorEvent, ev.delta);
    const paths = dragPathsRef.current;
    if (!paths) return;
    const fromPointer = point ? destAtPoint(point.x, point.y, listRef.current) : null;
    const fromOver = ev.over ? fileDirPathFromDropId(String(ev.over.id)) : null;
    const next = fileDropTarget(paths, fromPointer ?? fromOver, nodeMapRef.current);
    setDropTarget((prev) => (prev === next ? prev : next));
  }

  function onDragEnd(ev: DragEndEvent) {
    const paths = dragPathsRef.current ?? dragPathsOf(ev.active.data.current) ?? [];
    const point = pointerFromDrag(ev.activatorEvent, ev.delta);
    const fromPointer = point ? destAtPoint(point.x, point.y, listRef.current) : null;
    const fromOver = ev.over ? fileDirPathFromDropId(String(ev.over.id)) : null;
    const dest = fileDropTarget(paths, fromPointer ?? fromOver, nodeMapRef.current);
    clearDrag();
    if (paths.length && dest != null) onMove(paths, dest);
  }

  const preview = dragPaths ? dragPreviewLabel(dragPaths, nodeMap) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={filePointerCollision}
      autoScroll={{ enabled: true, threshold: { x: 0, y: 0.15 } }}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragOver={onDragMove}
      onDragCancel={clearDrag}
      onDragEnd={onDragEnd}
    >
    <FileListDrop>
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5"
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
      />
      {menu ? (
        <AnchoredMenu x={menu.x} y={menu.y}>
          {menuNodes.get(menu.path)?.kind !== "dir" ? (
            <MenuItem
              onClick={() => {
                onOpen(menu.path, "pin");
                setMenu(null);
              }}
            >
              Open
            </MenuItem>
          ) : null}
          <MenuItem
            onClick={() => {
              const parent = menuNodes.get(menu.path)?.kind === "dir" ? menu.path : fileParent(menu.path);
              onNewFile(parent);
              setMenu(null);
            }}
          >
            New file
          </MenuItem>
          <MenuItem
            onClick={() => {
              const parent = menuNodes.get(menu.path)?.kind === "dir" ? menu.path : fileParent(menu.path);
              onNewFolder(parent);
              setMenu(null);
            }}
          >
            New folder
          </MenuItem>
          <MenuItem
            disabled={!allowRename}
            onClick={() => {
              onRename(menuPaths[0]);
              setMenu(null);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            danger
            onClick={() => {
              onDelete(menuPaths);
              setMenu(null);
            }}
          >
            {menuPaths.length > 1 ? `Delete ${menuPaths.length}` : "Delete"}
          </MenuItem>
          {!allowMove && menuPaths.length > 1 ? (
            <p className="m-0 px-2.5 py-1 text-[11px] text-muted">Move and rename need files or folders, not both.</p>
          ) : null}
        </AnchoredMenu>
      ) : null}
      {blankMenu ? (
        <AnchoredMenu x={blankMenu.x} y={blankMenu.y}>
          <MenuItem
            onClick={() => {
              onNewFile("");
              setBlankMenu(null);
            }}
          >
            New file
          </MenuItem>
          <MenuItem
            onClick={() => {
              onNewFolder("");
              setBlankMenu(null);
            }}
          >
            New folder
          </MenuItem>
        </AnchoredMenu>
      ) : null}
    </div>
    </FileListDrop>
    <DragOverlay dropAnimation={null} zIndex={80} className="file-drag-overlay" modifiers={[snapCenterToCursor]}>
      {preview ? (
        <div className="file-drag-image">
          {preview.kind === "dir" ? (
            <Symbol name="folder.fill" className="size-3.5 text-accent" />
          ) : (
            <FileIcon name={preview.name} className="size-3.5 text-muted" />
          )}
          <span className="file-drag-image-name">{preview.count > 1 ? `${preview.count} items` : preview.name}</span>
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
}

function FileListDrop({ children }: { children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: ROOT_DROP_ID });
  return (
    <div ref={setNodeRef} className="flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  );
}

const ROOT_DROP_ID = fileDirDropId("");

function dragPathsOf(data: { paths?: unknown } | undefined): string[] | null {
  const paths = data?.paths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) return null;
  return paths;
}

function rowAtPoint(x: number, y: number): HTMLElement | null {
  const stack = document.elementsFromPoint(x, y);
  for (const node of stack) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest(".file-drag-overlay, .file-drag-image")) continue;
    const row = node.closest<HTMLElement>(".file-row");
    if (row) return row;
  }
  const hovered = document.querySelectorAll<HTMLElement>(".file-row");
  for (const row of hovered) {
    if (pointInRect(x, y, row.getBoundingClientRect())) return row;
  }
  return null;
}

function destAtPoint(x: number, y: number, list: HTMLElement | null): string | null {
  if (!x && !y) return null;
  const hit = rowAtPoint(x, y);
  const inside = Boolean(list && pointInRect(x, y, list.getBoundingClientRect()));
  const overList = Boolean(hit && list?.contains(hit)) || (inside && !hit);
  return fileDropDest(overList ? (hit?.dataset.path ?? null) : null, hit?.dataset.kind ?? null, overList);
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function pointerFromDrag(activator: Event | null, delta: { x: number; y: number }): { x: number; y: number } | null {
  if (!(activator instanceof PointerEvent) && !(activator instanceof MouseEvent)) return null;
  return { x: activator.clientX + delta.x, y: activator.clientY + delta.y };
}

/**
 * The folder under the pointer. A file row is not a droppable, so the pointer
 * also hits that file's parent folder. The deepest folder wins. Empty space
 * in the list is the project root.
 */
const filePointerCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const point = args.pointerCoordinates;
  let best: (typeof hits)[number] | null = null;
  let bestDepth = -1;
  if (point) {
    for (const hit of hits) {
      const path = fileDirPathFromDropId(String(hit.id));
      if (!path) continue;
      const node = hit.data?.droppableContainer?.node.current;
      if (!node || !pointInRect(point.x, point.y, node.getBoundingClientRect())) continue;
      const depth = path.split("/").length;
      if (depth > bestDepth) {
        best = hit;
        bestDepth = depth;
      }
    }
  }
  if (best) return [best];
  const root = hits.find((hit) => String(hit.id) === ROOT_DROP_ID);
  return root ? [root] : [];
};

function dragPreviewLabel(paths: string[], nodes: Map<string, Entry>): { name: string; kind: string; count: number } {
  const tops = topLevelPaths(paths);
  const first = tops[0] ?? paths[0] ?? "";
  return {
    name: fileName(first),
    kind: nodes.get(first)?.kind ?? "file",
    count: tops.length,
  };
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

export function visibleRange(
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
