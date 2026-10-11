import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  isAppProject,
  isProjectCollapsed,
  isSameProject,
  projectHasArchived,
  type ProjectChatGroup,
} from "../lib/all-projects";
import { projectKey } from "../lib/core";
import { projectGitKey, type ProjectGit } from "../lib/project-git";
import * as api from "../lib/tauri";
import { AnchoredMenu } from "./ContextMenu";
import { Symbol } from "./Symbol";

export function AllProjectsList({
  groups,
  activeWorkspace,
  projectsRoot,
  legacyProjectsRoot = "",
  collapsed,
  onToggleCollapsed,
  onOpenProject,
  onNewChat,
  onOpenSettings,
  onDeleteProject,
  onReorderProject,
  renderList,
  archiveOpen,
  onToggleArchive,
  gitByProject,
}: {
  groups: ProjectChatGroup[];
  activeWorkspace: string;
  projectsRoot: string;
  legacyProjectsRoot?: string;
  collapsed: string[];
  onToggleCollapsed: (path: string) => void;
  onOpenProject: (path: string) => void;
  onNewChat: (path: string) => void;
  onOpenSettings: (path: string, name: string) => void;
  onDeleteProject: (path: string) => void;
  onReorderProject?: (fromPath: string, toPath: string) => void;
  renderList: (group: ProjectChatGroup, options: { showArchived: boolean }) => ReactNode;
  archiveOpen: Record<string, boolean>;
  onToggleArchive: (path: string) => void;
  gitByProject?: Record<string, ProjectGit>;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; group: ProjectChatGroup } | null>(null);
  const [gitMenu, setGitMenu] = useState<{ x: number; y: number; path: string; remote: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectChatGroup | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    function onDoc() {
      setMenu(null);
      setGitMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setMenu(null);
        setGitMenu(null);
        setPendingDelete(null);
      }
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (groups.length === 0) {
    return <p className="px-2 py-1 text-[12px] text-muted">No projects yet</p>;
  }

  function onDragEnd(ev: DragEndEvent) {
    const { active, over } = ev;
    if (!over || active.id === over.id || !onReorderProject) return;
    const from = groups.find((group) => projectKey(group.path) === String(active.id));
    const to = groups.find((group) => projectKey(group.path) === String(over.id));
    if (!from || !to) return;
    onReorderProject(from.path, to.path);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={onDragEnd}
    >
    <SortableContext items={groups.map((group) => projectKey(group.path))} strategy={verticalListSortingStrategy}>
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const current = isSameProject(group.path, activeWorkspace);
        const closed = isProjectCollapsed(collapsed, group.path);
        const showArchived = Boolean(archiveOpen[projectKey(group.path)]);
        const hasArchived = projectHasArchived(group.conversations);
        const git = gitByProject?.[projectGitKey(group.path)] ?? null;
        const visibleEmpty = showArchived
          ? !hasArchived
          : !git && !group.conversations.some((row) => !row.archived) && group.journeys.length === 0;
        return (
          <ProjectSection
            key={projectKey(group.path)}
            id={projectKey(group.path)}
            header={(drag) => (
            <div className="contents">
            <div
              className="group flex cursor-grab items-center rounded-[6px] select-none hover:bg-wash active:cursor-grabbing"
              {...drag}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                setMenu({ x: ev.clientX, y: ev.clientY, group });
              }}
            >
              <button
                type="button"
                aria-label={closed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                onClick={() => onToggleCollapsed(group.path)}
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:text-ink"
              >
                <Symbol name={closed ? "chevron.right" : "chevron.down"} className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => onOpenProject(group.path)}
                title={group.path}
                className={`flex min-w-0 flex-1 items-center gap-1.5 py-[6px] pr-1 text-left text-[12px] font-medium ${
                  current ? "text-ink" : "text-muted"
                }`}
              >
                <Symbol
                  name="folder.fill"
                  className={`size-3.5 shrink-0 ${current ? "text-accent" : "text-muted"}`}
                />
                <span className="min-w-0 truncate">{group.name}</span>
                <ProjectMarks remote={group.remote} server={group.server} />
              </button>
              {hasArchived ? (
                <button
                  type="button"
                  aria-label={showArchived ? `Hide archived chats in ${group.name}` : `Show archived chats in ${group.name}`}
                  aria-pressed={showArchived}
                  title={showArchived ? "Hide archive" : "Archived chats"}
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (closed) onToggleCollapsed(group.path);
                    onToggleArchive(group.path);
                  }}
                  className={`mr-1 flex size-6 shrink-0 items-center justify-center rounded ${
                    showArchived
                      ? "bg-accent/15 text-accent"
                      : "text-muted hover:bg-wash-strong hover:text-ink"
                  }`}
                >
                  <Symbol name="archivebox" className="size-3.5" />
                </button>
              ) : null}
            </div>
            </div>
            )}
          >
            {closed || !showArchived ? null : (
              <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-[6px] bg-accent/10 px-2 py-1 text-accent">
                <Symbol name="archivebox" className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-[0.04em] uppercase">
                  Archived
                </span>
                <button
                  type="button"
                  onClick={() => onToggleArchive(group.path)}
                  className="shrink-0 rounded px-1 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/15"
                >
                  Back
                </button>
              </div>
            )}
            {closed || showArchived || !git ? null : (
              <ProjectGitRow
                git={git}
                onMenu={(x, y) => setGitMenu({ x, y, path: group.path, remote: Boolean(group.remote || group.server) })}
              />
            )}
            {closed ? null : visibleEmpty ? (
              <p className="px-7 py-0.5 text-[12px] text-muted">
                {showArchived ? "No archived chats" : "No chats yet"}
              </p>
            ) : (
              renderList(group, { showArchived })
            )}
          </ProjectSection>
        );
      })}
      {menu ? (
        <ProjectContextMenu
          x={menu.x}
          y={menu.y}
          name={menu.group.name}
          appManaged={isAppProject(menu.group.path, projectsRoot) || isAppProject(menu.group.path, legacyProjectsRoot)}
          onNewChat={() => {
            onNewChat(menu.group.path);
            setMenu(null);
          }}
          onSettings={() => {
            onOpenSettings(menu.group.path, menu.group.name);
            setMenu(null);
          }}
          onDelete={() => {
            setPendingDelete(menu.group);
            setMenu(null);
          }}
        />
      ) : null}
      {gitMenu ? (
        <ProjectGitMenu
          x={gitMenu.x}
          y={gitMenu.y}
          remote={gitMenu.remote}
          onOpenFinder={() => {
            const path = gitMenu.path;
            setGitMenu(null);
            void api.revealFolder(path).catch(() => undefined);
          }}
        />
      ) : null}
      {pendingDelete ? (
        <DeleteProjectDialog
          name={pendingDelete.name}
          appManaged={isAppProject(pendingDelete.path, projectsRoot) || isAppProject(pendingDelete.path, legacyProjectsRoot)}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            onDeleteProject(pendingDelete.path);
            setPendingDelete(null);
          }}
        />
      ) : null}
    </div>
    </SortableContext>
    </DndContext>
  );
}

