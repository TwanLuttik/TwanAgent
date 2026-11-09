import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../../lib/tauri";
import type { ProjectRemoval } from "../../lib/tauri";
import { formatBytes } from "../../lib/usage";
import { AnchoredMenu, MenuItem, MenuSubmenu } from "../ContextMenu";

export function ProjectContextMenu({
  x,
  y,
  name,
  path,
  onNewChat,
  onFavorite,
  favorite = false,
  onSettings,
  onDelete,
  onCopied,
  onReveal,
  onGroup,
  addTargets,
  onAddTo,
  removeLabel = "Remove project",
}: {
  x: number;
  y: number;
  name: string;
  path?: string;
  onNewChat?: () => void;
  onFavorite?: () => void;
  favorite?: boolean;
  onSettings?: () => void;
  onDelete: () => void;
  onCopied?: () => void;
  onReveal?: () => void;
  onGroup?: () => void;
  addTargets?: { path: string; name: string }[];
  onAddTo?: (groupPath: string) => void;
  removeLabel?: string;
}) {
  return (
    <AnchoredMenu x={x} y={y} label={name}>
      {onNewChat ? <MenuItem onClick={onNewChat}>New chat</MenuItem> : null}
      {onFavorite ? <MenuItem onClick={onFavorite}>{favorite ? "Unfavorite" : "Favorite"}</MenuItem> : null}
      {onSettings ? <MenuItem onClick={onSettings}>Settings</MenuItem> : null}
      {path ? (
        <MenuItem
          onClick={() => {
            void navigator.clipboard.writeText(path).catch(() => undefined);
            onCopied?.();
          }}
        >
          Copy ID
        </MenuItem>
      ) : null}
      {onReveal ? <MenuItem onClick={onReveal}>Open in Finder</MenuItem> : null}
      {onGroup ? <MenuItem onClick={onGroup}>Group projects</MenuItem> : null}
      {addTargets && addTargets.length > 0 ? (
        <MenuSubmenu label="Add to group">
          {addTargets.map((target) => (
            <MenuItem key={target.path} onClick={() => onAddTo?.(target.path)}>
              {target.name}
            </MenuItem>
          ))}
        </MenuSubmenu>
      ) : null}
      <MenuItem danger onClick={onDelete}>
        {removeLabel}
      </MenuItem>
    </AnchoredMenu>
  );
}

export type ProjectDeleteMode = "list" | "files" | "worktrees";

export function DeleteProjectDialog({
  name,
  path,
  appManaged,
  onCancel,
  onConfirm,
}: {
  name: string;
  path: string;
  appManaged: boolean;
  onCancel: () => void;
  onConfirm: (mode: ProjectDeleteMode) => void;
}) {
  const [report, setReport] = useState<ProjectRemoval | null>(null);
  useEffect(() => {
    let gone = false;
    void api.projectRemoval(path).then(
      (next) => {
        if (!gone) setReport(next);
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [path]);
  const worktrees = (report?.worktrees ?? 0) + (report?.app ?? 0);
  const everything = (report?.project ?? 0) + worktrees;
  const count = report?.worktree_count ?? 0;
  const hasWorktrees = count > 0 || (report?.worktrees ?? 0) > 0;
  const [mode, setMode] = useState<ProjectDeleteMode | null>(null);
  const chosen = mode === "worktrees" && !hasWorktrees ? null : mode;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-label={`Remove ${name}`}
        className="w-[300px] rounded-lg border border-line bg-canvas p-3 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && chosen) onConfirm(chosen);
        }}
      >
        <div className="text-[13px] font-medium text-ink">Remove {name}?</div>
        <p className="mt-1 text-[12px] text-muted">
          Choose what leaves the disk. The project folder stays unless you delete it.
        </p>
        <div className="mt-3 flex flex-col gap-0.5" role="radiogroup" aria-label="What to remove">
          {hasWorktrees ? (
            <DeleteChoice
              label={count === 1 ? "Delete worktree" : "Delete worktrees"}
              detail={
                report
                  ? `Removes ${count === 1 ? "the checkout" : `${count} checkouts`} and frees ${formatBytes(worktrees)}. The project stays.`
                  : "Checking how much the checkouts use…"
              }
              selected={chosen === "worktrees"}
              onClick={() => setMode("worktrees")}
            />
          ) : null}
          <DeleteChoice
            label={appManaged ? "Delete project" : "Delete all files"}
            detail={
              report
                ? `Deletes the folder, its chats, and its worktrees. Frees ${formatBytes(everything)}.`
                : "Checking how much this project uses…"
            }
            selected={chosen === "files"}
            onClick={() => setMode("files")}
          />
          <DeleteChoice
            label="Remove from list"
            detail="The folder on disk is left alone. It just leaves the sidebar."
            selected={chosen === "list"}
            onClick={() => setMode("list")}
          />
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[6px] px-2.5 py-1 text-[13px] text-muted hover:bg-wash hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!chosen}
            onClick={() => chosen && onConfirm(chosen)}
            className="rounded-[6px] bg-err px-2.5 py-1 text-[13px] font-medium text-white hover:bg-err/90 disabled:bg-wash disabled:text-muted"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DeleteChoice({
  label,
  detail,
  selected,
  onClick,
}: {
  label: string;
  detail: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex items-start gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-wash ${
        selected ? "bg-wash" : ""
      }`}
    >
      <span
        className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-err" : "border-muted/50"
        }`}
      >
        {selected ? <span className="size-1.5 rounded-full bg-err" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted">{detail}</span>
      </span>
    </button>
  );
}
