import { projectKey } from "./core.ts";
import type { MarkdownOpenMode } from "./editor";

export type { MarkdownOpenMode };

export const PREFS_EVENT = "twanagent-prefs";

const SPACE_CORNER_KEY = "twanagent.spaceCorner";
const SPACE_CORNER_SCENE_KEY = "twanagent.spaceCornerScene";
const SPACE_CORNER_IMAGE_KEY = "twanagent.spaceCornerImage";
const SPACE_CORNER_IMAGE_NAME_KEY = "twanagent.spaceCornerImageName";
const SPACE_CORNER_IMAGE_SIZE_KEY = "twanagent.spaceCornerImageSize";

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
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFS_EVENT));
}

export function loadSpaceCornerScene(): string {
  return localStorage.getItem(SPACE_CORNER_SCENE_KEY) ?? "";
}

export function setSpaceCornerScene(id: string): void {
  if (id) localStorage.setItem(SPACE_CORNER_SCENE_KEY, id);
  else localStorage.removeItem(SPACE_CORNER_SCENE_KEY);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFS_EVENT));
}

export type SpaceCornerImage = { path: string; name: string; width: number; height: number };

function positiveSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function loadSpaceCornerImage(): SpaceCornerImage | null {
  const path = localStorage.getItem(SPACE_CORNER_IMAGE_KEY)?.trim() ?? "";
  if (!path) return null;
  const name = localStorage.getItem(SPACE_CORNER_IMAGE_NAME_KEY)?.trim() || "Image";
  let width = 0;
  let height = 0;
  try {
    const raw = JSON.parse(localStorage.getItem(SPACE_CORNER_IMAGE_SIZE_KEY) ?? "");
    if (raw && typeof raw === "object") {
      width = positiveSize((raw as { width?: unknown }).width);
      height = positiveSize((raw as { height?: unknown }).height);
    }
  } catch {
    /* a missing size just keeps the default box until the image loads */
  }
  return { path, name, width, height };
}

export function setSpaceCornerImage(image: SpaceCornerImage | null): void {
  if (image?.path) {
    localStorage.setItem(SPACE_CORNER_IMAGE_KEY, image.path);
    localStorage.setItem(SPACE_CORNER_IMAGE_NAME_KEY, image.name || "Image");
    const width = positiveSize(image.width);
    const height = positiveSize(image.height);
    if (width && height) localStorage.setItem(SPACE_CORNER_IMAGE_SIZE_KEY, JSON.stringify({ width, height }));
    else localStorage.removeItem(SPACE_CORNER_IMAGE_SIZE_KEY);
  } else {
    localStorage.removeItem(SPACE_CORNER_IMAGE_KEY);
    localStorage.removeItem(SPACE_CORNER_IMAGE_NAME_KEY);
    localStorage.removeItem(SPACE_CORNER_IMAGE_SIZE_KEY);
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFS_EVENT));
}

const WORKSPACE_KEY = "twanagent.workspace";
const CONVERSATION_KEY = "twanagent.conversation";
const OPEN_TABS_KEY = "twanagent.openTabs";
const ACTIVE_TAB_KEY = "twanagent.activeTab";
const DRAFTS_KEY = "twanagent.drafts";
const PASTES_KEY = "twanagent.pastes";

export type StoredPaste = { id: string; text: string };

const COMPOSER_DRAFT_WAIT = 200;
const pendingDrafts = new Map<string, string>();
const pendingPastes = new Map<string, StoredPaste[]>();
let composerFlushTimer: ReturnType<typeof setTimeout> | undefined;
let composerFlushAt = 0;
let composerHideBound = false;

function storedPastes(rows: unknown): StoredPaste[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is StoredPaste =>
      !!row &&
      typeof row === "object" &&
      typeof (row as StoredPaste).id === "string" &&
      typeof (row as StoredPaste).text === "string" &&
      (row as StoredPaste).text.length > 0,
  );
}

function readComposerPastes(): Record<string, StoredPaste[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(PASTES_KEY) ?? "");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, StoredPaste[]> = {};
    for (const [id, rows] of Object.entries(raw)) {
      const pastes = storedPastes(rows);
      if (pastes.length) out[id] = pastes;
    }
    return out;
  } catch {
    return {};
  }
}

