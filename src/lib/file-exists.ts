const EMPTY: Set<string> = new Set();

const snapshots = new Map<string, Set<string>>();
const pathHits = new Map<string, boolean>();
const listeners = new Set<() => void>();
const refreshers = new Set<() => void>();

function snapshotId(workspace: string, key: string): string {
  return `${workspace}\0${key}`;
}

function sameMembers(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

export function subscribeFileExists(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function fileExistsSnapshot(workspace: string | null, key: string): Set<string> {
  if (!workspace) return EMPTY;
  const id = snapshotId(workspace, key);
  const cached = snapshots.get(id);
  if (cached) return cached;
  const paths = key ? key.split("\0").filter(Boolean) : [];
  // Unknown paths stay on the shared empty set. A fresh Set here makes
  // useSyncExternalStore re-render until React error 185 blanks the window.
  if (!paths.length || paths.some((path) => !pathHits.has(pathKey(workspace, path)))) return EMPTY;
  const found = new Set(paths.filter((path) => pathHits.get(pathKey(workspace, path))));
  const stable = found.size ? found : EMPTY;
  snapshots.set(id, stable);
  return stable;
}

function pathKey(workspace: string, path: string): string {
  return `${workspace}\0${path}`;
}

/** Paths in this bubble that have never been statted for the workspace. */
export function uncachedFileExists(workspace: string, paths: string[]): string[] {
  return paths.filter((path) => !pathHits.has(pathKey(workspace, path)));
}

/** Keep the previous set when membership did not change, so chat markdown does not reparse. */
export function publishFileExists(
  workspace: string,
  key: string,
  paths: string[],
  found: Set<string>,
): void {
  for (const path of paths) pathHits.set(pathKey(workspace, path), found.has(path));
  const next = new Set(
    paths.filter((path) => found.has(path) || pathHits.get(pathKey(workspace, path)) === true),
  );
  const id = snapshotId(workspace, key);
  const prev = snapshots.get(id) ?? EMPTY;
  if (sameMembers(prev, next)) return;
  snapshots.set(id, next.size === 0 ? EMPTY : next);
  listeners.forEach((listener) => listener());
}

export function watchFileRefresh(run: () => void): () => void {
  refreshers.add(run);
  return () => refreshers.delete(run);
}

export function refreshFileExists(): void {
  refreshers.forEach((run) => run());
}

export function resetFileExistsForTests(): void {
  snapshots.clear();
  pathHits.clear();
  listeners.clear();
  refreshers.clear();
}
