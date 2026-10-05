import { WorkspaceFileLinks } from "../../components/ChatMarkdown";
import { DeleteProjectDialog, ProjectContextMenu } from "../../components/AllProjectsList";
import { Flash } from "../../components/Flash";
import { FolderDialog } from "../../components/FolderDialog";
import { isAppProject } from "../../lib/all-projects";
import { AppSidebar } from "./AppSidebar";
import { ChatStage } from "./ChatStage";
import { useMain } from "./context";
import { LandingScreen } from "./LandingScreen";

export function MainShell() {
  const {
    applyWorkspace,
    deleteProjectFromSidebar,
    folderOpen,
    legacyProjectsRoot,
    openProjectSettings,
    pendingDeleteProject,
    projectMenu,
    projectsRoot,
    recents,
    setFolderOpen,
    setPendingDeleteProject,
    setProjectMenu,
    showLanding,
    startNewChat,
    tick,
    openWorkspaceFile,
    workspace,
  } = useMain();

  if (showLanding) return <LandingScreen />;

  return (
    <WorkspaceFileLinks workspace={workspace || null} tick={tick} onOpenFile={openWorkspaceFile}>
      <div className="flex h-full min-w-0 overflow-hidden bg-sidebar">
        <Flash />
        {folderOpen ? (
          <FolderDialog
            onClose={() => setFolderOpen(false)}
            onPick={applyWorkspace}
            showProjects
            recents={recents}
          />
        ) : null}
        <AppSidebar />
        {projectMenu ? (
          <ProjectContextMenu
            x={projectMenu.x}
            y={projectMenu.y}
            name={projectMenu.name}
            appManaged={isAppProject(projectMenu.path, projectsRoot) || isAppProject(projectMenu.path, legacyProjectsRoot)}
            onNewChat={() => {
              void startNewChat("chat", undefined, projectMenu.path);
              setProjectMenu(null);
            }}
            onSettings={() => {
              openProjectSettings(projectMenu.path, projectMenu.name);
              setProjectMenu(null);
            }}
            onDelete={() => {
              setPendingDeleteProject({ path: projectMenu.path, name: projectMenu.name });
              setProjectMenu(null);
            }}
          />
        ) : null}
        {pendingDeleteProject ? (
          <DeleteProjectDialog
            name={pendingDeleteProject.name}
            appManaged={
              isAppProject(pendingDeleteProject.path, projectsRoot) ||
              isAppProject(pendingDeleteProject.path, legacyProjectsRoot)
            }
            onCancel={() => setPendingDeleteProject(null)}
            onConfirm={() => {
              void deleteProjectFromSidebar(pendingDeleteProject.path);
              setPendingDeleteProject(null);
            }}
          />
        ) : null}
        <ChatStage />
      </div>
    </WorkspaceFileLinks>
  );
}
