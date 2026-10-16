import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { isMacOS } from "../components/WindowButtons";
import { scrollChatToEnd } from "../lib/chat-scroll";
import {
  backfillFinishedAt,
  conversationTitleFrom,
  moveById,
  newConversationId,
  nowIso,
  projectKey,
  type ChatMessage,
} from "../lib/core";
import {
  expandCollapsedProject,
  isAppProject,
  isLinkedWorktreePath,
  isSameProject,
  moveProjectGroup,
  patchSidebarConversations,
  removeProjectGroup,
  renameConversationInGroups,
  toggleCollapsedProject,
  upsertProjectGroup,
  type ProjectChatGroup,
} from "../lib/all-projects";
import { parseChatUsage, putChatUsage, usageToPersist, type ChatUsage } from "../lib/context";
import { closeEditorTab, emptyEditor, pinEditorTab, requestCloseEditorTab, selectChatTab, type EditorState } from "../lib/editor";
import { insertCompactionEvent } from "../lib/compact";
import { persistableCompaction, persistableMessages } from "../lib/image";
import {
  conversationHasSummarizeSource,
  JOURNEY_SUMMARIZE_PROMPT,
  journeyKnowledgePath,
  lastAssistantText,
  nextTopSort,
  parseJourneyColor,
  type JourneyColor,
  type JourneySummary,
} from "../lib/journey";
import { forgetPaneWorkspace } from "../lib/pane-sessions";
import { getLiveStream, setLiveStream, setSecondaryLiveStream } from "../lib/live-stream";
import { closeTabChat, focusedSplitMessages, rememberSplitPane, splitGroupForChat, splitPaneCache } from "../lib/split-pane";
import { shellSessions } from "../lib/shell-terminal";
import { conversationDraft, parseConversationKind, type ConversationKind } from "../lib/terminal-chat";
import { terminalSessions } from "../lib/terminal-sessions";
import { canPersistTurn, chatHasRunningTurn, clearPendingForChat, clearUnseenFinished, composerRowForOpen, composerSettingsForChat, foregroundRunningId, liveTurnMessages, type PendingMessage, type RunningTurn } from "../lib/turn";
import { publishWorktreeList, tabProjectKey, worktreeForPath, worktreeListsFor } from "../lib/worktree";
import { parsePermissionMode, type PermissionMode } from "../lib/permission";
import { emptyGrokPlan, grokPlanFromPayload, planModeEngaged, type GrokPlan } from "../lib/plan";
import { providerProfile } from "../lib/provider";
import { isNewChatHotkey, isSettingsHotkey } from "../lib/hotkeys";
import {
  loadContextWindow,
  loadConversation,
  loadEffort,
  loadModel,
  loadPermission,
  saveModel,
  pushRecentWorkspace,
  removeRecentWorkspace,
  saveCollapsedProjects,
  saveConversation,
  saveWorkspace,
} from "../lib/prefs";
import * as api from "../lib/tauri";
import type { ConversationSummary } from "../lib/tauri";
import type { ConversationActivity, LiveToolRow } from "../lib/core";
import { emptySubagentDock, toggleSubagentExpanded, type SubagentDockState } from "../lib/subagent";
import { PERSIST_TRAIL_MS, createPersistQueue } from "../lib/persist-queue";

type Update<T> = Dispatch<SetStateAction<T>>;

export type RunTurn = (
  ws: string,
  id: string,
  next: ChatMessage[],
  after?: (done: ChatMessage[]) => Promise<void>,
  journeyIdOverride?: string,
) => Promise<void>;

export type LibraryDeps = {
  workspace: string;
  conversations: ConversationSummary[];
  journeys: JourneySummary[];
  allProjectGroups: ProjectChatGroup[];
  messages: ChatMessage[];
  activeId: string;
  runningId: string;
  runningTurns: Record<string, RunningTurn>;
  projectsRoot: string;
  legacyProjectsRoot: string;
  pendingClosePath: string | null;
  dirtyFiles: Record<string, boolean>;
  usageByChat: Record<string, ChatUsage>;
  compactionByChat: Record<string, { summary: string; through: number }>;
  setCompactionByChat: Update<Record<string, { summary: string; through: number }>>;
  model: string;
  effort: string;
  contextWindow: number;
  permission: string;
  models: { id: string; efforts?: { id: string }[]; context_windows?: number[] | null; context_window?: number | null }[];
  defaultEffort: string;
  setModel: Update<string>;
  setEffort: Update<string>;
  setContextWindow: Update<number>;
  setPermission: Update<PermissionMode>;
  openSettings: () => void;
  reloadConversations: (ws: string, preferId?: string) => Promise<void>;
  /** True while the open project keeps its chats on the paired server. */
  hostedChats: boolean;
  /** The project whose chat list is on screen. Cleared when the project changes. */
  sidebarLoadedForRef: RefObject<string>;
  runTurn: RunTurn;
  scroller: RefObject<HTMLDivElement | null>;
  runningWsRef: RefObject<string>;
  /** Live composer model. A turn save must not use the model from the render that started it. */
  modelRef: RefObject<string>;
  /** Workspace currently on screen. Turn saves must follow this, not the workspace from when the turn started. */
  workspaceRef: RefObject<string>;
  activeIdRef: RefObject<string>;
  runningIdRef: RefObject<string>;
  abortRef: RefObject<AbortController | null>;
  turnsRef: RefObject<Map<string, AbortController>>;
  pendingRef: RefObject<Record<string, PendingMessage[]>>;
  deletedIdsRef: RefObject<Set<string>>;
  turnMessagesRef: RefObject<ChatMessage[] | null>;
  turnLiveRef: RefObject<{
    streamText: string;
    streamReasoning: string;
    liveTools: LiveToolRow[];
    activity: ConversationActivity | null;
  }>;
  liveByChatRef: RefObject<
    Map<
      string,
      {
        messages: ChatMessage[];
        streamText: string;
        streamReasoning: string;
        liveTools: LiveToolRow[];
        activity: ConversationActivity | null;
      }
    >
  >;
  subagentsByChatRef: RefObject<Map<string, SubagentDockState>>;
  planByChatRef: RefObject<Map<string, GrokPlan>>;
  onPlanChange?: () => void;
  stickToBottomRef: RefObject<boolean>;
  /** Latest sidebar rows, so a turn save does not write a stale journey or archive flag. */
  conversationsRef: RefObject<ConversationSummary[]>;
  /** Bumped when the visible chat or project changes, so a late load cannot overwrite it. */
  openGeneration: RefObject<number>;
  /** Saved cloud transcripts, keyed by project and chat. A click paints from here. */
  cloudTranscriptsRef: RefObject<Map<string, import("../lib/tauri").Conversation>>;
  setWorkspace: Update<string>;
  setConversations: Update<ConversationSummary[]>;
  setJourneys: Update<JourneySummary[]>;
  setAllProjectGroups: Update<ProjectChatGroup[]>;
  setMessages: Update<ChatMessage[]>;
  setActiveId: Update<string>;
  setRunningId: Update<string>;
  setEditor: Update<EditorState>;
  setDirtyFiles: Update<Record<string, boolean>>;
  setPendingClosePath: Update<string | null>;
  setFolderOpen: Update<boolean>;
  setShowSettings: Update<boolean>;
  setShowUsage: Update<boolean>;
  setShowDocs: Update<boolean>;
  setShowServers: Update<boolean>;
  setProjectSettings: Update<{ path: string; name: string } | null>;
  setCollapsedProjects: Update<string[]>;
  setRecents: Update<string[]>;
  setDrafts: Update<Record<string, string>>;
  setPastesByChat: Update<Record<string, import("../lib/paste").PasteBlock[]>>;
  setDraftImages: Update<Record<string, import("../lib/core").ChatImage[]>>;
  setUsageByChat: Update<Record<string, ChatUsage>>;
  setStreamText: Update<string>;
  setStreamReasoning: Update<string>;
  setLiveTools: Update<LiveToolRow[]>;
  setRunningActivity: Update<ConversationActivity | null>;
  setTurnStartedAt: Update<number>;
  setSubagents: Update<import("../lib/subagent").SubagentRecord[]>;
  setExpandedAgents: Update<Record<string, boolean>>;
  setOpeningId: Update<string>;
  setUnseenFinished: Update<ReadonlySet<string>>;
  setPendingByChat: Update<Record<string, PendingMessage[]>>;
  setChatTabsByProject: Update<Record<string, import("../lib/split-pane").TabItem[]>>;
  /** Open tabs for the project on screen. A split chat is already visible, so focusing it must not reload. */
  chatTabsByProject?: Record<string, import("../lib/split-pane").TabItem[]>;
  setFlash: (flash: { kind: "ok" | "err"; text: string } | null) => void;
  bumpFiles: () => void;
};

