import { useEffect, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  isAppProject,
  isProjectCollapsed,
  isSameProject,
  matchesSidebarQuery,
  projectHasArchived,
  toggleProjectSelection,
  type ProjectChatGroup,
  type ProjectGroupRow,
} from "../lib/all-projects";
import { projectKey } from "../lib/core";
import { projectGitKey, type ProjectGit } from "../lib/project-git";
import type { WorktreeChild } from "../lib/worktree.ts";
import * as api from "../lib/tauri";
import { AnchoredMenu } from "./ContextMenu";
import { GroupProjectsDialog, RemoveGroupDialog } from "./GroupProjectsDialog";
import { ProjectMark } from "./ProjectMark";
import { Symbol } from "./Symbol";
import {
  DeleteWorktreeDialog,
  ProjectGitMenu,
  ProjectGitRow,
  ProjectMarks,
  ProjectSection,
  WorktreeContextMenu,
  WorktreeRow,
} from "./projects/ProjectRows";
import { DeleteProjectDialog, ProjectContextMenu, type ProjectDeleteMode } from "./projects/ProjectDialogs";

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
  chatQuery = "",
  logoRefresh = 0,
  membersFor,
  projectGroups = [],
  onCreateGroup,
  onAddToGroup,
  onRemoveMember,
  onDeleteGroup,
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
  onDeleteProject: (path: string, mode: ProjectDeleteMode) => void;
  onReorderProject?: (fromPath: string, toPath: string) => void;
  worktreesFor?: (path: string) => WorktreeChild[];
  onRemoveWorktree?: (path: string) => void;
  renderWorktree?: (child: WorktreeChild) => ReactNode;
  renderList: (group: ProjectChatGroup, options: { showArchived: boolean }) => ReactNode;
  archiveOpen: Record<string, boolean>;
  onToggleArchive: (path: string) => void;
  gitByProject?: Record<string, ProjectGit>;
  /** When set, a project only lists the chats whose title matches. */
  chatQuery?: string;
  /** Bumps when a project file changes, so a new favicon replaces the folder. */
  logoRefresh?: number;
  membersFor?: (path: string) => ProjectChatGroup[];
  projectGroups?: ProjectGroupRow[];
  onCreateGroup?: (name: string, paths: string[]) => void;
  onAddToGroup?: (groupPath: string, path: string) => void;
  onRemoveMember?: (groupPath: string, path: string) => void;
  onDeleteGroup?: (path: string) => void;
}) {
  const [closedWorktrees, setClosedWorktrees] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; group: ProjectChatGroup } | null>(null);
  const [gitMenu, setGitMenu] = useState<{ x: number; y: number; path: string; remote: boolean } | null>(null);
  const [worktreeMenu, setWorktreeMenu] = useState<{ x: number; y: number; child: WorktreeChild } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectChatGroup | null>(null);
  const [pendingWorktree, setPendingWorktree] = useState<WorktreeChild | null>(null);
  const [pickedProjects, setPickedProjects] = useState<string[]>([]);
  const [groupDraft, setGroupDraft] = useState<string[] | null>(null);
  const [pendingGroup, setPendingGroup] = useState<ProjectChatGroup | null>(null);
  const [memberMenu, setMemberMenu] = useState<{ x: number; y: number; groupPath: string; member: ProjectChatGroup } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      const target = ev.target;
      if (target instanceof Element && target.closest("[role='menu']")) return;
      setMenu(null);
      setGitMenu(null);
      setWorktreeMenu(null);
      setMemberMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setMenu(null);
        setGitMenu(null);
        setWorktreeMenu(null);
        setMemberMenu(null);
        setPendingDelete(null);
        setPendingWorktree(null);
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
      {pickedProjects.length >= 2 && onCreateGroup ? (
        <button
          type="button"
          onClick={() => setGroupDraft(pickedProjects)}
          className="mx-1 rounded-[6px] bg-accent/15 px-2 py-1 text-left text-[12px] font-medium text-accent hover:bg-accent/25"
        >
          Group {pickedProjects.length} projects
        </button>
      ) : null}
      {groups.map((group) => {
        const current = isSameProject(group.path, activeWorkspace);
        const closed = isProjectCollapsed(collapsed, group.path);
        const showArchived = Boolean(archiveOpen[projectKey(group.path)]);
        const hasArchived = projectHasArchived(group.conversations);
        const git = gitByProject?.[projectGitKey(group.path)] ?? null;
        const worktrees = worktreesFor?.(group.path) ?? [];
        const members = membersFor?.(group.path) ?? [];
        const grouped = projectGroups.some((row) => isSameProject(row.path, group.path));
        const picked = pickedProjects.some((path) => isSameProject(path, group.path));
        const selectable = !group.remote && !group.server && !grouped;
        const listed = chatQuery.trim()
          ? {
              ...group,
              conversations: group.conversations.filter(
                (row) => !row.archived && matchesSidebarQuery(chatQuery, row.title),
              ),
              journeys: [],
            }
          : group;
        const visibleEmpty = chatQuery.trim()
          ? listed.conversations.length === 0
          : showArchived
            ? !hasArchived
            : !git && !group.conversations.some((row) => !row.archived);
        return (
          <ProjectSection
            key={projectKey(group.path)}
            id={projectKey(group.path)}
            header={(drag) => (
            <div className="contents">
            <div
              className={`group flex cursor-grab items-center rounded-[6px] select-none hover:bg-wash active:cursor-grabbing ${
                picked ? "bg-accent/10" : ""
              }`}
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
                onClick={(ev) => {
                  if ((ev.metaKey || ev.ctrlKey) && selectable) {
                    ev.preventDefault();
                    setPickedProjects((current) => toggleProjectSelection(current, group.path, true));
                    return;
                  }
                  setPickedProjects([]);
                  onOpenProject(group.path);
                }}
                className={`flex min-w-0 flex-1 items-center gap-1.5 py-[7px] pr-1 text-left text-[13px] font-medium ${
                  current ? "text-ink" : "text-ink/75"
                }`}
              >
                <ProjectMark
                  path={group.path}
                  remote={Boolean(group.remote)}
                  refresh={logoRefresh}
                  active={current}
                  className="size-3.5"
                />
                <span className="min-w-0 truncate">{group.name}</span>
                <ProjectMarks remote={group.remote} server={group.server} />
              </button>
              {git && !showArchived ? (
                <ProjectGitRow
                  git={git}
                  onMenu={(x, y) => setGitMenu({ x, y, path: group.path, remote: Boolean(group.remote || group.server) })}
                />
              ) : null}
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
            {closed || showArchived || worktrees.length === 0 ? null : (
              <div className="mt-0.5 mb-0.5 ml-3 border-l border-line/40 pl-1.5">
                {worktrees.map((child) => {
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
                        onMenu={(x, y) => setWorktreeMenu({ x, y, child })}
                      />
                      {childClosed || !renderWorktree ? null : renderWorktree(child)}
                    </div>
                  );
                })}
              </div>
            )}
            {closed || showArchived || members.length === 0 ? null : (
              <div className="mt-0.5 mb-0.5 ml-3 border-l border-line/40 pl-1.5">
                {members.map((member) => {
                  const memberGit = gitByProject?.[projectGitKey(member.path)] ?? null;
                  return (
                    <div key={projectKey(member.path)}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenProject(member.path)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter") onOpenProject(member.path);
                        }}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setMemberMenu({ x: ev.clientX, y: ev.clientY, groupPath: group.path, member });
                        }}
                        className={`flex w-full items-center gap-1.5 rounded-[6px] px-1.5 py-[5px] text-left text-[12px] hover:bg-wash ${
                          isSameProject(member.path, activeWorkspace) ? "text-ink" : "text-ink/75"
                        }`}
                      >
                        <ProjectMark path={member.path} remote={Boolean(member.remote)} refresh={logoRefresh} className="size-3" />
                        <span className="min-w-0 flex-1 truncate">{member.name}</span>
                        {memberGit ? <ProjectGitRow git={memberGit} onMenu={() => undefined} /> : null}
                      </div>
                      {renderList(member, { showArchived: false })}
                    </div>
                  );
                })}
              </div>
            )}
            {closed ? null : visibleEmpty && members.length === 0 ? (
              <p className="px-7 py-0.5 text-[12px] text-muted">
                {showArchived ? "No archived chats" : "No chats yet"}
              </p>
            ) : (
              <div className={worktrees.length ? "pl-2" : undefined}>
                {renderList(listed, { showArchived: chatQuery.trim() ? false : showArchived })}
              </div>
            )}
          </ProjectSection>
        );
      })}
      {menu ? (
        <ProjectContextMenu
          x={menu.x}
          y={menu.y}
          name={menu.group.name}
          path={menu.group.path}
          onNewChat={() => {
            onNewChat(menu.group.path);
            setMenu(null);
          }}
          onSettings={() => {
            onOpenSettings(menu.group.path, menu.group.name);
            setMenu(null);
          }}
          onDelete={() => {
            if (projectGroups.some((row) => isSameProject(row.path, menu.group.path))) {
              setPendingGroup(menu.group);
              setMenu(null);
              return;
            }
            setPendingDelete(menu.group);
            setMenu(null);
          }}
          onGroup={
            onCreateGroup && pickedProjects.length >= 2 && pickedProjects.some((path) => isSameProject(path, menu.group.path))
              ? () => {
                  setGroupDraft(pickedProjects);
                  setMenu(null);
                }
              : undefined
          }
          addTargets={
            onAddToGroup && !menu.group.remote && !menu.group.server && !projectGroups.some((row) => isSameProject(row.path, menu.group.path))
              ? projectGroups.map((row) => ({ path: row.path, name: row.name }))
              : undefined
          }
          onAddTo={(groupPath) => {
            onAddToGroup?.(groupPath, menu.group.path);
            setMenu(null);
          }}
          onCopied={() => setMenu(null)}
          removeLabel={projectGroups.some((row) => isSameProject(row.path, menu.group.path)) ? "Remove group" : "Remove project"}
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
      {worktreeMenu ? (
        <WorktreeContextMenu
          x={worktreeMenu.x}
          y={worktreeMenu.y}
          name={worktreeMenu.child.branch}
          onNewChat={() => {
            onNewChat(worktreeMenu.child.path);
            setWorktreeMenu(null);
          }}
          onDelete={
            onRemoveWorktree
              ? () => {
                  setPendingWorktree(worktreeMenu.child);
                  setWorktreeMenu(null);
                }
              : undefined
          }
        />
      ) : null}
      {pendingWorktree ? (
        <DeleteWorktreeDialog
          name={pendingWorktree.branch}
          onCancel={() => setPendingWorktree(null)}
          onConfirm={() => {
            onRemoveWorktree?.(pendingWorktree.path);
            setPendingWorktree(null);
          }}
        />
      ) : null}
      {memberMenu ? (
        <AnchoredMenu x={memberMenu.x} y={memberMenu.y} label={memberMenu.member.name}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onNewChat(memberMenu.member.path);
              setMemberMenu(null);
            }}
            className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
          >
            New chat
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onRemoveMember?.(memberMenu.groupPath, memberMenu.member.path);
              setMemberMenu(null);
            }}
            className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
          >
            Remove from group
          </button>
        </AnchoredMenu>
      ) : null}
      {groupDraft ? (
        <GroupProjectsDialog
          count={groupDraft.length}
          onCancel={() => setGroupDraft(null)}
          onConfirm={(name) => {
            onCreateGroup?.(name, groupDraft);
            setPickedProjects([]);
            setGroupDraft(null);
          }}
        />
      ) : null}
      {pendingGroup ? (
        <RemoveGroupDialog
          name={pendingGroup.name}
          chats={pendingGroup.conversations.filter((row) => !row.archived).length}
          onCancel={() => setPendingGroup(null)}
          onConfirm={() => {
            onDeleteGroup?.(pendingGroup.path);
            setPendingGroup(null);
          }}
        />
      ) : null}
      {pendingDelete ? (
        <DeleteProjectDialog
          name={pendingDelete.name}
          path={pendingDelete.path}
          appManaged={isAppProject(pendingDelete.path, projectsRoot) || isAppProject(pendingDelete.path, legacyProjectsRoot)}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(mode) => {
            onDeleteProject(pendingDelete.path, mode);
            setPendingDelete(null);
          }}
        />
      ) : null}
    </div>
    </SortableContext>
    </DndContext>
  );
}

export { ProjectMarks };
export { DeleteProjectDialog, ProjectContextMenu };
export type { ProjectDeleteMode };
