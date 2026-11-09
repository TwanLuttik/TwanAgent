import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { GitWorktree } from "../../lib/tauri";
import { Symbol } from "../Symbol";

const GIT_MENU_EASE = [0.22, 1, 0.36, 1] as const;

export function BranchSwitch({
  current,
  names,
  switching,
  onSwitch,
  upstream,
  ahead,
  behind,
  workspace,
  worktrees,
  busy,
  onOpenWorktree,
  onCreateWorktree,
  onRemoveWorktree,
}: {
  current: string | null;
  names: string[];
  switching: boolean;
  onSwitch: (name: string) => void;
  upstream: string | null;
  ahead: number;
  behind: number;
  workspace: string;
  worktrees: GitWorktree[];
  busy: boolean;
  onOpenWorktree: (path: string) => void;
  onCreateWorktree: (branch: string) => void;
  onRemoveWorktree: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const here = worktrees.find((row) => sameGitPath(row.path, workspace)) ?? null;
  const label = here
    ? here.detached
      ? "detached"
      : here.branch || current || folderName(here.path)
    : current || (names.length ? "Detached HEAD" : "No git repo");
  const canOpen = (names.length > 0 || worktrees.length > 0) && !switching;
  const checkedOut = new Set(
    worktrees.map((row) => (row.detached ? "" : row.branch || "")).filter(Boolean),
  );
  const otherBranches = names.filter((name) => name !== current && !checkedOut.has(name));

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

  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  function close() {
    setOpen(false);
    setNaming(false);
    setDraft("");
  }

  function createWorktree() {
    const name = draft.trim();
    if (!name || busy) return;
    close();
    onCreateWorktree(name);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        ref={button}
        type="button"
        disabled={!canOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        title={here?.path || (current ? `Branch ${current}` : label)}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        className={`flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] hover:bg-wash disabled:opacity-50 ${
          open ? "bg-wash text-ink" : "text-ink"
        }`}
      >
        <Symbol name="arrow.triangle.branch" className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{switching ? "Switching…" : label}</span>
        {ahead > 0 ? <span className="shrink-0 text-[10px] font-medium text-ok">↑{ahead}</span> : null}
        {behind > 0 ? <span className="shrink-0 text-[10px] font-medium text-warn">↓{behind}</span> : null}
        {canOpen ? <Symbol name="chevron.down" className={`size-2.5 shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`} /> : null}
      </button>
      <GitPopMenu open={open} anchor={button} label="Branches and worktrees">
        <div className="max-h-72 overflow-auto py-1">
          {worktrees.length ? (
            <>
              <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-[0.04em] text-muted uppercase">Worktrees</p>
              {worktrees.map((row) => {
                const selected = sameGitPath(row.path, workspace);
                const name = row.detached ? "detached" : row.branch || folderName(row.path);
                return (
                  <div key={row.path} className="group/wt flex items-center pr-1 hover:bg-wash">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      title={row.path}
                      disabled={selected}
                      onClick={() => {
                        close();
                        onOpenWorktree(row.path);
                      }}
                      className={`flex h-7 min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-[12px] disabled:opacity-100 ${
                        selected ? "font-medium text-ink" : "text-ink/80"
                      }`}
                    >
                      <Symbol name="arrow.triangle.branch" className={`size-3.5 shrink-0 ${selected ? "text-accent" : "text-muted"}`} />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-[10px] font-normal text-muted">{row.main ? "main" : folderName(row.path)}</span>
                      <Symbol name="checkmark" className={`size-3 shrink-0 text-accent ${selected ? "opacity-100" : "opacity-0"}`} />
                    </button>
                    {!row.main && !selected ? (
                      <button
                        type="button"
                        aria-label={`Remove worktree ${name}`}
                        title="Remove worktree"
                        disabled={busy}
                        onClick={() => onRemoveWorktree(row.path)}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-wash-strong hover:text-err group-hover/wt:opacity-100 disabled:opacity-40"
                      >
                        <Symbol name="xmark" className="size-3" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : null}
          {otherBranches.length ? (
            <>
              <p className={`px-2.5 pb-0.5 text-[10px] font-semibold tracking-[0.04em] text-muted uppercase ${worktrees.length ? "pt-2" : "pt-1"}`}>
                Branches
              </p>
              {otherBranches.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="menuitem"
                  title={upstream && name === current ? upstream : undefined}
                  onClick={() => {
                    close();
                    onSwitch(name);
                  }}
                  className="flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px] text-ink/80 transition-colors duration-150 hover:bg-wash"
                >
                  <Symbol name="arrow.triangle.branch" className="size-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </button>
              ))}
            </>
          ) : null}
          {!worktrees.length && !otherBranches.length ? (
            <p className="px-2.5 py-2 text-[12px] text-muted">No other branches</p>
          ) : null}
        </div>
        <div className="border-t border-line/20 p-1">
          {naming ? (
            <div className="px-1 py-0.5">
              <input
                ref={field}
                value={draft}
                aria-label="New worktree name"
                placeholder="feat/name"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    createWorktree();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setNaming(false);
                    setDraft("");
                  }
                }}
                className="h-7 w-full bg-transparent px-1.5 text-[12px] text-ink outline-none placeholder:text-muted"
              />
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => setNaming(true)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink/80 hover:bg-wash disabled:opacity-40"
            >
              <Symbol name="plus" className="size-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">New worktree</span>
            </button>
          )}
        </div>
      </GitPopMenu>
    </div>
  );
}

function GitPopMenu({
  open,
  anchor,
  label,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  children: ReactNode;
}) {
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const frame = anchor.current?.getBoundingClientRect();
    if (!frame) return;
    setAbove(frame.bottom + 280 > window.innerHeight && frame.top > 280);
  }, [open, anchor]);
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="menu"
          aria-label={label}
          initial={{ opacity: 0, y: above ? 6 : -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: above ? 6 : -6 }}
          transition={{ duration: 0.16, ease: GIT_MENU_EASE }}
          className={`absolute right-0 left-0 z-30 overflow-hidden rounded-lg border border-line/25 bg-canvas shadow-card ${
            above ? "bottom-full mb-1 origin-bottom" : "top-full mt-1 origin-top"
          }`}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function sameGitPath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}