export function useLibrary(deps: LibraryDeps) {
  const {
    workspace, conversations, journeys, allProjectGroups, messages, activeId, runningId, runningTurns, hostedChats, projectsRoot,
    legacyProjectsRoot,
    pendingClosePath, dirtyFiles, usageByChat, compactionByChat, setCompactionByChat, model, effort, contextWindow, permission, models, defaultEffort, setModel, setEffort, setContextWindow, setPermission, openSettings, reloadConversations, runTurn, scroller,
    runningWsRef, modelRef, activeIdRef, runningIdRef, abortRef, turnsRef, pendingRef, deletedIdsRef, turnMessagesRef, turnLiveRef, liveByChatRef, subagentsByChatRef, planByChatRef, onPlanChange, stickToBottomRef, conversationsRef, openGeneration, cloudTranscriptsRef, workspaceRef, sidebarLoadedForRef,
    setWorkspace, setConversations, setJourneys, setAllProjectGroups, setMessages, setActiveId, setRunningId, setEditor,
    setDirtyFiles, setPendingClosePath, setFolderOpen, setShowSettings, setShowUsage, setShowDocs, setShowServers, setProjectSettings,
    setCollapsedProjects, setRecents, setDrafts, setPastesByChat, setDraftImages, setUsageByChat, setStreamText, setStreamReasoning, setLiveTools,
    setRunningActivity, setTurnStartedAt,
    setSubagents, setExpandedAgents, setOpeningId, setUnseenFinished, setPendingByChat, setChatTabsByProject, setFlash, bumpFiles,
  } = deps;
  const chatTabsByProjectRef = useRef(deps.chatTabsByProject ?? {});
  chatTabsByProjectRef.current = deps.chatTabsByProject ?? chatTabsByProjectRef.current;

  const hostedChatsRef = useRef(hostedChats);
  hostedChatsRef.current = hostedChats;
  const followRef = useRef("");
  const followChatRef = useRef("");
  const followStopRef = useRef<(() => void) | null>(null);
  const persistGen = useRef(new Map<string, number>());
  const persistTrail = useRef<ReturnType<typeof createPersistQueue<PersistPayload>> | null>(null);
  const shownMessages = useRef(new Map<string, ChatMessage[]>());
  const shownId = useRef(activeId);
  if (activeId) shownMessages.current.set(activeId, messages);
  shownId.current = activeId;

  function setPending(next: Record<string, PendingMessage[]>) {
    pendingRef.current = next;
    setPendingByChat(next);
  }

function closeFileTab(path: string) {
  const asked = requestCloseEditorTab(pendingClosePath, path, Boolean(dirtyFiles[path]));
  setPendingClosePath(asked.pending);
  if (!asked.close) return;
  setDirtyFiles((prev) => {
    const next = { ...prev };
    delete next[path];
    return next;
  });
  setEditor((prev) => closeEditorTab(prev, path));
}

function openFolder() {
  setFolderOpen(true);
}

async function reorderProjects(fromPath: string, toPath: string) {
  const next = moveProjectGroup(allProjectGroups, fromPath, toPath);
  if (next === allProjectGroups) return;
  setAllProjectGroups(next);
  try {
    await api.reorderProjects(next.map((group) => group.path));
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

function toggleProjectCollapsed(path: string) {
  setCollapsedProjects((keys) => {
    const next = toggleCollapsedProject(keys, path);
    saveCollapsedProjects(next);
    return next;
  });
}

function expandProject(path: string) {
  setCollapsedProjects((keys) => {
    const next = expandCollapsedProject(keys, path);
    if (next.length !== keys.length) saveCollapsedProjects(next);
    return next;
  });
}

function projectConversations(path: string): ConversationSummary[] {
  if (isSameProject(path, workspace)) return conversations;
  return allProjectGroups.find((group) => isSameProject(group.path, path))?.conversations ?? [];
}

function projectJourneys(path: string): JourneySummary[] {
  if (isSameProject(path, workspace)) return journeys;
  return allProjectGroups.find((group) => isSameProject(group.path, path))?.journeys ?? [];
}

function applyProjectData(
  path: string,
  nextConversations: ConversationSummary[],
  nextJourneys?: JourneySummary[],
) {
  if (isSameProject(path, workspace)) {
    setConversations(nextConversations);
    if (nextJourneys) setJourneys(nextJourneys);
    return;
  }
  setAllProjectGroups((prev) =>
    upsertProjectGroup(prev, path, {
      conversations: nextConversations,
      ...(nextJourneys ? { journeys: nextJourneys } : {}),
    }),
  );
}

function showSubagents(id: string) {
  const dock = subagentsByChatRef.current.get(id) ?? emptySubagentDock();
  setSubagents(dock.agents);
  setExpandedAgents(dock.expanded);
}

function hideSubagents() {
  setSubagents([]);
  setExpandedAgents({});
}

function toggleSubagent(agentId: string) {
  if (!activeId) return;
  const dock = toggleSubagentExpanded(subagentsByChatRef.current, activeId, agentId);
  setSubagents(dock.agents);
  setExpandedAgents(dock.expanded);
}

function releaseProject(path: string) {
  if (!isSameProject(runningWsRef.current, path)) return;
  abortRef.current?.abort();
  hideSubagents();
}

function clearWorkspace() {
  releaseProject(workspace);
  saveWorkspace("");
  setWorkspace("");
  setEditor(emptyEditor());
  setDirtyFiles({});
  setPendingClosePath(null);
  if (!runningWsRef.current) hideSubagents();
  setDrafts({});
  setPastesByChat({});
  setDraftImages({});
  setUsageByChat({});
  setConversations([]);
  setJourneys([]);
  setActiveId("");
  setMessages([]);
  setFolderOpen(false);
}

async function deleteProjectFromSidebar(path: string) {
  setProjectSettings((current) => (current && isSameProject(current.path, path) ? null : current));
  try {
    // App-owned folders are deleted. A folder added from elsewhere is only forgotten.
    if (isAppProject(path, projectsRoot) || isAppProject(path, legacyProjectsRoot)) {
      await api.deleteProject(path);
    } else {
      await api.removeProject(path);
      await api.forgetWorkspace(path).catch(() => false);
    }
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    return;
  }
  saveConversation(path, "");
  void terminalSessions.disposeWorkspace(path);
  void shellSessions.disposeWorkspace(path);
  forgetPaneWorkspace(path);
  const leftover = removeRecentWorkspace(path);
  setRecents(leftover);
  setAllProjectGroups((prev) => removeProjectGroup(prev, path));
  setCollapsedProjects((keys) => {
    const next = expandCollapsedProject(keys, path);
    saveCollapsedProjects(next);
    return next;
  });
  releaseProject(path);
  if (!isSameProject(path, workspace)) return;
  const nextPath =
    leftover[0] || allProjectGroups.find((group) => !isSameProject(group.path, path))?.path || "";
  if (nextPath) applyWorkspace(nextPath);
  else clearWorkspace();
}

/**
 * A new chat that has not been saved yet. Picking a project only remembers where
 * the first prompt should land. It must not open a chat that project already has.
 */
function assignDraftProject(path: string) {
  if (!path || isSameProject(path, workspace)) return;
  // Remember the project for the first prompt only. Opening the folder, reloading
  // its chats, or swapping the composer would move the empty chat on screen.
  saveWorkspace(path);
  setRecents(pushRecentWorkspace(path));
  setWorkspace(path);
  expandProject(path);
}

/** Keep the open chat when its worktree folder is renamed out from under it. */
function retargetOpenChat(from: string, to: string, chatId: string) {
  if (!chatId || !isSameProject(from, workspaceRef.current)) return;
  sidebarLoadedForRef.current = to;
  saveWorkspace(to);
  setRecents(pushRecentWorkspace(to));
  setWorkspace(to);
  setAllProjectGroups((prev) => {
    const current = prev.find((group) => isSameProject(group.path, from));
    const kept = prev.filter((group) => !isSameProject(group.path, from));
    return upsertProjectGroup(kept, to, {
      name: current?.name,
      conversations: current?.conversations ?? conversationsRef.current,
      journeys: current?.journeys ?? [],
    });
  });
  expandProject(to);
}

/** A reply named this checkout after it was created. Move the branch and follow the folder. */
async function adoptWorktreeName(ws: string, branch: string) {
  const name = branch.trim();
  if (!ws || !name) return;
  const current = worktreeForPath(ws, worktreeListsFor(ws));
  if (!current || current.main || current.detached) return;
  if ((current.branch ?? "").trim() === name) return;
  const chatId = runningIdRef.current;
  try {
    const renamed = await api.gitWorktreeRename(ws, ws, name);
    publishWorktreeList(renamed.opened || ws, renamed.worktrees);
    bumpFiles();
    if (renamed.opened && !isSameProject(renamed.opened, ws)) {
      retargetOpenChat(ws, renamed.opened, chatId);
    }
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

function applyWorkspace(path: string) {
  const savedId = loadConversation(path);
  if (!isSameProject(path, workspace)) {
    const entering = allProjectGroups.find((group) => isSameProject(group.path, path));
    // Show the project we are opening from the rows it already has, in this same
    // update. Clearing first would paint the empty gap onto the cloud project.
    if (entering && (entering.conversations.length > 0 || entering.journeys.length > 0)) {
      setConversations(entering.conversations);
      setJourneys(entering.journeys);
      sidebarLoadedForRef.current = entering.path;
    } else {
      sidebarLoadedForRef.current = "";
    }
    setStreamText("");
    setStreamReasoning("");
    setLiveTools([]);
    if (!isSameProject(runningWsRef.current, workspace)) hideSubagents();
    const foregroundHere =
      isSameProject(runningWsRef.current, path) &&
      runningIdRef.current &&
      liveByChatRef.current.has(runningIdRef.current);
    const prefer =
      (savedId && liveByChatRef.current.has(savedId) && savedId) ||
      (foregroundHere ? runningIdRef.current : "") ||
      "";
    const savedCloud = savedId
      ? cloudTranscriptsRef.current.get(`${projectKey(path)}\t${savedId}`)
      : undefined;
    const live = prefer
      ? liveTurnMessages({
          workspace: path,
          conversationId: prefer,
          runningWorkspace: runningWsRef.current,
          runningId: runningIdRef.current,
          live: turnMessagesRef.current,
          liveByChat: liveByChatRef.current,
        })
      : null;
    if (live && prefer) {
      const cached = liveByChatRef.current.get(prefer);
      const group = allProjectGroups.find((row) => isSameProject(row.path, path));
      showOpenedChatSettings(prefer, group?.conversations.find((row) => row.id === prefer));
      setActiveId(prefer);
      runningIdRef.current = prefer;
      setRunningId(prefer);
      abortRef.current = turnsRef.current.get(prefer) ?? null;
      setMessages(live);
      setStreamText(cached?.streamText ?? "");
      setStreamReasoning(cached?.streamReasoning ?? "");
      setLiveTools(cached?.liveTools ?? []);
      setRunningActivity(cached?.activity ?? null);
      setTurnStartedAt(runningTurns[prefer]?.startedAt ?? 0);
      showSubagents(prefer);
    } else if (savedCloud) {
      const body = (savedCloud.messages as ChatMessage[]) ?? [];
      const shown =
        savedCloud.compaction?.summary && savedCloud.compaction.through > 0
          ? insertCompactionEvent(body, savedCloud.compaction.through)
          : body;
      showChatSettings(entering?.conversations.find((row) => row.id === savedId));
      setActiveId(savedId);
      setMessages(shown);
      shownMessages.current.set(savedId, shown);
      setRunningActivity(null);
      setTurnStartedAt(0);
      hideSubagents();
    } else if (savedId && entering?.conversations.some((row) => row.id === savedId)) {
      // The clicked chat is in this project's list. Keep it selected while its
      // transcript loads, instead of painting the empty new-chat screen first.
      showChatSettings(entering.conversations.find((row) => row.id === savedId));
      setActiveId(savedId);
      setMessages([]);
      setRunningActivity(null);
      setTurnStartedAt(0);
      hideSubagents();
    } else {
      setActiveId("");
      setMessages([]);
      setRunningActivity(null);
      setTurnStartedAt(0);
      hideSubagents();
    }
  }
  saveWorkspace(path);
  setRecents(pushRecentWorkspace(path));
  setWorkspace(path);
  // A click already picked a chat. Resetting to a blank editor puts the Code tab
  // on screen and the conversation never appears. Keep the chat selected.
  setEditor((prev) => (savedId ? selectChatTab(prev) : emptyEditor()));
  setDirtyFiles({});
  setPendingClosePath(null);
  setDrafts({});
  setPastesByChat({});
  setDraftImages({});
  setUsageByChat({});
  setFolderOpen(false);
  // A linked checkout stays collapsed under its repo. Expanding it here is the
  // flash of a folder before the conversation settles back underneath.
  if (!isLinkedWorktreePath(path, worktreeListsFor(path))) expandProject(path);
}

const startNewChatRef = useRef<(kind?: ConversationKind, journeyId?: string) => void>(() => {});
/** Set by the shell. True when the chat is already in a split and was only focused. */
const revealListedChatRef = useRef<((id: string) => boolean) | null>(null);
const openSettingsRef = useRef(openSettings);

async function ensureChatPlan(path: string, id: string, modelId: string | null | undefined) {
  if (!path || !id || !providerProfile(modelId ?? "").planMode) return;
  if (planByChatRef.current.has(id)) return;
  try {
    const plan = grokPlanFromPayload(await api.grokPlan(path, id));
    const state = plan.found && planModeEngaged(plan.state) ? plan.state : "Inactive";
    planByChatRef.current.set(id, plan.found ? { ...plan, state, awaitingApproval: false } : emptyGrokPlan());
    onPlanChange?.();
  } catch {
    planByChatRef.current.set(id, emptyGrokPlan());
  }
}

async function startNewChat(kind: ConversationKind = "chat", journeyId?: string, path = workspace) {
  setShowSettings(false);
  setShowUsage(false);
  setShowDocs(false);
  setShowServers(false);
  setProjectSettings(null);
  if (!runningWsRef.current) hideSubagents();
  // A plain new chat stays off every project until the first prompt. The selector
  // only chooses where that prompt will be saved.
  if (kind === "chat" && !journeyId) {
    stickToBottomRef.current = true;
    setActiveId("");
    setMessages([]);
    stopHostedFollow();
    setStreamText("");
    setStreamReasoning("");
    setLiveTools([]);
    setRunningActivity(null);
    setTurnStartedAt(0);
    hideSubagents();
    retargetForegroundTurn("");
    setEditor((prev) => selectChatTab(prev));
    return;
  }
  if (!path) {
    setFolderOpen(true);
    return;
  }
  stickToBottomRef.current = true;
  const chosen = composerSettingsForChat(
    null,
    models,
    {
      model: model || loadModel(),
      effort: effort || defaultEffort || loadEffort(),
      contextWindow: contextWindow || loadContextWindow(),
      permission: permission || loadPermission(),
    },
  );
  if (chosen.model) saveModel(chosen.model);
  const conv = conversationDraft(kind, newConversationId(), nowIso(), journeyId, chosen.effort, {
    model: chosen.model,
    contextWindow: chosen.contextWindow,
    permission: chosen.permission,
  });
  // A cloud chat is created on the server by the first prompt. Saving the empty
  // draft here writes it into the local mount, and the sidebar shows it beside
  // the real conversation.
  if (isSameProject(path, workspace) && hostedChatsRef.current) {
    setActiveId("");
    setMessages([]);
    stopHostedFollow();
    setStreamText("");
    setStreamReasoning("");
    setLiveTools([]);
    setRunningActivity(null);
    setTurnStartedAt(0);
    hideSubagents();
    retargetForegroundTurn("");
    setEditor((prev) => selectChatTab(prev));
    saveConversation(path, "");
    return;
  }
  const rows = projectConversations(path);
  const journeysHere = projectJourneys(path);
  const sortOrder = journeyId
    ? nextTopSort(rows.filter((row) => row.journey_id === journeyId).map((row) => row.sort_order))
    : nextTopSort([
        ...rows.filter((row) => !row.journey_id).map((row) => row.sort_order),
        ...journeysHere.map((row) => row.sort_order),
      ]);
  const summary: ConversationSummary = {
    id: conv.id,
    title: conv.title,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    kind: conv.kind,
    journey_id: journeyId ?? null,
    sort_order: sortOrder,
    effort: conv.effort ?? null,
    model: conv.model ?? null,
    context_window: conv.context_window ?? null,
    permission: conv.permission ?? null,
  };
  await api.saveConversation(path, { ...conv, sort_order: sortOrder });
  saveConversation(path, conv.id);
  expandProject(path);
  if (!isSameProject(path, workspace)) {
    applyProjectData(path, [summary, ...rows.filter((row) => row.id !== conv.id)]);
    applyWorkspace(path);
    return;
  }
  setActiveId(conv.id);
  setMessages([]);
  setStreamText("");
  setStreamReasoning("");
  setLiveTools([]);
  setRunningActivity(null);
  setTurnStartedAt(0);
  hideSubagents();
  retargetForegroundTurn(conv.id);
  setEditor((prev) => selectChatTab(prev));
  setConversations((current) => [summary, ...current.filter((row) => row.id !== conv.id)]);
  if (kind === "chat") planByChatRef.current.set(conv.id, emptyGrokPlan());
}

async function openSidebarChat(path: string, id: string) {
  setShowSettings(false);
  setShowUsage(false);
  setShowDocs(false);
  setShowServers(false);
  setProjectSettings(null);
  if (!path) return;
  if (isSameProject(path, workspace)) {
    // A chat already in a split stays in that pair. The list click only focuses it.
    const kept = revealListedChatRef.current?.(id);
    if (kept) return;
    await openChat(id);
    return;
  }
  saveConversation(path, id);
  applyWorkspace(path);
  // Load against the project that was clicked. The hook still has the previous
  // project until this render lands, and fetching with that path misses the chat.
  // The switch used to bump the open generation, which made this load look stale
  // and return before it could clear Loading….
  await openChat(id, chatTabsByProjectRef.current, path);
}

/** Take a linked checkout out of the project list. The folder and its chats stay. */
async function forgetProjectRow(path: string) {
  if (!path) return;
  try {
    await api.removeProject(path);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    return;
  }
  setAllProjectGroups((prev) => removeProjectGroup(prev, path));
}

function rememberOpenedProject(path: string, name = "") {
  if (!path) return;
  setAllProjectGroups((prev) => {
    if (prev.some((group) => isSameProject(group.path, path))) return prev;
    return upsertProjectGroup(prev, path, { name: name || undefined, conversations: [], journeys: [] });
  });
  setRecents(pushRecentWorkspace(path));
}

function openProjectFromSidebar(path: string) {
  if (isSameProject(path, workspace)) {
    toggleProjectCollapsed(path);
    return;
  }
  applyWorkspace(path);
}

startNewChatRef.current = startNewChat;
openSettingsRef.current = openSettings;

useEffect(() => {
  function onKey(ev: KeyboardEvent) {
    if (isSettingsHotkey(ev, isMacOS())) {
      ev.preventDefault();
      openSettingsRef.current();
      return;
    }
    if (!isNewChatHotkey(ev, isMacOS())) return;
    ev.preventDefault();
    void startNewChatRef.current("chat");
  }
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}, []);

function composerFallback() {
  return {
    model: model || loadModel(),
    effort: effort || defaultEffort || loadEffort(),
    contextWindow: contextWindow || loadContextWindow(),
    permission: permission || loadPermission(),
  };
}

function applyComposerSettings(next: { model: string; effort: string; contextWindow: number; permission: string }) {
  if (next.model) setModel(next.model);
  if (next.effort) setEffort(next.effort);
  if (next.contextWindow) setContextWindow(next.contextWindow);
  setPermission(parsePermissionMode(next.permission));
}

function showChatSettings(row: {
  model?: string | null;
  effort?: string | null;
  context_window?: number | null;
  permission?: string | null;
} | null | undefined) {
  applyComposerSettings(
    composerSettingsForChat(
      {
        model: row?.model,
        effort: row?.effort,
        contextWindow: row?.context_window,
        permission: row?.permission,
      },
      models,
      composerFallback(),
    ),
  );
}

/**
 * Model the turn on screen is sending.
 * That chip belongs to the chat that was open when the turn started. A turn
 * started in the background keeps the model on its own row instead.
 */
function runningTurnModel(id: string): string {
  if (!chatHasRunningTurn(runningTurns, id)) return "";
  if ((runningIdRef.current || runningId) !== id) return "";
  if (activeIdRef.current && activeIdRef.current !== id) return "";
  return (modelRef.current || "").trim();
}

function showOpenedChatSettings(
  id: string,
  known: {
    model?: string | null;
    effort?: string | null;
    context_window?: number | null;
    permission?: string | null;
  } | null | undefined,
  saved?: {
    model?: string | null;
    effort?: string | null;
    context_window?: number | null;
    permission?: string | null;
  } | null,
) {
  const row = composerRowForOpen(
    {
      model: known?.model,
      effort: known?.effort,
      contextWindow: known?.context_window,
      permission: known?.permission,
    },
    saved
      ? {
          model: saved.model,
          effort: saved.effort,
          contextWindow: saved.context_window,
          permission: saved.permission,
        }
      : null,
    runningTurnModel(id),
  );
  showChatSettings({
    model: row.model,
    effort: row.effort,
    context_window: row.contextWindow,
    permission: row.permission,
  });
}

/** A running chat paints from memory and used to return before its saved model was read. */
function refreshOpenedChatSettings(id: string, path: string, generation: number) {
  const known = conversationsRef.current.find((row) => row.id === id) ?? conversations.find((row) => row.id === id);
  const load = hostedChatsRef.current ? api.getConversationById(id) : api.getConversation(path, id);
  void load.then((full) => {
    if (generation !== openGeneration.current || shownId.current !== id) return;
    if (full.compaction?.summary && full.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [id]: full.compaction! }));
    }
    showOpenedChatSettings(id, known, full);
  }).catch(() => undefined);
}

/** Point the composer at this chat's turn, or clear it when the chat is idle. Other turns keep running. */
function retargetForegroundTurn(id: string) {
  const shown = foregroundRunningId(runningTurns, id);
  runningIdRef.current = shown;
  setRunningId(shown);
  abortRef.current = shown ? (turnsRef.current.get(shown) ?? null) : null;
}

async function openChat(id: string, tabs = chatTabsByProjectRef.current, path = workspace) {
  const generation = ++openGeneration.current;
  setUnseenFinished((prev) => clearUnseenFinished(prev, id));
  setShowSettings(false);
  setShowUsage(false);
  setShowDocs(false);
  setShowServers(false);
  setProjectSettings(null);
  if (!path) return;
  stickToBottomRef.current = true;
  setEditor((prev) => (prev.focus === "chat" ? prev : selectChatTab(prev)));
  if (id === activeId) {
    // The list may still be mounting the tail. Pin on the next frame, after layout.
    requestAnimationFrame(() => scrollChatToEnd(scroller.current, stickToBottomRef.current));
    return;
  }
  // Both sides of a split stay mounted. Clicking one only changes which pane is
  // focused. Reloading it paints "Loading…" on a chat that is already on screen.
  const openTabs = tabs[tabProjectKey(path)] ?? [];
  const showing = splitGroupForChat(openTabs, activeId);
  const clicked = splitGroupForChat(openTabs, id);
  if (showing && clicked && showing.id === clicked.id) {
    focusVisibleSplitChat(id, activeId, splitPaneCache(id)?.messages ?? []);
    return;
  }
  const openLive = liveByChatRef.current.get(id);
  const parked = !openLive ? splitPaneCache(id) : null;
  if (openLive) {
    const turn = runningTurns[id];
    showOpenedChatSettings(id, conversationsRef.current.find((row) => row.id === id) ?? conversations.find((row) => row.id === id));
    setActiveId(id);
    runningIdRef.current = id;
    setRunningId(id);
    setMessages(openLive.messages);
    setStreamText(openLive.streamText);
    setStreamReasoning(openLive.streamReasoning);
    setLiveTools(openLive.liveTools);
    setRunningActivity(openLive.activity);
    setTurnStartedAt(turn?.startedAt ?? 0);
    showSubagents(id);
    abortRef.current = turnsRef.current.get(id) ?? null;
    refreshOpenedChatSettings(id, path, generation);
    saveConversation(path, id);
    return;
  }
  if (runningId === id && turnMessagesRef.current) {
    showOpenedChatSettings(id, conversationsRef.current.find((row) => row.id === id) ?? conversations.find((row) => row.id === id));
    setActiveId(id);
    runningIdRef.current = id;
    setRunningId(id);
    setMessages(turnMessagesRef.current);
    setStreamText(turnLiveRef.current.streamText);
    setStreamReasoning(turnLiveRef.current.streamReasoning);
    setLiveTools(turnLiveRef.current.liveTools);
    setRunningActivity(turnLiveRef.current.activity);
    setTurnStartedAt(runningTurns[id]?.startedAt ?? 0);
    showSubagents(id);
    refreshOpenedChatSettings(id, path, generation);
    saveConversation(path, id);
    return;
  }
  retargetForegroundTurn(id);
  if (parked?.messages.length) {
    setMessages(parked.messages);
    setStreamText(parked.streamText);
    setStreamReasoning(parked.streamReasoning);
    setLiveTools(parked.liveTools);
    setRunningActivity(parked.activity);
  }
  if (chatHasRunningTurn(runningTurns, id)) showSubagents(id);
  else hideSubagents();
  setStreamText("");
  setStreamReasoning("");
  setLiveTools([]);
  setRunningActivity(null);
  setTurnStartedAt(0);
  showOpenedChatSettings(id, conversationsRef.current.find((row) => row.id === id) ?? conversations.find((row) => row.id === id));
  const cached = shownMessages.current.get(id);
  const remembered = !cached && hostedChatsRef.current
    ? cloudTranscriptsRef.current.get(`${projectKey(path)}\t${id}`)
    : undefined;
  const painted = cached ?? (remembered ? messagesFromCached(remembered) : undefined);
  if (painted) {
    setMessages(painted);
    shownMessages.current.set(id, painted);
    if (remembered?.compaction?.summary && remembered.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [id]: remembered.compaction! }));
    }
  }
  setActiveId(id);
  // A cloud chat that is not in memory yet still reads the sqlite copy before SSH.
  const cachedLookup = hostedChatsRef.current && !painted
    ? api.hostedConversationCached(path, id).catch(() => null)
    : null;
  setOpeningId(painted ? "" : id);
  try {
    const cachedTranscript = cachedLookup ? await cachedLookup : null;
    if (generation !== openGeneration.current) return;
    if (cachedTranscript && shownId.current === id && !shownMessages.current.has(id)) {
      const cachedBody = (cachedTranscript.messages as ChatMessage[]) ?? [];
      const shown =
        cachedTranscript.compaction?.summary && cachedTranscript.compaction.through > 0
          ? insertCompactionEvent(cachedBody, cachedTranscript.compaction.through)
          : cachedBody;
      shownMessages.current.set(id, shown);
      setMessages(shown);
      setOpeningId("");
      if (cachedTranscript.compaction?.summary && cachedTranscript.compaction.through > 0) {
        setCompactionByChat((prev) => ({ ...prev, [id]: cachedTranscript.compaction! }));
      }
    }
    const full = hostedChatsRef.current
      ? await api.getHostedConversation(path, id)
      : await api.getConversation(path, id);
    if (generation !== openGeneration.current) return;
    const known = conversationsRef.current.find((row) => row.id === id) ?? conversations.find((row) => row.id === id);
    setConversations((rows) =>
      patchSidebarConversations(
        rows,
        rows.map((row) =>
          row.id === id
            ? {
                ...row,
                effort: full.effort ?? row.effort,
                model: full.model ?? row.model,
                context_window: full.context_window ?? row.context_window,
                permission: full.permission ?? row.permission,
              }
            : row,
        ),
      ),
    );
    if (generation !== openGeneration.current) return;
    showOpenedChatSettings(id, known, full);
    const loaded = await withBackfilledTimes(path, id, (full.messages as ChatMessage[]) ?? []);
    const withNotice =
      full.compaction?.summary && full.compaction.through > 0
        ? insertCompactionEvent(loaded, full.compaction.through)
        : loaded;
    shownMessages.current.set(id, withNotice);
    if (shownId.current === id) setMessages(withNotice);
    setUsageByChat((prev) => putChatUsage(prev, id, full.context_usage));
    if (full.compaction?.summary && full.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [id]: full.compaction! }));
    }
    if (loaded !== ((full.messages as ChatMessage[]) ?? []) || withNotice !== loaded) {
      void persist(withNotice, id, path, parseChatUsage(full.context_usage) ?? undefined, full.compaction, {
        touch: false,
      });
    }
    saveConversation(path, id);
    const opened = conversationsRef.current.find((row) => row.id === id);
    void ensureChatPlan(path, id, opened?.model);
    if (hostedChatsRef.current) {
      void watchHosted(path, id);
    }
  } finally {
    setOpeningId("");
  }
}

