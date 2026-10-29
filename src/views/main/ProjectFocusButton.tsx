import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProjectMark } from "../../components/ProjectMark";
import { Symbol } from "../../components/Symbol";
import { isProjectCollapsed, isSameProject, sidebarFocusPath } from "../../lib/all-projects";
import { projectKey } from "../../lib/core";
import { fileRefreshRevision, subscribeFileRefresh } from "../../lib/file-structure";
import { subscribeWorktreeLists, withoutLinkedWorktrees, worktreeNameRevision } from "../../lib/worktree.ts";
import { useSidebar } from "./context";

const MENU_WIDTH = 248;

type FocusProject = { path: string; name: string; remote?: boolean };

/**
 * The sidebar's project focus. Hover the icon to pick one project, or all of them.
 * Click pins the menu open so it can be used without a pointer staying on it.
 */
export function ProjectFocusButton({
  focusPath,
  onFocus,
  hidden = false,
}: {
  focusPath: string;
  onFocus: (path: string) => void;
  /** The header is still mounted while the sidebar is collapsed. Close the menu then. */
  hidden?: boolean;
}) {
  const { allProjectGroups, sidebarReady, collapsedProjects, toggleProjectCollapsed } = useSidebar();
  const worktreeTick = useSyncExternalStore(subscribeWorktreeLists, worktreeNameRevision, worktreeNameRevision);
  const logoRefresh = useSyncExternalStore(subscribeFileRefresh, fileRefreshRevision, fileRefreshRevision);
  const groups = sidebarProjects(allProjectGroups, worktreeTick);
  const active = sidebarFocusPath(focusPath, groups);
  const current = groups.find((group) => isSameProject(group.path, active));
  const groupKey = groups.map((group) => projectKey(group.path)).join("\n");
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const closeTimer = useRef(0);

  useEffect(() => {
    if (!sidebarReady || !focusPath) return;
    const keys = groupKey ? groupKey.split("\n") : [];
    if (!keys.includes(projectKey(focusPath))) onFocus("");
  }, [sidebarReady, focusPath, groupKey, onFocus]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!hidden) return;
    pinned.current = false;
    window.clearTimeout(closeTimer.current);
    setOpen(false);
  }, [hidden]);

  function hold() {
    window.clearTimeout(closeTimer.current);
  }

  function armClose() {
    if (pinned.current) return;
    hold();
    closeTimer.current = window.setTimeout(() => {
      if (!pinned.current) setOpen(false);
    }, 140);
  }

  function close() {
    pinned.current = false;
    hold();
    setOpen(false);
  }

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      let left = rect.right - MENU_WIDTH;
      if (left < 8) left = 8;
      if (left + MENU_WIDTH > window.innerWidth - 8) left = Math.max(8, window.innerWidth - MENU_WIDTH - 8);
      setAnchor({
        top: rect.bottom - 2,
        left,
        maxHeight: Math.max(140, Math.min(420, window.innerHeight - rect.bottom - 16)),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      const target = ev.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(path: string) {
    onFocus(path);
    const collapsed = Array.isArray(collapsedProjects) ? collapsedProjects : [];
    if (path && isProjectCollapsed(collapsed, path)) toggleProjectCollapsed(path);
    close();
  }

  const label = current?.name || "All projects";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={current ? `Projects, focused on ${current.name}` : "Projects, showing all"}
        title={label}
        onMouseEnter={() => {
          hold();
          setOpen(true);
        }}
        onMouseLeave={armClose}
        onClick={() => {
          hold();
          if (pinned.current) {
            close();
            return;
          }
          pinned.current = true;
          setOpen(true);
        }}
        className={`flex size-7 items-center justify-center rounded-[6px] text-ink hover:bg-wash ${
          open ? "bg-wash-strong" : current ? "bg-wash" : ""
        }`}
      >
        {current ? (
          <ProjectMark path={current.path} remote={Boolean(current.remote)} refresh={logoRefresh} active className="size-4" />
        ) : (
          <Symbol name="rectangle.stack" className="size-3.5" />
        )}
      </button>
      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-50"
              style={{ top: anchor.top, left: anchor.left, width: MENU_WIDTH, paddingTop: 6 }}
              onMouseEnter={hold}
              onMouseLeave={armClose}
            >
              <div
                role="menu"
                aria-label="Projects"
                className="focus-menu overflow-auto rounded-lg border border-line/25 bg-canvas py-1 shadow-card"
                style={{ maxHeight: anchor.maxHeight }}
              >
                <div className="sticky top-0 z-10 bg-canvas px-1 pb-1">
                  <FocusRow
                    label="All projects"
                    selected={!active}
                    onPick={() => pick("")}
                    mark={<Symbol name="rectangle.stack" className="size-3.5 shrink-0 text-muted" />}
                  />
                  <div className="mx-1.5 mt-1 h-px bg-line/25" />
                </div>
                <div className="px-1">
                  {groups.length ? (
                    groups.map((group) => (
                      <FocusRow
                        key={projectKey(group.path)}
                        label={group.name}
                        title={group.path}
                        selected={isSameProject(group.path, active)}
                        onPick={() => pick(group.path)}
                        mark={
                          <ProjectMark
                            path={group.path}
                            remote={Boolean(group.remote)}
                            refresh={logoRefresh}
                            active={isSameProject(group.path, active)}
                            className="size-3.5"
                          />
                        }
                      />
                    ))
                  ) : (
                    <p className="px-2.5 py-2 text-[12px] text-muted">No projects yet</p>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function FocusRow({
  label,
  title,
  selected,
  onPick,
  mark,
}: {
  label: string;
  title?: string;
  selected: boolean;
  onPick: () => void;
  mark: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      title={title || label}
      onClick={onPick}
      className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-wash ${
        selected ? "font-medium text-ink" : "text-ink/80"
      }`}
    >
      {mark}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Symbol name="checkmark" className={`size-3 shrink-0 text-accent ${selected ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}

function isFocusProject(group: unknown): group is FocusProject {
  if (!group || typeof group !== "object") return false;
  const row = group as { path?: unknown; name?: unknown };
  return typeof row.path === "string" && typeof row.name === "string";
}

function sidebarProjects(groups: unknown, tick: number): FocusProject[] {
  void tick;
  if (!Array.isArray(groups)) return [];
  return withoutLinkedWorktrees(groups.filter(isFocusProject));
}
