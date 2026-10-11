import { projectKey } from "./core.ts";
import type { GitBranches, GitRepoSummary } from "./tauri.ts";

export type ProjectGit = {
  branch: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
};

/** Branch label for a sidebar row. Missing when the folder is not a git repo. */
export function projectGitLabel(
  info: GitBranches | GitRepoSummary | null | undefined,
): ProjectGit | null {
  if (!info || info.repo === false) return null;
  const summary = "detached" in info ? info : null;
  const current = info.current?.trim();
  const branch = current || (summary?.commit ? summary.commit.slice(0, 7) : "");
  if (!branch && !summary?.detached) {
    if ("branches" in info && info.branches.length > 0) return { branch: "detached" };
    return null;
  }
  if (!branch) return { branch: "detached" };
  const label: ProjectGit = { branch };
  if (summary?.ahead) label.ahead = summary.ahead;
  if (summary?.behind) label.behind = summary.behind;
  if (summary?.dirty) label.dirty = summary.dirty;
  return label;
}

export function projectGitKey(path: string): string {
  return projectKey(path);
}
