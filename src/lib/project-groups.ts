import { useSyncExternalStore } from "react";
import { isSameProject, type ProjectGroupRow } from "./all-projects.ts";

let rows: ProjectGroupRow[] = [];
const listeners = new Set<() => void>();

export function publishProjectGroups(next: ProjectGroupRow[]) {
  rows = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProjectGroups(): ProjectGroupRow[] {
  return useSyncExternalStore(subscribe, () => rows, () => rows);
}

export function useGroupMembers(workspace: string): ProjectGroupRow["members"] | null {
  const groups = useProjectGroups();
  if (!workspace) return null;
  return groups.find((group) => isSameProject(group.path, workspace))?.members ?? null;
}
