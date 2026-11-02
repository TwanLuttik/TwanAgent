import { invoke } from "@tauri-apps/api/core";

export type Entry = {
  name: string;
  path: string;
  kind: "file" | "dir" | string;
  size: number | null;
  /** Milliseconds. Present for files. A replaced icon changes this, so the sidebar reloads it. */
  modified?: number | null;
};

export function listDir(workspace: string, path = ""): Promise<Entry[]> {
  return invoke("dev_list_dir", { workspace, path });
}

export type TreeSnapshot = { signature: string; dirs: string[]; files?: string[] };

/** File and folder paths, hashed. Unchanged when only file contents change. Works for remote projects. */
export function treeSignature(workspace: string): Promise<TreeSnapshot> {
  return invoke("dev_tree_signature", { workspace });
}

export function readFile(
  workspace: string,
  path: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  return invoke("dev_read_file", { workspace, path, offset, limit });
}

/** A local PDF as base64. The webview cannot fetch the asset URL itself. */
export function readPdf(workspace: string, path: string): Promise<string> {
  return invoke("dev_read_pdf", { workspace, path });
}

/** Content search. Works for a local folder and a cloud project. */
export function grep(workspace: string, pattern: string, path = "", glob = ""): Promise<string> {
  return invoke("dev_grep", { workspace, pattern, path, glob });
}

/** Path search. Works for a local folder and a cloud project. */
export function glob(workspace: string, pattern: string, path = ""): Promise<string> {
  return invoke("dev_glob", { workspace, pattern, path });
}

export function readUserMcp(path: string): Promise<string> {
  return invoke("dev_read_user_mcp", { path });
}

export function writeUserMcp(path: string, contents: string): Promise<void> {
  return invoke("dev_write_user_mcp", { path, contents });
}

export function openUserMcp(path: string): Promise<void> {
  return invoke("dev_open_user_mcp", { path });
}

export function mcpAuthNames(): Promise<string[]> {
  return invoke("dev_mcp_auth_names");
}

export function mcpClearAuth(name: string): Promise<void> {
  return invoke("dev_mcp_clear_auth", { name });
}

export function mcpSignIn(name: string): Promise<void> {
  return invoke("dev_mcp_sign_in", { name });
}

export type SkillFile = {
  path: string;
  read_path: string;
  home: boolean;
  origin: string;
};

export function listSkillFiles(workspace?: string | null): Promise<SkillFile[]> {
  return invoke("dev_list_skill_files", { workspace: workspace || null });
}

export function readUserSkill(path: string): Promise<string> {
  return invoke("dev_read_user_skill", { path });
}

export function loadSkill(workspace: string, name: string): Promise<string> {
  return invoke("dev_load_skill", { workspace, name });
}

export function writeUserSkill(path: string, contents: string): Promise<void> {
  return invoke("dev_write_user_skill", { path, contents });
}

export function resolveFile(workspace: string, path: string): Promise<string> {
  return invoke("dev_resolve_file", { workspace, path });
}

export function existingFiles(workspace: string, paths: string[]): Promise<string[]> {
  return invoke("dev_existing_files", { workspace, paths });
}

export type FilePreview = {
  path: string;
  name: string;
  size: number;
  binary: boolean;
  lines?: number | null;
  preview?: string | null;
  modified?: number | null;
};

export function filePreview(workspace: string, path: string): Promise<FilePreview> {
  return invoke("dev_file_preview", { workspace, path });
}

export function renamePath(workspace: string, path: string, name: string): Promise<string> {
  return invoke("dev_rename_path", { workspace, path, name });
}

export function movePaths(workspace: string, paths: string[], dest: string): Promise<string[]> {
  return invoke("dev_move_paths", { workspace, paths, dest });
}

export function deletePaths(workspace: string, paths: string[]): Promise<void> {
  return invoke("dev_delete_paths", { workspace, paths });
}

export function createDir(workspace: string, parent: string, name: string): Promise<string> {
  return invoke("dev_create_dir", { workspace, parent, name });
}

export function writeFile(workspace: string, path: string, contents: string): Promise<void> {
  return invoke("dev_write_file", { workspace, path, contents });
}

export function editFile(
  workspace: string,
  path: string,
  oldString: string,
  newString: string,
): Promise<void> {
  return invoke("dev_edit_file", {
    workspace,
    path,
    oldString,
    newString,
    old_string: oldString,
    new_string: newString,
  });
}
