import { useEffect, useState, type ReactNode } from "react";
import {
  isAppProject,
  isProjectCollapsed,
  isSameProject,
  type ProjectChatGroup,
} from "../lib/dev-all-projects";
import { projectKey } from "../lib/dev";
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
  renderList,
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
  renderList: (group: ProjectChatGroup) => ReactNode;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; group: ProjectChatGroup } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectChatGroup | null>(null);

  useEffect(() => {
    function onDoc() {
      setMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setMenu(null);
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

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const current = isSameProject(group.path, activeWorkspace);
        const closed = isProjectCollapsed(collapsed, group.path);
        const empty = group.conversations.length === 0 && group.journeys.length === 0;
        return (
          <section key={projectKey(group.path)}>
            <div
              className="group flex items-center rounded-[6px] hover:bg-wash"
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
              </button>
            </div>
            {closed ? null : empty ? (
              <p className="px-7 py-0.5 text-[12px] text-muted">No chats yet</p>
            ) : (
              renderList(group)
            )}
          </section>
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
    <div
      role="menu"
      aria-label={name}
      className="fixed z-50 min-w-[168px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-card"
      style={{ left: x, top: y }}
      onMouseDown={(ev) => ev.stopPropagation()}
    >
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
    </div>
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
  return (
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
    </div>
  );
}


