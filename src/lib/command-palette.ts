import { isEmptyChatDraft } from "./all-projects.ts";
import { folderName, projectKey } from "./project-rows.ts";

/** Finished chats shown before the user starts searching. */
export const PALETTE_FINISHED_LIMIT = 5;
const CHAT_LIMIT = 20;
const PROJECT_LIMIT = 8;
const FILE_LIMIT = 40;

export type PaletteMode = "browse" | "files";

export type PaletteConversation = {
  id: string;
  title?: string;
  updated_at?: string;
  preview?: string;
  archived?: boolean;
  kind?: string;
  model?: string | null;
};

export type PaletteGroup = {
  name: string;
  path: string;
  remote?: boolean;
  conversations: PaletteConversation[];
};

export type PaletteFile = { path: string; name: string };

export type PaletteChatItem = {
  kind: "chat";
  id: string;
  title: string;
  path: string;
  project: string;
  updatedAt: string;
  running: boolean;
  preview: string;
  /** Model id for the provider mark. Empty when the chat has not stored one. */
  model: string;
  /** Conversation kind. Terminal chats use the terminal glyph instead of a project mark. */
  chatKind: string;
  /** The chat's project is remote, so its logo stays the folder glyph. */
  remote: boolean;
};

export type PaletteProjectItem = {
  kind: "project";
  name: string;
  path: string;
  remote: boolean;
};

export type PaletteFileItem = {
  kind: "file";
  path: string;
  name: string;
};

export type PaletteItem = PaletteChatItem | PaletteProjectItem | PaletteFileItem;

export type PaletteSection = {
  id: string;
  label: string;
  items: PaletteItem[];
};

type ChatRow = {
  id: string;
  title: string;
  path: string;
  project: string;
  updatedAt: string;
  preview: string;
  archived: boolean;
  emptyDraft: boolean;
  remote: boolean;
  model: string;
  chatKind: string;
};

/**
 * Home list, project/conversation search, or file search.
 * A later group replaces an earlier chat with the same id, so the open project's
 * live rows win. A project name keeps the first row, which is the sidebar name.
 */
export function buildPalette(input: {
  mode: PaletteMode;
  query: string;
  groups: PaletteGroup[];
  files: PaletteFile[];
  runningIds: Readonly<Record<string, unknown>>;
}): { sections: PaletteSection[]; items: PaletteItem[] } {
  const query = input.query.trim().toLowerCase();
  const sections =
    input.mode === "files"
      ? query
        ? fileSections(input.files, query)
        : []
      : query
        ? searchSections(input.groups, query, input.runningIds)
        : homeSections(collectChats(input.groups), input.runningIds);
  return { sections, items: sections.flatMap((section) => section.items) };
}

/**
 * Project whose files Tab should search.
 * An empty query stays on the open project, because the home list highlights a
 * chat by default and that highlight is not a choice. A typed query uses the
 * highlighted project or conversation.
 */
export function fileSearchProject(
  selected: PaletteItem | undefined,
  workspace: string,
  query: string,
): { path: string; name: string } | null {
  if (query.trim()) {
    if (selected?.kind === "project") return { path: selected.path, name: selected.name };
    if (selected?.kind === "chat") return { path: selected.path, name: selected.project };
  }
  const path = workspace.trim();
  if (!path) return null;
  return { path, name: folderName(path) };
}

/** Move the highlighted row, wrapping at the ends. An empty list stays at 0. */
export function movePaletteIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const current = Math.min(Math.max(index, 0), count - 1);
  const step = delta >= 0 ? delta % count : -((-delta) % count);
  return (current + step + count) % count;
}

function homeSections(chats: ChatRow[], runningIds: Readonly<Record<string, unknown>>): PaletteSection[] {
  const running = chats.filter((row) => !row.archived && row.id in runningIds).sort(byRecent);
  const finished = chats
    .filter((row) => !row.archived && !row.emptyDraft && !(row.id in runningIds))
    .sort(byRecent)
    .slice(0, PALETTE_FINISHED_LIMIT);
  const sections: PaletteSection[] = [];
  if (running.length) sections.push({ id: "running", label: "Running", items: running.map((row) => toChat(row, true)) });
  if (finished.length) {
    sections.push({ id: "finished", label: "Finished", items: finished.map((row) => toChat(row, false)) });
  }
  return sections;
}

