import { folderName, mergeProjectRows, projectKey, type ProjectRow } from "./dev.ts";
import type { JourneySummary } from "./dev-journey.ts";
import type { DevConversationSummary } from "./tauri.ts";

export type ProjectSidebarData = {
  conversations: DevConversationSummary[];
  journeys: JourneySummary[];
};

export type ProjectChatGroup = ProjectRow & ProjectSidebarData;

export function isSameProject(a: string, b: string): boolean {
  return Boolean(a) && Boolean(b) && projectKey(a) === projectKey(b);
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

export function renameConversationInGroups(
  groups: ProjectChatGroup[],
  id: string,
  patch: Partial<DevConversationSummary>,
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

/** Keep a project's in-memory chats on that project only after they have finished loading. */
export function applyLiveProjectChats(
  groups: ProjectChatGroup[],
  live: { workspace: string; conversations: DevConversationSummary[]; journeys: JourneySummary[] },
  loadedFor: string,
): ProjectChatGroup[] {
  if (!live.workspace || !isSameProject(loadedFor, live.workspace)) return groups;
  const patched = groups.map((group) =>
    isSameProject(group.path, live.workspace)
      ? { ...group, conversations: live.conversations, journeys: live.journeys }
      : group,
  );
  if (patched.some((group) => isSameProject(group.path, live.workspace))) return patched;
  return [
    {
      name: folderName(live.workspace),
      path: live.workspace,
      conversations: live.conversations,
      journeys: live.journeys,
    },
    ...patched,
  ];
}

/** Put this project's chats on its own group and drop those ids from every other group. */
export function placeProjectChats(
  groups: ProjectChatGroup[],
  path: string,
  conversations: DevConversationSummary[],
  journeys: JourneySummary[],
): ProjectChatGroup[] {
  const own = new Set(conversations.map((row) => row.id));
  const patched = groups.map((group) => {
    if (isSameProject(group.path, path)) {
      return { ...group, conversations, journeys };
    }
    if (!own.size || !group.conversations.some((row) => own.has(row.id))) return group;
    return { ...group, conversations: group.conversations.filter((row) => !own.has(row.id)) };
  });
  if (patched.some((group) => isSameProject(group.path, path))) return patched;
  return [
    { name: folderName(path), path, conversations, journeys },
    ...patched,
  ];
}

export function upsertProjectGroup(
  groups: ProjectChatGroup[],
  path: string,
  patch: Partial<ProjectChatGroup>,
): ProjectChatGroup[] {
  const key = projectKey(path);
  const idx = groups.findIndex((group) => projectKey(group.path) === key);
  if (idx < 0) {
    return [
      {
        name: patch.name || folderName(path),
        path,
        conversations: patch.conversations ?? [],
        journeys: patch.journeys ?? [],
      },
      ...groups,
    ];
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
