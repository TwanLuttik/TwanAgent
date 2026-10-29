import { useLayoutEffect, useRef, useState } from "react";
import { editorTabTitle, isAllDiffPath, isMcpEditorPath, isSkillEditorPath, type EditorState } from "../lib/editor";
import { FileIcon } from "./FileIcon";
import { Symbol } from "./Symbol";

export function EditorFileTabs({
  editor,
  dirtyFiles,
  pendingClosePath,
  onFile,
  onPinFile,
  onCloseFile,
}: {
  editor: EditorState;
  dirtyFiles: Record<string, boolean>;
  pendingClosePath: string | null;
  onFile: (path: string) => void;
  onPinFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}) {
  return (
    <div
      className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto"
      role="tablist"
      aria-label="Open files"
    >
      {editor.tabs.map((tab) => (
        <EditorFileTab
          key={tab.path}
          path={tab.path}
          preview={Boolean(tab.preview)}
          changes={tab.view === "diff"}
          selected={editor.focus === "file" && tab.path === editor.activePath}
          dirty={Boolean(dirtyFiles[tab.path])}
          warnClose={Boolean(dirtyFiles[tab.path]) && pendingClosePath === tab.path}
          onFile={onFile}
          onPinFile={onPinFile}
          onCloseFile={onCloseFile}
        />
      ))}
    </div>
  );
}

function EditorFileTab({
  path,
  title,
  preview,
  changes,
  selected,
  dirty,
  warnClose,
  onFile,
  onPinFile,
  onCloseFile,
}: {
  path: string;
  title?: string;
  preview: boolean;
  changes: boolean;
  selected: boolean;
  dirty: boolean;
  warnClose: boolean;
  onFile: (path: string) => void;
  onPinFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!warnClose) {
      setTip(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setTip({ left: box.left + box.width / 2, top: box.bottom + 6 });
  }, [warnClose]);

  const label = title ?? editorTabTitle(path);
  const folder = parentFolder(path);

  return (
    <div
      ref={ref}
      className={`group relative flex max-w-[15rem] min-w-[7.5rem] shrink-0 items-center border-r border-line ${
        selected
          ? "bg-canvas text-ink"
          : "bg-transparent text-muted hover:bg-wash hover:text-ink"
      } ${warnClose ? "ring-1 ring-inset ring-warn/70" : ""}`}
      onMouseDown={(ev) => {
        if (ev.button === 1) ev.preventDefault();
      }}
      onAuxClick={(ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        ev.stopPropagation();
        onCloseFile(path);
      }}
      onDoubleClick={() => {
        if (preview) onPinFile(path);
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={tabTooltip({ path, preview, changes, warnClose, folder })}
        onClick={() => onFile(path)}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 pl-2.5 text-left"
      >
        <FileIcon name={path} className="size-3.5 shrink-0" />
        <span className={`min-w-0 flex-1 truncate text-[12px] leading-none ${preview ? "italic" : ""}`}>
          {label}
        </span>
        {changes ? (
          <span className="shrink-0 rounded px-1 text-[9px] font-medium tracking-wide text-ok uppercase">
            Diff
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={dirty ? `Close ${label} (unsaved)` : `Close ${label}`}
        onClick={(ev) => {
          ev.stopPropagation();
          onCloseFile(path);
        }}
        className={`mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-[5px] hover:bg-wash-strong hover:text-ink ${
          selected || dirty ? "text-muted" : "text-muted opacity-0 group-hover:opacity-100"
        }`}
      >
        {dirty ? (
          <span className="relative flex size-5 items-center justify-center">
            <span className="size-1.5 rounded-full bg-accent group-hover:hidden" aria-hidden />
            <Symbol name="xmark" className="hidden size-2.5 group-hover:block" />
          </span>
        ) : (
          <Symbol name="xmark" className="size-2.5" />
        )}
      </button>
      {warnClose && tip ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 w-max max-w-[13rem] -translate-x-1/2 rounded-md border border-line bg-canvas px-2 py-1 text-[11px] leading-snug text-ink shadow-card"
          style={{ left: tip.left, top: tip.top }}
        >
          Unsaved changes — click close again to discard
        </div>
      ) : null}
    </div>
  );
}

function parentFolder(path: string): string {
  if (isAllDiffPath(path)) return "Git";
  if (path.startsWith("journey:")) return "Journey";
  if (isMcpEditorPath(path)) return "MCP";
  if (isSkillEditorPath(path)) return "Skill";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return "";
  return parts[parts.length - 2] ?? "";
}

function tabTooltip({
  path,
  preview,
  changes,
  warnClose,
  folder,
}: {
  path: string;
  preview: boolean;
  changes: boolean;
  warnClose: boolean;
  folder: string;
}): string {
  if (warnClose) return "Unsaved changes — click close again to discard";
  const bits = [path];
  if (changes) bits.push("git changes");
  if (preview) bits.push("preview — double-click to keep open");
  if (folder && !path.startsWith("journey:")) bits[0] = path;
  return bits.join(" · ");
}
