import { folderName, projectKey, type ProjectRow } from "./core.ts";
import type { GitWorktree } from "./tauri.ts";

/** Lists the sidebar loaded, keyed by the main checkout. A turn reads this without asking git again. */
const lists = new Map<string, GitWorktree[]>();
const listeners = new Set<() => void>();
let revision = 0;

/** Bumps when a list or a suggested branch name changes, so a composer can redraw. */
export function worktreeNameRevision(): number {
  return revision;
}

export function publishWorktreeLists(next: Record<string, GitWorktree[]>): void {
  lists.clear();
  for (const [key, rows] of Object.entries(next)) {
    if (rows.length) lists.set(projectKey(key), rows);
  }
  revision += 1;
  for (const listener of listeners) listener();
}

export function worktreeListsFor(workspace: string): GitWorktree[] {
  const key = projectKey(workspace);
  for (const rows of lists.values()) {
    if (rows.some((row) => projectKey(row.path) === key)) return rows;
  }
  return [];
}

export function subscribeWorktreeLists(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type WorktreeChild = {
  path: string;
  name: string;
  branch: string;
};

export type WorktreeGroup<T extends ProjectRow = ProjectRow> = T & {
  children: WorktreeChild[];
};

/** Replace one repo's list and leave every other published repo alone. */
export function publishWorktreeList(workspace: string, rows: GitWorktree[]): void {
  const key = rows.length ? worktreeRepoKey(workspace, rows) : projectKey(workspace);
  const next: Record<string, GitWorktree[]> = {};
  for (const [stored, list] of lists) {
    if (stored === key) continue;
    if (list.some((row) => projectKey(row.path) === projectKey(workspace))) continue;
    next[stored] = list;
  }
  if (rows.length) next[key] = rows;
  publishWorktreeLists(next);
}

export function worktreeRepoKey(path: string, worktrees: GitWorktree[] | null | undefined): string {
  const key = projectKey(path);
  if (!worktrees?.length) return key;
  const main = worktrees.find((row) => row.main) ?? worktrees[0];
  return main?.path ? projectKey(main.path) : key;
}

export type WorktreeChoice = {
  path: string;
  branch: string;
  name: string;
  current: boolean;
  main: boolean;
};

/** Label for the open checkout, plus every checkout of that repo. Empty when this folder is not one. */
export function worktreeChoices(workspace: string, worktrees: GitWorktree[] | null | undefined): {
  current: WorktreeChoice | null;
  rows: WorktreeChoice[];
} {
  if (!workspace || !worktrees?.length) return { current: null, rows: [] };
  const key = projectKey(workspace);
  if (!worktrees.some((row) => projectKey(row.path) === key)) return { current: null, rows: [] };
  const rows = worktrees
    .filter((row) => !row.bare)
    .map((row) => ({
      path: row.path,
      branch: row.detached ? "detached" : row.branch?.trim() || "detached",
      name: folderName(row.path),
      current: projectKey(row.path) === key,
      main: row.main,
    }));
  return { current: rows.find((row) => row.current) ?? null, rows };
}

const WORKTREE_NAME = /\{\{TwanAgent:([^}]*)\}\}/g;
/** Chats that already asked for a branch name, or already received one. */
const asked = new Set<string>();
const names = new Map<string, string>();

export function worktreeNameAsked(chatId: string): boolean {
  return Boolean(chatId) && asked.has(chatId);
}

export function markWorktreeNameAsked(chatId: string): void {
  if (chatId) asked.add(chatId);
}

export function worktreeNameForChat(chatId: string): string {
  return names.get(chatId) ?? "";
}

/** The name the model just returned, if this chat had not stored one yet. */
export function freshWorktreeName(chatId: string, name: string): string {
  const clean = worktreeNameFromSuggestion(name);
  if (!chatId || !clean || names.has(chatId)) return "";
  return clean;
}

/** Keep the last name a reply suggested for this chat. */
export function rememberWorktreeName(chatId: string, name: string): void {
  const clean = worktreeNameFromSuggestion(name);
  if (!chatId || !clean || names.get(chatId) === clean) return;
  names.set(chatId, clean);
  asked.add(chatId);
  revision += 1;
  for (const listener of listeners) listener();
}

