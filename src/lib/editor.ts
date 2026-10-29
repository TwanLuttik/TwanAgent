export type MarkdownOpenMode = "editor" | "viewer";

export type EditorFileView = "edit" | "diff";

export type EditorTab = {
  path: string;
  preview?: boolean;
  markdownView?: MarkdownOpenMode;
  view?: EditorFileView;
};

export type EditorFocus = "chat" | "file";

export type EditorState = {
  tabs: EditorTab[];
  activePath: string | null;
  focus: EditorFocus;
};

export type EditorLanguage =
  | "python"
  | "javascript"
  | "json"
  | "html"
  | "css"
  | "markdown"
  | "rust"
  | "yaml"
  | "xml"
  | "sql"
  | "text";

export function emptyEditor(): EditorState {
  return { tabs: [], activePath: null, focus: "chat" };
}

/** The Code tab was selected last time. The file itself is not kept, only the selection. */
export function codeTabEditor(): EditorState {
  return { tabs: [], activePath: null, focus: "file" };
}

export const ALL_DIFF_PATH = "diff:all";
export const MCP_EDITOR_PREFIX = "mcp:";
export const SKILL_EDITOR_PREFIX = "skill:";

export function isAllDiffPath(path: string): boolean {
  return path === ALL_DIFF_PATH;
}

export function isMcpEditorPath(path: string): boolean {
  return path.startsWith(MCP_EDITOR_PREFIX);
}

export function mcpEditorPath(source: string): string {
  return `${MCP_EDITOR_PREFIX}${source}`;
}

export function mcpSourceFromPath(path: string): string | null {
  if (!isMcpEditorPath(path)) return null;
  const source = path.slice(MCP_EDITOR_PREFIX.length);
  return source || null;
}

/** A skill that lives outside the project, opened from the skills pill. */
export function isSkillEditorPath(path: string): boolean {
  return path.startsWith(SKILL_EDITOR_PREFIX);
}

export function skillEditorPath(source: string): string {
  return `${SKILL_EDITOR_PREFIX}${source}`;
}

export function skillSourceFromPath(path: string): string | null {
  if (!isSkillEditorPath(path)) return null;
  const source = path.slice(SKILL_EDITOR_PREFIX.length);
  return source || null;
}

export function editorTabTitle(path: string): string {
  if (isAllDiffPath(path)) return "All changes";
  const mcp = mcpSourceFromPath(path);
  if (mcp) return editorTabTitle(mcp);
  const skill = skillSourceFromPath(path);
  if (skill) return editorTabTitle(skill);
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "Untitled";
}

