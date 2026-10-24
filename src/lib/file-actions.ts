export type FileNode = { path: string; kind: "file" | "dir" | string };

export function fileParent(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const slash = clean.lastIndexOf("/");
  return slash < 0 ? "" : clean.slice(0, slash);
}

export function fileName(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  const slash = clean.lastIndexOf("/");
  return slash < 0 ? clean : clean.slice(slash + 1);
}

export function joinFilePath(dir: string, name: string): string {
  const parent = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return parent ? `${parent}/${name}` : name;
}

export function isInsidePath(path: string, dir: string): boolean {
  const child = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parent = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!parent) return true;
  return child === parent || child.startsWith(`${parent}/`);
}

/** Drop selections that already live inside another selected folder. */
export function topLevelPaths(paths: string[]): string[] {
  const unique = [...new Set(paths.map((path) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")))].filter(
    Boolean,
  );
  return unique.filter(
    (path) => !unique.some((other) => other !== path && isInsidePath(path, other)),
  );
}

export function selectionKinds(paths: string[], nodes: Map<string, FileNode>): { files: boolean; dirs: boolean } {
  let files = false;
  let dirs = false;
  for (const path of paths) {
    const kind = nodes.get(path)?.kind;
    if (kind === "dir") dirs = true;
    else if (kind) files = true;
  }
  return { files, dirs };
}

export function canRenameSelection(paths: string[], nodes: Map<string, FileNode>): boolean {
  if (paths.length !== 1) return false;
  const kinds = selectionKinds(paths, nodes);
  return kinds.files !== kinds.dirs;
}

export function canMoveSelection(paths: string[], nodes: Map<string, FileNode>): boolean {
  if (paths.length === 0) return false;
  const kinds = selectionKinds(paths, nodes);
  return kinds.files !== kinds.dirs;
}

export function canDropOnDir(paths: string[], dest: string, nodes: Map<string, FileNode>): boolean {
  if (!canMoveSelection(paths, nodes)) return false;
  const target = dest.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  // The workspace root is a valid folder, but it is not an entry in the tree.
  if (target && nodes.get(target)?.kind !== "dir") return false;
  const tops = topLevelPaths(paths);
  return tops.every((path) => {
    if (isInsidePath(target, path)) return false;
    return fileParent(path) !== target;
  });
}

const FILE_ROW_DRAG = "file-row:";
const FILE_DIR_DROP = "file-dir:";

/** Stable id for a draggable file or folder row. Paths can contain `:`. */
export function fileRowDragId(path: string): string {
  return `${FILE_ROW_DRAG}${path}`;
}

/** Droppable id for a folder. An empty path is the project root. */
export function fileDirDropId(path: string): string {
  return `${FILE_DIR_DROP}${path}`;
}

export function fileRowPathFromDragId(id: string): string | null {
  return id.startsWith(FILE_ROW_DRAG) ? id.slice(FILE_ROW_DRAG.length) : null;
}

export function fileDirPathFromDropId(id: string): string | null {
  return id.startsWith(FILE_DIR_DROP) ? id.slice(FILE_DIR_DROP.length) : null;
}

/**
 * The folder a pointer is aiming at. A folder row means that folder.
 * A file row means its parent. Empty space in the list means the project root.
 * Null means the pointer is not over the file list.
 */
export function fileDropDest(hitPath: string | null, kind: string | null, insideList: boolean): string | null {
  if (!insideList) return null;
  if (!hitPath) return "";
  return kind === "dir" ? hitPath : fileParent(hitPath);
}

/** The folder to highlight, or null when this drop would not move anything. */
export function fileDropTarget(
  paths: string[],
  dest: string | null,
  nodes: Map<string, FileNode>,
): string | null {
  if (dest == null) return null;
  if (paths.some((item) => item === dest || isInsidePath(dest, item))) return null;
  if (!canDropOnDir(paths, dest, nodes)) return null;
  return dest;
}

/** A new file needs an extension or a dotfile name, such as `notes.md` or `.env`. */
export function validNewFileName(name: string): boolean {
  const trimmed = name.trim();
  if (!validEntryName(trimmed)) return false;
  const dot = trimmed.lastIndexOf(".");
  return dot >= 0 && dot < trimmed.length - 1;
}

export function nextFolderName(siblings: string[]): string {
  const names = new Set(siblings.map((name) => name.toLowerCase()));
  if (!names.has("untitled folder")) return "untitled folder";
  let n = 2;
  while (names.has(`untitled folder ${n}`)) n += 1;
  return `untitled folder ${n}`;
}

export function validEntryName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  return !/[/\\\0]/.test(trimmed);
}