/** Move focus inside a split without fetching the chat again. The other pane keeps what it was showing. */
function focusVisibleSplitChat(id: string, fromId: string, shown: ChatMessage[]) {
  showOpenedChatSettings(id, conversationsRef.current.find((row) => row.id === id) ?? conversations.find((row) => row.id === id));
  const leaving = getLiveStream();
  if (fromId) {
    rememberSplitPane(fromId, {
      messages,
      streamText: leaving.streamText,
      streamReasoning: leaving.streamReasoning,
      liveTools: leaving.liveTools,
      activity: leaving.runningActivity,
    });
  }
  const parked = splitPaneCache(id);
  const running = chatHasRunningTurn(runningTurns, id);
  const kept = focusedSplitMessages(shown.length ? shown : (shownMessages.current.get(id) ?? []), parked?.messages);
  if (kept.length) rememberSplitPane(id, { messages: kept });
  setActiveId(id);
  retargetForegroundTurn(id);
  setMessages(kept);
  setLiveStream({
    streamText: parked?.streamText ?? "",
    streamReasoning: parked?.streamReasoning ?? "",
    liveTools: parked?.liveTools ?? [],
    runningActivity: parked?.activity ?? null,
  });
  if (fromId) {
    const left = splitPaneCache(fromId);
    setSecondaryLiveStream({
      streamText: left?.streamText ?? "",
      streamReasoning: left?.streamReasoning ?? "",
      liveTools: left?.liveTools ?? [],
      runningActivity: left?.activity ?? null,
    });
  }
  if (running) {
    setTurnStartedAt(runningTurns[id]?.startedAt ?? 0);
    showSubagents(id);
  } else {
    setTurnStartedAt(0);
    hideSubagents();
  }
  saveConversation(workspace, id);
}

