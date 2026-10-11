const signatures = new Map<string, string>();
const dirLists = new Map<string, string[]>();
const fileLists = new Map<string, MentionFile[]>();
const listeners = new Set<() => void>();

/** Content edits. Separate from the tree signature, which misses writes to existing files. */
let refreshRevision = 0;
const refreshListeners = new Set<() => void>();

export type MentionFile = { path: string; name: string };

export function subscribeFileStructure(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bumps when a file was written, renamed, or removed. Does not change the tree signature. */
export function fileRefreshRevision(): number {
  return refreshRevision;
}

export function subscribeFileRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
}

export function bumpFileRefresh(): void {
  refreshRevision += 1;
  refreshListeners.forEach((listener) => listener());
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
  const hadFiles = fileLists.has(workspace);
  if (files.length || !hadFiles) fileLists.set(workspace, files);
  const prev = signatures.get(workspace);
  if (prev === signature && (hadFiles || files.length === 0)) return false;
  signatures.set(workspace, signature);
  // The first snapshot still has to reach listeners. Mention search reads the file list,
  // and skipping this notice leaves that list empty until the tree changes again.
  listeners.forEach((listener) => listener());
  return prev !== undefined;
}

export function resetFileStructureForTests(): void {
  signatures.clear();
  dirLists.clear();
  fileLists.clear();
  listeners.clear();
  refreshRevision = 0;
  refreshListeners.clear();
}
