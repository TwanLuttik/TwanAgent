import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { sidebarProjects } from "../lib/all-projects";
import {
  FOLDER_ACTIONS,
  filterProjectRows,
  folderActionEnabled,
  folderActionHint,
  isExistingProjectName,
  looksLikeGitUrl,
  looksLikePath,
  pathWithSlash,
  preferredFolderAction,
  sanitizeProjectName,
  type FolderActionId,
  type ProjectRow,
} from "../lib/core";
import * as api from "../lib/tauri";
import type { FolderSuggestion } from "../lib/tauri";
import { MachinesDialog } from "./MachinesDialog";
import { Symbol } from "./Symbol";

type Focus =
  | { kind: "action"; id: FolderActionId }
  | { kind: "folder"; index: number }
  | { kind: "project"; index: number };

export function FolderDialog({
  onClose,
  onPick,
  showProjects = true,
}: {
  onClose: () => void;
  onPick: (path: string) => void;
  showProjects?: boolean;
  recents?: string[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<FolderActionId>("open");
  const [manual, setManual] = useState(false);
  const [focus, setFocus] = useState<Focus>(
    showProjects ? { kind: "project", index: 0 } : { kind: "action", id: "open" },
  );
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serversOpen, setServersOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleProjects = showProjects ? filterProjectRows(projects, query) : [];
  const nameTaken = isExistingProjectName(query, projects);
  const createName = sanitizeProjectName(query);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!showProjects) return;
    let gone = false;
    void api
      .listProjects()
      .then((rows) => {
        if (!gone) setProjects(sidebarProjects(rows));
      })
      .catch(() => {
        if (!gone) setProjects([]);
      });
    return () => {
      gone = true;
    };
  }, [showProjects]);

  useEffect(() => {
    function onDocKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onDocKey);
    return () => window.removeEventListener("keydown", onDocKey);
  }, [busy, onClose]);

  useEffect(() => {
    if (manual && (active === "clone" || active === "create" || folderActionEnabled(active, query))) {
      return;
    }
    if (showProjects && visibleProjects.length && !looksLikeGitUrl(query) && !looksLikePath(query)) {
      setFocus({ kind: "project", index: 0 });
      setManual(false);
      return;
    }
    const next = preferredFolderAction(query);
    setActive(next);
    setFocus({ kind: "action", id: next });
    setManual(false);
  }, [query, manual, active, showProjects, visibleProjects.length]);

  useEffect(() => {
    if (!looksLikePath(query) || active === "clone") {
      setFolders([]);
      return;
    }
    let gone = false;
    const handle = window.setTimeout(() => {
      void api
        .suggestFolders(query.trim())
        .then((rows) => {
          if (!gone) setFolders(rows);
        })
        .catch(() => {
          if (!gone) setFolders([]);
        });
    }, 80);
    return () => {
      gone = true;
      window.clearTimeout(handle);
    };
  }, [query, active]);

  useEffect(() => {
    if (focus.kind === "folder" && focus.index >= folders.length) {
      setFocus(folders.length ? { kind: "folder", index: folders.length - 1 } : { kind: "action", id: "open" });
    }
    if (focus.kind === "project" && focus.index >= visibleProjects.length) {
      setFocus(
        visibleProjects.length
          ? { kind: "project", index: visibleProjects.length - 1 }
          : { kind: "action", id: "open" },
      );
    }
  }, [folders, visibleProjects.length, focus]);

  function focusSearch() {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }

  function selectAction(id: FolderActionId) {
    setActive(id);
    setFocus({ kind: "action", id });
    setManual(true);
    setError(null);
    if (id === "clone" && query && !looksLikeGitUrl(query)) setQuery("");
    if (id === "create" && query && (looksLikePath(query) || looksLikeGitUrl(query))) setQuery("");
    window.setTimeout(focusSearch, 0);
  }

  function move(delta: number) {
    const items: Focus[] = [
      ...visibleProjects.map((_, index) => ({ kind: "project" as const, index })),
      { kind: "action", id: "open" },
      ...folders.map((_, index) => ({ kind: "folder" as const, index })),
      ...FOLDER_ACTIONS.filter((a) => a.id !== "open").map((a) => ({
        kind: "action" as const,
        id: a.id,
      })),
    ];
    const current = items.findIndex((item) =>
      focus.kind === "folder"
        ? item.kind === "folder" && item.index === focus.index
        : focus.kind === "project"
          ? item.kind === "project" && item.index === focus.index
          : item.kind === "action" && item.id === focus.id,
    );
    const idx = current < 0 ? 0 : (current + delta + items.length) % items.length;
    const next = items[idx];
    setFocus(next);
    if (next.kind === "action") {
      setActive(next.id);
      setManual(true);
      if (next.id === "clone" && query && !looksLikeGitUrl(query)) setQuery("");
      if (next.id === "create" && query && (looksLikePath(query) || looksLikeGitUrl(query))) setQuery("");
    } else {
      setActive("open");
      setManual(true);
    }
    window.setTimeout(focusSearch, 0);
  }

  function applyFolder(row: FolderSuggestion, open: boolean) {
    if (open) {
      void runOpen(row.path);
      return;
    }
    setQuery(pathWithSlash(row.path));
    setFocus({ kind: "action", id: "open" });
    setActive("open");
    setManual(true);
    window.setTimeout(focusSearch, 0);
  }

  async function browse() {
    if (busy) return;
    setError(null);
    const picked = await api.pickDir();
    if (!picked) return;
    await runOpen(picked);
  }

  async function runOpen(path: string) {
    const trimmed = path.trim();
    if (!trimmed) {
      await browse();
      return;
    }
    setBusy(true);
    onPick(await api.openFolder(trimmed));
  }

  async function run(id: FolderActionId) {
    if (busy) return;
    setError(null);
    try {
      if (id === "open") {
        if (focus.kind === "folder" && folders[focus.index]) {
          await runOpen(folders[focus.index].path);
          return;
        }
        await runOpen(query);
        return;
      }
      if (id === "create") {
        if (!folderActionEnabled("create", query)) {
          selectAction("create");
          return;
        }
        if (isExistingProjectName(query, projects)) {
          selectAction("create");
          setError("A project with this name already exists.");
          return;
        }
        setBusy(true);
        onPick(await api.createProject(query));
        return;
      }
      if (!looksLikeGitUrl(query)) {
        selectAction("clone");
        setError("Paste a git URL.");
        return;
      }
      setBusy(true);
      onPick(await api.cloneRepo(query.trim()));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Tab" && folders.length && active !== "clone") {
      e.preventDefault();
      const row =
        focus.kind === "folder" && folders[focus.index] ? folders[focus.index] : folders[0];
      applyFolder(row, false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focus.kind === "project" && visibleProjects[focus.index]) {
        void runOpen(visibleProjects[focus.index].path);
      } else if (focus.kind === "folder" && folders[focus.index]) {
        void runOpen(folders[focus.index].path);
      } else {
        void run(active);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onClose();
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 px-4 pt-[16vh]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={(ev) => {
          if (ev.target === ev.currentTarget && !busy) onClose();
        }}
      >
        <motion.div
          className="w-full max-w-[520px] overflow-hidden rounded-xl border border-line bg-canvas shadow-card"
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 6 }}
          transition={{ duration: 0.16 }}
          role="dialog"
          aria-labelledby="folder-dialog-title"
        >
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Symbol name="magnifyingglass" className="size-4 shrink-0 text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setError(null);
              }}
              onKeyDown={onSearchKey}
              disabled={busy}
              placeholder={
                active === "clone"
                  ? "https://github.com/org/repo.git"
                  : active === "create"
                    ? "Type a project name"
                    : showProjects
                      ? "Search projects, or type a path"
                      : "Type a folder path or project name"
              }
              className={`h-11 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted disabled:opacity-60 ${
                active === "create" && nameTaken ? "text-err" : ""
              }`}
              aria-invalid={active === "create" && nameTaken}
              aria-labelledby="folder-dialog-title"
            />
          </div>
          <h2 id="folder-dialog-title" className="sr-only">
            {showProjects ? "Open a project" : "Open a folder"}
          </h2>
          <div role="listbox" aria-label={showProjects ? "Projects" : "Folder actions"} className="p-1.5">
            {showProjects && visibleProjects.length === 0 && !query.trim() && (
              <p className="px-2.5 py-2 text-[12px] text-muted">No projects yet</p>
            )}
            {visibleProjects.length > 0 && (
              <div className="mb-1 max-h-[220px] overflow-auto">
                {visibleProjects.map((row, index) => {
                  const on = focus.kind === "project" && focus.index === index;
                  const conflict = active === "create" && isExistingProjectName(query, [row]);
                  return (
                    <button
                      key={row.path}
                      type="button"
                      role="option"
                      aria-selected={on}
                      disabled={busy}
                      onMouseEnter={() => {
                        setFocus({ kind: "project", index });
                        setManual(true);
                      }}
                      onClick={() => void runOpen(row.path)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${
                        on ? "bg-wash-strong" : "hover:bg-wash"
                      }`}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-inset text-accent">
                        <Symbol name="folder.fill" className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block text-[13px] font-medium ${conflict ? "text-err" : "text-ink"}`}
                        >
                          {row.name}
                        </span>
                        <span className="block truncate text-[12px] text-muted">{row.path}</span>
                      </span>
                      {on && <span className="shrink-0 text-[11px] text-muted">↵</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {FOLDER_ACTIONS.map((action) => {
              const createConflict = action.id === "create" && nameTaken;
              const can =
                action.id === "clone" || action.id === "create"
                  ? true
                  : folderActionEnabled(action.id, query);
              const ready =
                action.id === "create"
                  ? folderActionEnabled("create", query) && !nameTaken
                  : action.id === "clone"
                    ? folderActionEnabled("clone", query)
                    : can;
              const selected = focus.kind === "action" && focus.id === action.id;
              const hint =
                createConflict && createName
                  ? `${createName} already exists`
                  : folderActionHint(action.id, query);
              return (
                <div key={action.id}>
                  <div
                    role="option"
                    aria-selected={selected}
                    aria-disabled={!can || busy}
                    onMouseEnter={() => {
                      if (can) {
                        setActive(action.id);
                        setFocus({ kind: "action", id: action.id });
                        setManual(true);
                      }
                    }}
                    className={`flex w-full items-center gap-1 rounded-lg pr-1.5 ${
                      selected ? "bg-wash-strong" : "hover:bg-wash"
                    } ${!can || (busy && !selected) ? "opacity-40" : ""}`}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (action.id === "clone" || action.id === "create") {
                          selectAction(action.id);
                          return;
                        }
                        void run(action.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-inset text-accent">
                        <Symbol name={action.icon} className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block text-[13px] font-medium ${createConflict ? "text-err" : "text-ink"}`}
                        >
                          {action.label}
                        </span>
                        <span
                          className={`block truncate text-[12px] ${createConflict ? "text-err" : "text-muted"}`}
                        >
                          {busy && selected
                            ? action.id === "clone"
                              ? "Cloning…"
                              : action.id === "create"
                                ? "Creating…"
                                : "Opening…"
                            : hint}
                        </span>
                      </span>
                      {selected && ready && (
                        <span className="shrink-0 text-[11px] text-muted">↵</span>
                      )}
                    </button>
                    {action.id === "open" && !busy && (
                      <button
                        type="button"
                        className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-wash hover:text-ink"
                        onClick={() => void browse()}
                      >
                        Browse
                      </button>
                    )}
                  </div>
                  {action.id === "open" && folders.length > 0 && (
                    <div className="mb-1 ml-11 max-h-[180px] overflow-auto pr-1">
                      {folders.map((row, index) => {
                        const on = focus.kind === "folder" && focus.index === index;
                        return (
                          <button
                            key={row.path}
                            type="button"
                            role="option"
                            aria-selected={on}
                            disabled={busy}
                            onMouseEnter={() => {
                              setFocus({ kind: "folder", index });
                              setActive("open");
                              setManual(true);
                            }}
                            onClick={() => applyFolder(row, true)}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] ${
                              on ? "bg-wash-strong text-ink" : "text-ink/85 hover:bg-wash"
                            }`}
                          >
                            <Symbol name="folder.fill" className="size-3.5 shrink-0 text-accent" />
                            <span className="min-w-0 truncate">{row.name}</span>
                            {on && <span className="ml-auto shrink-0 text-[11px] text-muted">↵</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {error && <p className="m-0 px-3.5 pb-2.5 text-[12px] text-err">{error}</p>}
          <div className="border-t border-line px-3 py-2">
            <button
              type="button"
              className="text-[12px] text-accent hover:underline"
              onClick={() => setServersOpen(true)}
            >
              Manage servers
            </button>
          </div>
        </motion.div>
        {serversOpen && (
          <MachinesDialog
            onClose={() => setServersOpen(false)}
            onOpenProject={(path) => {
              setServersOpen(false);
              onPick(path);
            }}
          />
        )}
      </motion.div>
    </AnimatePresence>
  );
}
