import { folderName, mergeProjectRows, projectKey, type ProjectRow } from "./core.ts";
import { formatRelativeAge } from "./relative-time.ts";
import type { JourneySummary } from "./journey.ts";
import type { ConversationSummary } from "./tauri.ts";

export type ProjectSidebarData = {
  conversations: ConversationSummary[];
  journeys: JourneySummary[];
};

export type ProjectChatGroup = ProjectRow & ProjectSidebarData;

export function isArchivedConversation(row: { archived?: boolean }): boolean {
  return row.archived === true;
}

/** Chats shown in the normal sidebar, or only the archived ones when the archive is open. */
export function visibleConversations<T extends { archived?: boolean; journey_id?: string | null }>(
  conversations: T[],
  showArchived: boolean,
): T[] {
  return conversations.filter((row) => isArchivedConversation(row) === showArchived);
}

/**
 * The chat to open for a project. The saved id wins, including an empty "New chat"
 * the user just opened. A titled chat is only preferred when nothing was saved,
 * so a local empty draft does not cover a cloud conversation on startup.
 */
export function preferredOpenConversation<T extends { id: string; title?: string; kind?: string; archived?: boolean }>(
  rows: T[],
  savedId = "",
): T | undefined {
  const visible = rows.filter((row) => row.archived !== true);
  const saved = visible.find((row) => row.id === savedId);
  if (saved) return saved;
  return visible.find((row) => !isEmptyChatDraft(row)) ?? visible[0];
}

/** Journeys that still have a visible child. Empty journeys stay in the normal list. */
export function visibleJourneys<T extends { id: string }>(
  journeys: T[],
  conversations: { journey_id?: string | null; archived?: boolean }[],
  showArchived: boolean,
): T[] {
  if (!showArchived) return journeys;
  const ids = new Set(
    visibleConversations(conversations, true)
      .map((row) => row.journey_id)
      .filter((id): id is string => Boolean(id)),
  );
  return journeys.filter((journey) => ids.has(journey.id));
}

export function projectHasArchived(conversations: { archived?: boolean }[]): boolean {
  return conversations.some(isArchivedConversation);
}

export function isSameProject(a: string, b: string): boolean {
  return Boolean(a) && Boolean(b) && projectKey(a) === projectKey(b);
}

/** One sidebar chat. The project is part of the key because ids can repeat across folders. */
export type ChatSelection = { path: string; id: string };

export function chatSelectionKey(path: string, id: string): string {
  return `${projectKey(path)}\t${id}`;
}

export function sameChatSelection(a: ChatSelection, b: ChatSelection): boolean {
  return a.id === b.id && isSameProject(a.path, b.path);
}

/**
 * Click selection for the sidebar. A plain click keeps one chat. Cmd/Ctrl toggles
 * it into the set. Shift extends from the anchor through the visible order.
 */
export function nextChatSelection(
  current: ChatSelection[],
  anchor: ChatSelection | null,
  clicked: ChatSelection,
  order: ChatSelection[],
  mods: { toggle: boolean; range: boolean },
): { selected: ChatSelection[]; anchor: ChatSelection } {
  if (mods.range && anchor) {
    const from = order.findIndex((row) => sameChatSelection(row, anchor));
    const to = order.findIndex((row) => sameChatSelection(row, clicked));
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      const range = order.slice(start, end + 1);
      if (mods.toggle) {
        const seen = new Set(current.map((row) => chatSelectionKey(row.path, row.id)));
        const extra = range.filter((row) => !seen.has(chatSelectionKey(row.path, row.id)));
        return { selected: [...current, ...extra], anchor };
      }
      return { selected: range, anchor };
    }
  }
  if (mods.toggle) {
    const hit = current.some((row) => sameChatSelection(row, clicked));
    return {
      selected: hit ? current.filter((row) => !sameChatSelection(row, clicked)) : [...current, clicked],
      anchor: clicked,
    };
  }
  return { selected: [clicked], anchor: clicked };
}