function messagesFromCached(row: import("../lib/tauri").Conversation): ChatMessage[] {
  const body = (row.messages as ChatMessage[]) ?? [];
  return row.compaction?.summary && row.compaction.through > 0
    ? insertCompactionEvent(body, row.compaction.through)
    : body;
}

function stopHostedFollow() {
  followStopRef.current?.();
  followStopRef.current = null;
  if (followRef.current) void api.hostedUnfollow(followRef.current);
  followRef.current = "";
  followChatRef.current = "";
}

/** Join the open cloud chat. Frames arrive while it is on screen, including a turn already running. */
async function watchHosted(ws: string, id: string) {
  if (followChatRef.current === id && followRef.current) return;
  stopHostedFollow();
  followChatRef.current = id;
  const streamId = crypto.randomUUID();
  followRef.current = streamId;
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await api.onChat((ev) => {
      if (ev.stream_id !== streamId || followRef.current !== streamId) return;
      if (ev.kind === "delta" && ev.text) {
        if (!turnsRef.current.has(id)) {
          setRunningId(id);
          runningIdRef.current = id;
        }
        const live = liveByChatRef.current.get(id);
        const streamText = `${live?.streamText ?? ""}` + ev.text;
        liveByChatRef.current.set(id, {
          messages: live?.messages ?? [],
          streamText,
          streamReasoning: live?.streamReasoning ?? "",
          liveTools: live?.liveTools ?? [],
          activity: live?.activity ?? null,
        });
        if (shownId.current === id) setStreamText(streamText);
      } else if (ev.kind === "status" && ev.text) {
        const activity = { kind: "tool" as const, label: ev.text };
        const live = liveByChatRef.current.get(id);
        liveByChatRef.current.set(id, {
          messages: live?.messages ?? [],
          streamText: live?.streamText ?? "",
          streamReasoning: live?.streamReasoning ?? "",
          liveTools: live?.liveTools ?? [],
          activity,
        });
        if (shownId.current === id) setRunningActivity(activity);
      } else if (ev.kind === "done" && ev.conversation) {
        const messages = (ev.conversation.messages as ChatMessage[]) ?? [];
        if (messages.length) {
          shownMessages.current.set(id, messages);
          liveByChatRef.current.set(id, {
            messages,
            streamText: "",
            streamReasoning: "",
            liveTools: [],
            activity: null,
          });
          if (shownId.current === id) {
            setMessages(messages);
            setStreamText("");
            setRunningActivity(null);
          }
        } else {
          liveByChatRef.current.delete(id);
        }
      } else if (ev.kind === "idle" || ev.kind === "error") {
        if (shownId.current === id) setRunningActivity(null);
      }
    });
    if (followRef.current !== streamId) {
      unlisten();
      return;
    }
    followStopRef.current = unlisten;
    await api.hostedFollow(ws, streamId, id);
  } catch {
    unlisten?.();
    if (followRef.current === streamId) {
      followStopRef.current = null;
      followRef.current = "";
      followChatRef.current = "";
    }
  }
}

