const EMPTY: Set<string> = new Set();

const snapshots = new Map<string, Set<string>>();
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
  return snapshots.get(snapshotId(workspace, key)) ?? EMPTY;
}

/** Keep the previous set when membership did not change, so chat markdown does not reparse. */
export function publishFileExists(
  workspace: string,
  key: string,
  paths: string[],
  found: Set<string>,
): void {
  const next = new Set(paths.filter((path) => found.has(path)));
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
  listeners.clear();
  refreshers.clear();
}
