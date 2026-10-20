import { useState } from "react";
import type { GitWorktree } from "../lib/tauri.ts";
import { Symbol } from "./Symbol";

function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function WorktreeSection({
  workspace,
  worktrees,
  busy,
  onOpen,
  onCreate,
  onRemove,
}: {
  workspace: string;
  worktrees: GitWorktree[];
  busy: boolean;
  onOpen: (path: string) => void;
  onCreate: (branch: string) => void;
  onRemove: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (worktrees.length === 0) return null;
  return (
    <div className="mt-0.5 px-0.5">
      <div className="flex items-center gap-1 px-1.5">
        <span className="min-w-0 flex-1 text-[10px] font-semibold tracking-[0.06em] text-muted uppercase">Worktrees</span>
        <button
          type="button"
          disabled={busy}
          title="New worktree"
          onClick={() => setOpen((value) => !value)}
          className="rounded-[6px] px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-wash hover:text-ink disabled:opacity-40"
        >
          {open ? "Cancel" : "New"}
        </button>
      </div>
      {open ? (
        <form
          className="flex gap-1 px-1 pt-1"
          onSubmit={(ev) => {
            ev.preventDefault();
            const next = name.trim();
            if (!next || busy) return;
            onCreate(next);
            setName("");
            setOpen(false);
          }}
        >
          <input
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            placeholder="feat/name"
            aria-label="New worktree branch"
            className="min-w-0 flex-1 rounded-[6px] bg-wash px-2 py-1 text-[12px] text-ink outline-none placeholder:text-muted/70"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-[6px] bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:bg-wash disabled:text-muted"
          >
            Create
          </button>
        </form>
      ) : null}
      <div className="pt-0.5">
        {worktrees.map((row) => {
          const here = samePath(row.path, workspace);
          const label = row.detached ? "detached" : row.branch || folderName(row.path);
          return (
            <div
              key={row.path}
              className={`group/wt flex items-center gap-1 rounded-[6px] pr-1 ${here ? "bg-accent/10" : "hover:bg-wash"}`}
            >
              <button
                type="button"
                disabled={here}
                onClick={() => onOpen(row.path)}
                title={row.path}
                className={`flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-[3px] text-left text-[12px] disabled:opacity-100 ${
                  here ? "text-ink" : "text-ink/75"
                }`}
              >
                <Symbol name="arrow.triangle.branch" className={`size-3.5 shrink-0 ${here ? "text-accent" : "text-muted"}`} />
                <span className={`min-w-0 flex-1 truncate ${here ? "font-medium" : ""}`}>{label}</span>
                <span className={`shrink-0 rounded px-1 text-[10px] ${here ? "bg-accent/15 text-accent" : "text-muted/80"}`}>
                  {row.main ? "main" : folderName(row.path)}
                </span>
              </button>
              {!row.main && !here ? (
                <button
                  type="button"
                  aria-label={`Remove worktree ${label}`}
                  title="Remove worktree"
                  disabled={busy}
                  onClick={() => onRemove(row.path)}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-wash-strong hover:text-err group-hover/wt:opacity-100 disabled:opacity-40"
                >
                  <Symbol name="xmark" className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