const finishEvents = new Map<string, { at: string; durationMs?: number | null }[]>();

async function withBackfilledTimes(ws: string, id: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (!messages.some((message) => message.role === "assistant" && !(message.finishedAt ?? "").trim())) {
    return messages;
  }
  let events = finishEvents.get(id);
  if (!events) {
    try {
      const rows = await api.usageList();
      events = rows
        .filter((row) => row.conversation_id === id && isSameProject(row.workspace_path, ws))
        .map((row) => ({ at: row.recorded_at, durationMs: row.duration_ms }));
    } catch {
      events = [];
    }
    finishEvents.set(id, events);
  }
  return backfillFinishedAt(messages, events);
}

async function archiveChat(id: string, archived = true, path = workspace) {
  if (!path) return;
  if (archived) {
    setPendingByChat((prev) => {
      const next = clearPendingForChat(prev, id);
      pendingRef.current = next;
      return next;
    });
    const turn = turnsRef.current.get(id);
    if (turn) turn.abort();
    else if (runningId === id) abortRef.current?.abort();
    await terminalSessions.dispose(id);
  }
  try {
    await api.archiveConversation(path, id, archived);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    return;
  }
  const patch = (rows: ConversationSummary[]) =>
    rows.map((row) => (row.id === id ? { ...row, archived } : row));
  if (isSameProject(path, workspace)) {
    setConversations(patch);
  } else {
    setAllProjectGroups((prev) =>
      upsertProjectGroup(prev, path, {
        conversations: patch(prev.find((group) => isSameProject(group.path, path))?.conversations ?? []),
      }),
    );
  }
  if (!archived) return;
  setChatTabsByProject((prev) => {
    const key = tabProjectKey(path);
    const tabs = prev[key];
    if (!tabs) return prev;
    const closed = closeTabChat(tabs, id);
    if (!closed.removed) return prev;
    return { ...prev, [key]: closed.items };
  });
  if (loadConversation(path) === id) saveConversation(path, "");
  if (isSameProject(path, workspace) && activeId === id) {
    await reloadConversations(workspace);
  }
}

