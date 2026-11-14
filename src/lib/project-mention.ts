import { useSyncExternalStore } from "react";
import { isSameProject, type ProjectGroupRow } from "./all-projects.ts";
import { folderName } from "./project-rows.ts";
import type { MentionQuery } from "./mention.ts";

/**
 * A project the composer can insert with `#name`.
 * The draft keeps `#token`. The stored prompt swaps that for `project name (path)`,
 * which is what the model reads. The transcript folds it back.
 */
export type MentionProject = {
  /** Text after `#`. Unique, and it never contains a space. */
  token: string;
  /** Folder name, or the group alias when this row is a member of the open group. */
  name: string;
  path: string;
  /** Alias the group chat tools take. Empty outside the open group. */
  alias: string;
};

const PROJECT_MENTION = /(?:^|[\s([{])#([^\s#]*)$/;
const MENTION_LEAD = String.raw`(?:^|[\s([{])`;
const MENTION_TAIL = String.raw`(?=$|[\s)\]}.,;:!?])`;

let published: MentionProject[] = [];
const listeners = new Set<() => void>();

export function publishMentionProjects(next: MentionProject[]) {
  if (sameProjects(published, next)) return;
  published = next;
  for (const listener of listeners) listener();
}

function sameProjects(left: MentionProject[], right: MentionProject[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a.path !== b.path || a.token !== b.token || a.alias !== b.alias || a.name !== b.name) return false;
  }
  return true;
}

export function mentionProjectsNow(): MentionProject[] {
  return published;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMentionProjects(): MentionProject[] {
  return useSyncExternalStore(subscribe, mentionProjectsNow, mentionProjectsNow);
}

export function projectMentionAtCursor(text: string, cursor: number): MentionQuery | null {
  const head = text.slice(0, Math.max(0, cursor));
  const match = PROJECT_MENTION.exec(head);
  if (!match || match.index == null) return null;
  const at = head.lastIndexOf("#");
  if (at < 0) return null;
  return { start: at, end: cursor, query: match[1] ?? "" };
}

export function filterMentionProjects(projects: MentionProject[], query: string, limit = 8): MentionProject[] {
  const q = query.trim().toLowerCase();
  const ranked: { project: MentionProject; score: number }[] = [];
  for (const project of projects) {
    const score = projectScore(project, q);
    if (score <= 0) continue;
    const row = { project, score };
    const at = ranked.findIndex(
      (item) =>
        row.score > item.score ||
        (row.score === item.score &&
          (row.project.path.length < item.project.path.length ||
            (row.project.path.length === item.project.path.length &&
              row.project.token.localeCompare(item.project.token) < 0))),
    );
    if (at === -1) {
      if (ranked.length < limit) ranked.push(row);
      continue;
    }
    ranked.splice(at, 0, row);
    if (ranked.length > limit) ranked.pop();
  }
  return ranked.map((row) => row.project);
}

function projectScore(project: MentionProject, query: string): number {
  if (!query) return 1;
  const token = project.token.toLowerCase();
  const name = project.name.toLowerCase();
  const path = project.path.toLowerCase();
  if (token === query || name === query) return 100;
  if (token.startsWith(query) || name.startsWith(query)) return 80;
  if (path.endsWith(`/${query}`)) return 70;
  if (token.includes(query) || name.includes(query)) return 50;
  if (path.includes(query)) return 30;
  return 0;
}

export type ProjectMentionSpan = { start: number; end: number; project: MentionProject };

export function draftProjectMentionSpans(text: string, projects: MentionProject[]): ProjectMentionSpan[] {
  if (!text.includes("#") || projects.length === 0) return [];
  const byToken = tokenMap(projects);
  const spans: ProjectMentionSpan[] = [];
  const re = /(^|[\s([{])#([^\s#]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const lead = match[1] ?? "";
    const token = match[2] ?? "";
    const project = byToken.get(token.toLowerCase());
    if (!project) continue;
    const start = match.index + lead.length;
    spans.push({ start, end: start + token.length + 1, project });
  }
  return spans;
}

/** What the model reads. The alias is the name group tools already take. */
export function projectMentionModelText(project: MentionProject): string {
  const label = (project.alias || project.name || project.token).trim();
  return `project ${label} (${project.path})`;
}

export function expandProjectMentions(text: string, projects: MentionProject[]): string {
  if (!projects.length || !text.includes("#")) return text;
  const byToken = tokenMap(projects);
  return text.replace(/(^|[\s([{])#([^\s#]+)/g, (full, lead: string, token: string) => {
    const project = byToken.get(token.toLowerCase());
    if (!project) return full;
    return `${lead}${projectMentionModelText(project)}`;
  });
}

/** Fold a sent project mention back to `#token`. Only the expanded form is folded. */
export function displayProjectMentions(text: string, projects: MentionProject[]): string {
  if (!text || !projects.length || !text.includes("project ")) return text;
  const rows = projects
    .map((project) => ({ project, model: projectMentionModelText(project) }))
    .filter((row) => row.model && text.includes(row.model))
    .sort((a, b) => b.model.length - a.model.length);
  let out = text;
  for (const row of rows) {
    out = out.replace(
      new RegExp(`(${MENTION_LEAD})(${escapeRegExp(row.model)})${MENTION_TAIL}`, "g"),
      `$1#${row.project.token}`,
    );
  }
  return out;
}

export function applyProjectMention(
  text: string,
  mention: MentionQuery,
  project: MentionProject,
): { text: string; cursor: number } {
  const next = `${text.slice(0, mention.start)}#${project.token} ${text.slice(mention.end)}`;
  const cursor = mention.start + project.token.length + 2;
  return { text: next, cursor };
}

export function mentionProjectsFor(
  workspace: string,
  projects: { name: string; path: string }[],
  groups: ProjectGroupRow[],
): MentionProject[] {
  const group = workspace ? groups.find((row) => isSameProject(row.path, workspace)) : undefined;
  const seen = new Set<string>();
  const rows: MentionProject[] = [];
  for (const project of projects) {
    const path = normalizePath(project.path);
    if (!path) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    if (workspace && isSameProject(path, workspace)) continue;
    seen.add(key);
    const alias = group?.members.find((member) => isSameProject(member.path, path))?.alias?.trim() ?? "";
    const name = (alias || project.name || folderName(path)).trim();
    if (!name && !alias) continue;
    rows.push({ token: "", name: name || alias, path, alias });
  }
  return assignTokens(rows);
}

function assignTokens(rows: MentionProject[]): MentionProject[] {
  const tokens = rows.map((row) => tokenAtDepth(row, 0));
  const depth = rows.map(() => 0);
  for (let pass = 0; pass < 12 && hasDup(tokens); pass += 1) {
    const groups = new Map<string, number[]>();
    tokens.forEach((token, index) => {
      const key = token.toLowerCase();
      const list = groups.get(key) ?? [];
      list.push(index);
      groups.set(key, list);
    });
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      // A group alias stays `#api`. The other folder grows a parent until it is unique.
      const keep = indexes.slice().sort((a, b) => preferStableToken(rows[a], rows[b]))[0];
      for (const index of indexes) {
        if (index === keep) continue;
        depth[index] += 1;
        tokens[index] = tokenAtDepth(rows[index], depth[index]);
      }
    }
  }
  if (hasDup(tokens)) {
    for (let i = 0; i < rows.length; i += 1) tokens[i] = mentionToken(rows[i].path) || rows[i].path;
  }
  return rows.map((row, index) => ({ ...row, token: tokens[index] || mentionToken(row.name) || "project" }));
}

function preferStableToken(a: MentionProject, b: MentionProject): number {
  const aAlias = a.alias ? 1 : 0;
  const bAlias = b.alias ? 1 : 0;
  if (aAlias !== bAlias) return bAlias - aAlias;
  return a.path.length - b.path.length;
}

function tokenAtDepth(row: MentionProject, depth: number): string {
  const parts = row.path.split("/").filter(Boolean);
  const base = mentionToken(row.alias || row.name) || parts[parts.length - 1] || "project";
  if (depth <= 0) return base;
  const parents = parts.slice(Math.max(0, parts.length - 1 - depth), Math.max(0, parts.length - 1));
  return [...parents, base].filter(Boolean).join("/");
}

function mentionToken(value: string): string {
  return value.trim().replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
}

function hasDup(tokens: string[]): boolean {
  const seen = new Set<string>();
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (!key) return true;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function tokenMap(projects: MentionProject[]): Map<string, MentionProject> {
  const byToken = new Map<string, MentionProject>();
  for (const project of projects) {
    const key = project.token.toLowerCase();
    if (key && !byToken.has(key)) byToken.set(key, project);
  }
  return byToken;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
