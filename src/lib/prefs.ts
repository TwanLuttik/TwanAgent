import { projectKey } from "./dev.ts";
import type { MarkdownOpenMode } from "./dev-editor";

export type { MarkdownOpenMode };

const SPACE_CORNER_KEY = "twanagent.spaceCorner";

export function loadSpaceCorner(): boolean {
  const raw = localStorage.getItem(SPACE_CORNER_KEY);
  return raw !== "off" && raw !== "0" && raw !== "false";
}

export function applySpaceCorner(on: boolean): void {
  document.documentElement.dataset.spaceCorner = on ? "on" : "off";
}

export function setSpaceCorner(on: boolean): void {
  localStorage.setItem(SPACE_CORNER_KEY, on ? "on" : "off");
  applySpaceCorner(on);
}

const DEV_WORKSPACE_KEY = "twanagent.workspace";
const DEV_CONVERSATION_KEY = "twanagent.conversation";
const DEV_DRAFTS_KEY = "twanagent.drafts";

export function loadDevWorkspace(): string {
  return localStorage.getItem(DEV_WORKSPACE_KEY) ?? "";
}

export function saveDevWorkspace(path: string): void {
  if (path) localStorage.setItem(DEV_WORKSPACE_KEY, path);
  else localStorage.removeItem(DEV_WORKSPACE_KEY);
}

const DEV_RECENTS_KEY = "twanagent.recentWorkspaces";
const DEV_RECENTS_MAX = 20;

export function loadDevRecentWorkspaces(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_RECENTS_KEY) ?? "");
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return [];
  }
}

export function pushDevRecentWorkspace(path: string): string[] {
  const next = [path, ...loadDevRecentWorkspaces().filter((p) => p !== path)].slice(0, DEV_RECENTS_MAX);
  localStorage.setItem(DEV_RECENTS_KEY, JSON.stringify(next));
  return next;
}

export function removeDevRecentWorkspace(path: string): string[] {
  const key = projectKey(path);
  const next = loadDevRecentWorkspaces().filter((item) => projectKey(item) !== key);
  localStorage.setItem(DEV_RECENTS_KEY, JSON.stringify(next));
  return next;
}

export type ProjectPathMove = { from: string; to: string };

export function rewriteStoredProjectPaths(moves: ProjectPathMove[]): void {
  const map = new Map<string, string>();
  for (const move of moves) {
    if (!move.from || !move.to) continue;
    if (projectKey(move.from) === projectKey(move.to)) continue;
    map.set(projectKey(move.from), move.to);
  }
  if (map.size === 0) return;
  const remap = (path: string) => map.get(projectKey(path)) ?? path;

  const current = loadDevWorkspace();
  if (current) {
    const next = remap(current);
    if (next !== current) saveDevWorkspace(next);
  }

  const seen = new Set<string>();
  const recents: string[] = [];
  for (const path of loadDevRecentWorkspaces()) {
    const next = remap(path);
    const key = projectKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    recents.push(next);
  }
  localStorage.setItem(DEV_RECENTS_KEY, JSON.stringify(recents.slice(0, DEV_RECENTS_MAX)));

  let saved: Record<string, string> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_CONVERSATION_KEY) ?? "");
    if (raw && typeof raw === "object") saved = raw as Record<string, string>;
  } catch {
    saved = {};
  }
  const nextSaved: Record<string, string> = {};
  for (const [path, id] of Object.entries(saved)) {
    if (typeof id !== "string" || !id) continue;
    const dest = remap(path);
    if (!nextSaved[dest]) nextSaved[dest] = id;
  }
  localStorage.setItem(DEV_CONVERSATION_KEY, JSON.stringify(nextSaved));

  const collapsed = new Set(
    loadCollapsedProjects().map((key) => {
      const dest = map.get(projectKey(key));
      return dest ? projectKey(dest) : key;
    }),
  );
  saveCollapsedProjects([...collapsed]);
}

