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

/** A new file needs a name and an extension, such as `notes.md`. */
export function validNewFileName(name: string): boolean {
  const trimmed = name.trim();
  if (!validEntryName(trimmed)) return false;
  const dot = trimmed.lastIndexOf(".");
  return dot > 0 && dot < trimmed.length - 1;
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