function readComposerDrafts(): Record<string, string> {
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

function armComposerFlush(wait = COMPOSER_DRAFT_WAIT): void {
  const delay = Math.max(0, wait);
  const due = Date.now() + delay;
  if (composerFlushTimer !== undefined && composerFlushAt <= due) return;
  if (composerFlushTimer !== undefined) clearTimeout(composerFlushTimer);
  composerFlushAt = due;
  composerFlushTimer = setTimeout(() => {
    composerFlushTimer = undefined;
    composerFlushAt = 0;
    flushComposerDrafts();
  }, delay);
}

function bindComposerFlush(): void {
  if (composerHideBound || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  const flush = () => flushComposerDrafts();
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  composerHideBound = true;
}

export function loadComposerPastes(): Record<string, StoredPaste[]> {
  const out = readComposerPastes();
  for (const [id, pastes] of pendingPastes) {
    if (pastes.length) out[id] = pastes;
    else delete out[id];
  }
  return out;
}

export function saveComposerPastes(chatId: string, pastes: StoredPaste[]): void {
  if (!chatId) return;
  pendingPastes.set(chatId, pastes.map((row) => ({ id: row.id, text: row.text })));
  armComposerFlush();
  bindComposerFlush();
}

export function scheduleComposerPastes(chatId: string, pastes: StoredPaste[], wait = COMPOSER_DRAFT_WAIT): void {
  if (!chatId) return;
  pendingPastes.set(chatId, pastes.map((row) => ({ id: row.id, text: row.text })));
  armComposerFlush(wait);
  bindComposerFlush();
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

  const nextTabs: Record<string, StoredTabItem[]> = {};
  for (const [path, items] of Object.entries(loadOpenTabs())) {
    const dest = remap(path);
    if (!nextTabs[dest]) nextTabs[dest] = items;
  }
  localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(nextTabs));

  const nextActive: Record<string, string> = {};
  for (const [path, key] of Object.entries(loadActiveTabs())) {
    const dest = remap(path);
    if (key && !nextActive[dest]) nextActive[dest] = key;
  }
  localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify(nextActive));

  const collapsed = new Set(
    loadCollapsedProjects().map((key) => {
      const dest = map.get(projectKey(key));
      return dest ? projectKey(dest) : key;
    }),
  );
  saveCollapsedProjects([...collapsed]);

  const focus = loadSidebarFocus();
  if (focus) {
    const next = remap(focus);
    if (projectKey(next) !== projectKey(focus)) saveSidebarFocus(next);
  }
}

export function loadComposerDrafts(): Record<string, string> {
  const out = readComposerDrafts();
  for (const [id, text] of pendingDrafts) {
    if (text) out[id] = text;
    else delete out[id];
  }
  return out;
}

export function saveComposerDraft(chatId: string, text: string): void {
  if (!chatId) return;
  pendingDrafts.set(chatId, text);
  armComposerFlush();
  bindComposerFlush();
}

export function scheduleComposerDraft(chatId: string, text: string, wait = COMPOSER_DRAFT_WAIT): void {
  if (!chatId) return;
  pendingDrafts.set(chatId, text);
  armComposerFlush(wait);
  bindComposerFlush();
}

export function flushComposerDrafts(): void {
  if (composerFlushTimer !== undefined) {
    clearTimeout(composerFlushTimer);
    composerFlushTimer = undefined;
    composerFlushAt = 0;
  }
  if (pendingDrafts.size) {
    const written = new Map(pendingDrafts);
    const all = readComposerDrafts();
    for (const [id, text] of written) {
      if (text) all[id] = text;
      else delete all[id];
    }
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
    for (const [id, text] of written) {
      if (pendingDrafts.get(id) === text) pendingDrafts.delete(id);
    }
  }
  if (pendingPastes.size) {
    const written = new Map(pendingPastes);
    const all = readComposerPastes();
    for (const [id, pastes] of written) {
      if (pastes.length) all[id] = pastes;
      else delete all[id];
    }
    localStorage.setItem(PASTES_KEY, JSON.stringify(all));
    for (const [id, pastes] of written) {
      if (pendingPastes.get(id) === pastes) pendingPastes.delete(id);
    }
  }
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

const SIDEBAR_COLLAPSED_KEY = "twanagent.sidebarCollapsed";
const SIDEBAR_FOCUS_KEY = "twanagent.sidebarFocus";
const PANE_COLLAPSED_KEY = "twanagent.paneCollapsed";

/** Empty means the sidebar lists every project. */
export function loadSidebarFocus(): string {
  return localStorage.getItem(SIDEBAR_FOCUS_KEY)?.trim() ?? "";
}

export function saveSidebarFocus(path: string): void {
  const next = path.trim();
  if (next) localStorage.setItem(SIDEBAR_FOCUS_KEY, next);
  else localStorage.removeItem(SIDEBAR_FOCUS_KEY);
}

function loadCollapsedFlag(key: string): boolean {
  const raw = localStorage.getItem(key);
  return raw === "on" || raw === "1" || raw === "true";
}

export function loadSidebarCollapsed(): boolean {
  return loadCollapsedFlag(SIDEBAR_COLLAPSED_KEY);
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "on" : "off");
}

export function loadPaneCollapsed(): boolean {
  return loadCollapsedFlag(PANE_COLLAPSED_KEY);
}

