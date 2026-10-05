import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { langs } from "@uiw/codemirror-extensions-langs";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  editorTabTitle,
  isAllDiffPath,
  languageForPath,
  mediaKindForPath,
  type EditorFileView,
  type EditorState,
  type MarkdownOpenMode,
} from "../lib/dev-editor";
import { parseJourneyId } from "../lib/dev-journey";
import { addedFileDiff, gutterMarksFromDiff, parseGitDiff, type GutterMark } from "../lib/dev-git-diff";
import { gitChangeGutter } from "../lib/editor-git-gutter";
import { editorTheme } from "../lib/editor-theme";
import { normalizeGitPath } from "../lib/dev";
import { selectionPromptSnippet, selectionRangeFromOffsets } from "../lib/editor-selection";
import * as api from "../lib/tauri";
import { isMacOS } from "./WindowButtons";
import { ChatMarkdown } from "./ChatMarkdown";
import { DevMedia, type MediaMeta } from "./DevMedia";
import { EditorFileTabs } from "./EditorFileTabs";
import { GitDiffView } from "./GitDiffView";
import { Symbol } from "./Symbol";

type Buffer = {
  path: string;
  original: string;
  draft: string;
  error: string | null;
};

export function DevEditor({
  workspace,
  path,
  tick,
  markdownView = null,
  fileView = "edit",
  editor,
  dirtyFiles,
  pendingClosePath,
  journeyTitles,
  onMarkdownView,
  onDirty,
  onSelectTab,
  onPinTab,
  onCloseTab,
  onSendToChat,
}: {
  workspace: string;
  path: string;
  tick: number;
  markdownView?: MarkdownOpenMode | null;
  fileView?: EditorFileView;
  editor: EditorState;
  dirtyFiles: Record<string, boolean>;
  pendingClosePath: string | null;
  journeyTitles: Record<string, string>;
  onMarkdownView?: (mode: MarkdownOpenMode) => void;
  onDirty?: (path: string, dirty: boolean) => void;
  onSelectTab: (path: string) => void;
  onPinTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onSendToChat?: (snippet: string) => void;
}) {
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [saving, setSaving] = useState(false);
  const [mediaMeta, setMediaMeta] = useState<MediaMeta | null>(null);
  const [gutterMarks, setGutterMarks] = useState<Map<number, GutterMark>>(() => new Map());
  const [selectionTip, setSelectionTip] = useState<{ top: number; left: number; snippet: string } | null>(
    null,
  );
  const buf = buffers[path];
  const dirty = Boolean(buf && buf.draft !== buf.original && !buf.error);
  const media = mediaKindForPath(path);
  const mode = useThemeMode();

  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  const load = useCallback(
    async (file: string, force = false) => {
      if (mediaKindForPath(file) || isAllDiffPath(file)) return;
      const existing = buffersRef.current[file];
      if (existing && existing.draft !== existing.original) return;
      if (existing && !force && !existing.error) return;
      try {
        const journeyId = parseJourneyId(file);
        const text = journeyId
          ? await api.devGetJourneyKnowledge(workspace, journeyId)
          : await api.devReadFile(workspace, file);
        setBuffers((prev) => {
          const cur = prev[file];
          if (cur && cur.draft !== cur.original) return prev;
          return { ...prev, [file]: { path: file, original: text, draft: text, error: null } };
        });
      } catch (e) {
        setBuffers((prev) => {
          const cur = prev[file];
          if (cur && cur.draft !== cur.original) return prev;
          return { ...prev, [file]: { path: file, original: "", draft: "", error: String(e) } };
        });
      }
    },
    [workspace],
  );

  useEffect(() => {
    setBuffers({});
  }, [workspace]);

  useEffect(() => {
    if (path) void load(path);
  }, [path, load]);

  useEffect(() => {
    setSelectionTip(null);
  }, [path, fileView, markdownView]);

  useEffect(() => {
    if (!selectionTip) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setSelectionTip(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionTip]);

  useEffect(() => {
    if (!path || tick === 0) return;
    void load(path, true);
  }, [tick, path, load]);

  useEffect(() => {
    if (media || fileView === "diff") {
      onDirty?.(path, false);
      return;
    }
    if (!buf) return;
    onDirty?.(path, dirty);
  }, [buf, dirty, fileView, media, onDirty, path]);

  useEffect(() => {
    setMediaMeta(null);
  }, [path]);

  useEffect(() => {
    if (!workspace || !path || fileView === "diff" || media || parseJourneyId(path)) {
      setGutterMarks(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [diff, changes] = await Promise.all([
          api.devGitDiff(workspace, path),
          api.devGitStatus(workspace),
        ]);
        let text = diff;
        if (!text.trim()) {
          const change = changes.find((row) => normalizeGitPath(row.path) === normalizeGitPath(path));
          if (change?.status === "untracked") {
            const contents = buffersRef.current[path]?.original ?? (await api.devReadFile(workspace, path));
            text = addedFileDiff(path, contents);
          }
        }
        if (!cancelled) setGutterMarks(gutterMarksFromDiff(parseGitDiff(text)));
      } catch {
        if (!cancelled) setGutterMarks(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, path, tick, fileView, media]);

  const save = useCallback(async () => {
    const current = buffersRef.current[path];
    if (!current || current.error || current.draft === current.original) return;
    setSaving(true);
    try {
      const journeyId = parseJourneyId(path);
      if (journeyId) await api.devSaveJourneyKnowledge(workspace, journeyId, current.draft);
      else await api.devWriteFile(workspace, path, current.draft);
      setBuffers((prev) => ({
        ...prev,
        [path]: { ...current, original: current.draft, error: null },
      }));
    } catch (e) {
      setBuffers((prev) => ({
        ...prev,
        [path]: { ...current, error: String(e) },
      }));
    } finally {
      setSaving(false);
    }
  }, [path, workspace]);

  const extensions = useMemo(() => {
    const lang = languageExtension(path);
    const saveKey = Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void save();
            return true;
          },
        },
      ]),
    );
    const selection = EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged && !update.geometryChanged) return;
      const sel = update.state.selection.main;
      if (sel.empty) {
        setSelectionTip(null);
        return;
      }
      const doc = update.state.doc.toString();
      const range = selectionRangeFromOffsets(path, doc, sel.from, sel.to);
      if (!range.text.trim()) {
        setSelectionTip(null);
        return;
      }
      const start = update.view.coordsAtPos(sel.from);
      const end = update.view.coordsAtPos(sel.to);
      if (!start) {
        setSelectionTip(null);
        return;
      }
      setSelectionTip({
        top: start.top,
        left: (start.left + (end?.right ?? start.right)) / 2,
        snippet: selectionPromptSnippet(range),
      });
    });
    return [...(lang ? [lang] : []), editorTheme(mode), gitChangeGutter(gutterMarks), saveKey, selection];
  }, [path, mode, save, gutterMarks]);

  function setDraft(draft: string) {
    const current = buffersRef.current[path];
    if (!current) return;
    setBuffers((prev) => ({ ...prev, [path]: { ...current, draft } }));
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-sidebar/70">
        <EditorFileTabs
          editor={editor}
          dirtyFiles={dirtyFiles}
          pendingClosePath={pendingClosePath}
          journeyTitles={journeyTitles}
          onFile={onSelectTab}
          onPinFile={onPinTab}
          onCloseFile={onCloseTab}
        />
        <EditorChromeActions
          fileView={fileView}
          markdownView={markdownView}
          media={Boolean(media)}
          dirty={dirty}
          saving={saving}
          onMarkdownView={onMarkdownView}
          onSave={() => void save()}
        />
      </div>
      {fileView === "diff" ? (
        <GitDiffView workspace={workspace} path={path} tick={tick} />
      ) : media ? (
        <DevMedia workspace={workspace} path={path} kind={media} tick={tick} onMeta={setMediaMeta} />
      ) : buf?.error ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] text-err">{buf.error}</div>
      ) : buf && markdownView === "viewer" ? (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          <div className="mx-auto w-full min-w-0 max-w-[720px]">
            {buf.draft ? (
              <ChatMarkdown text={buf.draft} />
            ) : (
              <p className="m-0 text-[13px] text-muted">Empty file</p>
            )}
          </div>
        </div>
      ) : buf ? (
        <div className="min-h-0 min-w-0 flex-1 [&_.cm-theme]:h-full [&_.cm-editor]:h-full">
          <CodeMirror
            value={buf.draft}
            height="100%"
            theme="none"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              autocompletion: true,
              tabSize: 2,
            }}
            extensions={extensions}
            onChange={setDraft}
            className="h-full"
          />
          {selectionTip
            ? createPortal(
                <SelectionChatTooltip
                  top={selectionTip.top}
                  left={selectionTip.left}
                  onSend={() => {
                    onSendToChat?.(selectionTip.snippet);
                    setSelectionTip(null);
                  }}
                  onCopy={() => {
                    void navigator.clipboard.writeText(selectionTip.snippet).catch(() => undefined);
                    setSelectionTip(null);
                  }}
                />,
                document.body,
              )
            : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 px-4 py-3 text-[12px] text-muted">Opening…</div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1 text-[11px] text-muted">
        <span className="min-w-0 truncate">
          {isAllDiffPath(path) ? "All changes" : parseJourneyId(path) ? "Journey knowledge" : path}
        </span>
        <span className="ml-auto shrink-0">
          {fileView === "diff"
            ? "Git changes"
            : media
              ? mediaMeta?.label ?? ""
              : `${languageForPath(path) ?? "text"}${dirty ? " · Unsaved" : ""}`}
        </span>
      </div>
    </div>
  );
}

