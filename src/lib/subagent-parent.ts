/** Child conversation id -> the chat that spawned it. Survives a reload so the breadcrumb can. */

const STORAGE_KEY = "twanagent.subagent-parents";

type Links = Record<string, string>;

let links: Links = readStoredLinks();
const listeners = new Set<() => void>();

function readStoredLinks(): Links {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Links = {};
    for (const [child, parent] of Object.entries(parsed)) {
      if (typeof parent === "string" && child.trim() && parent.trim()) out[child] = parent;
    }
    return out;
  } catch {
    return {};
  }
}

function publish() {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
    } catch {
      // The in-memory link still works for this window.
    }
  }
  for (const listener of listeners) listener();
}

export function subagentParentId(childId: string): string {
  return links[childId] ?? "";
}

/** The current child -> parent map. Same object until a link changes. */
export function subagentParentLinks(): Readonly<Record<string, string>> {
  return links;
}

export function subagentsForParent<T extends { id: string }>(parentId: string, rows: readonly T[]): T[] {
  const ids = new Set(subagentChildIds(parentId));
  if (!ids.size) return [];
  return rows.filter((row) => ids.has(row.id));
}

export function subagentChildIds(parentId: string): string[] {
  if (!parentId) return [];
  const ids: string[] = [];
  for (const [child, parent] of Object.entries(links)) {
    if (parent === parentId) ids.push(child);
  }
  return ids;
}

export function rememberSubagentParent(childId: string, parentId: string): void {
  const child = childId.trim();
  const parent = parentId.trim();
  if (!child || !parent || child === parent || links[child] === parent) return;
  links = { ...links, [child]: parent };
  publish();
}

export function subscribeSubagentParents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