async function removeChat(id: string, path = workspace) {
  if (!path) return;
  deletedIdsRef.current.add(id);
  setUnseenFinished((prev) => clearUnseenFinished(prev, id));
  setPendingByChat((prev) => {
    const next = clearPendingForChat(prev, id);
    pendingRef.current = next;
    return next;
  });
  const turn = turnsRef.current.get(id);
  if (turn) turn.abort();
  else if (runningId === id) abortRef.current?.abort();
  setUsageByChat((prev) => {
    if (!(id in prev)) return prev;
    const next = { ...prev };
    delete next[id];
    return next;
  });
  await terminalSessions.dispose(id);
  await api.deleteConversation(path, id);
  if (loadConversation(path) === id) saveConversation(path, "");
  if (isSameProject(path, workspace)) {
    if (activeId === id) {
      await reloadConversations(workspace);
    } else {
      setConversations((rows) => rows.filter((r) => r.id !== id));
    }
  } else {
    setAllProjectGroups((prev) =>
      upsertProjectGroup(prev, path, {
        conversations: (prev.find((group) => isSameProject(group.path, path))?.conversations ?? []).filter(
          (row) => row.id !== id,
        ),
      }),
    );
  }
}

type PersistPayload = {
  next: ChatMessage[];
  ws: string;
  usage?: ChatUsage;
  compaction?: { summary: string; through: number } | null;
  generation: number;
  /** Keep the sidebar age. A backfill save must not look like a new reply. */
  touch?: boolean;
};

