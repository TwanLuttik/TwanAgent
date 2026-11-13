import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { isMacOS } from "../components/WindowButtons";
import { scrollChatToEnd } from "../lib/chat-scroll";
import { TRANSCRIPT_PAGE_MESSAGES, cachedTranscript, cachedTranscriptIsLoaded, openedTranscriptIsCurrent, rememberShownTranscript } from "../lib/chat-window";
import { beginTranscriptLoad, clearTranscriptPreview, setTranscriptPreview } from "../lib/transcript-open";
import {
  backfillFinishedAt,
  conversationTitleFrom,
  lastChatLine,
  moveById,
  nowIso,
  projectKey,
  type ChatMessage,
} from "../lib/core";
import {
  expandCollapsedProject,
  isLinkedWorktreePath,
  isSameProject,
  moveProjectGroup,
  patchSidebarConversations,
  prependChatInGroups,
  prependProjectChat,
  removeProjectGroup,
  renameConversationInGroups,
  toggleCollapsedProject,
  upsertProjectGroup,
  type ProjectChatGroup,
} from "../lib/all-projects";
import { parseChatUsage, putChatUsage, usageToPersist, type ChatUsage } from "../lib/context";
import { closeEditorTab, emptyEditor, requestCloseEditorTab, selectChatTab, type EditorState } from "../lib/editor";
import { insertCompactionEvent } from "../lib/compact";
import { persistableCompaction, persistableMessages } from "../lib/image";
import { forgetPaneWorkspace } from "../lib/pane-sessions";
import { getLiveStream, setLiveStream, setSecondaryLiveStream } from "../lib/live-stream";
import { closeTabChat, focusedSplitMessages, rememberSplitPane, splitGroupForChat, splitPaneCache, type TabItem } from "../lib/split-pane";
import { shellSessions } from "../lib/shell-terminal";

import { canPersistTurn, chatHasRunningTurn, clearPendingForChat, clearUnseenFinished, commitPartialReply, composerRowForOpen, composerSettingsForChat, foregroundRunningId, forgetUnsavedDraft, liveTurnMessages, mergeHostedTranscript, messagesShowStream, type PendingMessage, type RunningTurn } from "../lib/turn";
import { publishWorktreeList, worktreeForPath, worktreeListsFor } from "../lib/worktree";
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
  saveComposerDraft,
  saveComposerPastes,
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
) => Promise<void>;

export type LibraryDeps = {
  workspace: string;
  conversations: ConversationSummary[];
  allProjectGroups: ProjectChatGroup[];
  messages: ChatMessage[];
  activeId: string;
  runningId: string;
  runningTurns: Record<string, RunningTurn>;
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
  /** Latest sidebar rows, so a turn save does not write a stale archive flag. */
  conversationsRef: RefObject<ConversationSummary[]>;
  /** Bumped when the visible chat or project changes, so a late load cannot overwrite it. */
  openGeneration: RefObject<number>;
  /** Saved cloud transcripts, keyed by project and chat. A click paints from here. */
  cloudTranscriptsRef: RefObject<Map<string, import("../lib/tauri").Conversation>>;
  setWorkspace: Update<string>;
  setConversations: Update<ConversationSummary[]>;
  setAllProjectGroups: Update<ProjectChatGroup[]>;
  setMessages: Update<ChatMessage[]>;
  setActiveId: Update<string>;
  setRunningId: Update<string>;
  setEditor: Update<EditorState>;
  setDirtyFiles: Update<Record<string, boolean>>;
  setPendingClosePath: Update<string | null>;
  setFolderOpen: Update<boolean>;
  closeOverlays: () => void;
  dismissProjectSettings: (path: string, same: (left: string, right: string) => boolean) => void;
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
  setOpenTabs: Update<TabItem[]>;
  /** The global tab strip. A split chat is already visible, so focusing it must not reload. */
  openTabs?: TabItem[];
  /** Which project each open chat belongs to. Clicking the tab switches there. */
  tabHomesRef: RefObject<Record<string, string>>;
  rememberTabHome: (id: string, path: string) => void;
  /** Chats whose transcript is already on screen. Switching back must not fetch it again. */
  paintedChatsRef: RefObject<Set<string>>;
  /** The editor on screen, so a project switch can put it back later. */
  editorRef: RefObject<EditorState>;
  setFlash: (flash: { kind: "ok" | "err"; text: string } | null) => void;
  bumpFiles: () => void;
};

