import { useEffect, useRef, useState } from "react";
import { formatDiffCount, gitChangeTotals, gitChangesTree } from "../../lib/core";
import { ALL_DIFF_PATH } from "../../lib/editor";
import { gitSectionAfterLoad, type GitSection } from "../../lib/git-sections";
import { loadGitChangesView, saveGitChangesView, type GitChangesView } from "../../lib/prefs";
import * as api from "../../lib/tauri";
import type { GitBranchPullRequest, GitBranches, GitChange, GitCommit, GitIdentity, GitRepoSummary, GitWorktree } from "../../lib/tauri";
import { Symbol } from "../Symbol";
import { ActionsRow } from "./ActionsRow";
import { BranchSwitch } from "./BranchSwitch";
import { ChangeFileRow, ChangeTree, changeLabel } from "./GitChanges";
import { CommitList, GitSectionTabs, PullRequestView } from "./GitSections";

export function GitPane({
  branches,
  summary,
  identity,
  history,
  branchError,
  switching,
  busy,
  onSwitch,
  onCreate,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onIdentity,
  onSync,
  onStash,
  onShow,
  workspacePath,
  worktrees,
  onOpenWorkspace,
  onCreateWorktree,
  onRemoveWorktree,
  changes,
  selected,
  onOpen,
  onOpenAll,
  grouped = false,
}: {
  branches: GitBranches;
  summary: GitRepoSummary | null;
  identity: GitIdentity | null;
  history: GitCommit[];
  branchError: string | null;
  switching: boolean;
  busy: boolean;
  onSwitch: (name: string) => void;
  onCreate: (name: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onCommit: (message: string) => void;
  onIdentity: (name: string, email: string) => void;
  onSync: (action: "fetch" | "pull" | "push" | "publish") => void;
  onStash: (action: "push" | "pop" | "list") => void;
  onShow: (hash: string) => Promise<string>;
  workspacePath: string;
  worktrees: GitWorktree[];
  onOpenWorkspace?: (path: string) => void;
  onCreateWorktree: (branch: string) => void;
  onRemoveWorktree: (path: string) => void;
  changes: GitChange[];
  selected: string | null;
  onOpen: (row: GitChange, mode?: "preview" | "pin") => void;
  onOpenAll: () => void;
  grouped?: boolean;
}) {
  const [view, setView] = useState<GitChangesView>(loadGitChangesView);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [commitText, setCommitText] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [section, setSection] = useState<GitSection>("changes");
  const [request, setRequest] = useState<GitBranchPullRequest | null>(null);
  const [actionsRefresh, setActionsRefresh] = useState(0);
  const tree = view === "tree" ? gitChangesTree(changes) : [];
  const totals = gitChangeTotals(changes);
  const staged = changes.filter((row) => row.staged);
  const unstaged = changes.filter((row) => !row.staged || row.unstaged || row.status === "untracked");
  const repo = branches.repo !== false && (summary?.repo !== false);
  const branch = summary?.detached ? "" : branches.current ?? "";
  const showing = gitSectionAfterLoad(section, Boolean(request));
  const requestFor = useRef("");

  useEffect(() => {
    if (!identity) return;
    setName(identity.name);
    setEmail(identity.email);
  }, [identity]);

  useEffect(() => {
    const key = `${workspacePath}\n${branch}`;
    if (requestFor.current !== key) {
      requestFor.current = key;
      setRequest(null);
    }
    if (!workspacePath || !repo || grouped || busy) {
      if (!workspacePath || !repo || grouped) setRequest(null);
      return;
    }
    let cancel = false;
    void api.gitBranchPullRequest(workspacePath).then(
      (row) => {
        if (!cancel) setRequest(row && row.number > 0 ? row : null);
      },
      () => {
        if (!cancel) setRequest(null);
      },
    );
    return () => {
      cancel = true;
    };
  }, [workspacePath, branch, repo, grouped, busy]);

  useEffect(() => {
    if (section === "request" && !request) setSection("changes");
  }, [section, request]);

  function openCommit(hash: string) {
    if (commitHash === hash && commitText !== null) {
      setCommitHash(null);
      setCommitText(null);
      return;
    }
    setCommitHash(hash);
    setCommitText(null);
    void onShow(hash).then(setCommitText).catch((e) => setCommitText(String(e)));
  }

  useEffect(() => {
    if (!moreOpen) return;
    function onDoc(ev: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(ev.target as Node)) setMoreOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  function setChangesView(next: GitChangesView) {
    setView(next);
    saveGitChangesView(next);
  }

  return (
    <>
      <div className="shrink-0 px-1 pt-1">
        <div className="flex items-center gap-0.5 pr-0.5">
          {grouped ? <div className="min-w-0 flex-1" /> : (
            <div className="min-w-0 flex-1">
              <BranchSwitch
                current={summary?.detached ? summary.commit : branches.current}
                names={branches.branches}
                switching={switching}
                onSwitch={onSwitch}
                upstream={summary?.upstream ?? null}
                ahead={summary?.ahead ?? 0}
                behind={summary?.behind ?? 0}
                workspace={workspacePath}
                worktrees={repo ? worktrees : []}
                busy={busy}
                onOpenWorktree={(path) => onOpenWorkspace?.(path)}
                onCreateWorktree={onCreateWorktree}
                onRemoveWorktree={onRemoveWorktree}
              />
            </div>
          )}
          {repo && !grouped ? (
            <div className="flex shrink-0 items-center">
              <GitIconButton label="Fetch" icon="arrow.2.circlepath" disabled={busy} onClick={() => onSync("fetch")} />
              <GitIconButton label="Pull" icon="square.and.arrow.down" disabled={busy} onClick={() => onSync("pull")} />
              <GitIconButton
                label={summary?.upstream ? "Push" : "Publish branch"}
                icon="square.and.arrow.up"
                disabled={busy}
                onClick={() => {
                  onSync(summary?.upstream ? "push" : "publish");
                  setActionsRefresh((n) => n + 1);
                }}
              />
              <div className="relative" ref={moreRef}>
              <GitIconButton
                label="More"
                icon="ellipsis"
                pressed={moreOpen}
                disabled={busy}
                onClick={() => setMoreOpen((open) => !open)}
              />
              {moreOpen ? (
                <div
                  role="menu"
                  aria-label="Git actions"
                  className="absolute top-full right-0 z-20 mt-1 min-w-[148px] rounded-md border border-line bg-canvas py-1 shadow-card"
                >
                  <GitMenuItem
                    label="Stash changes"
                    disabled={changes.length === 0}
                    onClick={() => {
                      setMoreOpen(false);
                      onStash("push");
                    }}
                  />
                  <GitMenuItem
                    label="Pop stash"
                    onClick={() => {
                      setMoreOpen(false);
                      onStash("pop");
                    }}
                  />
                  <GitMenuItem
                    label="New branch"
                    onClick={() => {
                      setMoreOpen(false);
                      setShowNew(true);
                    }}
                  />
                </div>
              ) : null}
              </div>
            </div>
          ) : null}
        </div>
        {repo && !grouped && workspacePath ? (
          <ActionsRow workspace={workspacePath} branch={branch} refreshToken={actionsRefresh} />
        ) : null}
        {branchError ? <p className="px-2 pt-1 text-[12px] text-err">{branchError}</p> : null}
        {showNew ? (
          <form
            className="flex gap-1 px-0.5 pt-1"
            onSubmit={(ev) => {
              ev.preventDefault();
              const next = newBranch.trim();
              if (!next) return;
              onCreate(next);
              setNewBranch("");
              setShowNew(false);
            }}
          >
            <input
              value={newBranch}
              onChange={(ev) => setNewBranch(ev.target.value)}
              placeholder="feature/name"
              className="min-w-0 flex-1 rounded-[6px] bg-wash px-2 py-1 text-[12px] text-ink outline-none placeholder:text-muted/70"
            />
            <GitAction label="Create" disabled={busy || !newBranch.trim()} onClick={() => undefined} submit />
            <button
              type="button"
              onClick={() => {
                setShowNew(false);
                setNewBranch("");
              }}
              className="rounded-[6px] px-1.5 text-[11px] text-muted hover:bg-wash hover:text-ink"
            >
              Cancel
            </button>
          </form>
        ) : null}
      </div>
      {repo && identity && !identity.configured ? (
        <form
          className="grid gap-1 px-2.5 pt-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (name.trim() && email.trim()) onIdentity(name.trim(), email.trim());
          }}
        >
          <p className="text-[11px] text-muted">Set a name and email for this repo before committing.</p>
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Name" className="rounded-[6px] bg-wash px-2 py-1 text-[12px] outline-none" />
          <input value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="Email" className="rounded-[6px] bg-wash px-2 py-1 text-[12px] outline-none" />
          <GitAction label="Save identity" disabled={busy || !name.trim() || !email.trim()} onClick={() => undefined} submit />
        </form>
      ) : null}
      {repo ? (
        <GitSectionTabs
          section={showing}
          hasRequest={Boolean(request)}
          onSelect={setSection}
          changesCount={changes.length}
          trailing={
            showing === "changes" ? (
              <div className="mb-1 flex items-center rounded-md bg-wash p-0.5" role="group" aria-label="Change list layout">
                <button
                  type="button"
                  aria-pressed={view === "list"}
                  aria-label="List view"
                  title="List"
                  onClick={() => setChangesView("list")}
                  className={`flex size-5 items-center justify-center rounded-[5px] ${view === "list" ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                >
                  <Symbol name="list.bullet" className="size-3" />
                </button>
                <button
                  type="button"
                  aria-pressed={view === "tree"}
                  aria-label="Tree view"
                  title="Tree"
                  onClick={() => setChangesView("tree")}
                  className={`flex size-5 items-center justify-center rounded-[5px] ${view === "tree" ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                >
                  <Symbol name="list.tree" className="size-3" />
                </button>
              </div>
            ) : null
          }
        />
      ) : null}
      {showing === "commits" ? (
        <CommitList commits={history} openHash={commitHash} detail={commitText} onOpen={openCommit} />
      ) : null}
      {showing === "request" && request ? (
        <PullRequestView
          request={request}
          openHash={commitHash}
          detail={commitText}
          onOpenCommit={openCommit}
          onOpenUrl={(url) => void api.openUrl(url)}
        />
      ) : null}
      {showing === "changes" && changes.length > 0 ? (
        <div className="shrink-0 px-2 pt-2 pb-1">
          <form
            className="overflow-hidden rounded-xl border border-line/40 bg-canvas"
            onSubmit={(ev) => {
              ev.preventDefault();
              const text = message.trim();
              if (!text || staged.length === 0) return;
              onCommit(text);
              setMessage("");
            }}
          >
            <button
              type="button"
              onClick={onOpenAll}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                selected === ALL_DIFF_PATH ? "bg-wash text-ink" : "text-muted hover:bg-wash/60 hover:text-ink"
              }`}
            >
              <span>All changes</span>
              <span className="ml-auto flex items-baseline gap-2 font-mono text-[11px] tabular-nums">
                {totals.additions > 0 ? <span className="text-ok">+{formatDiffCount(totals.additions)}</span> : null}
                {totals.deletions > 0 ? <span className="text-err">−{formatDiffCount(totals.deletions)}</span> : null}
              </span>
            </button>
            <div className="border-t border-line/30 px-2 pt-1.5 pb-2">
              <textarea
                value={message}
                onChange={(ev) => setMessage(ev.target.value)}
                placeholder="Commit message"
                rows={2}
                onKeyDown={(ev) => {
                  if (ev.key !== "Enter" || (!ev.metaKey && !ev.ctrlKey)) return;
                  ev.preventDefault();
                  ev.currentTarget.form?.requestSubmit();
                }}
                className="w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-5 text-ink outline-none placeholder:text-muted/70"
              />
              <div className="mt-0.5 flex items-center gap-0.5 px-0.5">
                <button
                  type="button"
                  disabled={busy || unstaged.length === 0}
                  onClick={() => onStage(unstaged.map((row) => row.path))}
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink hover:bg-wash disabled:text-muted disabled:hover:bg-transparent"
                >
                  Stage all
                  {unstaged.length > 0 ? (
                    <span className="rounded-full bg-wash px-1.5 py-px text-[11px] text-muted tabular-nums">{unstaged.length}</span>
                  ) : null}
                </button>
                {staged.length > 0 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onUnstage(staged.map((row) => row.path))}
                    className="rounded-md px-1.5 py-1 text-[12px] text-muted hover:bg-wash hover:text-ink disabled:opacity-40"
                  >
                    Unstage
                  </button>
                ) : null}
                <GitIconButton
                  label="Discard all changes"
                  icon="trash"
                  disabled={busy || changes.length === 0}
                  onClick={() => {
                    if (window.confirm("Discard all local changes? This cannot be undone.")) onDiscard(changes.map((row) => row.path));
                  }}
                />
                <button
                  type="submit"
                  disabled={busy || !message.trim() || staged.length === 0}
                  className="ml-auto rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:bg-wash disabled:text-muted"
                >
                  {busy ? "Working…" : "Commit"}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
      {showing === "changes" ? (
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
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))
        ) : (
          changes.map((row) => (
            <ChangeFileRow
              key={`${row.path}-${row.staged}`}
              row={row}
              label={changeLabel(row)}
              selected={selected === row.path}
              pad={8}
              onOpen={onOpen}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))
        )}
      </div>
      ) : null}
    </>
  );
}

function GitIconButton({
  label,
  icon,
  disabled,
  pressed,
  onClick,
}: {
  label: string;
  icon: "arrow.2.circlepath" | "square.and.arrow.down" | "square.and.arrow.up" | "ellipsis" | "trash";
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <span className="group/tip relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={`flex size-6 items-center justify-center rounded-[6px] hover:bg-wash hover:text-ink disabled:opacity-40 ${
          pressed ? "bg-wash-strong text-ink" : "text-muted"
        }`}
      >
        <Symbol name={icon} className="size-3.5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full left-1/2 z-30 mt-1 hidden -translate-x-1/2 rounded-md border border-line/25 bg-canvas px-2 py-1 text-[11px] whitespace-nowrap text-ink shadow-card group-hover/tip:block"
      >
        {label}
      </span>
    </span>
  );
}

function GitMenuItem({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-inset disabled:cursor-default disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function GitAction({
  label,
  disabled,
  onClick,
  submit,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  submit?: boolean;
}) {
  return (
    <button
      type={submit ? "submit" : "button"}
      disabled={disabled}
      onClick={submit ? undefined : onClick}
      className="rounded-[6px] border border-line/50 bg-panel px-2 py-1 text-[11px] font-medium text-ink hover:border-line hover:bg-wash-strong disabled:border-transparent disabled:bg-wash disabled:text-muted disabled:opacity-100"
    >
      {label}
    </button>
  );
}