function searchSections(
  groups: PaletteGroup[],
  query: string,
  runningIds: Readonly<Record<string, unknown>>,
): PaletteSection[] {
  const chats = collectChats(groups)
    .filter((row) => !row.archived)
    .map((row) => ({ row, score: chatScore(row, query, row.id in runningIds) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || byRecent(a.row, b.row))
    .slice(0, CHAT_LIMIT)
    .map((item) => toChat(item.row, item.row.id in runningIds));
  const projects = collectProjects(groups)
    .map((project) => ({ project, score: projectScore(project, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
    .slice(0, PROJECT_LIMIT)
    .map(
      (item): PaletteProjectItem => ({
        kind: "project",
        name: item.project.name,
        path: item.project.path,
        remote: item.project.remote,
      }),
    );
  const sections: PaletteSection[] = [];
  if (chats.length) sections.push({ id: "conversations", label: "Conversations", items: chats });
  if (projects.length) sections.push({ id: "projects", label: "Projects", items: projects });
  return sections;
}

function fileSections(files: PaletteFile[], query: string): PaletteSection[] {
  const items = files
    .map((file) => ({ file, score: fileScore(file, query) }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.file.path.length - b.file.path.length ||
        a.file.path.localeCompare(b.file.path),
    )
    .slice(0, FILE_LIMIT)
    .map((item): PaletteFileItem => ({ kind: "file", path: item.file.path, name: item.file.name }));
  return items.length ? [{ id: "files", label: "Files", items }] : [];
}

function collectChats(groups: PaletteGroup[]): ChatRow[] {
  const byId = new Map<string, ChatRow>();
  const order: string[] = [];
  for (const group of groups) {
    if (!group.path) continue;
    const project = group.name.trim() || folderName(group.path);
    for (const row of group.conversations) {
      if (!row.id) continue;
      if (!byId.has(row.id)) order.push(row.id);
      const title = (row.title || "New chat").trim() || "New chat";
      byId.set(row.id, {
        id: row.id,
        title,
        path: group.path,
        project,
        updatedAt: row.updated_at ?? "",
        preview: row.preview ?? "",
        archived: row.archived === true,
        emptyDraft: isEmptyChatDraft(row),
        remote: group.remote === true,
        model: row.model?.trim() ?? "",
        chatKind: (row.kind ?? "chat").trim() || "chat",
      });
    }
  }
  return order.map((id) => byId.get(id)!);
}

function collectProjects(groups: PaletteGroup[]): { name: string; path: string; remote: boolean }[] {
  const seen = new Set<string>();
  const out: { name: string; path: string; remote: boolean }[] = [];
  for (const group of groups) {
    if (!group.path) continue;
    const key = projectKey(group.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: group.name.trim() || folderName(group.path),
      path: group.path,
      remote: group.remote === true,
    });
  }
  return out;
}

function toChat(row: ChatRow, running: boolean): PaletteChatItem {
  return {
    kind: "chat",
    id: row.id,
    title: row.title,
    path: row.path,
    project: row.project,
    updatedAt: row.updatedAt,
    running,
    preview: row.preview,
    model: row.model,
    chatKind: row.chatKind,
    remote: row.remote,
  };
}

function byRecent(a: ChatRow, b: ChatRow): number {
  const delta = timeValue(b.updatedAt) - timeValue(a.updatedAt);
  if (delta) return delta;
  const title = a.title.localeCompare(b.title);
  if (title) return title;
  return a.id.localeCompare(b.id);
}

function timeValue(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

function chatScore(row: ChatRow, query: string, running: boolean): number {
  const title = row.title.toLowerCase();
  let score = 0;
  if (title === query) score = 100;
  else if (title.startsWith(query)) score = 80;
  else if (title.includes(query)) score = 60;
  else if (row.project.toLowerCase().includes(query)) score = 40;
  else if (row.preview.toLowerCase().includes(query)) score = 30;
  else if (row.path.toLowerCase().includes(query)) score = 20;
  else return 0;
  return running ? score + 5 : score;
}

function projectScore(project: { name: string; path: string; remote: boolean }, query: string): number {
  const name = project.name.toLowerCase();
  const path = project.path.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 50;
  if (path.includes(query)) return 30;
  return 0;
}

function fileScore(file: PaletteFile, query: string): number {
  const name = file.name.toLowerCase();
  const path = file.path.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 50;
  if (path.includes(query)) return 30;
  return 0;
}
