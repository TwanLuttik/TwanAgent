import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { projectMenuRows, type ProjectGroupRow } from "../../lib/all-projects";
import { folderName, projectKey, type ProjectRow } from "../../lib/core";
import { Symbol } from "../Symbol";
import { MODEL_MENU_EASE } from "./menuEase";

export function ProjectSelect({
  workspace,
  projects,
  groups = [],
  onOpen,
  onNew,
}: {
  workspace: string;
  projects: ProjectRow[];
  groups?: ProjectGroupRow[];
  onOpen: (path: string) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [menuAbove, setMenuAbove] = useState(true);
  const needle = query.trim();
  const shown = projectMenuRows(projects, groups, query);
  const count = shown.length + 1;
  const cursorIndex = count === 0 ? 0 : Math.max(0, Math.min(cursor, count - 1));
  const current = projects.find((row) => projectKey(row.path) === projectKey(workspace));
  const label = current?.name || (workspace ? folderName(workspace) : "Project");

  useLayoutEffect(() => {
    if (!open) return;
    const frame = button.current?.getBoundingClientRect();
    if (!frame) return;
    setMenuAbove(frame.top - 320 - 6 >= 8);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    const focus = window.setTimeout(() => search.current?.focus(), 0);
    return () => {
      window.clearTimeout(focus);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>("[data-cursor='true']")?.scrollIntoView({ block: "nearest" });
  }, [open, cursorIndex]);

  function placeCursor(next: number) {
    const size = shown.length + 1;
    setCursor(((next % size) + size) % size);
  }

  function pick(index: number) {
    setOpen(false);
    if (index >= shown.length) {
      onNew();
      return;
    }
    const path = shown[index]?.row.path;
    if (path && projectKey(path) !== projectKey(workspace)) onOpen(path);
  }

  return (
    <div className="relative max-w-[38%]" ref={ref}>
      <button
        ref={button}
        type="button"
        title={workspace || "Project"}
        aria-expanded={open}
        aria-label="Project"
        onClick={() => {
          setOpen((next) => {
            if (next) return false;
            setQuery("");
            const rows = projectMenuRows(projects, groups, "");
            const index = rows.findIndex(({ row }) => projectKey(row.path) === projectKey(workspace));
            setCursor(index >= 0 ? index : 0);
            return true;
          });
        }}
        className={`flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        <Symbol name="folder.fill" className="size-3 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <Symbol name="chevron.down" className="size-2.5 shrink-0 opacity-70" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            aria-label="Projects"
            initial={{ opacity: 0, y: menuAbove ? 6 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: menuAbove ? 6 : -6 }}
            transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
            className={`absolute right-0 z-30 flex h-80 w-[320px] flex-col overflow-hidden rounded-lg border border-line/25 bg-canvas shadow-card ${
              menuAbove ? "bottom-full mb-1 origin-bottom" : "top-full mt-1 origin-top"
            }`}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line/20 px-2.5">
              <Symbol name="magnifyingglass" className="size-3.5 shrink-0 text-muted" />
              <input
                ref={search}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursor(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    placeCursor(cursorIndex + 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    placeCursor(cursorIndex - 1);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    pick(cursorIndex);
                  } else if (event.key === "Escape" && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                    setCursor(0);
                  }
                }}
                placeholder="Search projects"
                aria-label="Search projects"
                className="h-9 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
              />
            </div>
            <div ref={list} className="min-h-0 flex-1 overflow-auto px-1 py-1">
              {shown.length ? (
                shown.map(({ row, depth }, index) => {
                  const selected = projectKey(row.path) === projectKey(workspace);
                  const pointed = index === cursorIndex;
                  const child = depth > 0;
                  const where = row.server?.machineName || row.server?.host;
                  return (
                    <button
                      key={row.path}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      data-cursor={pointed ? "true" : undefined}
                      title={where ? `${where} · ${row.path}` : row.path}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => pick(index)}
                      className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md text-left text-[12px] transition-colors duration-150 ${
                        child ? "pr-2 pl-7" : "px-2"
                      } ${
                        selected ? "bg-accent/10 font-medium text-ink" : pointed ? "bg-wash text-ink" : child ? "text-ink/75 hover:bg-wash" : "text-ink/80 hover:bg-wash"
                      }`}
                    >
                      <Symbol
                        name="folder.fill"
                        className={`shrink-0 ${child ? "size-3" : "size-3.5"} ${selected ? "text-accent" : "text-muted"}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{row.name}</span>
                      </span>
                      {row.remote ? (
                        <Symbol name="server.rack" className="size-3 shrink-0 text-muted" />
                      ) : null}
                      <Symbol
                        name="checkmark"
                        className={`size-3 shrink-0 text-accent transition-opacity duration-150 ${selected ? "opacity-100" : "opacity-0"}`}
                      />
                    </button>
                  );
                })
              ) : (
                <p className="px-2.5 py-2 text-[12px] text-muted">{needle ? "No matching projects" : "No projects yet"}</p>
              )}
            </div>
            <div className="shrink-0 border-t border-line/20 p-1">
              <button
                type="button"
                role="menuitem"
                data-cursor={cursorIndex === shown.length ? "true" : undefined}
                onMouseEnter={() => setCursor(shown.length)}
                onClick={() => pick(shown.length)}
                className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors duration-150 ${
                  cursorIndex === shown.length ? "bg-wash text-ink" : "text-ink/80 hover:bg-wash"
                }`}
              >
                <Symbol name="plus" className="size-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">New project</span>
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
