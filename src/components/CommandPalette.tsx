import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  buildPalette,
  fileSearchProject,
  movePaletteIndex,
  type PaletteFile,
  type PaletteGroup,
  type PaletteItem,
  type PaletteMode,
} from "../lib/command-palette";
import { fileStructureFiles, fileStructureSignature, publishFileStructure } from "../lib/file-structure";
import { isCommandPaletteHotkey } from "../lib/hotkeys";
import { folderName } from "../lib/project-rows";
import { formatRelativeAge } from "../lib/relative-time";
import { isSameProject } from "../lib/all-projects";
import * as api from "../lib/tauri";
import { providerProfile } from "../lib/provider";
import { isMacOS } from "./WindowButtons";
import { FileIcon } from "./FileIcon";
import { ProjectMark } from "./ProjectMark";
import { Symbol } from "./Symbol";
import { useMain, useSidebar } from "../views/main/context";

/**
 * ⌘K jumps to a running chat, a finished chat, a project, or a file.
 * Tab, or the Files button, is the extra step that searches files in one project.
 */
export function CommandPalette() {
  const {
    applyWorkspace,
    closeDocs,
    closeProjectSettings,
    closeServers,
    closeSettings,
    closeUsage,
    mentionFiles,
    openWorkspaceFile,
    workspace,
  } = useMain();
  const { allProjectGroups, conversations, openSidebarChat, runningTurns } = useSidebar();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PaletteMode>("browse");
  const [active, setActive] = useState(0);
  const [fileProject, setFileProject] = useState<{ path: string; name: string } | null>(null);
  const [loadedFiles, setLoadedFiles] = useState<PaletteFile[]>([]);
  const [filesStatus, setFilesStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const openRef = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  openRef.current = open;

  const groups = useMemo<PaletteGroup[]>(() => {
    const listed = allProjectGroups.map((group) => ({
      name: group.name,
      path: group.path,
      remote: group.remote,
      conversations: group.conversations,
    }));
    if (!workspace) return listed;
    return [...listed, { name: folderName(workspace), path: workspace, conversations }];
  }, [allProjectGroups, conversations, workspace]);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (!isCommandPaletteHotkey(ev, isMacOS())) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (openRef.current) {
        setOpen(false);
        return;
      }
      setQuery("");
      setMode("browse");
      setActive(0);
      setFileProject(null);
      setOpen(true);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.current?.focus();
    return () => previous?.focus();
  }, [open]);

  const fileScope = open && mode === "files" ? fileProject?.path ?? "" : "";
  const cachedFiles = fileScope ? fileStructureFiles(fileScope) : [];
  const currentFiles =
    cachedFiles.length || (fileScope && fileStructureSignature(fileScope))
      ? cachedFiles
      : fileScope && isSameProject(fileScope, workspace) && mentionFiles.length
        ? mentionFiles
        : loadedFiles;

  useEffect(() => {
    if (!fileScope) {
      setLoadedFiles([]);
      setFilesStatus("idle");
      return;
    }
    if (fileStructureFiles(fileScope).length || fileStructureSignature(fileScope)) {
      setFilesStatus("ready");
      return;
    }
    if (isSameProject(fileScope, workspace) && mentionFiles.length) {
      setFilesStatus("ready");
      return;
    }
    let gone = false;
    setLoadedFiles([]);
    setFilesStatus("loading");
    void api
      .treeSignature(fileScope)
      .then((snapshot) => {
        if (gone) return;
        const files = (snapshot.files ?? []).map(fileFromPath);
        publishFileStructure(fileScope, snapshot.signature, snapshot.dirs ?? [], files);
        setLoadedFiles(files);
        setFilesStatus("ready");
      })
      .catch(() => {
        if (gone) return;
        setLoadedFiles([]);
        setFilesStatus("error");
      });
    return () => {
      gone = true;
    };
  }, [fileScope, workspace, mentionFiles]);

  const palette = useMemo(
    () =>
      buildPalette({
        mode,
        query,
        groups,
        files: mode === "files" ? currentFiles : [],
        runningIds: runningTurns,
      }),
    [mode, query, groups, currentFiles, runningTurns],
  );
  const items = palette.items;
  const selected = items.length ? Math.min(active, items.length - 1) : 0;
  const selectedItem = items[selected];

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [open, selected, items]);

  function showFiles() {
    if (mode === "files") {
      setMode("browse");
      setActive(0);
      return;
    }
    setFileProject(fileSearchProject(selectedItem, workspace, query));
    setMode("files");
    setActive(0);
  }

  function activate(item: PaletteItem | undefined) {
    if (!item) return;
    if (item.kind === "chat") {
      void openSidebarChat(item.path, item.id);
    } else if (item.kind === "project") {
      if (!isSameProject(item.path, workspace)) {
        closeOverlays();
        applyWorkspace(item.path);
      }
    } else {
      const scope = fileProject?.path || workspace;
      if (scope && !isSameProject(scope, workspace)) applyWorkspace(scope);
      openWorkspaceFile(item.path);
    }
    setOpen(false);
  }

  function closeOverlays() {
    closeSettings();
    closeUsage();
    closeDocs();
    closeServers();
    closeProjectSettings();
  }

  function onKey(ev: ReactKeyboardEvent) {
    if (ev.nativeEvent.isComposing) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive(movePaletteIndex(selected, ev.key === "ArrowDown" ? 1 : -1, items.length));
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      activate(selectedItem);
      return;
    }
    if (ev.key === "Tab") {
      ev.preventDefault();
      showFiles();
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(false);
    }
  }

  const projectName = fileProject?.name || (workspace ? folderName(workspace) : "");
  const hint = paletteHint(mode, query, items.length, projectName, filesStatus);
  const mod = isMacOS() ? "⌘" : "Ctrl";
  const motionDuration = reduceMotion ? 0 : 0.18;

  return createPortal(
    <AnimatePresence>
      {open ? (
    <motion.div
      key="command-palette"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: motionDuration, ease: PALETTE_EASE }}
      onMouseDown={() => setOpen(false)}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        className="flex max-h-[min(32rem,70vh)] w-[min(36rem,100%)] flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-card"
        initial={reduceMotion ? false : { y: 8, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        exit={reduceMotion ? undefined : { y: 4, scale: 0.98 }}
        transition={{ duration: motionDuration, ease: PALETTE_EASE }}
        onMouseDown={(ev) => ev.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Symbol name="magnifyingglass" className="size-4 shrink-0 text-muted" />
          <input
            ref={field}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={selectedItem ? paletteItemId(selected) : undefined}
            aria-label={mode === "files" ? "Search files" : "Search projects and conversations"}
            value={query}
            onChange={(ev) => {
              setQuery(ev.target.value);
              setActive(0);
            }}
            placeholder={mode === "files" && projectName ? `Search files in ${projectName}` : "Search projects and conversations"}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted/70"
          />
          <button
            type="button"
            aria-pressed={mode === "files"}
            onClick={showFiles}
            className={`max-w-[11rem] shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] font-medium ${
              mode === "files" ? "bg-wash-strong text-ink" : "bg-wash text-muted hover:text-ink"
            }`}
          >
            {mode === "files" && projectName ? `Files · ${projectName}` : "Files"}
          </button>
        </div>
        <div ref={list} id="command-palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {hint ? <p className="px-2 py-6 text-center text-[13px] text-muted">{hint}</p> : null}
          {palette.sections.map((section) => (
            <div key={section.id} className="mb-1">
              <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted">{section.label}</div>
              {section.items.map((item) => {
                const index = items.indexOf(item);
                const on = index === selected;
                return (
                  <button
                    key={paletteItemKey(item)}
                    id={paletteItemId(index)}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-active={on ? "true" : "false"}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => activate(item)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
                      on ? "bg-wash-strong" : "hover:bg-wash"
                    }`}
                  >
                    <PaletteMark item={item} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{paletteTitle(item)}</span>
                      <span className="block truncate text-[11px] text-muted">{paletteDetail(item, query)}</span>
                    </span>
                    {item.kind === "chat" && item.running ? (
                      <span
                        className="size-3 shrink-0 animate-spin rounded-full border border-muted/55 border-t-transparent"
                        aria-label="Running"
                      />
                    ) : null}
                    {item.kind === "chat" && item.updatedAt ? (
                      <span className="shrink-0 text-[11px] text-muted">{formatRelativeAge(item.updatedAt)}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-muted">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>{mode === "files" ? "Tab back" : "Tab search files"}</span>
          <span className="ml-auto">{mod}K close</span>
        </div>
      </motion.div>
    </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

const PALETTE_EASE = [0.22, 1, 0.36, 1] as const;

function paletteHint(
  mode: PaletteMode,
  query: string,
  count: number,
  projectName: string,
  filesStatus: "idle" | "loading" | "ready" | "error",
): string | null {
  if (mode === "files" && !projectName) return "Open a project to search its files.";
  if (mode === "files" && !query.trim()) return `Type to search files in ${projectName}.`;
  if (mode === "files" && filesStatus === "loading") return "Indexing files…";
  if (mode === "files" && filesStatus === "error") return "Couldn't read files in this project.";
  if (count > 0) return null;
  if (mode === "files") return "No matching files.";
  if (!query.trim()) return "No running or recent conversations.";
  return "No matching projects or conversations.";
}

function paletteTitle(item: PaletteItem): string {
  if (item.kind === "chat") return item.title;
  if (item.kind === "project") return item.name;
  return item.name;
}

function paletteDetail(item: PaletteItem, query: string): string {
  if (item.kind === "project") return item.path;
  if (item.kind === "file") return item.path;
  const needle = query.trim().toLowerCase();
  const preview = item.preview.trim();
  if (needle && preview.toLowerCase().includes(needle) && !item.title.toLowerCase().includes(needle)) return preview;
  return item.project;
}

function paletteItemKey(item: PaletteItem): string {
  if (item.kind === "chat") return `chat:${item.path}:${item.id}`;
  if (item.kind === "project") return `project:${item.path}`;
  return `file:${item.path}`;
}

function paletteItemId(index: number): string {
  return `command-palette-item-${index}`;
}

function PaletteMark({ item }: { item: PaletteItem }) {
  if (item.kind === "project") return <ProjectMark path={item.path} remote={item.remote} className="size-4" />;
  if (item.kind === "file") return <FileIcon name={item.name} className="size-4 shrink-0" />;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <ProjectMark path={item.path} remote={item.remote} className="size-4" />
      <ConversationMark model={item.model} />
    </span>
  );
}

/** Same provider mark the conversation list uses. */
function ConversationMark({ model }: { model: string }) {
  const profile = providerProfile(model);
  const tone =
    profile.id === "anthropic" ? "text-[#d97757]" : profile.id === "minimax" ? "group/minimax" : "usage-mark-xai";
  return (
    <span className={`flex size-3.5 shrink-0 items-center justify-center ${tone}`} data-colored="">
      <Symbol name={profile.symbol} colored={profile.id === "minimax"} className="size-3.5" />
    </span>
  );
}

function fileFromPath(path: string): PaletteFile {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { path, name: slash < 0 ? path : path.slice(slash + 1) };
}
