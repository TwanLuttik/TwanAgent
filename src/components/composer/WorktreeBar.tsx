import { useEffect, useRef, useState } from "react";
import { projectKey } from "../../lib/core";
import {
  pullRequestChoices,
  subscribeWorktreeLists,
  worktreeChoices,
  worktreeListsFor,
  type PullRequestChoice,
  type WorktreeChoice,
} from "../../lib/worktree";
import type { GitPullRequest } from "../../lib/tauri";
import * as api from "../../lib/tauri";
import { Symbol } from "../Symbol";
import { PopMenu } from "./PopMenu";

export function WorktreeBar({
  workspace,
  suggested,
  onOpen,
  onCreate,
  onOpenPullRequest,
  checkingOut = 0,
}: {
  workspace: string;
  suggested: string;
  onOpen: (path: string) => void;
  onCreate?: (branch: string) => void;
  onOpenPullRequest?: (number: number) => void;
  checkingOut?: number;
}) {
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [requests, setRequests] = useState<GitPullRequest[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => subscribeWorktreeLists(() => setTick((n) => n + 1)), []);
  const trees = worktreeListsFor(workspace);
  const { current, rows } = worktreeChoices(workspace, trees);
  const pulls = pullRequestChoices(requests, trees, workspace);
  // A checked-out pull request is one row. The `pr/5` branch would say the same thing again.
  const pullPaths = new Set(pulls.filter((row) => row.path).map((row) => projectKey(row.path)));
  const branchRows = rows.filter((row) => row.main || row.current || !pullPaths.has(projectKey(row.path)));
  const currentPull = pulls.find((row) => row.current) ?? null;
  const openPulls = pulls.filter((row) => row.open);
  const closedPulls = pulls.filter((row) => !row.open);
  const shownPulls = showClosed ? pulls : openPulls;
  void tick;
  useEffect(() => {
    if (!workspace || !onOpenPullRequest) return;
    let cancelled = false;
    // Paint the list saved last time, then refresh. A restart should not wait on GitHub.
    void api.gitPullRequestsCached(workspace).then((cached) => {
      if (!cancelled && cached.length) setRequests(cached);
    }, () => undefined);
    void api.gitPullRequests(workspace).then(
      (next) => {
        if (!cancelled) setRequests(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [workspace, onOpenPullRequest]);
  useEffect(() => {
    if (!naming) return;
    field.current?.focus();
  }, [naming]);
  if (!current) return null;
  const label = currentPull
    ? currentPull.title
      ? `#${currentPull.number} ${currentPull.title}`
      : `#${currentPull.number}`
    : current.main
      ? `${current.branch} · main`
      : current.branch;
  const generated = suggested.trim();
  function create() {
    if (!onCreate) return;
    // A blank field uses the name already generated for this chat.
    const name = draft.trim() || generated;
    setOpen(false);
    setNaming(false);
    setDraft("");
    onCreate(name);
  }
  return (
    <div className="mt-1 flex items-center px-1">
      <button
        ref={button}
        type="button"
        aria-label="Worktree"
        aria-expanded={open}
        title={current.path}
        onClick={() => {
          setOpen((value) => !value);
          setNaming(false);
          setDraft("");
        }}
        className={`flex h-6 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        {checkingOut ? (
          <span className="size-3 shrink-0 animate-spin rounded-full border border-current/40 border-t-transparent" aria-label="Checking out" />
        ) : (
          <Symbol
            name={currentPull ? "arrow.triangle.pull" : "arrow.triangle.branch"}
            className={`size-3 shrink-0 ${current.main && !currentPull ? "text-muted" : "text-accent"}`}
          />
        )}
        <span className="min-w-0 truncate">{checkingOut ? "Checking out…" : label}</span>
        <Symbol name="chevron.down" className="size-2.5 shrink-0 opacity-70" />
      </button>
      <PopMenu
        open={open}
        anchor={button}
        label="Worktrees"
        align="start"
        width={280}
        placement="below"
        onClose={() => {
          setOpen(false);
          setNaming(false);
        }}
      >
        <div className="max-h-72 overflow-auto py-1">
          {branchRows.map((row) => (
            <WorktreeChoiceRow
              key={row.path}
              row={row}
              onPick={() => {
                setOpen(false);
                if (!row.current) onOpen(row.path);
              }}
            />
          ))}
          {shownPulls.length || closedPulls.length ? (
            <>
              <p className="px-2.5 pt-2 pb-0.5 text-[10px] font-semibold tracking-[0.04em] text-muted uppercase">
                Pull requests
              </p>
              {shownPulls.map((row) => (
                <PullRequestChoiceRow
                  key={row.number}
                  row={row}
                  loading={checkingOut === row.number}
                  onPick={() => {
                    if (checkingOut) return;
                    if (row.path) {
                      setOpen(false);
                      const currentPath = current?.path ?? "";
                      if (currentPath && projectKey(row.path) !== projectKey(currentPath)) onOpen(row.path);
                      return;
                    }
                    // Keep the menu open so the spinner stays on the row being fetched.
                    onOpenPullRequest?.(row.number);
                  }}
                />
              ))}
              {closedPulls.length ? (
                <button
                  type="button"
                  role="menuitem"
                  aria-expanded={showClosed}
                  onClick={() => setShowClosed((value) => !value)}
                  className="flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px] text-muted hover:bg-wash hover:text-ink"
                >
                  <Symbol name={showClosed ? "chevron.up" : "chevron.right"} className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {showClosed ? "Hide closed" : `Closed · ${closedPulls.length}`}
                  </span>
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {onCreate ? (
          <div className="border-t border-line/20 p-1">
            {naming ? (
              <div className="px-1 py-0.5">
                <input
                  ref={field}
                  value={draft}
                  aria-label="New worktree name"
                  placeholder={generated || "Press enter to create"}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      create();
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
                onClick={() => setNaming(true)}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink/80 hover:bg-wash"
              >
                <Symbol name="plus" className="size-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  {generated ? `New worktree · ${generated}` : "New worktree"}
                </span>
              </button>
            )}
          </div>
        ) : null}
      </PopMenu>
    </div>
  );
}

function PullRequestChoiceRow({
  row,
  loading = false,
  onPick,
}: {
  row: PullRequestChoice;
  loading?: boolean;
  onPick: () => void;
}) {
  const title = row.title || row.branch;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={row.current}
      aria-busy={loading}
      title={loading ? "Fetching this pull request" : row.url || title}
      disabled={loading}
      onClick={onPick}
      className={`flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px] hover:bg-wash disabled:opacity-100 ${
        row.current ? "font-medium text-ink" : row.open ? "text-ink/80" : "text-muted"
      }`}
    >
      {loading ? (
        <span className="size-3.5 shrink-0 animate-spin rounded-full border border-current/40 border-t-transparent" aria-hidden />
      ) : (
        <Symbol
          name="arrow.triangle.pull"
          className={`size-3.5 shrink-0 ${row.current ? "text-accent" : row.open ? "text-muted" : "text-muted/50"}`}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{loading ? "Checking out…" : title}</span>
      <span className="shrink-0 text-[10px] text-muted">#{row.number}</span>
      <Symbol name="checkmark" className={`size-3 shrink-0 text-accent ${row.current && !loading ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}

function WorktreeChoiceRow({ row, onPick }: { row: WorktreeChoice; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={row.current}
      title={row.path}
      onClick={onPick}
      className={`flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px] hover:bg-wash ${
        row.current ? "font-medium text-ink" : "text-ink/80"
      }`}
    >
      <Symbol name="arrow.triangle.branch" className={`size-3.5 shrink-0 ${row.current ? "text-accent" : "text-muted"}`} />
      <span className="min-w-0 flex-1 truncate">{row.branch}</span>
      <span className="shrink-0 text-[10px] text-muted">{row.main ? "main" : row.name}</span>
      <Symbol name="checkmark" className={`size-3 shrink-0 text-accent ${row.current ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}