export function loadComposerDrafts(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_DRAFTS_KEY) ?? "");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [id, text] of Object.entries(raw)) {
      if (typeof text === "string" && text) out[id] = text;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveComposerDraft(chatId: string, text: string): void {
  if (!chatId) return;
  const all = loadComposerDrafts();
  if (text) all[chatId] = text;
  else delete all[chatId];
  localStorage.setItem(DEV_DRAFTS_KEY, JSON.stringify(all));
}

export function loadDevConversation(workspace: string): string {
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_CONVERSATION_KEY) ?? "");
    if (raw && typeof raw === "object") {
      const id = (raw as Record<string, unknown>)[workspace];
      return typeof id === "string" ? id : "";
    }
  } catch {
    /* ignore */
  }
  return "";
}

const DEV_MODEL_KEY = "twanagent.model";
const DEV_EFFORT_KEY = "twanagent.effort";
const DEV_CONTEXT_WINDOW_KEY = "twanagent.contextWindow";
const DEV_PERMISSION_KEY = "twanagent.permission";

export function loadDevModel(): string {
  return localStorage.getItem(DEV_MODEL_KEY) ?? "";
}

export function saveDevModel(id: string): void {
  localStorage.setItem(DEV_MODEL_KEY, id);
}

export function loadDevEffort(): string {
  return localStorage.getItem(DEV_EFFORT_KEY) ?? "";
}

export function loadDevContextWindow(): number {
  const raw = Number(localStorage.getItem(DEV_CONTEXT_WINDOW_KEY) ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function saveDevContextWindow(tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  localStorage.setItem(DEV_CONTEXT_WINDOW_KEY, String(Math.floor(tokens)));
}

export function saveDevEffort(id: string): void {
  localStorage.setItem(DEV_EFFORT_KEY, id);
}

export function loadDevPermission(): string {
  return localStorage.getItem(DEV_PERMISSION_KEY) ?? "";
}

export function saveDevPermission(id: string): void {
  localStorage.setItem(DEV_PERMISSION_KEY, id);
}

const DEV_PANE_WIDTH_KEY = "twanagent.paneWidth";
export const DEV_PANE_DEFAULT = 300;
export const DEV_PANE_MIN = 200;
export const DEV_PANE_MAX = 720;

export function clampDevPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return DEV_PANE_DEFAULT;
  return Math.min(DEV_PANE_MAX, Math.max(DEV_PANE_MIN, Math.round(width)));
}

export function loadDevPaneWidth(): number {
  return clampDevPaneWidth(Number(localStorage.getItem(DEV_PANE_WIDTH_KEY)));
}

export function saveDevPaneWidth(width: number): void {
  localStorage.setItem(DEV_PANE_WIDTH_KEY, String(clampDevPaneWidth(width)));
}

const DEV_SIDEBAR_WIDTH_KEY = "twanagent.sidebarWidth";
export const DEV_SIDEBAR_DEFAULT = 220;
export const DEV_SIDEBAR_MIN = 160;
export const DEV_SIDEBAR_MAX = 420;

export function clampDevSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEV_SIDEBAR_DEFAULT;
  return Math.min(DEV_SIDEBAR_MAX, Math.max(DEV_SIDEBAR_MIN, Math.round(width)));
}

export function loadDevSidebarWidth(): number {
  const raw = localStorage.getItem(DEV_SIDEBAR_WIDTH_KEY);
  if (raw == null || raw === "") return DEV_SIDEBAR_DEFAULT;
  return clampDevSidebarWidth(Number(raw));
}

export function saveDevSidebarWidth(width: number): void {
  localStorage.setItem(DEV_SIDEBAR_WIDTH_KEY, String(clampDevSidebarWidth(width)));
}

const MARKDOWN_OPEN_KEY = "twanagent.markdownOpen";

export function loadMarkdownOpenMode(): MarkdownOpenMode {
  return localStorage.getItem(MARKDOWN_OPEN_KEY) === "viewer" ? "viewer" : "editor";
}

export function saveMarkdownOpenMode(mode: MarkdownOpenMode): void {
  localStorage.setItem(MARKDOWN_OPEN_KEY, mode);
}

