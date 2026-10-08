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
  if (nodes.get(dest)?.kind !== "dir") return false;
  const tops = topLevelPaths(paths);
  return tops.every((path) => {
    if (isInsidePath(dest, path)) return false;
    return fileParent(path) !== dest;
  });
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