/** Chats a bulk action should touch. The right-clicked row joins the set when it was not already in it. */
export function archiveTargets(selected: ChatSelection[], clicked: ChatSelection): ChatSelection[] {
  if (selected.some((row) => sameChatSelection(row, clicked))) return selected;
  return [clicked];
}

export function buildProjectGroups(
  fromDisk: ProjectRow[],
  recents: string[],
  loaded: Record<string, ProjectSidebarData>,
): ProjectChatGroup[] {
  return mergeProjectRows(fromDisk, recents).map((row) => {
    const data = loaded[projectKey(row.path)];
    return {
      ...row,
      conversations: data?.conversations ?? [],
      journeys: data?.journeys ?? [],
    };
  });
}

/** Fields the sidebar paints. `updated_at` is left out so a save can refresh the age without rebuilding the row. */
export function sameSidebarConversation(a: ConversationSummary, b: ConversationSummary): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.kind === b.kind &&
    (a.journey_id ?? null) === (b.journey_id ?? null) &&
    (a.sort_order ?? 0) === (b.sort_order ?? 0) &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.effort ?? null) === (b.effort ?? null) &&
    (a.context_window ?? null) === (b.context_window ?? null) &&
    (a.permission ?? null) === (b.permission ?? null) &&
    (a.archived ?? false) === (b.archived ?? false)
  );
}

/**
 * Keep the previous row when the sidebar would paint the same card.
 * A timestamp that changes `now` to `1m` is a new row. One that stays inside the same minute is not.
 */
export function patchSidebarConversation(
  prev: ConversationSummary | undefined,
  next: ConversationSummary,
  nowMs = Date.now(),
): ConversationSummary {
  if (!prev) return next;
  if (!sameSidebarConversation(prev, next)) return { ...prev, ...next, id: next.id };
  if (prev.updated_at === next.updated_at) return prev;
  if (formatRelativeAge(prev.updated_at, nowMs) !== formatRelativeAge(next.updated_at, nowMs)) {
    return { ...prev, ...next, id: next.id };
  }
  return prev;
}

/** Replace a list only when a row the sidebar paints actually changed. */
export function patchSidebarConversations(
  prev: ConversationSummary[],
  next: ConversationSummary[],
  nowMs = Date.now(),
): ConversationSummary[] {
  const patchAt = (before: ConversationSummary | undefined, row: ConversationSummary) =>
    patchSidebarConversation(before, row, nowMs);
  if (prev.length !== next.length) {
    return next.map((row, i) => patchAt(prev[i]?.id === row.id ? prev[i] : prev.find((item) => item.id === row.id), row));
  }
  let changed = false;
  const rows = next.map((row, i) => {
    const before = prev[i];
    const patched = patchAt(before?.id === row.id ? before : undefined, row);
    if (patched !== before) changed = true;
    return patched;
  });
  return changed ? rows : prev;
}

export function renameConversationInGroups(
  groups: ProjectChatGroup[],
  id: string,
  patch: Partial<ConversationSummary>,
): { groups: ProjectChatGroup[]; found: boolean } {
  let found = false;
  const next = groups.map((group) => {
    if (!group.conversations.some((row) => row.id === id)) return group;
    found = true;
    return {
      ...group,
      conversations: group.conversations.map((row) => (row.id === id ? { ...row, ...patch, id } : row)),
    };
  });
  return { groups: found ? next : groups, found };
}

/**
 * The first launch frame. A project in the snapshot already has its chats, so the
 * sidebar can paint them with the header instead of inserting them a moment later.
 * A project the snapshot does not know keeps an empty list and is filled afterwards.
 */
export function groupsFromSidebarSnapshot(
  rows: ProjectRow[],
  snapshot: { path: string; conversations: ConversationSummary[]; journeys: JourneySummary[] }[],
): ProjectChatGroup[] {
  const byPath = new Map(snapshot.map((group) => [projectKey(group.path), group]));
  return rows.map((row) => {
    const cached = byPath.get(projectKey(row.path));
    return {
      ...row,
      conversations: cached?.conversations ?? [],
      journeys: cached?.journeys ?? [],
    };
  });
}

