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
import { CSS, type Transform } from "@dnd-kit/utilities";
import {
  isAppProject,
  isProjectCollapsed,
  isSameProject,
  projectHasArchived,
  type ProjectChatGroup,
} from "../lib/all-projects";
import { projectKey } from "../lib/core";
import { projectGitKey, type ProjectGit } from "../lib/project-git";
import type { WorktreeChild } from "../lib/worktree.ts";
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
  worktreesFor,
  onRemoveWorktree,
  renderWorktree,
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
  worktreesFor?: (path: string) => WorktreeChild[];
  onRemoveWorktree?: (path: string) => void;
  renderWorktree?: (child: WorktreeChild) => ReactNode;
  renderList: (group: ProjectChatGroup, options: { showArchived: boolean }) => ReactNode;
  archiveOpen: Record<string, boolean>;
  onToggleArchive: (path: string) => void;
  gitByProject?: Record<string, ProjectGit>;
}) {
  const [closedWorktrees, setClosedWorktrees] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; group: ProjectChatGroup } | null>(null);
  const [gitMenu, setGitMenu] = useState<{ x: number; y: number; path: string; remote: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectChatGroup | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      const target = ev.target;
      if (target instanceof Element && target.closest("[role='menu']")) return;
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
    document.addEventListener("mousedown", onDoc, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
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
        const worktrees = worktreesFor?.(group.path) ?? [];
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
            {closed || showArchived
              ? null
              : worktrees.map((child) => {
                  const childKey = projectKey(child.path);
                  const childClosed = Boolean(closedWorktrees[childKey]);
                  return (
                    <div key={childKey}>
                      <WorktreeRow
                        child={child}
                        closed={childClosed}
                        current={isSameProject(child.path, activeWorkspace)}
                        onToggle={() =>
                          setClosedWorktrees((prev) => ({ ...prev, [childKey]: !prev[childKey] }))
                        }
                        onOpen={() => onOpenProject(child.path)}
                        onRemove={onRemoveWorktree ? () => onRemoveWorktree(child.path) : undefined}
                      />
                      {childClosed || !renderWorktree ? null : renderWorktree(child)}
                    </div>
                  );
                })}
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

/** Move the held row without stretching it to the height of the row it passes over. */
function rowDragTransform(transform: Transform | null): string | undefined {
  if (!transform) return undefined;
  return CSS.Translate.toString({ ...transform, scaleX: 1, scaleY: 1 });
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
      style={{ transform: rowDragTransform(transform), transition }}
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

function WorktreeRow({
  child,
  closed,
  current,
  onToggle,
  onOpen,
  onRemove,
}: {
  child: WorktreeChild;
  closed: boolean;
  current: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="group/wt flex items-center gap-1 rounded-[6px] py-[3px] pr-1 pl-1 text-[12px] select-none hover:bg-wash">
      <button
        type="button"
        aria-label={closed ? `Expand ${child.branch}` : `Collapse ${child.branch}`}
        onClick={onToggle}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:text-ink"
      >
        <Symbol name={closed ? "chevron.right" : "chevron.down"} className="size-3" />
      </button>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <Symbol name="arrow.triangle.branch" className={`size-3.5 shrink-0 ${current ? "text-accent" : "text-muted"}`} />
        <span className={`min-w-0 flex-1 truncate ${current ? "font-medium text-ink" : "text-ink/80"}`} title={child.branch}>
          {child.branch}
        </span>
        <span className="shrink-0 truncate text-[10px] text-muted">{child.name}</span>
      </button>
      {onRemove && !current ? (
        <button
          type="button"
          aria-label={`Remove worktree ${child.branch}`}
          title="Remove worktree"
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onRemove();
          }}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-wash-strong hover:text-err group-hover/wt:opacity-100 focus-visible:opacity-100"
        >
          <Symbol name="xmark" className="size-3" />
        </button>
      ) : null}
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
    providers?: string[];
  };
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  if (!remote && !server) return null;
  const offline = server?.online === false;
  return (
    <span
      ref={anchor}
      className="ml-auto flex shrink-0 items-center pl-1.5"
      onMouseEnter={() => {
        const rect = anchor.current?.getBoundingClientRect();
        if (!rect) return;
        // Prefer the card's right edge near the icon, but never past the window.
        // The card sizes to its text, so the right edge is what stays put.
        const margin = 8;
        const right = Math.min(window.innerWidth - margin, Math.max(rect.right + 8, margin));
        setBox({ top: rect.bottom + 6, right });
      }}
      onMouseLeave={() => setBox(null)}
    >
      <span className={offline ? "text-err" : "text-[#3b82f6]"} aria-label={offline ? "Cloud project offline" : "Cloud project"}>
        <Symbol name="cloud.fill" className="size-3.5" />
      </span>
      {box
        ? createPortal(
            <span
              role="tooltip"
              className="pointer-events-none fixed z-50 w-max max-w-[min(320px,calc(100vw-16px))] rounded-lg border border-line/25 bg-canvas text-left font-normal shadow-card"
              style={{ top: box.top, right: window.innerWidth - box.right }}
            >
              <span className="flex items-center gap-2 border-b border-line/20 px-3 py-2.5">
                <Symbol name="cloud.fill" className={`size-3.5 shrink-0 ${offline ? "text-err" : "text-[#3b82f6]"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">Cloud project</span>
                  <span className={`block truncate text-[11px] ${offline ? "text-err" : "text-muted"}`}>
                    {offline ? "This machine is not answering" : "Files and chats stay on this machine"}
                  </span>
                </span>
              </span>
              {server ? (
                <span className="grid gap-2 px-3 py-2.5">
                  <CloudFact label="Runs on" value={server.host} />
                  <CloudFact label="Project folder" value={server.remotePath} />
                  <CloudFact label="Models" value={modelKeysLabel(server.providers)} />
                </span>
              ) : (
                <span className="block px-3 py-2.5 text-[12px] text-muted">Checking this machine…</span>
              )}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

function CloudFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-muted">{label}</span>
      <span className="min-w-0 text-right text-[12px] leading-snug break-all text-ink">{value}</span>
    </span>
  );
}

const CLOUD_MODELS: { id: string; label: string }[] = [
  { id: "xai", label: "Grok" },
  { id: "anthropic", label: "Claude" },
  { id: "minimax", label: "MiniMax" },
];

function modelKeysLabel(providers: string[] | undefined): string {
  if (!providers) return "Checking…";
  const names = CLOUD_MODELS.filter((row) => providers.includes(row.id)).map((row) => row.label);
  return names.length ? names.join(", ") : "No keys copied";
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


