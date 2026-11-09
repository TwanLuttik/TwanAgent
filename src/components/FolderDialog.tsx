import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { sidebarProjects } from "../lib/all-projects";
import {
  FOLDER_ACTIONS,
  filterProjectRows,
  folderActionEnabled,
  folderActionHint,
  folderClickAction,
  folderEnterTarget,
  folderFocusFromQuery,
  isExistingProjectName,
  looksLikeGitUrl,
  looksLikePath,
  pathWithSlash,
  repoNameFromUrl,
  sanitizeProjectName,
  type FolderActionId,
  type FolderFocus,
  type ProjectRow,
} from "../lib/core";
import * as api from "../lib/tauri";
import type { AgentServer, FolderSuggestion } from "../lib/tauri";
import { Symbol } from "./Symbol";

const MENU_EASE = [0.22, 1, 0.36, 1] as const;
const LOCAL = "local";
const HOVER_ARM_PX = 4;

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
  const [focus, setFocus] = useState<FolderFocus>(
    showProjects ? { kind: "project", index: 0 } : { kind: "action", id: "open" },
  );
  const queryDriven = useRef(true);
  const hoverArmed = useRef(false);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [servers, setServers] = useState<AgentServer[]>([]);
  const [online, setOnline] = useState<Record<string, boolean | null>>({});
  const [place, setPlace] = useState(LOCAL);
  const [serversOpen, setServersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [present, setPresent] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const server = servers.find((row) => row.id === place) ?? null;
  const onServer = Boolean(server);
  const placeName = server?.name || "this Mac";
  const visibleProjects = showProjects && !onServer ? filterProjectRows(projects, query) : [];
  const nameTaken = !onServer && isExistingProjectName(query, projects);
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
    void api
      .listAgentServers()
      .then((rows) => {
        if (gone) return;
        const paired = rows.filter((row) => row.paired);
        setServers(paired);
        for (const row of paired) {
          void api
            .agentServerOnline(row.id)
            .then((online) => {
              if (!gone) setOnline((current) => ({ ...current, [row.id]: online }));
            })
            .catch(() => {
              if (!gone) setOnline((current) => ({ ...current, [row.id]: false }));
            });
        }
      })
      .catch(() => {
        if (!gone) setServers([]);
      });
    return () => {
      gone = true;
    };
  }, [showProjects]);

  const dismiss = useCallback(() => {
    if (busy || !present) return;
    setPresent(false);
  }, [busy, present]);

  useEffect(() => {
    function onDocKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onDocKey);
    return () => window.removeEventListener("keydown", onDocKey);
  }, [dismiss]);

  useEffect(() => {
    if (!queryDriven.current) return;
    const next = folderFocusFromQuery(query, visibleProjects.length, onServer);
    setFocus(next);
    setActive(next.kind === "action" ? next.id : looksLikeGitUrl(query) ? "clone" : looksLikePath(query) ? "open" : "open");
  }, [query, onServer, visibleProjects.length]);

  useEffect(() => {
    if (onServer || !looksLikePath(query) || active === "clone") {
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
  }, [query, active, onServer]);

  useEffect(() => {
    if (focus.kind === "folder" && focus.index >= folders.length) {
      setFocus(folders.length ? { kind: "folder", index: folders.length - 1 } : { kind: "action", id: "open" });
    }
    if (focus.kind === "project" && focus.index >= visibleProjects.length) {
      setFocus(
        visibleProjects.length
          ? { kind: "project", index: visibleProjects.length - 1 }
          : { kind: "action", id: onServer ? "create" : "open" },
      );
    }
  }, [folders, visibleProjects.length, focus, onServer]);

  function focusSearch() {
    inputRef.current?.focus();
  }

  function disarmHover() {
    hoverArmed.current = false;
    pointerAt.current = null;
  }

  function onListPointerMove(ev: { clientX: number; clientY: number }) {
    const prev = pointerAt.current;
    pointerAt.current = { x: ev.clientX, y: ev.clientY };
    if (!prev) return;
    if (Math.abs(ev.clientX - prev.x) + Math.abs(ev.clientY - prev.y) < HOVER_ARM_PX) return;
    hoverArmed.current = true;
  }

  function sameFocus(a: FolderFocus, b: FolderFocus): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "action" && b.kind === "action") return a.id === b.id;
    return a.kind !== "action" && b.kind !== "action" && a.index === b.index;
  }

  function highlightFromPointer(next: FolderFocus, ev?: { clientX: number; clientY: number }) {
    if (ev) onListPointerMove(ev);
    if (!hoverArmed.current) return;
    queryDriven.current = false;
    setFocus((current) => (sameFocus(current, next) ? current : next));
    if (next.kind === "action") setActive(next.id);
    else setActive("open");
  }

  function selectAction(id: FolderActionId) {
    queryDriven.current = false;
    setActive(id);
    setFocus({ kind: "action", id });
    setError(null);
    window.setTimeout(focusSearch, 0);
  }

  function pickPlace(id: string) {
    if (id !== LOCAL && online[id] !== true) return;
    setPlace(id);
    queryDriven.current = true;
    setError(null);
    setFolders([]);
    if (id !== LOCAL) {
      setActive((current) => (current === "open" ? "create" : current));
      setFocus((current) => (current.kind === "project" || (current.kind === "action" && current.id === "open") ? { kind: "action", id: "create" } : current));
    }
    window.setTimeout(focusSearch, 0);
  }

  function move(delta: number) {
    const actions = FOLDER_ACTIONS.filter((action) => !onServer || action.id !== "open");
    const items: FolderFocus[] = [
      ...visibleProjects.map((_, index) => ({ kind: "project" as const, index })),
      ...(onServer ? [] : [{ kind: "action" as const, id: "open" as const }]),
      ...folders.map((_, index) => ({ kind: "folder" as const, index })),
      ...actions.filter((action) => action.id !== "open").map((action) => ({
        kind: "action" as const,
        id: action.id,
      })),
    ];
    if (!items.length) return;
    const current = items.findIndex((item) =>
      focus.kind === "folder"
        ? item.kind === "folder" && item.index === focus.index
        : focus.kind === "project"
          ? item.kind === "project" && item.index === focus.index
          : item.kind === "action" && item.id === focus.id,
    );
    const idx = current < 0 ? 0 : (current + delta + items.length) % items.length;
    const next = items[idx];
    queryDriven.current = false;
    setFocus(next);
    if (next.kind === "action") setActive(next.id);
    else setActive("open");
    window.setTimeout(focusSearch, 0);
  }

  function applyFolder(row: FolderSuggestion, open: boolean) {
    if (open) {
      void runOpen(row.path);
      return;
    }
    queryDriven.current = true;
    setQuery(pathWithSlash(row.path));
    setFocus({ kind: "action", id: "open" });
    setActive("open");
    window.setTimeout(focusSearch, 0);
  }

  async function browse() {
    if (busy || onServer) return;
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

  async function remoteHomePath(name: string): Promise<string> {
    if (!server?.machine_id) throw new Error("Pair this server again before creating a project.");
    const home = await api.remoteHome(server.machine_id);
    return `${home.replace(/\/$/, "")}/projects/${name}`;
  }

  async function run(id: FolderActionId) {
    if (busy) return;
    setError(null);
    try {
      if (id === "open") {
        if (onServer) return;
        if (focus.kind === "folder" && folders[focus.index]) {
          await runOpen(folders[focus.index].path);
          return;
        }
        await runOpen(query);
        return;
      }
      if (id === "create") {
        if (looksLikeGitUrl(query)) {
          await run("clone");
          return;
        }
        if (!folderActionEnabled("create", query)) {
          selectAction("create");
          return;
        }
        if (!onServer && isExistingProjectName(query, projects)) {
          selectAction("create");
          setError("A project with this name already exists.");
          return;
        }
        const name = sanitizeProjectName(query);
        if (!name) return;
        setBusy(true);
        if (server?.machine_id) {
          onPick(await api.createRemoteProject(name, server.machine_id, await remoteHomePath(name)));
          return;
        }
        onPick(await api.createProject(query));
        return;
      }
      if (!looksLikeGitUrl(query)) {
        selectAction("clone");
        setError("Paste a git URL.");
        return;
      }
      setBusy(true);
      const url = query.trim();
      if (server?.machine_id) {
        const name = repoNameFromUrl(url);
        if (!name) throw new Error("Could not read a folder name from that git URL.");
        onPick(await api.cloneRemoteRepo(url, server.machine_id, await remoteHomePath(name)));
        return;
      }
      onPick(await api.cloneRepo(url));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") disarmHover();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Tab" && folders.length && active !== "clone" && !onServer) {
      e.preventDefault();
      const row =
        focus.kind === "folder" && folders[focus.index] ? folders[focus.index] : folders[0];
      applyFolder(row, false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = folderEnterTarget(query, focus);
      if (target.kind === "project" && visibleProjects[target.index]) {
        void runOpen(visibleProjects[target.index].path);
      } else if (target.kind === "folder" && folders[target.index]) {
        void runOpen(folders[target.index].path);
      } else if (target.kind === "clone" || target.kind === "create" || target.kind === "open") {
        void run(target.kind);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    }
  }

  const searchPlaceholder = looksLikeGitUrl(query)
    ? "https://github.com/org/repo.git"
    : looksLikePath(query)
      ? "Type a folder path"
      : active === "clone"
        ? "https://github.com/org/repo.git"
        : active === "create"
          ? "Type a project name"
          : showProjects
            ? "Search projects, or paste a git URL"
            : "Type a folder path or project name";

  const actions = FOLDER_ACTIONS.filter((action) => !onServer || action.id !== "open");

  return (
    <AnimatePresence onExitComplete={onClose}>
      {present ? (
        <motion.div
          key="folder-dialog"
          className="fixed inset-0 z-40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: MENU_EASE }}
        >
          <div className="absolute inset-0 bg-black/40" onClick={dismiss} />
          <motion.div
            className="absolute inset-x-0 top-[16vh] mx-auto flex max-h-[min(520px,70vh)] w-[calc(100%-2rem)] max-w-[520px] flex-col overflow-hidden rounded-xl border border-line/25 bg-canvas shadow-card"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16, ease: MENU_EASE }}
            role="dialog"
            aria-labelledby="folder-dialog-title"
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-line/20 px-3">
                <Symbol name="magnifyingglass" className="size-4 shrink-0 text-muted" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    queryDriven.current = true;
                    disarmHover();
                    setQuery(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={onSearchKey}
                  disabled={busy}
                  autoCorrect="off"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={searchPlaceholder}
                  className={`h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted disabled:opacity-60 ${
                    active === "create" && nameTaken ? "text-err" : "text-ink"
                  }`}
                  aria-invalid={active === "create" && nameTaken}
                  aria-labelledby="folder-dialog-title"
                />
              </div>
              <h2 id="folder-dialog-title" className="sr-only">
                {onServer ? `New project on ${placeName}` : showProjects ? "Open a project" : "Open a folder"}
              </h2>
              <div
                role="listbox"
                aria-label={showProjects ? "Projects" : "Folder actions"}
                className="min-h-0 flex-1 overflow-auto p-1"
                onMouseMove={onListPointerMove}
              >
                {showProjects && !onServer && visibleProjects.length === 0 && !query.trim() && (
                  <p className="px-2.5 py-2 text-[12px] text-muted">No projects yet</p>
                )}
                {visibleProjects.map((row, index) => {
                  const on = !looksLikeGitUrl(query) && focus.kind === "project" && focus.index === index;
                  const conflict = active === "create" && isExistingProjectName(query, [row]);
                  return (
                    <button
                      key={row.path}
                      type="button"
                      role="option"
                      aria-selected={on}
                      disabled={busy}
                      onMouseEnter={() => highlightFromPointer({ kind: "project", index })}
                      onMouseMove={(ev) => highlightFromPointer({ kind: "project", index }, ev)}
                      onClick={() => void runOpen(row.path)}
                      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                        on ? "bg-wash" : ""
                      }`}
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-inset text-accent">
                        <Symbol name="folder.fill" className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[13px] font-medium ${conflict ? "text-err" : "text-ink"}`}>
                          {row.name}
                        </span>
                        <span className="block truncate text-[11px] text-muted">{row.path}</span>
                      </span>
                      {on ? <span className="shrink-0 text-[11px] text-muted">↵</span> : null}
                    </button>
                  );
                })}
                {visibleProjects.length > 0 ? <div className="mx-2 my-1 h-px bg-line/25" /> : null}
                {actions.map((action) => {
                  const createConflict = action.id === "create" && nameTaken;
                  const ready =
                    action.id === "create"
                      ? folderActionEnabled("create", query) && !nameTaken
                      : action.id === "clone"
                        ? folderActionEnabled("clone", query)
                        : true;
                  const selected = looksLikeGitUrl(query)
                    ? action.id === "clone"
                    : focus.kind === "action" && focus.id === action.id;
                  const hint =
                    createConflict && createName
                      ? `${createName} already exists`
                      : folderActionHint(action.id, query, placeName);
                  return (
                    <div key={action.id}>
                      <div
                        role="option"
                        aria-selected={selected}
                        onMouseEnter={() => highlightFromPointer({ kind: "action", id: action.id })}
                        onMouseMove={(ev) => highlightFromPointer({ kind: "action", id: action.id }, ev)}
                        className={`flex w-full items-center gap-1 rounded-lg pr-1.5 transition-colors duration-150 ${
                          selected ? "bg-wash" : ""
                        } ${busy && !selected ? "opacity-40" : ""}`}
                      >
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            const id = folderClickAction(action.id, query);
                            if (id === "clone" || id === "create") {
                              if (folderActionEnabled(id, query) && !(id === "create" && nameTaken)) {
                                void run(id);
                              } else {
                                selectAction(id);
                                if (id === "clone" && query.trim() && !looksLikeGitUrl(query)) {
                                  setError("Paste a git URL to clone.");
                                }
                              }
                              return;
                            }
                            void run(id);
                          }}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left"
                        >
                          <span className={`flex size-7 shrink-0 items-center justify-center rounded-md bg-inset ${createConflict ? "text-err" : "text-accent"}`}>
                            <Symbol name={action.icon} className="size-3.5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-[13px] font-medium ${createConflict ? "text-err" : "text-ink"}`}>
                              {action.label}
                            </span>
                            <span className={`block truncate text-[11px] ${createConflict ? "text-err" : "text-muted"}`}>
                              {busy && selected
                                ? action.id === "clone"
                                  ? "Cloning…"
                                  : action.id === "create"
                                    ? "Creating…"
                                    : "Opening…"
                                : hint}
                            </span>
                          </span>
                          {selected && ready ? <span className="shrink-0 text-[11px] text-muted">↵</span> : null}
                        </button>
                        {action.id === "open" && !busy && (
                          <button
                            type="button"
                            className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-canvas hover:text-ink"
                            onClick={() => void browse()}
                          >
                            Browse
                          </button>
                        )}
                      </div>
                      {action.id === "open" && folders.length > 0 && (
                        <div className="mb-1 ml-9 max-h-[160px] overflow-auto pr-1">
                          {folders.map((row, index) => {
                            const on = focus.kind === "folder" && focus.index === index;
                            return (
                              <button
                                key={row.path}
                                type="button"
                                role="option"
                                aria-selected={on}
                                disabled={busy}
                                onMouseEnter={() => highlightFromPointer({ kind: "folder", index })}
                                onMouseMove={(ev) => highlightFromPointer({ kind: "folder", index }, ev)}
                                onClick={() => applyFolder(row, true)}
                                className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors duration-150 ${
                                  on ? "bg-wash text-ink" : "text-ink/80"
                                }`}
                              >
                                <Symbol name="folder.fill" className="size-3.5 shrink-0 text-accent" />
                                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                                {on ? <span className="shrink-0 text-[11px] text-muted">↵</span> : null}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {error && <p className="m-0 border-t border-line/20 px-3 py-1.5 text-[12px] text-err">{error}</p>}
            </div>
            <div className="shrink-0 border-t border-line/20 px-2 py-1.5">
              <button
                type="button"
                aria-expanded={serversOpen}
                onClick={() => setServersOpen(true)}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[12px] text-ink/80 transition-colors duration-150 hover:bg-wash"
              >
                <Symbol name={server ? "server.rack" : "desktopcomputer"} className="size-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">{server ? server.name : "This Mac"}</span>
                {server ? <ReachDot online={online[server.id] ?? null} /> : null}
                <span className="shrink-0 text-[11px] text-muted">Servers</span>
              </button>
            </div>
            <AnimatePresence>
              {serversOpen ? (
                <ServerPick
                  servers={servers}
                  online={online}
                  place={place}
                  onPick={(id) => {
                    pickPlace(id);
                    setServersOpen(false);
                  }}
                  onClose={() => setServersOpen(false)}
                />
              ) : null}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function ReachDot({ online }: { online: boolean | null }) {
  const label = online == null ? "Checking" : online ? "Up" : "Down";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px]">
      <span className={`size-1.5 rounded-full ${online == null ? "bg-muted" : online ? "bg-ok" : "bg-err"}`} />
      <span className={online ? "text-ok" : online == null ? "text-muted" : "text-err"}>{label}</span>
    </span>
  );
}

function ServerPick({
  servers,
  online,
  place,
  onPick,
  onClose,
}: {
  servers: AgentServer[];
  online: Record<string, boolean | null>;
  place: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const rows = [
    { id: LOCAL, name: "This Mac", detail: "Projects on this computer", reach: true as boolean | null },
    ...servers.map((row) => ({
      id: row.id,
      name: row.name,
      detail: `${row.user}@${row.host}`,
      reach: online[row.id] ?? null,
    })),
  ];
  return (
    <motion.div
      role="dialog"
      aria-label="Servers"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.16, ease: MENU_EASE }}
      className="absolute inset-0 z-10 flex flex-col bg-canvas"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line/20 px-2">
        <button
          type="button"
          aria-label="Back"
          onClick={onClose}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="chevron.left" className="size-3.5" />
        </button>
        <span className="text-[13px] font-medium text-ink">Servers</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {rows.map((row) => {
          const on = row.id === place;
          const down = row.id !== LOCAL && row.reach === false;
          const checking = row.id !== LOCAL && row.reach == null;
          return (
            <button
              key={row.id}
              type="button"
              aria-pressed={on}
              disabled={down || checking}
              title={down ? "This server is down" : checking ? "Checking this server" : undefined}
              onClick={() => onPick(row.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                down || checking ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-wash"
              }`}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-inset text-accent">
                <Symbol name={row.id === LOCAL ? "desktopcomputer" : "server.rack"} className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{row.name}</span>
                <span className="block truncate text-[11px] text-muted">{row.detail}</span>
              </span>
              {row.id === LOCAL ? null : <ReachDot online={row.reach} />}
              <Symbol name="checkmark" className={`size-3 shrink-0 text-accent ${on ? "opacity-100" : "opacity-0"}`} />
            </button>
          );
        })}
        {servers.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted">No paired servers yet.</p>
        ) : null}
      </div>
    </motion.div>
  );
}