/**
 * A startup pass loads projects one at a time. `incoming` is only the prefix
 * that has finished. Projects not in that prefix keep the chats they already had,
 * so a later pass does not flash "No chats yet" over them.
 *
 * A project created or opened after that pass started is not in `incoming`.
 * It stays in the list. Dropping it would hide the folder the user just added.
 */
export function mergeLoadedProjectGroups(
  previous: ProjectChatGroup[],
  incoming: ProjectChatGroup[],
): ProjectChatGroup[] {
  const seen = new Set(incoming.map((group) => projectKey(group.path)));
  const kept = previous.filter((group) => !seen.has(projectKey(group.path)));
  const filled = incoming.map((group) => {
    if (group.conversations.length > 0 || group.journeys.length > 0) {
      return keepServerMark(group, previous);
    }
    const before = previous.find((row) => isSameProject(row.path, group.path));
    if (!before) return keepServerMark(group, previous);
    // The local mount of a cloud project is empty. That read is not the server
    // list, so a pass that came back empty keeps the copy already on screen.
    if (group.remote || before.remote) {
      if (before.conversations.length > 0 || before.journeys.length > 0) {
        return keepServerMark(
          { ...group, conversations: before.conversations, journeys: before.journeys },
          previous,
        );
      }
      return keepServerMark(group, previous);
    }
    return keepServerMark(group, previous);
  });
  return [...filled, ...kept];
}

/**
 * An empty "New chat" on a cloud project was saved in the local mount, not on the server.
 * A chat that already has a title, or is a terminal, stays.
 */
export function isLocalCloudDraft(row: { title?: string; kind?: string }): boolean {
  return isEmptyChatDraft(row);
}

export function isEmptyChatDraft(row: { title?: string; kind?: string }): boolean {
  return (row.title || "New chat").trim() === "New chat" && (row.kind ?? "chat") !== "terminal";
}

export type SidebarActivityStatus = "running" | "finished";

/** One chat in the overview above the project list. */
export type SidebarActivityItem = {
  id: string;
  title: string;
  path: string;
  project: string;
  status: SidebarActivityStatus;
  updatedAt: string;
};

const ACTIVITY_LIMIT = 8;

/**
 * Chats worth a glance above the projects.
 * A turn that is still running comes first. A reply the user has not opened yet follows it.
 * Archived chats stay in the archive. The same id is listed once, under the project that owns it.
 */
