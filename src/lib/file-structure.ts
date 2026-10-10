const signatures = new Map<string, string>();
const dirLists = new Map<string, string[]>();
const fileLists = new Map<string, MentionFile[]>();
const listeners = new Set<() => void>();

export type MentionFile = { path: string; name: string };

export function subscribeFileStructure(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function fileStructureSignature(workspace: string | null): string {
  if (!workspace) return "";
  return signatures.get(workspace) ?? "";
}

export function fileStructureDirs(workspace: string | null): string[] {
  if (!workspace) return [];
  return dirLists.get(workspace) ?? [];
}

/** Files from the last tree snapshot. Empty until a snapshot publishes them. */
export function fileStructureFiles(workspace: string | null): MentionFile[] {
  if (!workspace) return [];
  return fileLists.get(workspace) ?? [];
}

/**
 * Expanded folders, plus a direct child folder the snapshot found under one
 * the user already has open. A collapsed folder is not walked further.
 */
export function dirsToList(expanded: Record<string, boolean>, known: string[]): string[] {
  const open = new Set<string>([""]);
  for (const [path, on] of Object.entries(expanded)) {
    if (on === true) open.add(path);
  }
  const visible = new Set(open);
  for (const path of known) {
    if (!path || visible.has(path)) continue;
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    if (open.has(parent)) visible.add(path);
  }
  return [...visible];
}

/** Store a new tree hash. Returns true when create, rename, delete, or move changed the tree. */
export function publishFileStructure(
  workspace: string,
  signature: string,
  dirs: string[] = [],
  files: MentionFile[] = [],
): boolean {
  dirLists.set(workspace, dirs);
  if (files.length || !fileLists.has(workspace)) fileLists.set(workspace, files);
  const prev = signatures.get(workspace);
  if (prev === signature) return false;
  signatures.set(workspace, signature);
  if (prev !== undefined) listeners.forEach((listener) => listener());
  return prev !== undefined;
}

export function resetFileStructureForTests(): void {
  signatures.clear();
  dirLists.clear();
  fileLists.clear();
  listeners.clear();
}
