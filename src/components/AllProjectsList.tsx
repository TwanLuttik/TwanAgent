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
  favoriteProjectsFirst,
  isAppProject,
  isProjectCollapsed,
  isProjectFavorite,
  isSameProject,
  matchesSidebarQuery,
  projectHasArchived,
  toggleProjectSelection,
  type ProjectChatGroup,
  type ProjectGroupRow,
} from "../lib/all-projects";
import { projectKey } from "../lib/core";
import { serverDisplayName, type ChatPlace } from "../lib/chat-place";
import { projectGitKey, type ProjectGit } from "../lib/project-git";
import type { WorktreeChild } from "../lib/worktree.ts";
import * as api from "../lib/tauri";
import { AnchoredMenu, MenuItem } from "./ContextMenu";
import { GroupProjectsDialog, RemoveGroupDialog } from "./GroupProjectsDialog";
import { ProjectMark } from "./ProjectMark";
import { Symbol } from "./Symbol";
import {
  DeleteWorktreeDialog,
  ProjectGitRow,
  ProjectMarks,
  ProjectSection,
  WorktreeContextMenu,
} from "./projects/ProjectRows";
import { DeleteProjectDialog, ProjectContextMenu, type ProjectDeleteMode } from "./projects/ProjectDialogs";

/** Height transition for a project body. Content stays mounted until the close finishes. */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      }`}
      onTransitionEnd={(ev) => {
        if (ev.target !== ev.currentTarget || ev.propertyName !== "grid-template-rows" || open) return;
        setShown(false);
      }}
    >
      <div className="min-h-0 overflow-hidden">{shown ? children : null}</div>
    </div>
  );
}

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
  focusPath = "",
  favoritePaths = [],
  onToggleFavorite,
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
  renderWorktree?: (child: WorktreeChild, group: ProjectChatGroup) => ReactNode;
  renderList: (
    group: ProjectChatGroup,
    options: { showArchived: boolean; place: Omit<ChatPlace, "pr"> },
  ) => ReactNode;
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
  /** When this path is the one project in view, its header is already the sidebar title. */
  focusPath?: string;
  favoritePaths?: readonly string[];
  onToggleFavorite?: (path: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; group: ProjectChatGroup } | null>(null);
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
      setWorktreeMenu(null);
      setMemberMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setMenu(null);
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
    <SortableContext items={favoriteProjectsFirst(groups, favoritePaths).map((group) => projectKey(group.path))} strategy={verticalListSortingStrategy}>
    <div className="flex flex-col gap-1">
      {pickedProjects.length >= 2 && onCreateGroup ? (
        <button
          type="button"
          onClick={() => setGroupDraft(pickedProjects)}
          className="mx-1 rounded-[6px] bg-accent/15 px-2 py-1 text-left text-[12px] font-medium text-accent hover:bg-accent/25"
        >
          Group {pickedProjects.length} projects
        </button>
      ) : null}
      {favoriteProjectsFirst(groups, favoritePaths).map((group) => {
        const current = isSameProject(group.path, activeWorkspace);
        const headerHidden = Boolean(focusPath) && isSameProject(group.path, focusPath);
        const closed = headerHidden ? false : isProjectCollapsed(collapsed, group.path);
        const favorite = isProjectFavorite(favoritePaths, group.path);
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
            card={grouped}
            open={!closed}
            header={(drag) => headerHidden ? null : (
            <div className="contents">
            <div
              className={`group flex cursor-pointer items-center rounded-[6px] select-none hover:bg-wash [&_*]:cursor-pointer ${
                picked ? "bg-accent/10" : ""
              } ${group.remote ? "cloud-zebra" : ""}`}
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
                <Symbol
                  name="chevron.down"
                  className={`size-3 transition-transform duration-200 ease-out motion-reduce:transition-none ${
                    closed ? "-rotate-90" : ""
                  }`}
                />
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
              {onToggleFavorite && favorite ? (
                <button
                  type="button"
                  aria-label={`Unfavorite ${group.name}`}
                  aria-pressed
                  title="Unfavorite"
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    onToggleFavorite(group.path);
                  }}
                  className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-warn"
                >
                  <Symbol name="star.fill" className="size-4" />
                </button>
              ) : null}
              {git && !showArchived ? <ProjectGitRow git={git} /> : null}
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
            <Collapse open={!closed}>
            {!showArchived ? null : (
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
            {showArchived || worktrees.length === 0 ? null : (
              <div className="mt-1 flex flex-col gap-1">
                {worktrees.map((child) => (
                  <div
                    key={projectKey(child.path)}
                    onContextMenu={(ev) => {
                      const target = ev.target;
                      if (target instanceof Element && target.closest("button")) return;
                      ev.preventDefault();
                      setWorktreeMenu({ x: ev.clientX, y: ev.clientY, child });
                    }}
                  >
                    {renderWorktree ? renderWorktree(child, group) : null}
                  </div>
                ))}
              </div>
            )}
            {showArchived || members.length === 0 ? null : (
              <div className={grouped ? undefined : "mt-0.5 mb-0.5 ml-3 border-l border-line/40 pl-1.5"}>
                {members.map((member) => {
                  const memberGit = gitByProject?.[projectGitKey(member.path)] ?? null;
                  const memberClosed = !chatQuery.trim() && isProjectCollapsed(collapsed, member.path);
                  const memberCurrent = isSameProject(member.path, activeWorkspace);
                  return (
                    <div key={projectKey(member.path)}>
                      <div
                        className={`flex w-full items-center rounded-[6px] pr-1 hover:bg-wash ${
                          memberCurrent ? "text-ink" : "text-ink/75"
                        }`}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setMemberMenu({ x: ev.clientX, y: ev.clientY, groupPath: group.path, member });
                        }}
                      >
                        <button
                          type="button"
                          aria-label={memberClosed ? `Expand ${member.name}` : `Collapse ${member.name}`}
                          onClick={() => onToggleCollapsed(member.path)}
                          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:text-ink"
                        >
                          <Symbol
                            name="chevron.down"
                            className={`size-3 transition-transform duration-200 ease-out motion-reduce:transition-none ${
                              memberClosed ? "-rotate-90" : ""
                            }`}
                          />
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenProject(member.path)}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-[5px] pr-1 text-left text-[12px]"
                        >
                          <ProjectMark path={member.path} remote={Boolean(member.remote)} refresh={logoRefresh} className="size-3" />
                          <span className="min-w-0 flex-1 truncate">{member.name}</span>
                          {memberGit ? <ProjectGitRow git={memberGit} /> : null}
                        </button>
                      </div>
                      <Collapse open={!memberClosed}><div className="mt-1">{renderList(member, {
                        showArchived: false,
                        place: {
                          branch: gitByProject?.[projectGitKey(member.path)]?.branch ?? "",
                          worktree: false,
                          server: Boolean(member.remote || member.server),
                          serverName: serverDisplayName(member.server),
                          ahead: gitByProject?.[projectGitKey(member.path)]?.ahead,
                          behind: gitByProject?.[projectGitKey(member.path)]?.behind,
                          dirty: gitByProject?.[projectGitKey(member.path)]?.dirty,
                        },
                      })}</div></Collapse>
                    </div>
                  );
                })}
              </div>
            )}
            {visibleEmpty && members.length === 0 ? (
              <p className="px-7 py-0.5 text-[12px] text-muted">
                {showArchived ? "No archived chats" : "No chats yet"}
              </p>
            ) : (
              <div className="mt-1">
                {renderList(listed, {
                  showArchived: chatQuery.trim() ? false : showArchived,
                  place: {
                    branch: git?.branch ?? "",
                    worktree: false,
                    server: Boolean(group.remote || group.server),
                    serverName: serverDisplayName(group.server),
                    ahead: git?.ahead,
                    behind: git?.behind,
                    dirty: git?.dirty,
                  },
                })}
              </div>
            )}
            </Collapse>
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
          favorite={isProjectFavorite(favoritePaths, menu.group.path)}
          onFavorite={
            onToggleFavorite
              ? () => {
                  onToggleFavorite(menu.group.path);
                  setMenu(null);
                }
              : undefined
          }
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
          onReveal={
            menu.group.remote || menu.group.server
              ? undefined
              : () => {
                  const path = menu.group.path;
                  setMenu(null);
                  void api.revealFolder(path).catch(() => undefined);
                }
          }
          onCopied={() => setMenu(null)}
          removeLabel={projectGroups.some((row) => isSameProject(row.path, menu.group.path)) ? "Remove group" : "Remove project"}
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
          <MenuItem
            onClick={() => {
              onNewChat(memberMenu.member.path);
              setMemberMenu(null);
            }}
          >
            New chat
          </MenuItem>
          <MenuItem
            onClick={() => {
              onRemoveMember?.(memberMenu.groupPath, memberMenu.member.path);
              setMemberMenu(null);
            }}
          >
            Remove from group
          </MenuItem>
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