/** Turn a model suggestion into a git branch. Empty when nothing usable is left. */
export function worktreeNameFromSuggestion(raw: string): string {
  let name = raw.trim().replace(/^['"`]+|['"`]+$/g, "");
  name = name.replace(/^refs\/heads\//i, "");
  name = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9./-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/\/+/g, "/")
    .replace(/^[-./]+|[-./]+$/g, "");
  if (!name || name === "." || name === ".." || name === "head") return "";
  if (/^[0-9a-f]{7,}$/.test(name)) return "";
  return name.slice(0, 60).replace(/[-./]+$/g, "");
}

/**
 * Pull `{{TwanAgent:name}}` out of a reply. The marker is not shown.
 * A missing marker leaves the text alone.
 */
/** Hide a marker that is still being typed. A finished marker is handled by takeWorktreeName. */
export function hideOpenWorktreeMarker(text: string): { text: string; pending: boolean } {
  const open = text.lastIndexOf("{{");
  if (open < 0) return { text, pending: false };
  const tail = text.slice(open);
  if (tail.includes("}}")) return { text, pending: false };
  if (!"{{TwanAgent:".startsWith(tail) && !tail.startsWith("{{TwanAgent:")) return { text, pending: false };
  return { text: text.slice(0, open).replace(/[ \t]+$/g, ""), pending: true };
}

export function takeWorktreeName(text: string): { text: string; name: string } {
  let name = "";
  const stripped = text.replace(WORKTREE_NAME, (_match, raw: string) => {
    if (!name) name = worktreeNameFromSuggestion(raw);
    return "";
  });
  if (stripped === text) return { text, name: "" };
  return { text: stripped.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), name };
}

/**
 * A checkout created before anyone named it.
 * The model replaces this once it returns `{{TwanAgent:name}}`.
 */
export function provisionalWorktreeName(seed = ""): string {
  const raw = seed.trim() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12);
  return `wip-${slug || "new"}`;
}

/** A branch from the first thing the user asked, used when the model has not named one yet. */
export function worktreeNameFromPrompt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const words = flat.split(" ").slice(0, 6).join(" ");
  return worktreeNameFromSuggestion(words);
}

/**
 * Hidden instruction on the first user message.
 * The last line is the only thing the app reads, so the model has to copy it.
 */
export function worktreeNamePrompt(asked: boolean): string {
  if (asked) return "";
  return [
    "Name a git branch for this request. Use lowercase words joined by hyphens, no spaces.",
    "End your reply with this line and nothing after it. Copy it exactly, with the name filled in:",
    "{{TwanAgent:branch-name}}",
  ].join("\n");
}

export function worktreeForPath(path: string, worktrees: GitWorktree[] | null | undefined): GitWorktree | null {
  const key = projectKey(path);
  return worktrees?.find((row) => projectKey(row.path) === key) ?? null;
}

function childOf(row: GitWorktree): WorktreeChild {
  return {
    path: row.path,
    name: folderName(row.path),
    branch: row.detached ? "detached" : row.branch?.trim() || "detached",
  };
}

/**
 * Nest linked worktrees under the main checkout. A checkout that is also a top-level
 * project is rendered only as a child. Projects with no worktree list stay as they are.
 */
export function groupProjectsByWorktree<T extends ProjectRow>(
  rows: T[],
  worktreesByPath: Record<string, GitWorktree[] | null | undefined>,
): WorktreeGroup<T>[] {
  const byPath = new Map(rows.map((row) => [projectKey(row.path), row]));
  const childrenOf = new Map<string, WorktreeChild[]>();

  for (const row of rows) {
    const list = worktreesByPath[projectKey(row.path)];
    if (!list?.length) continue;
    const main = list.find((item) => item.main) ?? list[0];
    if (!main) continue;
    const mainKey = projectKey(main.path);
    const linked = list.filter((item) => !item.main && !item.bare);
    if (!linked.length && projectKey(row.path) === mainKey) continue;
    const bucket = childrenOf.get(mainKey) ?? [];
    for (const item of linked) {
      const key = projectKey(item.path);
      if (bucket.some((child) => projectKey(child.path) === key)) continue;
      bucket.push(childOf(item));
    }
    childrenOf.set(mainKey, bucket);
  }

  // A linked checkout leaves the top level only when its main project is also listed.
  const claimed = new Set<string>();
  for (const [mainKey, children] of childrenOf) {
    if (!byPath.has(mainKey)) continue;
    for (const child of children) claimed.add(projectKey(child.path));
  }

  const seen = new Set<string>();
  const out: WorktreeGroup<T>[] = [];
  for (const row of rows) {
    const key = projectKey(row.path);
    if (claimed.has(key) || seen.has(key)) continue;
    seen.add(key);
    const list = worktreesByPath[key];
    const main = list?.find((item) => item.main);
    const mainKey = main ? projectKey(main.path) : key;
    const parent = mainKey !== key ? byPath.get(mainKey) : undefined;
    if (parent && !seen.has(projectKey(parent.path))) {
      seen.add(projectKey(parent.path));
      out.push({ ...parent, children: childrenOf.get(mainKey) ?? [] });
      continue;
    }
    const own = childrenOf.get(key) ?? [];
    const fromMain = mainKey !== key && !parent ? (childrenOf.get(mainKey) ?? []) : [];
    out.push({ ...row, children: own.length ? own : fromMain });
  }
  return out;
}
