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