export function normalizeEditorPath(path: string): string {
  if (isAllDiffPath(path) || isMcpEditorPath(path) || isSkillEditorPath(path)) {
    return path;
  }
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function openEditorTab(state: EditorState, path: string): EditorState {
  return pinEditorTab(state, path);
}

export function previewEditorTab(state: EditorState, path: string): EditorState {
  const next = normalizeEditorPath(path);
  if (!next) return state;
  const existing = state.tabs.find((tab) => tab.path === next);
  if (existing) {
    return { ...state, activePath: next, focus: "file" };
  }
  const previewIdx = state.tabs.findIndex((tab) => tab.preview);
  const tab: EditorTab = { path: next, preview: true };
  if (previewIdx >= 0) {
    const tabs = state.tabs.slice();
    tabs[previewIdx] = tab;
    return { tabs, activePath: next, focus: "file" };
  }
  return { tabs: [...state.tabs, tab], activePath: next, focus: "file" };
}

export function editorFileView(tab?: EditorTab | null): EditorFileView {
  return tab?.view === "diff" ? "diff" : "edit";
}

function tabFields(tab: EditorTab, preview?: boolean): EditorTab {
  return {
    path: tab.path,
    ...(preview ? { preview: true } : {}),
    ...(tab.markdownView ? { markdownView: tab.markdownView } : {}),
    ...(tab.view === "diff" ? { view: "diff" as const } : {}),
  };
}

export function setEditorFileView(state: EditorState, path: string, view: EditorFileView): EditorState {
  const target = normalizeEditorPath(path);
  const idx = state.tabs.findIndex((tab) => tab.path === target);
  if (idx < 0) return state;
  const current = state.tabs[idx];
  const nextView = view === "diff" ? ("diff" as const) : undefined;
  if (current.view === nextView && state.activePath === target && state.focus === "file") return state;
  const tabs = state.tabs.map((tab, i) =>
    i === idx ? tabFields({ ...tab, view: nextView }, tab.preview) : tab,
  );
  return { ...state, tabs, activePath: target, focus: "file" };
}

export function openGitDiffTab(state: EditorState, path: string): EditorState {
  return setEditorFileView(pinEditorTab(state, path), path, "diff");
}

export function previewGitDiffTab(state: EditorState, path: string): EditorState {
  return setEditorFileView(previewEditorTab(state, path), path, "diff");
}

export function pinEditorTab(state: EditorState, path: string): EditorState {
  const next = normalizeEditorPath(path);
  if (!next) return state;
  const idx = state.tabs.findIndex((tab) => tab.path === next);
  if (idx >= 0) {
    const current = state.tabs[idx];
    if (!current.preview && state.activePath === next && state.focus === "file") return state;
    const tabs = current.preview
      ? state.tabs.map((tab, i) => (i === idx ? tabFields({ ...current, path: next }) : tab))
      : state.tabs;
    return { ...state, tabs, activePath: next, focus: "file" };
  }
  return { tabs: [...state.tabs, { path: next }], activePath: next, focus: "file" };
}

export function requestCloseEditorTab(
  pendingPath: string | null,
  path: string,
  dirty: boolean,
): { close: boolean; pending: string | null } {
  const target = normalizeEditorPath(path);
  if (!dirty || pendingPath === target) return { close: true, pending: null };
  return { close: false, pending: target };
}

export function closeEditorTab(state: EditorState, path: string): EditorState {
  const target = normalizeEditorPath(path);
  const idx = state.tabs.findIndex((tab) => tab.path === target);
  if (idx < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.path !== target);
  if (tabs.length === 0) return emptyEditor();
  if (state.activePath !== target) return { ...state, tabs };
  const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
  return { tabs, activePath: neighbor?.path ?? null, focus: neighbor ? "file" : "chat" };
}

export function selectEditorTab(state: EditorState, path: string): EditorState {
  const target = normalizeEditorPath(path);
  if (!state.tabs.some((tab) => tab.path === target)) return state;
  return { ...state, activePath: target, focus: "file" };
}

export function focusEditor(state: EditorState): EditorState {
  if (state.tabs.length === 0) return state;
  const path =
    state.activePath && state.tabs.some((tab) => tab.path === state.activePath)
      ? state.activePath
      : state.tabs[0].path;
  if (state.focus === "file" && state.activePath === path) return state;
  return { ...state, activePath: path, focus: "file" };
}

export function selectChatTab(state: EditorState): EditorState {
  return { ...state, focus: "chat" };
}

export type MediaKind = "image" | "video" | "pdf";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
  apng: "image/apng",
  heic: "image/heic",
  heif: "image/heif",
};

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

const PDF_MIME: Record<string, string> = {
  pdf: "application/pdf",
};

function fileExtension(path: string): string {
  const name = editorTabTitle(bareEditorSource(path)).toLowerCase();
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

export function isMarkdownPath(path: string): boolean {
  const ext = fileExtension(path);
  return ext === "md" || ext === "markdown";
}

export function markdownViewForTab(
  path: string,
  defaultMode: MarkdownOpenMode,
  override?: MarkdownOpenMode,
): MarkdownOpenMode | null {
  if (!isMarkdownPath(path)) return null;
  return override ?? defaultMode;
}

export function setEditorMarkdownView(
  state: EditorState,
  path: string,
  mode: MarkdownOpenMode,
): EditorState {
  const target = normalizeEditorPath(path);
  if (!isMarkdownPath(target)) return state;
  const idx = state.tabs.findIndex((tab) => tab.path === target);
  if (idx < 0) return state;
  const current = state.tabs[idx];
  if (current.markdownView === mode) return state;
  const tabs = state.tabs.map((tab, i) => (i === idx ? { ...tab, markdownView: mode } : tab));
  return { ...state, tabs };
}

export function mediaKindForPath(path: string): MediaKind | null {
  const ext = fileExtension(path);
  if (ext in IMAGE_MIME) return "image";
  if (ext in VIDEO_MIME) return "video";
  if (ext in PDF_MIME) return "pdf";
  return null;
}

export function mediaMimeForPath(path: string): string | null {
  const ext = fileExtension(path);
  return IMAGE_MIME[ext] ?? VIDEO_MIME[ext] ?? PDF_MIME[ext] ?? null;
}

export function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

function bareEditorSource(path: string): string {
  return mcpSourceFromPath(path) ?? skillSourceFromPath(path) ?? path;
}

export function languageForPath(path: string): EditorLanguage {
  const name = editorTabTitle(bareEditorSource(path)).toLowerCase();
  const i = name.lastIndexOf(".");
  const ext = i > 0 ? name.slice(i + 1) : "";
  if (ext === "py" || ext === "pyw") return "python";
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs" || ext === "ts" || ext === "tsx") {
    return "javascript";
  }
  if (ext === "json" || ext === "jsonc") return "json";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "css") return "css";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "rs") return "rust";
  if (ext === "yml" || ext === "yaml") return "yaml";
  if (ext === "xml" || ext === "svg") return "xml";
  if (ext === "sql") return "sql";
  return "text";
}