export function useLibrary(deps: LibraryDeps) {
  const {
    workspace, conversations, allProjectGroups, messages, activeId, runningId, runningTurns, hostedChats,
    pendingClosePath, dirtyFiles, usageByChat, compactionByChat, setCompactionByChat, model, effort, contextWindow, permission, models, defaultEffort, setModel, setEffort, setContextWindow, setPermission, openSettings, reloadConversations, scroller,
    runningWsRef, modelRef, activeIdRef, runningIdRef, abortRef, turnsRef, pendingRef, deletedIdsRef, turnMessagesRef, turnLiveRef, liveByChatRef, subagentsByChatRef, planByChatRef, onPlanChange, stickToBottomRef, conversationsRef, openGeneration, cloudTranscriptsRef, workspaceRef, sidebarLoadedForRef,
    setWorkspace, setConversations, setAllProjectGroups, setMessages, setActiveId, setRunningId, setEditor,
    setDirtyFiles, setPendingClosePath, setFolderOpen, closeOverlays, dismissProjectSettings,
    setCollapsedProjects, setRecents, setDrafts, setPastesByChat, setDraftImages, setUsageByChat, setStreamText, setStreamReasoning, setLiveTools,
    setRunningActivity, setTurnStartedAt,
    setSubagents, setExpandedAgents, setOpeningId, setUnseenFinished, setPendingByChat, setOpenTabs, setFlash, bumpFiles,
    tabHomesRef, rememberTabHome, paintedChatsRef, editorRef,
  } = deps;
  const openTabsRef = useRef<TabItem[]>(deps.openTabs ?? []);
  openTabsRef.current = deps.openTabs ?? openTabsRef.current;
  const editorsByProjectRef = useRef<Record<string, EditorState>>({});

  const hostedChatsRef = useRef(hostedChats);
  hostedChatsRef.current = hostedChats;
  const followRef = useRef("");
  const followChatRef = useRef("");
  const followStopRef = useRef<(() => void) | null>(null);
  const persistGen = useRef(new Map<string, number>());
  const persistTrail = useRef<ReturnType<typeof createPersistQueue<PersistPayload>> | null>(null);
  const shownMessages = useRef(new Map<string, ChatMessage[]>());
  const shownId = useRef(activeId);
  const shownList = useRef(messages);
  // The chat id we're already fetching. A second click on it must not cancel that fetch.
  const openingChatRef = useRef("");
  shownId.current = rememberShownTranscript(
    shownMessages.current,
    shownId.current,
    activeId,
    messages,
    shownList.current,
  );
  shownList.current = messages;

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

const expandProjectRef = useRef(expandProject);
expandProjectRef.current = expandProject;
useEffect(() => {
  let gone = false;
  let unlisten: (() => void) | undefined;
  void api.onConversationCreated((event) => {
    if (gone) return;
    try {
      const path = event.workspace;
      const chat = event.conversation;
      if (!path || !chat?.id) return;
      expandProjectRef.current(path);
      if (isSameProject(path, workspaceRef.current)) {
        setConversations((current) => {
          const next = prependProjectChat(current, chat);
          conversationsRef.current = next;
          return next;
        });
        return;
      }
      setAllProjectGroups((prev) => prependChatInGroups(prev, path, chat));
    } catch {
      /* a bad payload should not take the window down */
    }
  }).then((stop) => {
    if (gone) stop();
    else unlisten = stop;
  });
  return () => {
    gone = true;
    unlisten?.();
  };
}, [conversationsRef, setAllProjectGroups, setConversations, workspaceRef]);

function projectConversations(path: string): ConversationSummary[] {
  if (isSameProject(path, workspace)) return conversations;
  return allProjectGroups.find((group) => isSameProject(group.path, path))?.conversations ?? [];
}

function applyProjectData(path: string, nextConversations: ConversationSummary[]) {
  if (isSameProject(path, workspace)) {
    setConversations(nextConversations);
    return;
  }
  setAllProjectGroups((prev) => upsertProjectGroup(prev, path, { conversations: nextConversations }));
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
  setActiveId("");
  setMessages([]);
  setFolderOpen(false);
}

async function deleteProjectFromSidebar(path: string, mode: "list" | "files" | "worktrees" = "list") {
  if (mode === "worktrees") {
    try {
      await api.deleteProjectWorktrees(path);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      return;
    }
    return;
  }
  dismissProjectSettings(path, isSameProject);
  try {
    // Deleting files removes the folder. Removing from the list only forgets it,
    // including a project the app created. The folder stays until the user asks.
    if (mode === "files") {
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

function applyWorkspace(path: string, preferId = "", name = "", remote = false) {
  const savedId = preferId || loadConversation(path);
  // Create, clone, and open all land here. The sidebar list is loaded once at
  // startup, so a folder that did not exist then never appears unless we add it now.
  // A linked checkout stays under its repo instead of becoming its own project.
  if (!isLinkedWorktreePath(path, worktreeListsFor(path))) rememberOpenedProject(path, name, remote);
  if (!isSameProject(path, workspace)) {
    const entering = allProjectGroups.find((group) => isSameProject(group.path, path));
    // Show the project we are opening from the rows it already has, in this same
    // update. Clearing first would paint the empty gap onto the cloud project.
    if (entering && entering.conversations.length > 0) {
      setConversations(entering.conversations);
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
      paintedChatsRef.current.add(prefer);
    } else if (savedId && shownMessages.current.has(savedId)) {
      const shown = shownMessages.current.get(savedId) ?? [];
      showChatSettings(entering?.conversations.find((row) => row.id === savedId));
      setActiveId(savedId);
      setMessages(shown);
      paintedChatsRef.current.add(savedId);
      setRunningActivity(null);
      setTurnStartedAt(0);
      hideSubagents();
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
      paintedChatsRef.current.add(savedId);
      setRunningActivity(null);
      setTurnStartedAt(0);
      hideSubagents();
    } else if (savedId && entering?.conversations.some((row) => row.id === savedId)) {
      // The row is selected, but its transcript is not in memory yet. Clearing
      // the list here paints the empty new-chat screen. Keep the previous
      // messages until the cached copy arrives, and mark this chat as opening.
      showChatSettings(entering.conversations.find((row) => row.id === savedId));
      activeIdRef.current = savedId;
      setActiveId(savedId);
      setOpeningId(savedId);
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
  // Files belong to the project that was open. Put those back when we return,
  // instead of throwing them away and rebuilding the editor on the click.
  if (!isSameProject(path, workspace)) {
    const fromKey = projectKey(workspace);
    if (fromKey) editorsByProjectRef.current[fromKey] = editorRef.current;
    const restored = editorsByProjectRef.current[projectKey(path)];
    setEditor(savedId ? selectChatTab(restored ?? emptyEditor()) : (restored ?? emptyEditor()));
  } else if (savedId) {
    setEditor((prev) => selectChatTab(prev));
  }
  setPendingClosePath(null);
  setFolderOpen(false);
  // A linked checkout stays collapsed under its repo. Expanding it here is the
  // flash of a folder before the conversation settles back underneath.
  if (!isLinkedWorktreePath(path, worktreeListsFor(path))) expandProject(path);
}

const startNewChatRef = useRef<() => void>(() => {});
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

/** New chats share the empty composer id. Drop it so the next one starts blank. */
function forgetEmptyComposer() {
  saveComposerDraft("", "");
  saveComposerPastes("", []);
  setDrafts(forgetUnsavedDraft);
  setPastesByChat(forgetUnsavedDraft);
  setDraftImages(forgetUnsavedDraft);
}

async function startNewChat() {
  closeOverlays();
  if (!runningWsRef.current) hideSubagents();
  // A new chat stays off every project until the first prompt. The selector
  // only chooses where that prompt will be saved.
  stickToBottomRef.current = true;
  activeIdRef.current = "";
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
  // Every unsaved chat shares the empty id. A prompt that was just sent, or one
  // still sitting there, must not appear in the next new chat.
  forgetEmptyComposer();
}

async function openSidebarChat(path: string, id: string) {
  closeOverlays();
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
  await openChat(id, openTabsRef.current, path);
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

function rememberOpenedProject(path: string, name = "", remote = false) {
  if (!path) return;
  setAllProjectGroups((prev) => {
    if (prev.some((group) => isSameProject(group.path, path))) {
      if (!remote) return prev;
      return prev.map((group) => (isSameProject(group.path, path) ? { ...group, remote: true } : group));
    }
    return upsertProjectGroup(prev, path, {
      name: name || undefined,
      remote: remote || undefined,
      conversations: [],
      journeys: [],
    });
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

/** Open a folder even when it is already showing. Removing the open worktree leaves for the main checkout first. */
function switchToProject(path: string) {
  if (!path) return;
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
    void startNewChatRef.current();
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
    if (!openedTranscriptIsCurrent(generation, openGeneration.current, activeIdRef.current, id)) return;
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

function finishOpen(generation: number, id: string) {
  if (generation !== openGeneration.current || openingChatRef.current !== id) return;
  openingChatRef.current = "";
}

/**
 * The sidebar cache can be the tool rows from a turn that already saved its
 * reply. Opening that chat used to return before reading the database, so the
 * answer stayed missing until a restart.
 */
async function repairCachedReply(path: string, id: string, painted: ChatMessage[], generation: number) {
  try {
    const full = await api.getConversation(path, id);
    if (!openedTranscriptIsCurrent(generation, openGeneration.current, activeIdRef.current, id)) return;
    const disk = (full.messages as ChatMessage[]) ?? [];
    const merged = mergeHostedTranscript(painted, disk);
    if (merged === painted) return;
    shownMessages.current.set(id, merged);
    setMessages(merged);
  } catch {
    /* the cache stays; the next full read can still repair it */
  }
}

async function openChat(id: string, tabs = openTabsRef.current, path = workspace) {
  setUnseenFinished((prev) => clearUnseenFinished(prev, id));
  closeOverlays();
  const home = tabHomesRef.current[id];
  // A saved home can be another spelling of the folder this click already
  // named, such as a lowercased TwanAgent path. Using it would open that
  // spelling, then the canonical path would leave the file pane loading.
  if (home && !(path && isSameProject(home, path))) path = home;
  else if (path && home !== path) rememberTabHome(id, path);
  if (!path) return;
  if (!isSameProject(path, workspace)) applyWorkspace(path, id);
  stickToBottomRef.current = true;
  setEditor((prev) => (prev.focus === "chat" ? prev : selectChatTab(prev)));
  const here = isSameProject(path, workspace);
  // This transcript is already on screen. Returning before the generation bump
  // matters: the old check incremented first, so clicking the chat you were
  // leaving cancelled the load and both rows kept that transcript.
  // An empty screen is not proof this chat has no messages. Reloading is what
  // paints them. A chat that already has rows, or a turn that is running, stays.
  if (
    here &&
    id === activeIdRef.current &&
    shownId.current === id &&
    (messages.length > 0 || chatHasRunningTurn(runningTurns, id))
  ) {
    requestAnimationFrame(() => scrollChatToEnd(scroller.current, stickToBottomRef.current));
    return;
  }
  // A second click on the chat that is already opening. Bumping the generation
  // would drop its fetch, then the next click would no-op because the id matches.
  if (here && id === openingChatRef.current) return;
  const generation = ++openGeneration.current;
  const fromId = activeIdRef.current;
  openingChatRef.current = id;
  // Turns read this ref, not the render. Set it now so the chat we left cannot
  // paint its reply over the one just selected.
  activeIdRef.current = id;
  // Both sides of a split stay mounted. Clicking one only changes which pane is
  // focused. Reloading it paints "Loading…" on a chat that is already on screen.
  const showing = splitGroupForChat(tabs, fromId);
  const clicked = splitGroupForChat(tabs, id);
  if (showing && clicked && showing.id === clicked.id) {
    focusVisibleSplitChat(id, fromId, splitPaneCache(id)?.messages ?? []);
    finishOpen(generation, id);
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
    paintedChatsRef.current.add(id);
    finishOpen(generation, id);
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
    paintedChatsRef.current.add(id);
    finishOpen(generation, id);
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
  const cached = cachedTranscript(shownMessages.current, id, shownId.current, shownList.current);
  const remembered = !cached && hostedChatsRef.current
    ? cloudTranscriptsRef.current.get(`${projectKey(path)}\t${id}`)
    : undefined;
  const painted = cached ?? (remembered ? messagesFromCached(remembered) : undefined);
  const paintedLoaded = cachedTranscriptIsLoaded(painted);
  if (paintedLoaded) {
    setMessages(painted);
    shownMessages.current.set(id, painted);
    paintedChatsRef.current.add(id);
    if (remembered?.compaction?.summary && remembered.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [id]: remembered.compaction! }));
    }
  }
  // This chat was already on screen. Painting it is the whole switch. Fetching
  // the transcript again is what freezes the window between projects. A cloud
  // copy we just remembered still has to be read from the server.
  // A blank cache is not that copy: `[]` is truthy and used to skip the read.
  if (cachedTranscriptIsLoaded(cached)) {
    setActiveId(id);
    saveConversation(path, id);
    setOpeningId("");
    finishOpen(generation, id);
    // The cache can be the tool rows from before the reply was saved. The
    // database still has the answer, so read it without blocking the click.
    if (!hostedChatsRef.current) void repairCachedReply(path, id, cached, generation);
    return;
  }
  // A chat that is not in memory yet keeps the previous transcript for this one
  // frame. Swapping in an empty list here re-renders the whole chat on the click,
  // which is the pause before the sidebar row can highlight.
  setActiveId(id);
  saveConversation(path, id);
  // Read the saved copy and the server together. Waiting a frame, or waiting
  // for sqlite before SSH, is what lets the project reload download other chats first.
  const cachedLookup = hostedChatsRef.current && !painted
    ? api.hostedConversationCached(path, id).catch(() => null)
    : null;
  // A local chat reads the tail first. Starting the full read now would hold the
  // database lock, and the tail would wait behind every message in the chat.
  const serverLookup = hostedChatsRef.current
    ? api.getHostedConversation(path, id).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    : null;
  setOpeningId(paintedLoaded ? "" : id);
  const finishLoad = hostedChatsRef.current ? null : beginTranscriptLoad(id);
  try {
    if (generation !== openGeneration.current) return;
    if (!hostedChatsRef.current) {
      // The last turns are enough to paint. The full history follows, and send waits for it.
      const tail = await api.getConversation(path, id, TRANSCRIPT_PAGE_MESSAGES).catch(() => null);
      if (generation !== openGeneration.current) return;
      const tailMessages = (tail?.messages as ChatMessage[] | undefined) ?? [];
      if (
        tailMessages.length > 0 &&
        openedTranscriptIsCurrent(generation, openGeneration.current, activeIdRef.current, id)
      ) {
        setTranscriptPreview(id, tailMessages);
        setOpeningId("");
      }
    }
    if (generation !== openGeneration.current) return;
    const cachedTranscript = cachedLookup ? await cachedLookup : null;
    if (generation !== openGeneration.current) return;
    if (
      cachedTranscript &&
      openedTranscriptIsCurrent(generation, openGeneration.current, activeIdRef.current, id) &&
      !shownMessages.current.has(id)
    ) {
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
    const loaded = await (serverLookup ??
      api.getConversation(path, id).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ));
    if (!loaded.ok) throw loaded.error;
    const full = loaded.value;
    if (generation !== openGeneration.current) return;
    const known = conversationsRef.current.find((row) => row.id === id) ?? conversations.find((row) => row.id === id);
    const raw = (full.messages as ChatMessage[]) ?? [];
    const noticed =
      full.compaction?.summary && full.compaction.through > 0
        ? insertCompactionEvent(raw, full.compaction.through)
        : raw;
    // Paint before the usage lookup. That second read is what keeps the row
    // spinning and the previous chat on screen after this one is already loaded.
    const shown = hostedChatsRef.current
      ? mergeHostedTranscript(shownMessages.current.get(id) ?? liveByChatRef.current.get(id)?.messages ?? [], noticed)
      : noticed;
    shownMessages.current.set(id, shown);
    paintedChatsRef.current.add(id);
    // shownId still names the chat on screen until this list commits. The row
    // highlight already painted, so commit the transcript now. A transition
    // waits behind streaming updates and leaves that previous chat up.
    if (openedTranscriptIsCurrent(generation, openGeneration.current, activeIdRef.current, id)) {
      clearTranscriptPreview(id);
      setOpeningId("");
      setMessages(shown);
      finishLoad?.(shown);
    }
    showOpenedChatSettings(id, known, full);
    setUsageByChat((prev) => putChatUsage(prev, id, full.context_usage));
    if (full.compaction?.summary && full.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [id]: full.compaction! }));
    }
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
    void withBackfilledTimes(path, id, raw).then((loaded) => {
      if (!openedTranscriptIsCurrent(generation, openGeneration.current, activeIdRef.current, id)) return;
      const timed =
        full.compaction?.summary && full.compaction.through > 0
          ? insertCompactionEvent(loaded, full.compaction.through)
          : loaded;
      if (loaded === raw) return;
      const next = hostedChatsRef.current
        ? mergeHostedTranscript(shownMessages.current.get(id) ?? liveByChatRef.current.get(id)?.messages ?? [], timed)
        : timed;
      shownMessages.current.set(id, next);
      setMessages(next);
      if (loaded !== raw || timed !== loaded) {
        void persist(timed, id, path, parseChatUsage(full.context_usage) ?? undefined, full.compaction, {
          touch: false,
        });
      }
    });
    const opened = conversationsRef.current.find((row) => row.id === id);
    void ensureChatPlan(path, id, opened?.model);
    if (hostedChatsRef.current) {
      void watchHosted(path, id);
    }
  } finally {
    finishLoad?.(null);
    clearTranscriptPreview(id);
    if (generation === openGeneration.current) {
      finishOpen(generation, id);
      setOpeningId("");
    }
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
  activeIdRef.current = id;
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
        const incoming = (ev.conversation.messages as ChatMessage[]) ?? [];
        const live = liveByChatRef.current.get(id);
        const held = live?.messages ?? shownMessages.current.get(id) ?? [];
        // The follow socket replays the tail. A done from the turn before this
        // prompt is shorter than the messages already on screen, so it stays.
        const merged = mergeHostedTranscript(held, incoming);
        const partial = { text: live?.streamText ?? "", reasoning: live?.streamReasoning ?? "" };
        const messages = commitPartialReply(merged, partial);
        const covered = messagesShowStream(messages, partial.text, partial.reasoning);
        if (messages.length) {
          shownMessages.current.set(id, messages);
          liveByChatRef.current.set(id, {
            messages,
            streamText: covered ? "" : (live?.streamText ?? ""),
            streamReasoning: covered ? "" : (live?.streamReasoning ?? ""),
            liveTools: covered ? [] : (live?.liveTools ?? []),
            activity: null,
          });
          if (shownId.current === id) {
            setMessages(messages);
            if (covered) {
              setStreamText("");
              setStreamReasoning("");
            }
            setRunningActivity(null);
          }
        } else if (!held.length) {
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
      const rows = await api.usageForConversation(id, ws);
      events = rows.map((row) => ({ at: row.recorded_at, durationMs: row.duration_ms }));
    } catch {
      events = [];
    }
    finishEvents.set(id, events);
  }
  return backfillFinishedAt(messages, events);
}

async function archiveChats(targets: { path: string; id: string }[], archived = true) {
  const seen = new Set<string>();
  const rows = targets.filter((row) => {
    if (!row.path || !row.id) return false;
    const key = `${projectKey(row.path)}\t${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const failed: string[] = [];
  for (const row of rows) {
    const ok = await archiveChat(row.id, archived, row.path);
    if (!ok) failed.push(row.id);
  }
  if (failed.length && failed.length < rows.length) {
    setFlash({ kind: "err", text: `Archived ${rows.length - failed.length} of ${rows.length} chats.` });
  }
}

async function archiveChat(id: string, archived = true, path = workspace): Promise<boolean> {
  if (!path) return false;
  if (archived) {
    setPendingByChat((prev) => {
      const next = clearPendingForChat(prev, id);
      pendingRef.current = next;
      return next;
    });
    const turn = turnsRef.current.get(id);
    if (turn) turn.abort();
    else if (runningId === id) abortRef.current?.abort();
  }
  try {
    await api.archiveConversation(path, id, archived);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    return false;
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
  if (!archived) return true;
  setOpenTabs((prev) => {
    const closed = closeTabChat(prev, id);
    return closed.removed ? closed.items : prev;
  });
  if (loadConversation(path) === id) saveConversation(path, "");
  if (isSameProject(path, workspace) && activeId === id) {
    await reloadConversations(workspace);
  }
  return true;
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
  await api.deleteConversation(path, id);
  if (loadConversation(path) === id) saveConversation(path, "");
  if (isSameProject(path, workspace)) {
    if (activeId === id || activeIdRef.current === id) {
      // The reload skips a chat that is still the one on screen. Leaving this
      // id there keeps the deleted transcript up, with no row under it.
      if (activeIdRef.current === id) activeIdRef.current = "";
      paintedChatsRef.current.delete(id);
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
  // Old terminal chats are normal chats now. Saving one drops that kind.
  const kind = existing?.kind === "terminal" ? "chat" : existing?.kind || "chat";
  // Until an assistant reply exists, the composer chip is the model for this
  // chat. The row may still hold the model copied when the empty chat was created.
  const unanswered = !next.some((message) => message.role === "assistant");
  const chipModel = (modelRef.current || model || loadModel()).trim();
  const storedModel = (existing?.model ?? "").trim();
  const modelId = (unanswered ? chipModel || storedModel : storedModel || chipModel) || null;
  const saved = await api.saveConversation(ws, {
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
  const sortOrder = typeof saved.sort_order === "number" ? saved.sort_order : (existing?.sort_order ?? 0);
  const journeyId = saved.journey_id ?? existing?.journey_id ?? null;
  const archivedFlag = saved.archived ?? existing?.archived ?? false;
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
    preview: lastChatLine(next),
  };
  if (isSameProject(ws, workspaceRef.current)) {
    setConversations((rows) => {
      const prev = rows.find((row) => row.id === id);
      const nextRow = {
        id,
        ...summary,
        created_at: prev?.created_at ?? summary.created_at,
        journey_id: prev?.journey_id ?? journeyId,
        sort_order: sortOrder,
        archived: prev?.archived ?? archivedFlag,
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
      journey_id: journeyId,
      sort_order: sortOrder,
      archived: archivedFlag,
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
  const next = moveById(rows, fromId, toId);
  if (next === rows) return;
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
    switchToProject,
    rememberOpenedProject,
    openChat,
    revealListedChatRef,
    toggleSubagent,
    archiveChat,
    archiveChats,
    removeChat,
    persist,
    watchHosted,
    reorderChats,
  };
}