async function writePersisted(id: string, payload: PersistPayload) {
  if (persistGen.current.get(id) !== payload.generation) return;
  if (!canPersistTurn(id, deletedIdsRef.current)) return;
  const { next, ws, usage, compaction } = payload;
  const title = conversationTitleFrom(next);
  const existing =
    conversationsRef.current.find((c) => c.id === id) ?? conversations.find((c) => c.id === id);
  const now = payload.touch === false ? (existing?.updated_at || nowIso()) : nowIso();
  const kind = parseConversationKind(existing?.kind);
  // Until an assistant reply exists, the composer chip is the model for this
  // chat. The row may still hold the model copied when the empty chat was created.
  const unanswered = !next.some((message) => message.role === "assistant");
  const chipModel = (modelRef.current || model || loadModel()).trim();
  const storedModel = (existing?.model ?? "").trim();
  const modelId = (unanswered ? chipModel || storedModel : storedModel || chipModel) || null;
  await api.saveConversation(ws, {
    id,
    title,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    kind,
    journey_id: existing?.journey_id ?? null,
    sort_order: existing?.sort_order ?? 0,
    effort: existing?.effort ?? null,
    model: modelId,
    context_window: existing?.context_window ?? null,
    permission: existing?.permission ?? null,
    archived: existing?.archived ?? false,
    messages: persistableMessages(next),
    context_usage: usageToPersist(usage, usageByChat[id]),
    compaction: persistableCompaction(compaction ?? compactionByChat[id]),
  });
  if (persistGen.current.get(id) !== payload.generation) return;
  const summary = {
    title,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    kind,
    effort: existing?.effort ?? null,
    model: modelId,
    context_window: existing?.context_window ?? null,
    permission: existing?.permission ?? null,
  };
  if (isSameProject(ws, workspaceRef.current)) {
    setConversations((rows) => {
      const prev = rows.find((row) => row.id === id);
      const nextRow = {
        id,
        ...summary,
        created_at: prev?.created_at ?? summary.created_at,
        journey_id: prev?.journey_id ?? existing?.journey_id ?? null,
        sort_order: prev?.sort_order ?? existing?.sort_order ?? 0,
        archived: prev?.archived ?? existing?.archived ?? false,
      };
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) return [nextRow, ...rows];
      // A turn save rewrites the same title on every step. Keep the row so the sidebar does not rebuild.
      return patchSidebarConversations(rows, rows.map((r, i) => (i === idx ? { ...r, ...nextRow } : r)));
    });
    return;
  }
  setAllProjectGroups((groups) =>
    renameConversationInGroups(groups, id, {
      ...summary,
      journey_id: existing?.journey_id ?? null,
      sort_order: existing?.sort_order ?? 0,
      archived: existing?.archived ?? false,
    }).groups,
  );
}

if (!persistTrail.current) {
  persistTrail.current = createPersistQueue<PersistPayload>({
    delay: PERSIST_TRAIL_MS,
    write: writePersisted,
  });
}

async function persist(
  next: ChatMessage[],
  id: string,
  ws = workspace,
  usage?: ChatUsage,
  compaction?: { summary: string; through: number } | null,
  options?: { flush?: boolean; touch?: boolean },
) {
  if (compaction?.summary && compaction.through > 0) {
    setCompactionByChat((prev) =>
      prev[id]?.summary === compaction.summary && prev[id]?.through === compaction.through
        ? prev
        : { ...prev, [id]: compaction },
    );
  }
  if (!canPersistTurn(id, deletedIdsRef.current)) return;
  if (!ws || !id) return;
  const generation = (persistGen.current.get(id) ?? 0) + 1;
  persistGen.current.set(id, generation);
  const trail = persistTrail.current!;
  const payload: PersistPayload = {
    next,
    ws,
    usage,
    compaction,
    generation,
    ...(options?.touch === false ? { touch: false } : {}),
  };
  // Tool steps only schedule. The turn's last save flushes so the await sees this payload.
  if (options?.flush) {
    const queued = trail.enqueue(id, payload).catch(() => undefined);
    await trail.flush(id);
    await queued;
    return;
  }
  await trail.enqueue(id, payload);
}

async function reorderChats(fromId: string, toId: string, path = workspace) {
  const rows = projectConversations(path);
  const from = rows.find((row) => row.id === fromId);
  const siblings = rows.filter((row) => (row.journey_id ?? null) === (from?.journey_id ?? null));
  const next = moveById(siblings, fromId, toId);
  if (next === siblings) return;
  if (!path) return;
  try {
    const saved = await api.reorderConversations(
      path,
      next.map((row) => row.id),
    );
    applyProjectData(path, saved);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    if (isSameProject(path, workspace)) await reloadConversations(workspace);
  }
}