export function sidebarActivity(
  groups: { name: string; path: string; conversations: ConversationSummary[] }[],
  runningIds: Readonly<Record<string, unknown>>,
  unseenIds: ReadonlySet<string>,
  extra: { path: string; conversations: ConversationSummary[] }[] = [],
): SidebarActivityItem[] {
  const seen = new Set<string>();
  const items: SidebarActivityItem[] = [];
  const sources = [
    ...groups.map((group) => ({ name: group.name, path: group.path, conversations: group.conversations })),
    ...extra.map((row) => ({ name: folderName(row.path), path: row.path, conversations: row.conversations })),
  ];
  for (const source of sources) {
    for (const row of source.conversations) {
      if (seen.has(row.id) || isArchivedConversation(row)) continue;
      const status: SidebarActivityStatus | null =
        row.id in runningIds ? "running" : unseenIds.has(row.id) ? "finished" : null;
      if (!status) continue;
      seen.add(row.id);
      items.push({
        id: row.id,
        title: (row.title || "New chat").trim() || "New chat",
        path: source.path,
        project: source.name || folderName(source.path),
        status,
        updatedAt: row.updated_at,
      });
    }
  }
  items.sort((a, b) => {
    if (a.status !== b.status) return a.status === "running" ? -1 : 1;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  return items.slice(0, ACTIVITY_LIMIT);
}

/** Match a chat or its project against the sidebar search. An empty query matches everything. */
export function matchesSidebarQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}

function cloudChatsWithoutLocalDrafts(rows: ConversationSummary[]): ConversationSummary[] {
  return rows.filter((row) => !isLocalCloudDraft(row));
}

/** A list pass does not know whether the server is up. Keep the mark the open project already has. */
function keepServerMark(group: ProjectChatGroup, previous: ProjectChatGroup[]): ProjectChatGroup {
  if (group.server) return group;
  const before = previous.find((row) => isSameProject(row.path, group.path));
  if (!before?.server || Boolean(before.remote) !== Boolean(group.remote)) return group;
  return { ...group, server: before.server };
}

/**
 * A linked worktree is a child of its repo, not its own project.
 * The open workspace still points at that folder, so a live chat update must not
 * add it to the top of the sidebar while its conversation opens.
 */
export function isLinkedWorktreePath(path: string, worktrees: { path: string; main?: boolean; bare?: boolean }[]): boolean {
  const key = projectKey(path);
  return worktrees.some((row) => !row.main && !row.bare && projectKey(row.path) === key);
}

/** Keep a project's in-memory chats on that project only after they have finished loading. */
export function applyLiveProjectChats(
  groups: ProjectChatGroup[],
  live: { workspace: string; conversations: ConversationSummary[]; journeys: JourneySummary[] },
  loadedFor: string,
): ProjectChatGroup[] {
  if (!live.workspace || !isSameProject(loadedFor, live.workspace)) return groups;
  if (!groups.some((group) => isSameProject(group.path, live.workspace))) return groups;
  const patched = groups.map((group) => {
    if (!isSameProject(group.path, live.workspace)) return group;
    // The open project's live list can still be the local mount. Do not put an
    // empty "New chat" back onto a cloud project that already has its real chats.
    const conversations =
      group.remote && live.conversations.some(isLocalCloudDraft)
        ? cloudChatsWithoutLocalDrafts(live.conversations)
        : live.conversations;
    return { ...group, conversations, journeys: live.journeys };
  });
  return patched;
}

/** True when two sidebar rows would paint the same card, including the relative-age timestamp. */
export function sameSidebarConversationList(a: ConversationSummary[], b: ConversationSummary[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left !== right && (!sameSidebarConversation(left, right) || left.updated_at !== right.updated_at)) return false;
  }
  return true;
}

export function sameJourneyList(a: JourneySummary[], b: JourneySummary[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || left === right) continue;
    if (
      left.id !== right.id ||
      left.title !== right.title ||
      left.collapsed !== right.collapsed ||
      (left.color ?? "") !== (right.color ?? "") ||
      left.sort_order !== right.sort_order
    ) {
      return false;
    }
  }
  return true;
}

/** Put this project's chats on its own group and drop those ids from every other group. */
export function placeProjectChats(
  groups: ProjectChatGroup[],
  path: string,
  conversations: ConversationSummary[],
  journeys: JourneySummary[],
  /** The project these chats were loaded for. Empty means they match `path`. */
  loadedFor = "",
): ProjectChatGroup[] {
  if (loadedFor && !isSameProject(loadedFor, path)) return groups;
  if (!groups.some((group) => isSameProject(group.path, path))) return groups;
  const target = groups.find((group) => isSameProject(group.path, path));
  const shown =
    target?.remote && conversations.some(isLocalCloudDraft)
      ? cloudChatsWithoutLocalDrafts(conversations)
      : conversations;
  const own = new Set(shown.map((row) => row.id));
  const patched = groups.map((group) => {
    if (isSameProject(group.path, path)) {
      return { ...group, conversations: shown, journeys };
    }
    if (!own.size || !group.conversations.some((row) => own.has(row.id))) return group;
    return { ...group, conversations: group.conversations.filter((row) => !own.has(row.id)) };
  });
  return patched;
}

export type ProjectServerMark = NonNullable<ProjectChatGroup["server"]>;

/**
 * The cloud icon belongs to the project the lookup ran for.
 * A local project opened while that lookup is still in flight must not inherit it,
 * and a project that is no longer on a server must lose the mark.
 */
