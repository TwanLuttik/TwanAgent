import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { isMacOS } from "../../components/WindowButtons";
import { scrollChatToEnd } from "../../lib/chat-scroll";
import {
  conversationTitleFrom,
  moveById,
  newConversationId,
  nowIso,
  projectKey,
  type ChatMessage,
} from "../../lib/core";
import {
  expandCollapsedProject,
  isAppProject,
  isSameProject,
  removeProjectGroup,
  renameConversationInGroups,
  toggleCollapsedProject,
  upsertProjectGroup,
  type ProjectChatGroup,
} from "../../lib/all-projects";
import { parseChatUsage, putChatUsage, usageToPersist, type ChatUsage } from "../../lib/context";
import { closeEditorTab, emptyEditor, pinEditorTab, requestCloseEditorTab, selectChatTab, type EditorState } from "../../lib/editor";
import { insertCompactionEvent } from "../../lib/compact";
import { persistableCompaction, persistableMessages } from "../../lib/image";
import {
  conversationHasSummarizeSource,
  JOURNEY_SUMMARIZE_PROMPT,
  journeyKnowledgePath,
  lastAssistantText,
  nextTopSort,
  parseJourneyColor,
  type JourneyColor,
  type JourneySummary,
} from "../../lib/journey";
import { forgetPaneWorkspace } from "../../lib/pane-sessions";
import { shellSessions } from "../../lib/shell-terminal";
import { conversationDraft, parseConversationKind, type ConversationKind } from "../../lib/terminal-chat";
import { terminalSessions } from "../../lib/terminal-sessions";
import { canPersistTurn, chatHasRunningTurn, clearPendingForChat, clearUnseenFinished, effortForModel, foregroundRunningId, liveTurnMessages, type PendingMessage, type RunningTurn } from "../../lib/turn";
import { isNewChatHotkey, isSettingsHotkey } from "../../lib/hotkeys";
import {
  loadConversation,
  loadEffort,
  pushRecentWorkspace,
  removeRecentWorkspace,
  saveCollapsedProjects,
  saveConversation,
  saveWorkspace,
} from "../../lib/prefs";
import * as api from "../../lib/tauri";
import type { ConversationSummary } from "../../lib/tauri";
import type { ConversationActivity, LiveToolRow } from "../../lib/core";
import { emptySubagentDock, toggleSubagentExpanded, type SubagentDockState } from "../../lib/subagent";

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
  models: { id: string; efforts?: { id: string }[]; default_effort?: string }[];
  defaultEffort: string;
  setEffort: Update<string>;
  openSettings: () => void;
  reloadConversations: (ws: string, preferId?: string) => Promise<void>;
  runTurn: RunTurn;
  scroller: RefObject<HTMLDivElement | null>;
  runningWsRef: RefObject<string>;
  /** Workspace currently on screen. Turn saves must follow this, not the workspace from when the turn started. */
  workspaceRef: RefObject<string>;
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
  stickToBottomRef: RefObject<boolean>;
  /** Latest sidebar rows, so a turn save does not write a stale journey or archive flag. */
  conversationsRef: RefObject<ConversationSummary[]>;
  /** Bumped when the visible chat or project changes, so a late load cannot overwrite it. */
  openGeneration: RefObject<number>;
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
  setProjectSettings: Update<{ path: string; name: string } | null>;
  setCollapsedProjects: Update<string[]>;
  setRecents: Update<string[]>;
  setDrafts: Update<Record<string, string>>;
  setPastesByChat: Update<Record<string, import("../../lib/paste").PasteBlock[]>>;
  setDraftImages: Update<Record<string, import("../../lib/core").ChatImage[]>>;
  setUsageByChat: Update<Record<string, ChatUsage>>;
  setStreamText: Update<string>;
  setStreamReasoning: Update<string>;
  setLiveTools: Update<LiveToolRow[]>;
  setRunningActivity: Update<ConversationActivity | null>;
  setTurnStartedAt: Update<number>;
  setSubagents: Update<import("../../lib/subagent").SubagentRecord[]>;
  setExpandedAgents: Update<Record<string, boolean>>;
  setOpeningId: Update<string>;
  setUnseenFinished: Update<ReadonlySet<string>>;
  setPendingByChat: Update<Record<string, PendingMessage[]>>;
  setChatTabsByProject: Update<Record<string, string[]>>;
  setFlash: (flash: { kind: "ok" | "err"; text: string } | null) => void;
  bumpFiles: () => void;
};