function EditorChromeActions({
  fileView,
  markdownView,
  media,
  dirty,
  saving,
  onMarkdownView,
  onSave,
}: {
  fileView: EditorFileView;
  markdownView?: MarkdownOpenMode | null;
  media: boolean;
  dirty: boolean;
  saving: boolean;
  onMarkdownView?: (mode: MarkdownOpenMode) => void;
  onSave: () => void;
}) {
  if (fileView === "diff") {
    return (
      <span className="flex shrink-0 items-center px-2.5 text-[11px] text-muted">Read only</span>
    );
  }
  if (media) return null;

  const showSave = dirty || saving;
  const shortcut = isMacOS() ? "⌘S" : "Ctrl+S";

  return (
    <div className="flex shrink-0 items-center gap-1.5 px-2">
      {markdownView ? (
        <div
          className="flex rounded-[7px] bg-wash p-0.5"
          role="radiogroup"
          aria-label="Markdown view"
        >
          {(
            [
              { id: "editor", label: "Edit", icon: "pencil", title: "Edit source" },
              { id: "viewer", label: "Preview", icon: "eye", title: "Preview rendered Markdown" },
            ] as const
          ).map((opt) => {
            const on = markdownView === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={on}
                title={opt.title}
                onClick={() => onMarkdownView?.(opt.id)}
                className={`flex items-center gap-1 rounded-[5px] px-2 py-[3px] text-[11px] ${
                  on ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                <Symbol name={opt.icon} className="size-3" />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {markdownView && showSave ? <span className="h-3.5 w-px shrink-0 bg-line" aria-hidden /> : null}
      {showSave ? (
        <button
          type="button"
          disabled={!dirty || saving}
          title={`Save ${shortcut}`}
          onClick={onSave}
          className="shrink-0 rounded-[6px] bg-accent px-2 py-[3px] text-[11px] font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      ) : null}
    </div>
  );
}

function SelectionChatTooltip({
  top,
  left,
  onSend,
  onCopy,
}: {
  top: number;
  left: number;
  onSend: () => void;
  onCopy: () => void;
}) {
  const x = Math.min(Math.max(12, left), window.innerWidth - 12);
  const y = Math.max(8, top - 8);
  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-line bg-canvas px-1 py-0.5 shadow-card"
      style={{ top: y, left: x, transform: "translate(-50%, -100%)" }}
      onMouseDown={(ev) => ev.preventDefault()}
    >
      <button
        type="button"
        onClick={onSend}
        className="rounded-md px-2 py-1 text-[12px] text-ink hover:bg-wash"
      >
        Send to chat
      </button>
      <button
        type="button"
        aria-label="Copy"
        title="Copy"
        onClick={onCopy}
        className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-wash hover:text-ink"
      >
        <Symbol name="copy" className="size-3.5" />
      </button>
    </div>
  );
}

function languageExtension(path: string) {
  if (parseJourneyId(path)) {
    const table = langs as Record<string, () => Extension>;
    return typeof table.md === "function" ? table.md() : null;
  }
  const name = editorTabTitle(path).toLowerCase();
  const i = name.lastIndexOf(".");
  const ext = i > 0 ? name.slice(i + 1) : "";
  const table = langs as Record<string, () => Extension>;
  if (typeof table[ext] === "function") return table[ext]();
  return null;
}

function useThemeMode(): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.themeMode === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setMode(el.dataset.themeMode === "dark" ? "dark" : "light");
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme-mode"] });
    return () => obs.disconnect();
  }, []);
  return mode;
}