async function reorderSidebar(
  fromId: string,
  fromKind: "journey" | "conversation",
  toId: string,
  toKind: "journey" | "conversation",
  path = workspace,
) {
  if (!path) return;
  const groupConversations = projectConversations(path);
  const groupJourneys = projectJourneys(path);
  const top: api.SidebarItem[] = [];
  const seen = new Set<string>();
  const ordered = [...groupJourneys.map((j) => ({ kind: "journey" as const, id: j.id, sort: j.sort_order })),
    ...groupConversations
      .filter((c) => !c.journey_id)
      .map((c) => ({ kind: "conversation" as const, id: c.id, sort: c.sort_order ?? 0 })),
  ].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  for (const row of ordered) {
    if (seen.has(`${row.kind}:${row.id}`)) continue;
    seen.add(`${row.kind}:${row.id}`);
    top.push({ kind: row.kind, id: row.id });
  }
  const fromIdx = top.findIndex((row) => row.id === fromId && row.kind === fromKind);
  const toIdx = top.findIndex((row) => row.id === toId && row.kind === toKind);
  if (fromIdx < 0 || toIdx < 0) return;
  const next = top.slice();
  const [item] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, item);
  try {
    const saved = await api.reorderSidebar(path, next);
    applyProjectData(path, saved, await api.listJourneys(path));
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    if (isSameProject(path, workspace)) await reloadConversations(workspace);
  }
}

async function createJourneyFromChat(id: string, path = workspace) {
  if (!path) return;
  const seed = projectConversations(path).find((row) => row.id === id);
  if (!seed || seed.journey_id || chatHasRunningTurn(runningTurns, id)) return;
  try {
    const journey = await api.createJourney(path, id);
    const [rows, nextJourneys] = await Promise.all([
      api.listConversations(path),
      api.listJourneys(path),
    ]);
    applyProjectData(path, rows, nextJourneys);
    if (!isSameProject(path, workspace)) return;
    const loaded = id === activeId
      ? null
      : hostedChatsRef.current
        ? await api.getConversationById(id)
        : await api.getConversation(path, id);
    const msgs = loaded ? ((loaded.messages as ChatMessage[]) ?? []) : messages;
    if (id !== activeId) await openChat(id);
    if (!conversationHasSummarizeSource(msgs)) return;
    const next = [...msgs, { role: "user" as const, content: JOURNEY_SUMMARIZE_PROMPT }];
    await runTurn(path, id, next, async (done) => {
      const text = lastAssistantText(done);
      if (!text) return;
      await api.saveJourneyKnowledge(path, journey.id, text);
      bumpFiles();
    }, journey.id);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

async function openJourneyKnowledge(id: string, path = workspace) {
  setShowSettings(false);
  setShowUsage(false);
  setShowDocs(false);
  setShowServers(false);
  setProjectSettings(null);
  if (path && !isSameProject(path, workspace)) {
    applyWorkspace(path);
    setEditor(() => pinEditorTab(emptyEditor(), journeyKnowledgePath(id)));
    return;
  }
  setEditor((prev) => pinEditorTab(prev, journeyKnowledgePath(id)));
}

async function toggleJourney(id: string, path = workspace) {
  const current = projectJourneys(path).find((row) => row.id === id);
  if (!current || !path) return;
  const collapsed = !current.collapsed;
  const nextJourneys = projectJourneys(path).map((row) => (row.id === id ? { ...row, collapsed } : row));
  if (isSameProject(path, workspace)) {
    setJourneys(nextJourneys);
  } else {
    setAllProjectGroups((prev) => upsertProjectGroup(prev, path, { journeys: nextJourneys }));
  }
  try {
    await api.setJourneyCollapsed(path, id, collapsed);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    if (isSameProject(path, workspace)) await reloadConversations(workspace);
  }
}

async function setJourneyColor(id: string, color: JourneyColor, path = workspace) {
  if (!path) return;
  const nextJourneys = projectJourneys(path).map((row) => (row.id === id ? { ...row, color } : row));
  if (isSameProject(path, workspace)) {
    setJourneys(nextJourneys);
  } else {
    setAllProjectGroups((prev) => upsertProjectGroup(prev, path, { journeys: nextJourneys }));
  }
  try {
    const next = await api.setJourneyColor(path, id, color);
    const painted = projectJourneys(path).map((row) =>
      row.id === id ? { ...row, color: parseJourneyColor(next.color) } : row,
    );
    if (isSameProject(path, workspace)) {
      setJourneys((rows) => rows.map((row) => (row.id === id ? { ...row, color: parseJourneyColor(next.color) } : row)));
    } else {
      setAllProjectGroups((prev) => upsertProjectGroup(prev, path, { journeys: painted }));
    }
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    if (isSameProject(path, workspace)) await reloadConversations(workspace);
  }
}

async function renameJourney(id: string, title: string, path = workspace) {
  if (!path) return;
  try {
    const next = await api.renameJourney(path, id, title);
    if (isSameProject(path, workspace)) {
      setJourneys((rows) => rows.map((row) => (row.id === id ? next : row)));
    } else {
      setAllProjectGroups((prev) =>
        upsertProjectGroup(prev, path, {
          journeys: (prev.find((group) => isSameProject(group.path, path))?.journeys ?? []).map((row) =>
            row.id === id ? next : row,
          ),
        }),
      );
    }
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

async function deleteJourney(id: string, deleteChats: boolean, path = workspace) {
  if (!path) return;
  const kids = projectConversations(path).filter((row) => row.journey_id === id);
  try {
    if (deleteChats) {
      for (const kid of kids) {
        deletedIdsRef.current.add(kid.id);
        setPending(clearPendingForChat(pendingRef.current, kid.id));
        const turn = turnsRef.current.get(kid.id);
        if (turn) turn.abort();
        else if (runningId === kid.id) abortRef.current?.abort();
        await terminalSessions.dispose(kid.id);
      }
    }
    await api.deleteJourney(path, id, deleteChats);
    if (isSameProject(path, workspace)) {
      setEditor((prev) => closeEditorTab(prev, journeyKnowledgePath(id)));
      setDirtyFiles((prev) => {
        const next = { ...prev };
        delete next[journeyKnowledgePath(id)];
        return next;
      });
      const prefer = deleteChats && kids.some((kid) => kid.id === activeId) ? undefined : activeId;
      await reloadConversations(workspace, prefer);
    } else {
      const [rows, nextJourneys] = await Promise.all([
        api.listConversations(path),
        api.listJourneys(path),
      ]);
      applyProjectData(path, rows, nextJourneys);
    }
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

async function moveConversation(id: string, journeyId: string | null, path = workspace) {
  if (!path) return;
  try {
    await api.moveConversation(path, id, journeyId);
    const [rows, nextJourneys] = await Promise.all([
      api.listConversations(path),
      api.listJourneys(path),
    ]);
    applyProjectData(path, rows, nextJourneys);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

  return {
    closeFileTab,
    openFolder,
    toggleProjectCollapsed,
    reorderProjects,
    clearWorkspace,
    deleteProjectFromSidebar,
    forgetProjectRow,
    adoptWorktreeName,
    applyWorkspace,
    assignDraftProject,
    startNewChat,
    openSidebarChat,
    openProjectFromSidebar,
    rememberOpenedProject,
    openChat,
    revealListedChatRef,
    toggleSubagent,
    archiveChat,
    removeChat,
    persist,
    watchHosted,
    reorderChats,
    reorderSidebar,
    createJourneyFromChat,
    openJourneyKnowledge,
    toggleJourney,
    setJourneyColor,
    renameJourney,
    deleteJourney,
    moveConversation,
  };
}
