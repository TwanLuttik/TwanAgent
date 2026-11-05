import { invoke } from "@tauri-apps/api/core";

export type GitChange = {
  path: string;
  original?: string | null;
  status: string;
  staged: boolean;
  unstaged?: boolean;
  additions: number;
  deletions: number;
};
export type GitBranches = { current: string | null; branches: string[]; repo?: boolean };
export type GitRepoSummary = {
  repo: boolean;
  current: string | null;
  detached: boolean;
  commit: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
};
export type GitCommit = {
  hash: string;
  short: string;
  author: string;
  at: string;
  subject: string;
};
export type GitIdentity = { name: string; email: string; configured: boolean };
export type GitWorktree = {
  path: string;
  head?: string | null;
  branch?: string | null;
  bare: boolean;
  detached: boolean;
  main: boolean;
};
export type GitWorktreeAdd = { worktrees: GitWorktree[]; opened: string };
export type GitPullRequest = {
  number: number;
  title: string;
  branch: string;
  head: string;
  url: string;
  /** False once GitHub has closed or merged it. Git still advertises the head. */
  open?: boolean;
};

export type GitPullRequestChecks = { pass: number; fail: number; pending: number };

export type GitPullRequestCommit = {
  hash: string;
  short: string;
  author: string;
  at: string;
  subject: string;
};

export type GitPullRequestFile = { path: string; additions: number; deletions: number };

/** The pull request for the branch that is checked out. Null when this branch has none. */
export type GitBranchPullRequest = {
  number: number;
  title: string;
  /** open, draft, merged, or closed. */
  state: string;
  body: string;
  author: string;
  base: string;
  head: string;
  url: string;
  additions: number;
  deletions: number;
  changed: number;
  /** approved, changes, review, or empty when GitHub has no decision yet. */
  review: string;
  checks: GitPullRequestChecks;
  commits: GitPullRequestCommit[];
  files: GitPullRequestFile[];
};

export function gitStatus(workspace: string, stats = true): Promise<GitChange[]> {
  return invoke("dev_git_status", { workspace, stats });
}

export function gitDiff(workspace: string, path = ""): Promise<string> {
  return invoke("dev_git_diff", { workspace, path });
}

export function gitBranches(workspace: string): Promise<GitBranches> {
  return invoke("dev_git_branches", { workspace });
}

export function gitSwitch(workspace: string, name: string): Promise<GitBranches> {
  return invoke("dev_git_switch", { workspace, name });
}

export function gitSummary(workspace: string): Promise<GitRepoSummary> {
  return invoke("dev_git_summary", { workspace });
}

/** Branch label for a folder that is not the open workspace. Does not register it. */
export function gitProjectSummary(path: string): Promise<GitRepoSummary> {
  return invoke("dev_git_project_summary", { path });
}

export function gitCreateBranch(workspace: string, name: string, checkout = true): Promise<GitBranches> {
  return invoke("dev_git_create_branch", { workspace, name, checkout });
}

export function gitStage(workspace: string, paths: string[]): Promise<GitChange[]> {
  return invoke("dev_git_stage", { workspace, paths });
}

export function gitUnstage(workspace: string, paths: string[]): Promise<GitChange[]> {
  return invoke("dev_git_unstage", { workspace, paths });
}

export function gitDiscard(workspace: string, paths: string[]): Promise<GitChange[]> {
  return invoke("dev_git_discard", { workspace, paths });
}

export function gitCommit(workspace: string, message: string): Promise<string> {
  return invoke("dev_git_commit", { workspace, message });
}

export function gitIdentity(workspace: string): Promise<GitIdentity> {
  return invoke("dev_git_identity", { workspace });
}

export function gitSetIdentity(workspace: string, name: string, email: string): Promise<GitIdentity> {
  return invoke("dev_git_set_identity", { workspace, name, email });
}

export function gitSync(workspace: string, action: "fetch" | "pull" | "push" | "publish"): Promise<string> {
  return invoke("dev_git_sync", { workspace, action });
}

export function gitStash(workspace: string, action: "push" | "pop" | "list", message = ""): Promise<string> {
  return invoke("dev_git_stash", { workspace, action, message });
}

export function gitLog(workspace: string, limit = 40): Promise<GitCommit[]> {
  return invoke("dev_git_log", { workspace, limit });
}

export function gitShow(workspace: string, hash: string): Promise<string> {
  return invoke("dev_git_show", { workspace, hash });
}

export function gitFileAt(workspace: string, path: string, revision = "HEAD"): Promise<string> {
  return invoke("dev_git_file_at", { workspace, path, revision });
}

export function gitWorktrees(workspace: string): Promise<GitWorktree[]> {
  return invoke("dev_git_worktrees", { workspace });
}

/** GitHub pull requests for this repo, open and closed. Empty when it is not a GitHub remote. */
export function gitPullRequests(workspace: string): Promise<GitPullRequest[]> {
  return invoke("dev_git_pull_requests", { workspace });
}

/** The list saved after the last refresh. Empty until one has landed. */
export function gitPullRequestsCached(workspace: string): Promise<GitPullRequest[]> {
  return invoke("dev_git_pull_requests_cached", { workspace });
}

/** Fetch one open pull request into a sibling worktree and return that checkout. */
export function gitBranchPullRequest(workspace: string): Promise<GitBranchPullRequest | null> {
  return invoke("dev_git_branch_pull_request", { workspace });
}

export function gitPullRequestCheckout(workspace: string, number: number): Promise<GitWorktreeAdd> {
  return invoke("dev_git_pull_request_checkout", { workspace, number });
}

export function gitWorktreeAdd(workspace: string, branch: string, create = true): Promise<GitWorktreeAdd> {
  return invoke("dev_git_worktree_add", { workspace, branch, create });
}

/** Rename a linked worktree's branch and move its folder. Chats stay with the folder. */
export function gitWorktreeRename(workspace: string, path: string, branch: string): Promise<GitWorktreeAdd> {
  return invoke("dev_git_worktree_rename", { workspace, path, branch });
}

export function gitWorktreeRemove(workspace: string, path: string): Promise<GitWorktree[]> {
  return invoke("dev_git_worktree_remove", { workspace, path });
}