export function stampProjectServer(
  groups: ProjectChatGroup[],
  path: string,
  remote: ProjectServerMark | null,
  loadedFor: string,
): ProjectChatGroup[] {
  if (!path || !isSameProject(loadedFor, path)) return groups;
  let changed = false;
  const next = groups.map((group) => {
    if (!isSameProject(group.path, path)) return group;
    const server = remote ?? undefined;
    const isRemote = Boolean(remote);
    // `remote: undefined` still paints no icon, but it is not a finished answer.
    // A local lookup stores `false` so a later pass cannot put the cloud icon back.
    if (group.remote === isRemote && sameProjectServer(group.server, server)) return group;
    changed = true;
    return { ...group, remote: isRemote, server };
  });
  return changed ? next : groups;
}

function sameProviders(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function sameProjectServer(
  a: ProjectServerMark | undefined,
  b: ProjectServerMark | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.machineName === b.machineName &&
    a.host === b.host &&
    a.user === b.user &&
    a.port === b.port &&
    a.remotePath === b.remotePath &&
    a.online === b.online &&
    sameProviders(a.providers, b.providers)
  );
}

/** Two projects can reuse a chat id. The sidebar chip is keyed by both. */
export function sidebarTodoKey(path: string, id: string): string {
  return `${projectKey(path)}\t${id}`;
}

export function upsertProjectGroup(
  groups: ProjectChatGroup[],
  path: string,
  patch: Partial<ProjectChatGroup>,
): ProjectChatGroup[] {
  const key = projectKey(path);
  const idx = groups.findIndex((group) => projectKey(group.path) === key);
  if (idx < 0) {
    const fresh: ProjectChatGroup = {
      name: patch.name || folderName(path),
      path,
      remote: patch.remote,
      server: patch.server,
      conversations: patch.conversations ?? [],
      journeys: patch.journeys ?? [],
    };
    // A project opened for the first time leads the list, matching the stored sort.
    return [fresh, ...groups];
  }
  const next = groups.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}

export function isProjectCollapsed(keys: string[], path: string): boolean {
  const key = projectKey(path);
  return keys.some((item) => projectKey(item) === key);
}

export function toggleCollapsedProject(keys: string[], path: string): string[] {
  const key = projectKey(path);
  const normalized = keys.map(projectKey);
  if (normalized.includes(key)) return normalized.filter((item) => item !== key);
  return [...normalized, key];
}

export function expandCollapsedProject(keys: string[], path: string): string[] {
  const key = projectKey(path);
  return keys.map(projectKey).filter((item) => item !== key);
}

/** Move one project in front of another. Same path, or a path that is not in the list, leaves the array alone. */
export function moveProjectGroup(groups: ProjectChatGroup[], fromPath: string, toPath: string): ProjectChatGroup[] {
  if (isSameProject(fromPath, toPath)) return groups;
  const from = groups.findIndex((group) => isSameProject(group.path, fromPath));
  const to = groups.findIndex((group) => isSameProject(group.path, toPath));
  if (from < 0 || to < 0) return groups;
  const next = groups.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function removeProjectGroup(groups: ProjectChatGroup[], path: string): ProjectChatGroup[] {
  const key = projectKey(path);
  return groups.filter((group) => projectKey(group.path) !== key);
}

export function isAppProject(path: string, projectsRoot: string): boolean {
  if (!path || !projectsRoot) return false;
  const folder = projectKey(path);
  const root = projectKey(projectsRoot);
  if (folder === root || !folder.startsWith(`${root}/`)) return false;
  const rest = folder.slice(root.length + 1);
  return Boolean(rest) && !rest.includes("/");
}

/** Saved projects, including folders outside the default projects directory. Duplicate paths collapse. */
export function sidebarProjects(fromDisk: ProjectRow[], _projectsRoot = ""): ProjectRow[] {
  const seen = new Set<string>();
  const out: ProjectRow[] = [];
  for (const row of fromDisk) {
    if (!row.path.trim()) continue;
    const key = projectKey(row.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
