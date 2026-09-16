import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { langs } from "@uiw/codemirror-extensions-langs";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  editorTabTitle,
  languageForPath,
  mediaKindForPath,
  type MarkdownOpenMode,
} from "../lib/dev-editor";
import { editorTheme } from "../lib/editor-theme";
import * as api from "../lib/tauri";
import { ChatMarkdown } from "./ChatMarkdown";
import { DevMedia, type MediaMeta } from "./DevMedia";

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
  onMarkdownView,
  onDirty,
}: {
  workspace: string;
  path: string;
  tick: number;
  markdownView?: MarkdownOpenMode | null;
  onMarkdownView?: (mode: MarkdownOpenMode) => void;
  onDirty?: (path: string, dirty: boolean) => void;
}) {
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [saving, setSaving] = useState(false);
  const [mediaMeta, setMediaMeta] = useState<MediaMeta | null>(null);
  const buf = buffers[path];
  const dirty = Boolean(buf && buf.draft !== buf.original && !buf.error);
  const media = mediaKindForPath(path);
  const mode = useThemeMode();

  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  const load = useCallback(
    async (file: string, force = false) => {
      if (mediaKindForPath(file)) return;
      const existing = buffersRef.current[file];
      if (existing && existing.draft !== existing.original) return;
      if (existing && !force && !existing.error) return;
      try {
        const text = await api.devReadFile(workspace, file);
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
    if (!path || tick === 0) return;
    void load(path, true);
  }, [tick, path, load]);

  useEffect(() => {
    if (media) {
      onDirty?.(path, false);
      return;
    }
    if (!buf) return;
    onDirty?.(path, dirty);
  }, [buf, dirty, media, onDirty, path]);

  useEffect(() => {
    setMediaMeta(null);
  }, [path]);

  const save = useCallback(async () => {
    const current = buffersRef.current[path];
    if (!current || current.error || current.draft === current.original) return;
    setSaving(true);
    try {
      await api.devWriteFile(workspace, path, current.draft);
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
    return [...(lang ? [lang] : []), editorTheme(mode), saveKey];
  }, [path, mode, save]);

  function setDraft(draft: string) {
    const current = buffersRef.current[path];
    if (!current) return;
    setBuffers((prev) => ({ ...prev, [path]: { ...current, draft } }));
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1">
        <span className="min-w-0 truncate text-[11px] text-muted">{path}</span>
        <span className="text-[11px] text-muted">{media ?? languageForPath(path)}</span>
        {markdownView ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <div className="flex gap-0.5">
              {(
                [
                  { id: "editor", label: "Editor" },
                  { id: "viewer", label: "Viewer" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onMarkdownView?.(opt.id)}
                  className={`rounded-[6px] px-2 py-[3px] text-[12px] ${
                    markdownView === opt.id ? "bg-wash-strong text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              className="shrink-0 rounded-[6px] px-2 py-[3px] text-[12px] text-ink hover:bg-wash disabled:opacity-35"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : media ? null : (
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save()}
            className="ml-auto shrink-0 rounded-[6px] px-2 py-[3px] text-[12px] text-ink hover:bg-wash disabled:opacity-35"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {media ? (
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
        </div>
      ) : (
        <div className="min-h-0 flex-1 px-4 py-3 text-[12px] text-muted">Opening…</div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1 text-[11px] text-muted">
        <span className="min-w-0 truncate">{editorTabTitle(path)}</span>
        <span className="ml-auto shrink-0">
          {media ? mediaMeta?.label ?? "" : dirty ? "Unsaved" : "Saved"}
        </span>
      </div>
    </div>
  );
}

function languageExtension(path: string) {
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
