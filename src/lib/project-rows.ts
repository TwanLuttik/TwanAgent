export function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "Folder";
}

export type ProjectServer = {
  machineName: string;
  host: string;
  user: string;
  port: number;
  remotePath: string;
  online: boolean;
  /** Provider ids whose keys were copied to this server. */
  providers?: string[];
};

export type ProjectRow = { name: string; path: string; remote?: boolean; server?: ProjectServer };

export function projectKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function mergeProjectRows(fromDisk: ProjectRow[], recents: string[]): ProjectRow[] {
  const out: ProjectRow[] = [];
  const seen = new Set<string>();
  for (const path of recents) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const key = projectKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: folderName(trimmed), path: trimmed.replace(/[/\\]+$/, "") || trimmed });
  }
  for (const row of fromDisk) {
    const key = projectKey(row.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function filterProjectRows(rows: ProjectRow[], query: string): ProjectRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (row) => row.name.toLowerCase().includes(q) || row.path.toLowerCase().includes(q),
  );
}

export type FolderActionId = "open" | "create" | "clone";

export type FolderAction = {
  id: FolderActionId;
  label: string;
  hint: string;
  icon: string;
};

export const FOLDER_ACTIONS: FolderAction[] = [
  { id: "open", label: "Open folder", hint: "Type a folder location", icon: "folder.fill" },
  {
    id: "create",
    label: "New project",
    hint: "Create a folder on this Mac",
    icon: "plus",
  },
  { id: "clone", label: "Clone from Git", hint: "Clone a repository", icon: "square.and.arrow.down" },
];

export function looksLikePath(query: string): boolean {
  const s = query.trim();
  if (!s) return false;
  return s.startsWith("/") || s.startsWith("~") || s.startsWith(".") || /^[A-Za-z]:[\\/]/.test(s);
}

export function looksLikeGitUrl(query: string): boolean {
  const s = query.trim();
  if (!s) return false;
  if (/[\0\s]/.test(s)) return false;
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i.test(s);
}

export function sanitizeProjectName(raw: string): string | null {
  const s = raw.trim();
  if (!s || s === "." || s === "..") return null;
  if (/[/\\]/.test(s)) return null;
  const cleaned = s
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 80);
}

export function isExistingProjectName(query: string, rows: { name: string }[]): boolean {
  const name = sanitizeProjectName(query);
  if (!name) return false;
  const key = name.toLowerCase();
  return rows.some((row) => {
    const existing = sanitizeProjectName(row.name) ?? row.name.trim();
    return existing.toLowerCase() === key;
  });
}

export function repoNameFromUrl(url: string): string | null {
  const s = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  const part = s.split(/[:/]/).filter(Boolean).pop();
  return part ? sanitizeProjectName(part) : null;
}

export function preferredFolderAction(query: string): FolderActionId {
  if (looksLikeGitUrl(query)) return "clone";
  if (looksLikePath(query)) return "open";
  if (sanitizeProjectName(query)) return "create";
  return "open";
}

export type FolderFocus =
  | { kind: "action"; id: FolderActionId }
  | { kind: "project"; index: number }
  | { kind: "folder"; index: number };

export type FolderEnterTarget =
  | { kind: "clone" }
  | { kind: "create" }
  | { kind: "open" }
  | { kind: "project"; index: number }
  | { kind: "folder"; index: number };

/**
 * Highlight from the field, before the mouse or arrows intervene.
 * A git URL always points at Clone, even when project rows still match.
 */
export function folderFocusFromQuery(query: string, matchedProjects: number, onServer: boolean): FolderFocus {
  if (looksLikeGitUrl(query)) return { kind: "action", id: "clone" };
  if (looksLikePath(query)) return { kind: "action", id: onServer ? "create" : "open" };
  if (matchedProjects > 0 && !onServer) return { kind: "project", index: 0 };
  if (sanitizeProjectName(query)) return { kind: "action", id: "create" };
  return { kind: "action", id: onServer ? "create" : "open" };
}

/**
 * Enter follows the query when it is a git URL, so hovering New project
 * cannot create a folder from a clone.
 */
export function folderEnterTarget(query: string, focus: FolderFocus): FolderEnterTarget {
  if (looksLikeGitUrl(query)) return { kind: "clone" };
  if (focus.kind === "project" || focus.kind === "folder") return focus;
  if (focus.id === "clone") return { kind: "clone" };
  if (focus.id === "create") return { kind: "create" };
  return { kind: "open" };
}

/** A click on New project with a git URL in the field is a clone, not a create. */
export function folderClickAction(id: FolderActionId, query: string): FolderActionId {
  if (id === "create" && looksLikeGitUrl(query)) return "clone";
  return id;
}

export function folderActionEnabled(id: FolderActionId, query: string): boolean {
  if (id === "open") return true;
  if (id === "create") return sanitizeProjectName(query) !== null;
  return looksLikeGitUrl(query);
}

export function folderActionHint(id: FolderActionId, query: string, place = "this Mac"): string {
  if (id === "open") {
    const path = query.trim();
    return path && looksLikePath(path) ? path : "Type a folder location";
  }
  if (id === "create") {
    if (looksLikeGitUrl(query)) return "That is a git URL — use Clone from Git";
    const name = sanitizeProjectName(query);
    return name ? `Create ${name} on ${place}` : `Create a folder on ${place}`;
  }
  const url = query.trim();
  if (!looksLikeGitUrl(url)) return "Paste a git URL to clone";
  const name = repoNameFromUrl(url);
  return name ? `Clone ${name} onto ${place}` : `Paste a git URL to clone onto ${place}`;
}

export function pathWithSlash(path: string): string {
  if (!path) return path;
  return /[/\\]$/.test(path) ? path : `${path}/`;
}