export function useLibrary(deps: LibraryDeps) {
  const {
    workspace, conversations, journeys, allProjectGroups, messages, activeId, runningId, runningTurns, projectsRoot,
    legacyProjectsRoot,
    pendingClosePath, dirtyFiles, usageByChat, compactionByChat, setCompactionByChat, model, models, defaultEffort, setEffort, openSettings, reloadConversations, runTurn, scroller,
    runningWsRef, runningIdRef, abortRef, turnsRef, pendingRef, deletedIdsRef, turnMessagesRef, turnLiveRef, liveByChatRef, subagentsByChatRef, stickToBottomRef, conversationsRef, openGeneration, workspaceRef,
    setWorkspace, setConversations, setJourneys, setAllProjectGroups, setMessages, setActiveId, setRunningId, setEditor,
    setDirtyFiles, setPendingClosePath, setFolderOpen, setShowSettings, setShowUsage, setProjectSettings,
    setCollapsedProjects, setRecents, setDrafts, setPastesByChat, setDraftImages, setUsageByChat, setStreamText, setStreamReasoning, setLiveTools,
    setRunningActivity, setTurnStartedAt,
    setSubagents, setExpandedAgents, setOpeningId, setUnseenFinished, setPendingByChat, setChatTabsByProject, setFlash, bumpFiles,
  } = deps;

  const persistQueue = useRef(new Map<string, Promise<void>>());
  const persistGen = useRef(new Map<string, number>());

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

function applyWorkspace(path: string) {
  if (!isSameProject(path, workspace)) {
    openGeneration.current += 1;
    setStreamText("");
    setStreamReasoning("");
    setLiveTools([]);
    if (!isSameProject(runningWsRef.current, workspace)) hideSubagents();
    const savedId = loadConversation(path);
    const foregroundHere =
      isSameProject(runningWsRef.current, path) &&
      runningIdRef.current &&
      liveByChatRef.current.has(runningIdRef.current);
    const prefer =
      (savedId && liveByChatRef.current.has(savedId) && savedId) ||
      (foregroundHere ? runningIdRef.current : "") ||
      "";
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
  setEditor(emptyEditor());
  setDirtyFiles({});
  setPendingClosePath(null);
  setDrafts({});
  setPastesByChat({});
  setDraftImages({});
  setUsageByChat({});
  setJourneys([]);
  setFolderOpen(false);
  expandProject(path);
}

const startNewChatRef = useRef<(kind?: ConversationKind, journeyId?: string) => void>(() => {});
const openSettingsRef = useRef(openSettings);

async function startNewChat(kind: ConversationKind = "chat", journeyId?: string, path = workspace) {
  setShowSettings(false);
  setShowUsage(false);
  setProjectSettings(null);
  if (!runningWsRef.current) hideSubagents();
  if (!path) {
    setFolderOpen(true);
    return;
  }
  stickToBottomRef.current = true;
  const conv = conversationDraft(kind, newConversationId(), nowIso(), journeyId, loadEffort());
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
}

async function openSidebarChat(path: string, id: string) {
  setShowSettings(false);
  setShowUsage(false);
  setProjectSettings(null);
  if (!path) return;
  if (isSameProject(path, workspace)) {
    await openChat(id);
    return;
  }
  saveConversation(path, id);
  applyWorkspace(path);
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

function showChatEffort(id: string) {
  const stored = conversations.find((row) => row.id === id)?.effort;
  const chosen = models.find((row) => row.id === model) ?? models[0];
  const next = effortForModel(stored, chosen?.efforts, defaultEffort || loadEffort());
  if (next) setEffort(next);
}

/** Point the composer at this chat's turn, or clear it when the chat is idle. Other turns keep running. */
function retargetForegroundTurn(id: string) {
  const shown = foregroundRunningId(runningTurns, id);
  runningIdRef.current = shown;
  setRunningId(shown);
  abortRef.current = shown ? (turnsRef.current.get(shown) ?? null) : null;
}

async function openChat(id: string) {
  const generation = ++openGeneration.current;
  setUnseenFinished((prev) => clearUnseenFinished(prev, id));
  setShowSettings(false);
  setShowUsage(false);
  setProjectSettings(null);
  if (!workspace) return;
  stickToBottomRef.current = true;
  setEditor((prev) => (prev.focus === "chat" ? prev : selectChatTab(prev)));
  if (id === activeId) {
    // The list may still be mounting the tail. Pin on the next frame, after layout.
    requestAnimationFrame(() => scrollChatToEnd(scroller.current, stickToBottomRef.current));
    return;
  }
  const openLive = liveByChatRef.current.get(id);
  if (openLive) {
    const turn = runningTurns[id];
    showChatEffort(id);
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
    void api.getConversation(workspace, id).then((full) => {
      if (full.compaction?.summary && full.compaction.through > 0) {
        setCompactionByChat((prev) => ({ ...prev, [id]: full.compaction! }));
      }
    }).catch(() => undefined);
    saveConversation(workspace, id);
    return;
  }
  if (runningId === id && turnMessagesRef.current) {
    showChatEffort(id);
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
    saveConversation(workspace, id);
    return;
  }
  retargetForegroundTurn(id);
  if (chatHasRunningTurn(runningTurns, id)) showSubagents(id);
  else hideSubagents();
  setStreamText("");
  setStreamReasoning("");
  setLiveTools([]);
  setRunningActivity(null);
  setTurnStartedAt(0);
  showChatEffort(id);
  setActiveId(id);
  setOpeningId(id);
  try {
    const full = await api.getConversation(workspace, id);
    if (generation !== openGeneration.current) return;
    const known = conversations.find((row) => row.id === id)?.effort;
    if (full.effort && full.effort !== known) {
      setConversations((rows) => rows.map((row) => (row.id === id ? { ...row, effort: full.effort } : row)));
    }
    const chosen = models.find((row) => row.id === model) ?? models[0];
    const nextEffort = effortForModel(full.effort || known, chosen?.efforts, defaultEffort || loadEffort());
    if (nextEffort) setEffort(nextEffort);
    const loaded = (full.messages as ChatMessage[]) ?? [];
    const withNotice =
      full.compaction?.summary && full.compaction.through > 0
        ? insertCompactionEvent(loaded, full.compaction.through)
        : loaded;
    setMessages(withNotice);
    setUsageByChat((prev) => putChatUsage(prev, id, full.context_usage));
    if (full.compaction?.summary && full.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [id]: full.compaction! }));
    }
    if (withNotice !== loaded) {
      void persist(withNotice, id, workspace, parseChatUsage(full.context_usage) ?? undefined, full.compaction);
    }
    saveConversation(workspace, id);
  } finally {
    setOpeningId("");
  }
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
    const key = projectKey(path);
    const tabs = prev[key];
    if (!tabs?.includes(id)) return prev;
    return { ...prev, [key]: tabs.filter((tab) => tab !== id) };
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

async function persist(
  next: ChatMessage[],
  id: string,
  ws = workspace,
  usage?: ChatUsage,
  compaction?: { summary: string; through: number } | null,
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
  const previous = persistQueue.current.get(id) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      if (persistGen.current.get(id) !== generation) return;
      if (!canPersistTurn(id, deletedIdsRef.current)) return;
      const title = conversationTitleFrom(next);
      const now = nowIso();
      const existing =
        conversationsRef.current.find((c) => c.id === id) ?? conversations.find((c) => c.id === id);
      const kind = parseConversationKind(existing?.kind);
      await api.saveConversation(ws, {
        id,
        title,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        kind,
        journey_id: existing?.journey_id ?? null,
        sort_order: existing?.sort_order ?? 0,
        effort: existing?.effort ?? null,
        archived: existing?.archived ?? false,
        messages: persistableMessages(next),
        context_usage: usageToPersist(usage, usageByChat[id]),
        compaction: persistableCompaction(compaction ?? compactionByChat[id]),
      });
      if (persistGen.current.get(id) !== generation) return;
      const summary = {
        title,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        kind,
        effort: existing?.effort ?? null,
      };
      if (isSameProject(ws, workspaceRef.current)) {
        setConversations((rows) => {
          const prev = rows.find((row) => row.id === id);
          const next = {
            id,
            ...summary,
            created_at: prev?.created_at ?? summary.created_at,
            journey_id: prev?.journey_id ?? existing?.journey_id ?? null,
            sort_order: prev?.sort_order ?? existing?.sort_order ?? 0,
            archived: prev?.archived ?? existing?.archived ?? false,
          };
          const idx = rows.findIndex((r) => r.id === id);
          if (idx < 0) return [next, ...rows];
          return rows.map((r, i) => (i === idx ? { ...r, ...next } : r));
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
    });
  persistQueue.current.set(id, run);
  await run;
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
    const msgs = id === activeId ? messages : (((await api.getConversation(path, id)).messages as ChatMessage[]) ?? []);
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
    clearWorkspace,
    deleteProjectFromSidebar,
    applyWorkspace,
    startNewChat,
    openSidebarChat,
    openProjectFromSidebar,
    openChat,
    toggleSubagent,
    archiveChat,
    removeChat,
    persist,
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
