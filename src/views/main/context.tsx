import { createContext, useContext, useMemo, type ReactNode } from "react";

type MainFn = (...args: any[]) => any;

/** State and actions the main shell reads. Views pull a slice with `useMain` instead of taking a prop each. */
export type MainModel = {
  activeId: any;
  addPromptImages: MainFn;
  allProjectGroups: any;
  answerShell: MainFn;
  applyWorkspace: MainFn;
  beginPendingEdit: MainFn;
  busy: any;
  chatTabs: { id: string; title: string; kind: "chat" | "terminal" }[];
  closeChatTab: MainFn;
  closeFileTab: MainFn;
  closePendingEdit: MainFn;
  closeProjectSettings: MainFn;
  closeSettings: MainFn;
  closeUsage: MainFn;
  collapsedProjects: any;
  composerDockRef: any;
  composerPad: any;
  holdScrollForOlder: MainFn;
  contextWindow: any;
  conversations: any;
  createJourneyFromChat: MainFn;
  deleteJourney: MainFn;
  deleteProjectFromSidebar: MainFn;
  dirtyFiles: any;
  draft: any;
  draftPastes: any;
  mentionFiles: any;
  editingPending: any;
  editMcpServer: MainFn;
  editor: any;
  editSkill: MainFn;
  effort: any;
  expandedAgents: any;
  fileDrag: any;
  folderOpen: any;
  journeys: any;
  /** @deprecated Read from useStream. Kept optional so a stale object still typechecks. */
  liveTools?: any;
  mcpBusy: any;
  mcpServers: any;
  messages: any;
  model: any;
  models: any;
  moveConversation: MainFn;
  onSidebarResizeStart: MainFn;
  openChat: MainFn;
  opened: any;
  openFolder: MainFn;
  openingId: any;
  openJourneyKnowledge: MainFn;
  openProjectFromSidebar: MainFn;
  openProjectSettings: MainFn;
  openSettings: MainFn;
  openSidebarChat: MainFn;
  openUsage: MainFn;
  openWorkspaceFile: MainFn;
  pendingClosePath: any;
  pendingDeleteProject: any;
  pendingShell: any;
  permission: any;
  pickContextWindow: MainFn;
  pickEffort: MainFn;
  pickModel: MainFn;
  pickPermission: MainFn;
  pickSpeechModel: MainFn;
  dictate: MainFn;
  speechModel: any;
  speechModels: any;
  speechProgress: any;
  speechDownloading: any;
  refreshSpeech: MainFn;
  downloadSpeech: MainFn;
  projectMenu: any;
  projectSettings: any;
  projectsRoot: any;
  legacyProjectsRoot: any;
  promptImages: any;
  queued: any;
  ready: any;
  reauthMcpServer: MainFn;
  recents: any;
  reloadRuntime: MainFn;
  remoteWorkspace: any;
  archiveChat: MainFn;
  removeChat: MainFn;
  removePendingAt: MainFn;
  renameJourney: MainFn;
  reorderChats: MainFn;
  reorderSidebar: MainFn;
  runningActivity?: any;
  runningId: any;
  runningTurns: any;
  unseenFinished: any;
  runtime: any;
  savePendingEdit: MainFn;
  scroller: any;
  send: MainFn;
  stop: MainFn;
  setDirtyFiles: MainFn;
  setDraft: MainFn;
  setDraftPastes: MainFn;
  setDraftImages: MainFn;
  setDrafts: MainFn;
  setEditor: MainFn;
  toggleSubagent: MainFn;
  setFolderOpen: MainFn;
  setJourneyColor: MainFn;
  setPendingDeleteProject: MainFn;
  setProjectMenu: MainFn;
  setShowSettings: MainFn;
  setShowUsage: MainFn;
  setSidebarWidth: MainFn;
  bumpFiles: () => void;
  showLanding: any;
  showSettings: any;
  showUsage: any;
  sidebarDragging: any;
  sidebarWidth: any;
  skillBusy: any;
  skills: any;
  startNewChat: MainFn;
  streamText?: any;
  streamReasoning?: any;
  subagents: any;
  tick: any;
  toggleJourney: MainFn;
  toggleMcpServer: MainFn;
  toggleProjectCollapsed: MainFn;
  toggleSkill: MainFn;
  turnStartedAt: any;
  usageByChat: any;
  usageTick: any;
  workspace: any;
};

const MainContext = createContext<MainModel | null>(null);

/**
 * Fields that change on every streamed token. They stay off `MainModel` so a
 * delta does not rebuild the sidebar, file tree, and composer.
 */
export type StreamSlice = {
  streamText: string;
  streamReasoning: string;
  liveTools: MainModel["liveTools"];
  runningActivity: MainModel["runningActivity"];
};

const StreamContext = createContext<StreamSlice | null>(null);

export function MainProvider({
  value,
  stream,
  children,
}: {
  value: MainModel;
  stream: StreamSlice;
  children: ReactNode;
}) {
  const streamValue = useMemo(
    () => stream,
    [stream.streamText, stream.streamReasoning, stream.liveTools, stream.runningActivity],
  );
  return (
    <MainContext.Provider value={value}>
      <StreamContext.Provider value={streamValue}>{children}</StreamContext.Provider>
    </MainContext.Provider>
  );
}

export function useStream(): StreamSlice {
  const value = useContext(StreamContext);
  if (!value) throw new Error("useStream must be used inside MainProvider");
  return value;
}

export function useMain(): MainModel {
  const value = useContext(MainContext);
  if (!value) throw new Error("useMain must be used inside MainProvider");
  return value;
}
