import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { filterProjectRows, folderName, projectKey, type ProjectRow } from "../../lib/core";
import { Symbol } from "../Symbol";
import { MODEL_MENU_EASE } from "./menuEase";

export function ProjectSelect({
  workspace,
  projects,
  onOpen,
  onNew,
}: {
  workspace: string;
  projects: ProjectRow[];
  onOpen: (path: string) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [menuAbove, setMenuAbove] = useState(true);
  const needle = query.trim();
  const shown = filterProjectRows(projects, query);
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
            return true;
          });
        }}
        className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
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
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                placeholder="Search projects"
                aria-label="Search projects"
                className="h-9 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {shown.length ? (
                shown.map((row) => {
                  const selected = projectKey(row.path) === projectKey(workspace);
                  return (
                    <button
                      key={row.path}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      title={row.path}
                      onClick={() => {
                        setOpen(false);
                        if (!selected) onOpen(row.path);
                      }}
                      className={`flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left text-[12px] transition-colors duration-150 hover:bg-wash ${
                        selected ? "font-medium text-ink" : "text-ink/80"
                      }`}
                    >
                      <Symbol name="folder.fill" className={`size-3.5 shrink-0 ${selected ? "text-accent" : "text-muted"}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{row.name}</span>
                      </span>
                      {row.remote ? <Symbol name="cloud.fill" className="size-3 shrink-0 text-[#3b82f6]" /> : null}
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
                onClick={() => {
                  setOpen(false);
                  onNew();
                }}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink/80 transition-colors duration-150 hover:bg-wash"
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
