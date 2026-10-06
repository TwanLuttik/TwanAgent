import { projectKey } from "./core.ts";
import type { MarkdownOpenMode } from "./editor";

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

const WORKSPACE_KEY = "twanagent.workspace";
const CONVERSATION_KEY = "twanagent.conversation";
const DRAFTS_KEY = "twanagent.drafts";
const PASTES_KEY = "twanagent.pastes";

export type StoredPaste = { id: string; text: string };

export function loadComposerPastes(): Record<string, StoredPaste[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(PASTES_KEY) ?? "");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, StoredPaste[]> = {};
    for (const [id, rows] of Object.entries(raw)) {
      if (!Array.isArray(rows)) continue;
      const pastes = rows.filter(
        (row): row is StoredPaste =>
          !!row &&
          typeof row === "object" &&
          typeof (row as StoredPaste).id === "string" &&
          typeof (row as StoredPaste).text === "string" &&
          (row as StoredPaste).text.length > 0,
      );
      if (pastes.length) out[id] = pastes;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveComposerPastes(chatId: string, pastes: StoredPaste[]): void {
  if (!chatId) return;
  const all = loadComposerPastes();
  if (pastes.length) all[chatId] = pastes;
  else delete all[chatId];
  localStorage.setItem(PASTES_KEY, JSON.stringify(all));
}

export function loadWorkspace(): string {
  return localStorage.getItem(WORKSPACE_KEY) ?? "";
}

export function saveWorkspace(path: string): void {
  if (path) localStorage.setItem(WORKSPACE_KEY, path);
  else localStorage.removeItem(WORKSPACE_KEY);
}

const RECENTS_KEY = "twanagent.recentWorkspaces";
const RECENTS_MAX = 20;

export function loadRecentWorkspaces(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "");
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return [];
  }
}

export function pushRecentWorkspace(path: string): string[] {
  const next = [path, ...loadRecentWorkspaces().filter((p) => p !== path)].slice(0, RECENTS_MAX);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  return next;
}

export function removeRecentWorkspace(path: string): string[] {
  const key = projectKey(path);
  const next = loadRecentWorkspaces().filter((item) => projectKey(item) !== key);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
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

  const current = loadWorkspace();
  if (current) {
    const next = remap(current);
    if (next !== current) saveWorkspace(next);
  }

  const seen = new Set<string>();
  const recents: string[] = [];
  for (const path of loadRecentWorkspaces()) {
    const next = remap(path);
    const key = projectKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    recents.push(next);
  }
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, RECENTS_MAX)));

  let saved: Record<string, string> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(CONVERSATION_KEY) ?? "");
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
  localStorage.setItem(CONVERSATION_KEY, JSON.stringify(nextSaved));

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
    const raw = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "");
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
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
}

export function loadConversation(workspace: string): string {
  try {
    const raw = JSON.parse(localStorage.getItem(CONVERSATION_KEY) ?? "");
    if (raw && typeof raw === "object") {
      const id = (raw as Record<string, unknown>)[workspace];
      return typeof id === "string" ? id : "";
    }
  } catch {
    /* ignore */
  }
  return "";
}

const MODEL_KEY = "twanagent.model";
const EFFORT_KEY = "twanagent.effort";
const CONTEXT_WINDOW_KEY = "twanagent.contextWindow";
const PERMISSION_KEY = "twanagent.permission";

export function loadModel(): string {
  return localStorage.getItem(MODEL_KEY) ?? "";
}

export function saveModel(id: string): void {
  localStorage.setItem(MODEL_KEY, id);
}

export function loadEffort(): string {
  return localStorage.getItem(EFFORT_KEY) ?? "";
}

export function loadContextWindow(): number {
  const raw = Number(localStorage.getItem(CONTEXT_WINDOW_KEY) ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function saveContextWindow(tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  localStorage.setItem(CONTEXT_WINDOW_KEY, String(Math.floor(tokens)));
}

export function saveEffort(id: string): void {
  localStorage.setItem(EFFORT_KEY, id);
}

export function loadPermission(): string {
  return localStorage.getItem(PERMISSION_KEY) ?? "";
}

export function savePermission(id: string): void {
  localStorage.setItem(PERMISSION_KEY, id);
}

const PANE_WIDTH_KEY = "twanagent.paneWidth";
export const PANE_DEFAULT = 300;
export const PANE_MIN = 200;
export const PANE_MAX = 720;

export function clampPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return PANE_DEFAULT;
  return Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(width)));
}

export function loadPaneWidth(): number {
  return clampPaneWidth(Number(localStorage.getItem(PANE_WIDTH_KEY)));
}

export function savePaneWidth(width: number): void {
  localStorage.setItem(PANE_WIDTH_KEY, String(clampPaneWidth(width)));
}

const SIDEBAR_WIDTH_KEY = "twanagent.sidebarWidth";
export const SIDEBAR_DEFAULT = 220;
export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 420;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

export function loadSidebarWidth(): number {
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (raw == null || raw === "") return SIDEBAR_DEFAULT;
  return clampSidebarWidth(Number(raw));
}

export function saveSidebarWidth(width: number): void {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
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

export function saveConversation(workspace: string, id: string): void {
  let all: Record<string, string> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(CONVERSATION_KEY) ?? "");
    if (raw && typeof raw === "object") all = raw as Record<string, string>;
  } catch {
    all = {};
  }
  if (id) all[workspace] = id;
  else delete all[workspace];
  localStorage.setItem(CONVERSATION_KEY, JSON.stringify(all));
}