export function savePaneCollapsed(collapsed: boolean): void {
  localStorage.setItem(PANE_COLLAPSED_KEY, collapsed ? "on" : "off");
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

const LIVE_SOCKET_DEBUG_KEY = "twanagent.liveSocketDebug";

export function loadLiveSocketDebug(): boolean {
  const raw = localStorage.getItem(LIVE_SOCKET_DEBUG_KEY);
  return raw === "on" || raw === "1" || raw === "true";
}

export function setLiveSocketDebug(on: boolean): void {
  localStorage.setItem(LIVE_SOCKET_DEBUG_KEY, on ? "on" : "off");
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFS_EVENT));
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

const WRAP_LINES_KEY = "twanagent.wrapLines";

/** Soft-wrap long editor lines so they stay in view. Off by default. */
export function loadWrapLines(): boolean {
  const raw = localStorage.getItem(WRAP_LINES_KEY);
  return raw === "on" || raw === "1" || raw === "true";
}

export function setWrapLines(on: boolean): void {
  localStorage.setItem(WRAP_LINES_KEY, on ? "on" : "off");
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFS_EVENT));
}

const EXPAND_EDITS_KEY = "twanagent.expandEdits";

export function loadExpandEdits(): boolean {
  const raw = localStorage.getItem(EXPAND_EDITS_KEY);
  return raw === "on" || raw === "1" || raw === "true";
}

export function setExpandEdits(on: boolean): void {
  localStorage.setItem(EXPAND_EDITS_KEY, on ? "on" : "off");
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

/** One open conversation tab, or two chats kept side by side. */
export type StoredTabItem =
  | { kind: "chat"; id: string }
  | { kind: "code" }
  | {
      kind: "split";
      id: string;
      chatIds: [string, string];
      activePane: 0 | 1;
      leftShare: number;
    };

export function loadOpenTabs(): Record<string, StoredTabItem[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, StoredTabItem[]> = {};
    for (const [path, items] of Object.entries(raw as Record<string, unknown>)) {
      const tabs = storedTabItems(items);
      if (path && tabs.length) out[path] = tabs;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadProjectOpenTabs(workspace: string): StoredTabItem[] {
  if (!workspace) return [];
  const all = loadOpenTabs();
  return all[workspace] ?? all[projectKey(workspace)] ?? [];
}

export function saveProjectOpenTabs(workspace: string, items: StoredTabItem[]): void {
  if (!workspace) return;
  const all = loadOpenTabs();
  const tabs = storedTabItems(items);
  if (tabs.length) all[workspace] = tabs;
  else delete all[workspace];
  localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(all));
}

/** The tab that was selected, keyed like `chat:<id>`, `split:<id>`, or `code`. */
export function loadActiveTabs(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_TAB_KEY) ?? "");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [path, key] of Object.entries(raw as Record<string, unknown>)) {
      if (path && typeof key === "string" && key.trim()) out[path] = key;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadActiveTab(workspace: string): string {
  if (!workspace) return "";
  const all = loadActiveTabs();
  return all[workspace] ?? all[projectKey(workspace)] ?? "";
}

export function saveActiveTab(workspace: string, key: string): void {
  if (!workspace) return;
  const all = loadActiveTabs();
  if (key.trim()) all[workspace] = key;
  else delete all[workspace];
  localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify(all));
}

function storedTabItems(items: unknown): StoredTabItem[] {
  if (!Array.isArray(items)) return [];
  const out: StoredTabItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const tab = storedTabItem(item);
    if (!tab) continue;
    const ids = tab.kind === "chat" ? [tab.id] : tab.kind === "code" ? ["code"] : tab.chatIds;
    if (ids.some((id) => seen.has(id))) continue;
    ids.forEach((id) => seen.add(id));
    out.push(tab);
  }
  return out;
}

function storedTabItem(item: unknown): StoredTabItem | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Partial<StoredTabItem> & { chatIds?: unknown; leftShare?: unknown };
  if (row.kind === "chat" && typeof row.id === "string" && row.id.trim()) {
    return { kind: "chat", id: row.id };
  }
  if (row.kind === "code") return { kind: "code" };
  if (row.kind !== "split" || typeof row.id !== "string" || !row.id.trim()) return null;
  if (!Array.isArray(row.chatIds) || row.chatIds.length !== 2) return null;
  const [left, right] = row.chatIds;
  if (typeof left !== "string" || typeof right !== "string" || !left.trim() || !right.trim() || left === right) {
    return null;
  }
  const pane = row.activePane === 1 ? 1 : 0;
  const share = typeof row.leftShare === "number" && Number.isFinite(row.leftShare) ? row.leftShare : 0.5;
  return { kind: "split", id: row.id, chatIds: [left, right], activePane: pane, leftShare: share };
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
