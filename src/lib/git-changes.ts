export type GitDecorChange = {
  path: string;
  original?: string | null;
  status: string;
  staged: boolean;
  unstaged?: boolean;
  additions?: number;
  deletions?: number;
};

export function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function gitChangeMap(changes: GitDecorChange[]): Map<string, GitDecorChange> {
  const map = new Map<string, GitDecorChange>();
  for (const change of changes) {
    map.set(normalizeGitPath(change.path), change);
  }
  return map;
}

export function gitChangeForPath(
  map: Map<string, GitDecorChange>,
  path: string,
): GitDecorChange | undefined {
  return map.get(normalizeGitPath(path));
}

export function gitFolderHasChanges(map: Map<string, GitDecorChange>, dirPath: string): boolean {
  return gitDirtyDirs(map).has(normalizeGitPath(dirPath));
}

/** Every folder that contains a change, including the workspace root. Built once per status. */
export function gitDirtyDirs(map: Map<string, GitDecorChange>): Set<string> {
  const dirs = new Set<string>();
  if (map.size === 0) return dirs;
  dirs.add("");
  for (const path of map.keys()) {
    const normalized = normalizeGitPath(path);
    let slash = normalized.lastIndexOf("/");
    while (slash > 0) {
      const dir = normalized.slice(0, slash);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      slash = dir.lastIndexOf("/");
    }
  }
  return dirs;
}

export function gitLineStats(change: GitDecorChange | undefined): { additions: number; deletions: number } {
  return {
    additions: Math.max(0, change?.additions ?? 0),
    deletions: Math.max(0, change?.deletions ?? 0),
  };
}

export function gitChangeTotals(
  changes: GitDecorChange[],
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    const stats = gitLineStats(change);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return { additions, deletions };
}

export function formatDiffCount(n: number): string {
  return n.toLocaleString("en-US");
}

export type GitChangeTreeFile<T extends GitDecorChange = GitDecorChange> = {
  kind: "file";
  name: string;
  change: T;
};

export type GitChangeTreeDir<T extends GitDecorChange = GitDecorChange> = {
  kind: "dir";
  name: string;
  path: string;
  children: GitChangeTreeNode<T>[];
};

export type GitChangeTreeNode<T extends GitDecorChange = GitDecorChange> =
  | GitChangeTreeFile<T>
  | GitChangeTreeDir<T>;

export function gitChangesTree<T extends GitDecorChange>(changes: T[]): GitChangeTreeNode<T>[] {
  type MutableDir = {
    kind: "dir";
    name: string;
    path: string;
    children: GitChangeTreeNode<T>[];
    dirs: Map<string, MutableDir>;
  };

  const root: MutableDir = { kind: "dir", name: "", path: "", children: [], dirs: new Map() };

  for (const change of changes) {
    const path = normalizeGitPath(change.path);
    if (!path) continue;
    const parts = path.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = {
          kind: "dir",
          name: part,
          path: dir.path ? `${dir.path}/${part}` : part,
          children: [],
          dirs: new Map(),
        };
        dir.dirs.set(part, next);
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", name: fileName, change });
  }

  const sortNodes = (nodes: GitChangeTreeNode<T>[]): GitChangeTreeNode<T>[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) {
      if (node.kind === "dir") sortNodes(node.children);
    }
    return nodes;
  };

  return sortNodes(root.children);
}
