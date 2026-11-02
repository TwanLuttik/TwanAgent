import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { HEAVY_DIRS, gitChangeForPath, gitChangeMap, gitLineStats } from "../../lib/core";
import { canMoveSelection, fileDirDropId, fileRowDragId, validNewFileName } from "../../lib/file-actions";
import type { Entry } from "../../lib/tauri";
import { FileIcon } from "../FileIcon";
import { Symbol } from "../Symbol";
import { GitLineStats } from "./gitBits";

const FILE_DROP_CLASS = "file-drop-target";

type FileDragData = { paths: string[] };

export function Tree({
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
        return (
          <FileRow
            key={row.path}
            row={row}
            depth={depth}
            separated={separated}
            isDir={isDir}
            open={open}
            dirty={dirty}
            stats={stats}
            on={on}
            editing={editing}
            dragging={Boolean(dragPaths?.includes(row.path))}
            dropHere={Boolean(isDir && dropTarget === row.path)}
            dragPaths={onDragPaths(row.path)}
            canDrag={!editing && canMoveSelection(onDragPaths(row.path), nodeMap)}
            onToggle={onToggle}
            onSelect={onSelect}
            onOpen={onOpen}
            onContext={onContext}
            onRenameCommit={onRenameCommit}
            onCreateCommit={onCreateCommit}
            creating={creating === row.path}
          >
            {isDir && open ? (
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
              />
            ) : null}
          </FileRow>
        );
      })}
    </div>
  );
}

function FileRow({
  row,
  depth,
  separated,
  isDir,
  open,
  dirty,
  stats,
  on,
  editing,
  dragging,
  dropHere,
  dragPaths,
  canDrag,
  onToggle,
  onSelect,
  onOpen,
  onContext,
  onRenameCommit,
  onCreateCommit,
  creating,
  children,
}: {
  row: Entry;
  depth: number;
  separated: boolean;
  isDir: boolean;
  open: boolean;
  dirty: boolean;
  stats: { additions: number; deletions: number };
  on: boolean;
  editing: boolean;
  dragging: boolean;
  dropHere: boolean;
  dragPaths: string[];
  canDrag: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string, kind: string, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  onOpen: (path: string, mode?: "preview" | "pin") => void;
  onContext: (path: string, x: number, y: number) => void;
  onRenameCommit: (path: string, name: string) => void;
  onCreateCommit: (path: string, name: string) => void;
  creating: boolean;
  children?: ReactNode;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: fileRowDragId(row.path),
    disabled: !canDrag,
    data: { paths: dragPaths } satisfies FileDragData,
  });
  const faceRef = useRef<HTMLDivElement | null>(null);
  const folderDrop = useDroppable({
    id: fileDirDropId(row.path),
    disabled: !isDir,
    data: { path: row.path, kind: "dir", rowRef: faceRef },
  });
  const press = useRef<{ x: number; y: number } | null>(null);
  const dragListeners = canDrag && !editing ? listeners : undefined;
  return (
    <div ref={setDragRef} className={`file-branch ${separated ? "mt-1" : ""}`}>
      <div
        ref={(node) => {
          faceRef.current = node;
          if (isDir) folderDrop.setNodeRef(node);
        }}
        data-path={row.path}
        data-kind={row.kind}
        {...(canDrag && !editing ? attributes : {})}
        {...dragListeners}
        {...(dragListeners
          ? {
              onPointerDown: (ev: ReactPointerEvent<HTMLDivElement>) => {
                press.current = { x: ev.clientX, y: ev.clientY };
                const start = dragListeners.onPointerDown as (event: ReactPointerEvent<HTMLDivElement>) => void;
                start(ev);
              },
            }
          : {})}
        onContextMenu={(ev) => {
          ev.preventDefault();
          onContext(row.path, ev.clientX, ev.clientY);
        }}
        onClick={(ev) => {
          const start = press.current;
          press.current = null;
          if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) return;
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
          editing ? "cursor-text" : "cursor-grab touch-none active:cursor-grabbing"
        } ${on ? "bg-wash-strong" : ""} ${dragging || isDragging ? "opacity-40" : ""} ${
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
                    onCommit={(name) => (creating ? onCreateCommit(row.path, name) : onRenameCommit(row.path, name))}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                )}
              </span>
              {isDir ? <span className="file-drop-label">Move here</span> : null}
              {!isDir && !editing ? <GitLineStats additions={stats.additions} deletions={stats.deletions} /> : null}
            </div>
      {children}
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
      onPointerDown={(ev) => ev.stopPropagation()}
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