export type GitChangesView = "list" | "tree";

const GIT_CHANGES_VIEW_KEY = "twanagent.gitChangesView";

export function loadGitChangesView(): GitChangesView {
  return localStorage.getItem(GIT_CHANGES_VIEW_KEY) === "tree" ? "tree" : "list";
}

export function saveGitChangesView(view: GitChangesView): void {
  localStorage.setItem(GIT_CHANGES_VIEW_KEY, view);
}

const FILE_HOVER_CARD_KEY = "twanagent.fileHoverCard";
const PREFS_EVENT = "twanagent-prefs";

export function loadFileHoverCard(): boolean {
  const raw = localStorage.getItem(FILE_HOVER_CARD_KEY);
  return raw !== "off" && raw !== "0" && raw !== "false";
}

export function applyFileHoverCard(on: boolean): void {
  document.documentElement.dataset.fileHoverCard = on ? "on" : "off";
}

export function setFileHoverCard(on: boolean): void {
  localStorage.setItem(FILE_HOVER_CARD_KEY, on ? "on" : "off");
  applyFileHoverCard(on);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFS_EVENT));
}

const ALL_PROJECTS_KEY = "twanagent.allProjects";

export function loadAllProjects(): boolean {
  const raw = localStorage.getItem(ALL_PROJECTS_KEY);
  return raw === "on" || raw === "1" || raw === "true";
}

export function setAllProjects(on: boolean): void {
  localStorage.setItem(ALL_PROJECTS_KEY, on ? "on" : "off");
}

const ALL_PROJECTS_COLLAPSED_KEY = "twanagent.allProjects.collapsed";

export function loadCollapsedProjects(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ALL_PROJECTS_COLLAPSED_KEY) ?? "");
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return [];
  }
}

export function saveCollapsedProjects(keys: string[]): void {
  localStorage.setItem(ALL_PROJECTS_COLLAPSED_KEY, JSON.stringify(keys));
}

const FILE_TREE_OPEN_KEY = "twanagent.fileTreeOpen";
const FILE_TREE_OPEN_MAX = 80;

export function loadOpenFileTree(workspace: string): string[] {
  if (!workspace) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(FILE_TREE_OPEN_KEY) ?? "");
    if (!raw || typeof raw !== "object") return [];
    const rows = (raw as Record<string, unknown>)[projectKey(workspace)];
    if (!Array.isArray(rows)) return [];
    return rows.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function saveOpenFileTree(workspace: string, paths: string[]): void {
  if (!workspace) return;
  let all: Record<string, string[]> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(FILE_TREE_OPEN_KEY) ?? "");
    if (raw && typeof raw === "object") all = raw as Record<string, string[]>;
  } catch {
    all = {};
  }
  const key = projectKey(workspace);
  const next = [...new Set(paths.filter((path) => path !== ""))].slice(0, FILE_TREE_OPEN_MAX);
  if (next.length === 0) delete all[key];
  else all[key] = next;
  localStorage.setItem(FILE_TREE_OPEN_KEY, JSON.stringify(all));
}

const PERF_OVERLAY_KEY = "twanagent.perfOverlay";

export function loadPerfOverlay(): boolean {
  const raw = localStorage.getItem(PERF_OVERLAY_KEY);
  return raw === "on" || raw === "1" || raw === "true";
}

export function setPerfOverlay(on: boolean): void {
  localStorage.setItem(PERF_OVERLAY_KEY, on ? "on" : "off");
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFS_EVENT));
}

export function subscribePrefs(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(PREFS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREFS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function saveDevConversation(workspace: string, id: string): void {
  let all: Record<string, string> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_CONVERSATION_KEY) ?? "");
    if (raw && typeof raw === "object") all = raw as Record<string, string>;
  } catch {
    all = {};
  }
  if (id) all[workspace] = id;
  else delete all[workspace];
  localStorage.setItem(DEV_CONVERSATION_KEY, JSON.stringify(all));
}
