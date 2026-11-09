import { gitLineStats, type GitChangeTreeNode } from "../../lib/core";
import type { GitChange } from "../../lib/tauri";
import { Symbol } from "../Symbol";
import { GitLineStats, statusMark, statusTone } from "./gitBits";

export function changeLabel(row: GitChange): string {
  if (row.original && row.original !== row.path) return `${row.original} → ${row.path}`;
  return row.path;
}

export function ChangeTree({
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
        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12px] text-muted select-none hover:bg-wash hover:text-ink"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <Symbol name={open ? "chevron.down" : "chevron.right"} className="size-2.5 shrink-0" />
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

export function ChangeFileRow({
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
      className={`group/change relative flex w-full items-center rounded-md py-1 pr-2 text-left text-[13px] select-none ${
        selected ? "bg-wash" : "hover:bg-wash"
      }`}
      style={{ paddingLeft: pad }}
    >
      <button
        type="button"
        onClick={() => onOpen(row, "preview")}
        onDoubleClick={() => onOpen(row, "pin")}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className={`w-3 shrink-0 text-center text-[11px] font-medium ${statusTone(row.status)}`}>{statusMark(row.status)}</span>
        <span className="min-w-0 flex-1 truncate text-ink" title={row.original ? `${row.original} → ${row.path}` : row.path}>
          {label}
        </span>
        {row.staged ? <span className="shrink-0 text-[11px] text-accent">staged</span> : null}
        <span className="transition-opacity group-hover/change:opacity-0">
          <GitLineStats {...gitLineStats(row)} />
        </span>
      </button>
      <span className="absolute top-1/2 right-1 hidden -translate-y-1/2 items-center group-hover/change:flex">
        <button
          type="button"
          title={row.staged && !row.unstaged ? "Unstage" : "Stage"}
          aria-label={row.staged && !row.unstaged ? "Unstage" : "Stage"}
          onClick={() => (row.staged && !row.unstaged ? onUnstage([row.path]) : onStage([row.path]))}
          className="flex size-5 items-center justify-center rounded text-muted hover:bg-wash-strong hover:text-ink"
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
          className="flex size-5 items-center justify-center rounded text-muted hover:bg-wash-strong hover:text-err"
        >
          <Symbol name="arrow.2.circlepath" className="size-3" />
        </button>
      </span>
    </div>
  );
}
