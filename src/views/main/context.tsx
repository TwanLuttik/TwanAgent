import { createContext, useContext, type ReactNode } from "react";
import type { ProjectChatGroup } from "../../lib/all-projects";
import type { JourneySummary } from "../../lib/journey";
import type { TabItem, TabMenu } from "../../lib/split-pane";
import type { ConversationSummary } from "../../lib/tauri";
import type { RunningTurn } from "../../lib/turn";

type MainFn = (...args: any[]) => any;

/** State and actions the main shell reads. Views pull a slice with `useMain` instead of taking a prop each. */
export type MainModel = {
  activeId: any;
  addPromptImages: MainFn;
  allProjectGroups: any;
  answerPlan: MainFn;
  answerShell: MainFn;
  applyWorkspace: MainFn;
  /** Point an unsaved new chat at another project without opening that project's chats. */
  assignDraftProject: MainFn;
  beginPendingEdit: MainFn;
  busy: any;
  chatTabs: { id: string; title: string; kind: "chat" | "terminal"; running: boolean }[];
  tabItems: TabItem[];
  splitChatIds: string[];
  tabMenu: TabMenu | null;
  setTabMenu: MainFn;
  splitChat: MainFn;
  splitSelected: MainFn;
  moveChatTab: MainFn;
  setSplitShare: MainFn;
  unsplitChat: MainFn;
  focusSplitPane: MainFn;
  closeChatTab: MainFn;
  closeFileTab: MainFn;
  closePendingEdit: MainFn;
  closeProjectSettings: MainFn;
  closeServers: MainFn;
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
  drafts: Record<string, string>;
  draftImages: Record<string, import("../../lib/core").ChatImage[]>;
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
  mcpBusy: any;
  mcpServers: any;
  messages: any;
  model: any;
  models: any;
  moveConversation: MainFn;
  onSidebarResizeStart: MainFn;
  openChat: MainFn;
  /** Open a chat from this project's list without moving a split that already shows it. */
  openListedChat: MainFn;
  opened: any;
  openFolder: MainFn;
  openingId: any;
  openJourneyKnowledge: MainFn;
  openProjectFromSidebar: MainFn;
  openProjectSettings: MainFn;
  openServers: MainFn;
  openSettings: MainFn;
  openSidebarChat: MainFn;
  openUsage: MainFn;
  openWorkspaceFile: MainFn;
  pendingClosePath: any;
  pendingDeleteProject: any;
  pendingByChat: Record<string, { text: string; images?: import("../../lib/core").ChatImage[] }[]>;
  pendingPlan: any;
  pendingShell: any;
  permission: any;
  pickContextWindow: MainFn;
  pickEffort: MainFn;
  pickModel: MainFn;
  pickPermission: MainFn;
  pickPlanMode: MainFn;
  planMode: "off" | "pending" | "on";
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
  /** True while a cloud project is still opening its server. Send stays off. */
  cloudConnecting: boolean;
  archiveChat: MainFn;
  removeChat: MainFn;
  removePendingAt: MainFn;
  renameJourney: MainFn;
  reorderChats: MainFn;
  reorderProjects: MainFn;
  reorderSidebar: MainFn;
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
  /** Replace one chat's composer text and keep it for the next open. */
  setChatDraft: MainFn;
  setEditor: MainFn;
  toggleSubagent: MainFn;
  setFolderOpen: MainFn;
  setJourneyColor: MainFn;
  setPendingDeleteProject: MainFn;
  setProjectMenu: MainFn;
  setShowSettings: MainFn;
  setShowUsage: MainFn;
  settingsTab: any;
  setSettingsTab: MainFn;
  setSidebarWidth: MainFn;
  bumpFiles: () => void;
  showLanding: any;
  showServers: any;
  showSettings: any;
  showUsage: any;
  sidebarDragging: any;
  sidebarWidth: any;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: MainFn;
  paneCollapsed: boolean;
  setPaneCollapsed: MainFn;
  skillBusy: any;
  skills: any;
  startNewChat: MainFn;
  subagents: any;
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
 * The conversation list. It stays off `MainModel` so a draft, a streamed token,
 * or the composer height does not rebuild every chat row.
 */
export type SidebarSlice = {
  activeId: string;
  allProjectGroups: ProjectChatGroup[];
  archiveChat: MainFn;
  collapsedProjects: string[];
  conversations: ConversationSummary[];
  createJourneyFromChat: MainFn;
  deleteJourney: MainFn;
  deleteProjectFromSidebar: MainFn;
  journeys: JourneySummary[];
  legacyProjectsRoot: string;
  messages: MainModel["messages"];
  moveConversation: MainFn;
  openChat: MainFn;
  openListedChat: MainFn;
  openingId: string;
  openJourneyKnowledge: MainFn;
  openProjectFromSidebar: MainFn;
  openProjectSettings: MainFn;
  openSidebarChat: MainFn;
  projectSettings: MainModel["projectSettings"];
  projectsRoot: string;
  removeChat: MainFn;
  renameJourney: MainFn;
  setProjectMenu: MainFn;
  reorderChats: MainFn;
  reorderProjects: MainFn;
  reorderSidebar: MainFn;
  runningTurns: Record<string, RunningTurn>;
  unseenFinished: ReadonlySet<string>;
  setJourneyColor: MainFn;
  showSettings: boolean;
  showUsage: boolean;
  startNewChat: MainFn;
  toggleJourney: MainFn;
  toggleProjectCollapsed: MainFn;
  workspace: string;
};

const SidebarContext = createContext<SidebarSlice | null>(null);

export function MainProvider({
  value,
  sidebar,
  children,
}: {
  value: MainModel;
  sidebar: SidebarSlice;
  children: ReactNode;
}) {
  return (
    <MainContext.Provider value={value}>
      <SidebarContext.Provider value={sidebar}>{children}</SidebarContext.Provider>
    </MainContext.Provider>
  );
}

export function useMain(): MainModel {
  const value = useContext(MainContext);
  if (!value) throw new Error("useMain must be used inside MainProvider");
  return value;
}

export function useSidebar(): SidebarSlice {
  const value = useContext(SidebarContext);
  if (!value) throw new Error("useSidebar must be used inside MainProvider");
  return value;
}
