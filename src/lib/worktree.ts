import { folderName, projectKey, type ProjectRow } from "./core.ts";
import type { ConversationSummary, GitPullRequest, GitWorktree } from "./tauri.ts";

/** Lists the sidebar loaded, keyed by the main checkout. A turn reads this without asking git again. */
const lists = new Map<string, GitWorktree[]>();
/** Conversations of a linked checkout, keyed by that folder. The tab strip reads titles from here. */
const chats = new Map<string, ConversationSummary[]>();
/** Last title painted for a chat. Switching checkouts must not replace it with "Chat". */
const tabTitles = new Map<string, string>();
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

/** Every linked checkout the sidebar has loaded, whatever repo it belongs to. */
export function linkedWorktrees(): GitWorktree[] {
  const out: GitWorktree[] = [];
  const seen = new Set<string>();
  for (const rows of lists.values()) {
    for (const row of rows) {
      if (row.main || row.bare) continue;
      const key = projectKey(row.path);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

export function worktreeListsFor(workspace: string): GitWorktree[] {
  const key = projectKey(workspace);
  for (const rows of lists.values()) {
    if (rows.some((row) => projectKey(row.path) === key)) return rows;
  }
  return [];
}

export function publishWorktreeChats(next: Record<string, ConversationSummary[]>): void {
  chats.clear();
  for (const [key, rows] of Object.entries(next)) {
    chats.set(projectKey(key), rows);
  }
  revision += 1;
  for (const listener of listeners) listener();
}

/** True once this folder's conversations have been published. An empty publish still counts. */
export function worktreeChatsKnown(path: string): boolean {
  return chats.has(projectKey(path));
}

/**
 * Chats the open strip may drop. A checkout whose list has not arrived keeps every
 * tab already on the strip. Once it arrives, only the chats it still lists stay.
 */
export function keptTabChatIds(
  openPath: string,
  openChats: readonly { id: string }[],
  currentIds: readonly string[],
): Set<string> {
  const kept = new Set(openChats.map((row) => row.id));
  const rows = worktreeListsFor(openPath);
  if (!rows.length) return kept;
  let waiting = false;
  for (const row of rows) {
    const folder = projectKey(row.path);
    if (folder === projectKey(openPath)) continue;
    if (!worktreeChatsKnown(row.path)) {
      waiting = true;
      continue;
    }
    for (const chat of chats.get(folder) ?? []) kept.add(chat.id);
  }
  // One checkout is still loading. Hold the tabs already open until its list arrives.
  if (waiting) for (const id of currentIds) kept.add(id);
  return kept;
}

export function rememberTabTitle(id: string, title: string): void {
  const clean = title.trim();
  if (!id || !clean || clean === "Chat" || tabTitles.get(id) === clean) return;
  tabTitles.set(id, clean);
}

export function tabTitleFor(id: string): string {
  return tabTitles.get(id) ?? "";
}

/** Every conversation that belongs on this repo's tab strip, including linked checkouts. */
export function projectTabChats(workspace: string): ConversationSummary[] {
  const rows = worktreeListsFor(workspace);
  const keys = new Set((rows.length ? rows : [{ path: workspace }]).map((row) => projectKey(row.path)));
  const seen = new Set<string>();
  const out: ConversationSummary[] = [];
  for (const key of keys) {
    for (const chat of chats.get(key) ?? []) {
      if (seen.has(chat.id)) continue;
      seen.add(chat.id);
      out.push(chat);
    }
  }
  return out;
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

/** The folder the open tabs belong to. A linked checkout shares the main checkout's strip. */
export function tabProjectKey(path: string): string {
  return worktreeRepoKey(path, worktreeListsFor(path));
}

/**
 * One strip for the whole repo. Tabs saved under a linked checkout, or under the
 * folder before git answered, move onto the main checkout. The first copy wins.
 */
export function sharedRepoTabs<T>(tabs: Record<string, T>, lists: Record<string, GitWorktree[]>): Record<string, T> {
  const out: Record<string, T> = { ...tabs };
  for (const rows of Object.values(lists)) {
    if (!rows.length) continue;
    const repo = worktreeRepoKey(rows[0]?.path ?? "", rows);
    if (!repo) continue;
    for (const row of rows) {
      const key = projectKey(row.path);
      if (key === repo || !(key in out)) continue;
      if (!(repo in out)) out[repo] = out[key]!;
      delete out[key];
    }
  }
  return out;
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

export type PullRequestChoice = {
  number: number;
  title: string;
  branch: string;
  url: string;
  /** Set when that pull request is already checked out in a worktree. */
  path: string;
  /** False for a request GitHub has closed or merged. */
  open: boolean;
  /** True when the open folder is this pull request's checkout. */
  current: boolean;
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

/**
 * Pull requests for the menu. Open ones come first. A closed request stays in the list
 * so the menu can hide it until it is asked for.
 * A request whose branch is checked out keeps that path, so picking it just opens the folder.
 */
export function pullRequestChoices(
  requests: GitPullRequest[] | null | undefined,
  worktrees: GitWorktree[] | null | undefined,
  workspace = "",
): PullRequestChoice[] {
  const rows = (requests ?? []).filter((row) => row.number > 0);
  if (!rows.length) return [];
  const checked = new Map<string, string>();
  for (const tree of worktrees ?? []) {
    const branch = tree.branch?.trim();
    if (branch && !tree.bare) checked.set(branch, tree.path);
  }
  const seen = new Set<number>();
  const out: PullRequestChoice[] = [];
  for (const row of rows) {
    if (seen.has(row.number)) continue;
    seen.add(row.number);
    const branch = row.branch.trim() || `pr/${row.number}`;
    const path = checked.get(branch) ?? "";
    out.push({
      number: row.number,
      title: row.title.trim(),
      branch,
      url: row.url,
      path,
      open: row.open !== false,
      current: Boolean(path && workspace && projectKey(path) === projectKey(workspace)),
    });
  }
  return out.sort((a, b) => Number(b.open) - Number(a.open) || b.number - a.number);
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
 * Hidden instruction on the first user message of an unnamed checkout.
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

/** Placeholder branch from provisionalWorktreeName, before anyone has named the checkout. */
export function isProvisionalWorktreeBranch(branch: string | null | undefined): boolean {
  return /^wip-[a-z0-9]+$/.test((branch ?? "").trim());
}

/**
 * True only for a linked checkout that was created with no branch name.
 * The main checkout, a named worktree, and a detached head do not need one.
 */
export function worktreeAwaitingName(workspace: string): boolean {
  const row = worktreeForPath(workspace, worktreeListsFor(workspace));
  if (!row || row.main || row.bare || row.detached) return false;
  return isProvisionalWorktreeBranch(row.branch);
}

/**
 * Ask the model to name the branch on the first message of an unnamed new worktree.
 * A chat on the main checkout, or on a worktree that already has a name, is left as written.
 */
export function promptWithWorktreeName(
  text: string,
  history: readonly { role: string }[],
  chatId: string,
  workspace: string,
): string {
  if (!worktreeAwaitingName(workspace)) return text;
  const asked = worktreeNameAsked(chatId) || history.some((message) => message.role === "user");
  const line = worktreeNamePrompt(asked);
  if (!line) return text;
  markWorktreeNameAsked(chatId);
  return `${text}\n\n${line}`;
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
