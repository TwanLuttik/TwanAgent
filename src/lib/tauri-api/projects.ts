import { invoke } from "@tauri-apps/api/core";

export function projectsRoot(): Promise<string> {
  return invoke("dev_projects_root");
}

export type ProjectPathMove = { from: string; to: string };

export type ProjectsLocation = {
  root: string;
  legacy_root: string;
  moves: ProjectPathMove[];
};

export function projectsLocation(): Promise<ProjectsLocation> {
  return invoke("dev_projects_location");
}

export function listProjects(): Promise<FolderSuggestion[]> {
  return invoke("dev_list_projects");
}

export function addProject(path: string): Promise<FolderSuggestion> {
  return invoke("dev_app_add_project", { path });
}

export function removeProject(path: string): Promise<boolean> {
  return invoke("dev_app_remove_project", { path });
}

export function reorderProjects(paths: string[]): Promise<FolderSuggestion[]> {
  return invoke("dev_app_reorder_projects", { paths });
}

export function getAppSetting(key: string): Promise<string | null> {
  return invoke("dev_app_get_setting", { key });
}

export function setAppSetting(key: string, value: string): Promise<void> {
  return invoke("dev_app_set_setting", { key, value });
}

export function openFolder(path: string): Promise<string> {
  return invoke("dev_open_folder", { path });
}

export type FolderSuggestion = { name: string; path: string };

export function suggestFolders(path: string): Promise<FolderSuggestion[]> {
  return invoke("dev_suggest_folders", { path });
}

export function createProject(name: string): Promise<string> {
  return invoke("dev_create_project", { name });
}

export type ProjectGroupMember = { path: string; alias: string; name: string };

export type ProjectGroup = { path: string; name: string; members: ProjectGroupMember[] };

export function listProjectGroups(): Promise<ProjectGroup[]> {
  return invoke("dev_list_project_groups");
}

export function createProjectGroup(name: string, paths: string[]): Promise<ProjectGroup> {
  return invoke("dev_create_project_group", { name, paths });
}

export function addGroupMember(group: string, path: string): Promise<ProjectGroupMember> {
  return invoke("dev_add_group_member", { group, path });
}

export function removeGroupMember(group: string, path: string): Promise<void> {
  return invoke("dev_remove_group_member", { group, path });
}

export function deleteProjectGroup(path: string): Promise<void> {
  return invoke("dev_delete_project_group", { path });
}

export function deleteProject(path: string): Promise<void> {
  return invoke("dev_delete_project", { path });
}

export type WorktreeSize = { path: string; bytes: number };

export type ProjectRemoval = {
  project: number;
  worktrees: number;
  app: number;
  worktree_count: number;
  app_managed: boolean;
  /** One size per linked checkout. Missing on a result saved before sizes were split. */
  worktree_sizes?: WorktreeSize[];
};

/** Bytes the project folder, its worktrees, and their app data would free. */
export function projectRemoval(path: string): Promise<ProjectRemoval> {
  return invoke("dev_project_removal", { path });
}

/** Delete every linked worktree. The main checkout stays. Returns the folders that were removed. */
export function deleteProjectWorktrees(path: string): Promise<string[]> {
  return invoke("dev_delete_project_worktrees", { path });
}

export function cloneRepo(url: string, name?: string): Promise<string> {
  return invoke("dev_clone_repo", { url, name: name ?? null });
}
