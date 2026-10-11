import { projectKey } from "./core.ts";
import type { GitBranches } from "./tauri.ts";

export type ProjectGit = {
  branch: string;
};

/** Branch label for a sidebar row. Missing when the folder is not a git repo. */
export function projectGitLabel(info: GitBranches | null | undefined): ProjectGit | null {
  if (!info || info.repo === false) return null;
  const current = info.current?.trim();
  if (current) return { branch: current };
  if (info.branches.length > 0) return { branch: "detached" };
  return null;
}

export function projectGitKey(path: string): string {
  return projectKey(path);
}