function ProjectSection({
  id,
  header,
  children,
}: {
  id: string;
  header: (drag: HTMLAttributes<HTMLDivElement>) => ReactNode;
  children?: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "relative z-10 opacity-70" : undefined}
    >
      {header({ ...attributes, ...listeners })}
      {children}
    </section>
  );
}

function ProjectGitRow({
  git,
  onMenu,
}: {
  git: ProjectGit;
  onMenu: (x: number, y: number) => void;
}) {
  const tracking = [
    git.ahead ? `↑${git.ahead}` : "",
    git.behind ? `↓${git.behind}` : "",
    git.dirty ? `${git.dirty}` : "",
  ].filter(Boolean);
  return (
    <div className="group/git flex items-center gap-1.5 rounded-[6px] py-[3px] pr-1 pl-1 text-[12px] text-muted select-none hover:bg-wash">
      <Symbol name="arrow.triangle.branch" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-ink/80" title={git.branch}>
        {git.branch}
      </span>
      {tracking.length ? (
        <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">{tracking.join(" ")}</span>
      ) : null}
      <button
        type="button"
        aria-label="Project actions"
        aria-haspopup="menu"
        title="Project actions"
        onClick={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const box = ev.currentTarget.getBoundingClientRect();
          onMenu(box.right, box.bottom + 4);
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-wash-strong hover:text-ink group-hover/git:opacity-100 focus-visible:opacity-100"
      >
        <Symbol name="ellipsis" className="size-3.5" />
      </button>
    </div>
  );
}

function ProjectGitMenu({
  x,
  y,
  remote,
  onOpenFinder,
}: {
  x: number;
  y: number;
  remote: boolean;
  onOpenFinder: () => void;
}) {
  return (
    <AnchoredMenu x={x} y={y} label="Project">
      <button
        type="button"
        role="menuitem"
        disabled={remote}
        onClick={onOpenFinder}
        className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset disabled:cursor-default disabled:opacity-40"
      >
        Open in Finder
      </button>
    </AnchoredMenu>
  );
}

/** Status icons that sit on the project name. Add the next one as another child. */
export function ProjectMarks({
  remote,
  server,
}: {
  remote?: boolean;
  server?: {
    machineName: string;
    host: string;
    user: string;
    port: number;
    remotePath: string;
    online: boolean;
  };
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  if (!remote && !server) return null;
  const offline = server?.online === false;
  const address = server
    ? `${server.user}@${server.host}${server.port === 22 ? "" : `:${server.port}`}`
    : "";
  return (
    <span
      ref={anchor}
      className="ml-auto flex shrink-0 items-center pl-1.5"
      onMouseEnter={() => {
        const rect = anchor.current?.getBoundingClientRect();
        if (!rect) return;
        setBox({ top: rect.bottom + 6, left: Math.max(8, rect.right - 220) });
      }}
      onMouseLeave={() => setBox(null)}
    >
      <span className={offline ? "text-err" : "text-[#3b82f6]"} aria-label={offline ? "Server offline" : "On a server"}>
        <Symbol name={offline ? "exclamationmark.triangle.fill" : "cloud.fill"} className="size-4" />
      </span>
      {box
        ? createPortal(
            <span
              role="tooltip"
              className="pointer-events-none fixed z-50 w-[220px] overflow-hidden rounded-xl border border-line bg-canvas text-left font-normal shadow-card"
              style={{ top: box.top, left: box.left }}
            >
              <span className={`flex items-center gap-2 px-3 py-2 ${offline ? "bg-err/10" : "bg-[#3b82f6]/10"}`}>
                <Symbol
                  name={offline ? "exclamationmark.triangle.fill" : "cloud.fill"}
                  className={`size-4 ${offline ? "text-err" : "text-[#3b82f6]"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">{server?.machineName ?? "Server"}</span>
                  <span className={`block text-[11px] font-medium ${offline ? "text-err" : "text-[#3b82f6]"}`}>
                    {offline ? "Offline" : "Reachable"}
                  </span>
                </span>
              </span>
              {server ? (
                <span className="grid gap-1.5 px-3 py-2.5">
                  <span className="block">
                    <span className="block text-[10px] font-semibold tracking-wide text-muted uppercase">Login</span>
                    <span className="block truncate font-mono text-[11px] text-ink">{address}</span>
                  </span>
                  <span className="block">
                    <span className="block text-[10px] font-semibold tracking-wide text-muted uppercase">Folder</span>
                    <span className="block truncate font-mono text-[11px] text-ink">{server.remotePath}</span>
                  </span>
                </span>
              ) : (
                <span className="block px-3 py-2 text-[12px] text-muted">On a server</span>
              )}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

export function ProjectContextMenu({
  x,
  y,
  name,
  appManaged,
  onNewChat,
  onSettings,
  onDelete,
}: {
  x: number;
  y: number;
  name: string;
  appManaged: boolean;
  onNewChat?: () => void;
  onSettings?: () => void;
  onDelete: () => void;
}) {
  return (
    <AnchoredMenu x={x} y={y} label={name}>
      {onNewChat ? (
        <button
          type="button"
          role="menuitem"
          onClick={onNewChat}
          className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
        >
          New chat
        </button>
      ) : null}
      {onSettings ? (
        <button
          type="button"
          role="menuitem"
          onClick={onSettings}
          className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
        >
          Settings
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-err hover:bg-inset"
      >
        {appManaged ? "Delete project" : "Remove from list"}
      </button>
    </AnchoredMenu>
  );
}

export function DeleteProjectDialog({
  name,
  appManaged,
  onCancel,
  onConfirm,
}: {
  name: string;
  appManaged: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20" onMouseDown={onCancel}>
      <div
        className="w-[280px] rounded-lg border border-line bg-canvas p-3 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="text-[13px] font-medium text-ink">
          {appManaged ? `Delete ${name}?` : `Remove ${name}?`}
        </div>
        <p className="mt-1 text-[12px] text-muted">
          {appManaged
            ? "This removes the project folder and its chats."
            : "The folder on disk is left alone. It just leaves the sidebar."}
        </p>
        <div className="mt-3 flex flex-col gap-1">
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-[6px] px-2 py-1.5 text-left text-[13px] text-err hover:bg-wash"
          >
            {appManaged ? "Delete project" : "Remove from list"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[6px] px-2 py-1.5 text-left text-[13px] text-muted hover:bg-wash"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}


