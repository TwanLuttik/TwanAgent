import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { isMacOS } from "../../components/WindowButtons";
import { scrollChatToEnd } from "../../lib/chat-scroll";
import {
  conversationTitleFrom,
  moveById,
  newConversationId,
  nowIso,
  type ChatMessage,
} from "../../lib/dev";
import {
  expandCollapsedProject,
  isAppProject,
  isSameProject,
  removeProjectGroup,
  toggleCollapsedProject,
  upsertProjectGroup,
  type ProjectChatGroup,
} from "../../lib/dev-all-projects";
import { putChatUsage, usageToPersist, type ChatUsage } from "../../lib/dev-context";
import { closeEditorTab, emptyEditor, pinEditorTab, requestCloseEditorTab, selectChatTab, type EditorState } from "../../lib/dev-editor";
import { persistableCompaction, persistableMessages } from "../../lib/dev-image";
import {
  conversationHasSummarizeSource,
  JOURNEY_SUMMARIZE_PROMPT,
  journeyKnowledgePath,
  lastAssistantText,
  parseJourneyColor,
  type JourneyColor,
  type JourneySummary,
} from "../../lib/dev-journey";
import { conversationDraft, parseConversationKind, type ConversationKind } from "../../lib/dev-terminal-chat";
import { terminalSessions } from "../../lib/dev-terminal-sessions";
import { canPersistTurn, chatHasRunningTurn, clearPendingForChat, liveTurnMessages, type PendingMessage, type RunningTurn } from "../../lib/dev-turn";
import { isNewChatHotkey, isSettingsHotkey } from "../../lib/hotkeys";
import {
  loadDevConversation,
  pushDevRecentWorkspace,
  removeDevRecentWorkspace,
  saveCollapsedProjects,
  saveDevConversation,
  saveDevWorkspace,
  setAllProjects,
} from "../../lib/prefs";
import * as api from "../../lib/tauri";
import type { DevConversationSummary } from "../../lib/tauri";
import type { ConversationActivity, LiveToolRow } from "../../lib/dev";

type Update<T> = Dispatch<SetStateAction<T>>;

export type RunTurn = (
  ws: string,
  id: string,
  next: ChatMessage[],
  after?: (done: ChatMessage[]) => Promise<void>,
  journeyIdOverride?: string,
) => Promise<void>;

export type DevLibraryDeps = {
  workspace: string;
  conversations: DevConversationSummary[];
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
  openSettings: () => void;
  reloadConversations: (ws: string, preferId?: string) => Promise<void>;
  runTurn: RunTurn;
  scroller: RefObject<HTMLDivElement | null>;
  runningWsRef: RefObject<string>;
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
  stickToBottomRef: RefObject<boolean>;
  /** Bumped when the visible chat or project changes, so a late load cannot overwrite it. */
  openGeneration: RefObject<number>;
  setWorkspace: Update<string>;
  setConversations: Update<DevConversationSummary[]>;
  setJourneys: Update<JourneySummary[]>;
  setAllProjectGroups: Update<ProjectChatGroup[]>;
  setMessages: Update<ChatMessage[]>;
  setActiveId: Update<string>;
  setRunningId: Update<string>;
  setEditor: Update<EditorState>;
  setDirtyFiles: Update<Record<string, boolean>>;
  setPendingClosePath: Update<string | null>;
  setFolderOpen: Update<boolean>;
  setShowAllProjects: Update<boolean>;
  setShowSettings: Update<boolean>;
  setShowUsage: Update<boolean>;
  setProjectSettings: Update<{ path: string; name: string } | null>;
  setCollapsedProjects: Update<string[]>;
  setRecents: Update<string[]>;
  setDrafts: Update<Record<string, string>>;
  setDraftImages: Update<Record<string, import("../../lib/dev").ChatImage[]>>;
  setUsageByChat: Update<Record<string, ChatUsage>>;
  setStreamText: Update<string>;
  setStreamReasoning: Update<string>;
  setLiveTools: Update<LiveToolRow[]>;
  setRunningActivity: Update<ConversationActivity | null>;
  setTurnStartedAt: Update<number>;
  setSubagents: Update<import("../../lib/dev-subagent").SubagentRecord[]>;
  setExpandedAgents: Update<Record<string, boolean>>;
  setOpeningId: Update<string>;
  setPendingByChat: Update<Record<string, PendingMessage[]>>;
  setFlash: (flash: { kind: "ok" | "err"; text: string } | null) => void;
  bumpFiles: () => void;
};

export function useDevLibrary(deps: DevLibraryDeps) {
  const {
    workspace, conversations, journeys, allProjectGroups, messages, activeId, runningId, runningTurns, projectsRoot,
    legacyProjectsRoot,
    pendingClosePath, dirtyFiles, usageByChat, compactionByChat, setCompactionByChat, openSettings, reloadConversations, runTurn, scroller,
    runningWsRef, runningIdRef, abortRef, turnsRef, pendingRef, deletedIdsRef, turnMessagesRef, turnLiveRef, liveByChatRef, stickToBottomRef, openGeneration,
    setWorkspace, setConversations, setJourneys, setAllProjectGroups, setMessages, setActiveId, setRunningId, setEditor,
    setDirtyFiles, setPendingClosePath, setFolderOpen, setShowAllProjects, setShowSettings, setShowUsage, setProjectSettings,
    setCollapsedProjects, setRecents, setDrafts, setDraftImages, setUsageByChat, setStreamText, setStreamReasoning, setLiveTools,
    setRunningActivity, setTurnStartedAt,
    setSubagents, setExpandedAgents, setOpeningId, setPendingByChat, setFlash, bumpFiles,
  } = deps;

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

function setAllProjectsMode(on: boolean) {
  setShowAllProjects(on);
  setAllProjects(on);
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

function projectConversations(path: string): DevConversationSummary[] {
  if (isSameProject(path, workspace)) return conversations;
  return allProjectGroups.find((group) => isSameProject(group.path, path))?.conversations ?? [];
}

function projectJourneys(path: string): JourneySummary[] {
  if (isSameProject(path, workspace)) return journeys;
  return allProjectGroups.find((group) => isSameProject(group.path, path))?.journeys ?? [];
}

function applyProjectData(
  path: string,
  nextConversations: DevConversationSummary[],
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

function releaseProject(path: string) {
  void terminalSessions.disposeWorkspace(path);
  if (!isSameProject(runningWsRef.current, path)) return;
  abortRef.current?.abort();
  setSubagents([]);
  setExpandedAgents({});
}

function clearWorkspace() {
  releaseProject(workspace);
  saveDevWorkspace("");
  setWorkspace("");
  setEditor(emptyEditor());
  setDirtyFiles({});
  setPendingClosePath(null);
  if (!runningWsRef.current) {
    setSubagents([]);
    setExpandedAgents({});
  }
  setDrafts({});
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
    if (isAppProject(path, projectsRoot) || isAppProject(path, legacyProjectsRoot)) {
      await api.devDeleteProject(path);
    }
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    return;
  }
  saveDevConversation(path, "");
  const leftover = removeDevRecentWorkspace(path);
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
    void terminalSessions.disposeWorkspace(workspace);
    setStreamText("");
    setStreamReasoning("");
    setLiveTools([]);
    if (!isSameProject(runningWsRef.current, workspace)) {
      setSubagents([]);
      setExpandedAgents({});
    }
    const savedId = loadDevConversation(path);
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
    } else {
      setActiveId("");
      setMessages([]);
      setRunningActivity(null);
      setTurnStartedAt(0);
    }
  }
  saveDevWorkspace(path);
  setRecents(pushDevRecentWorkspace(path));
  setWorkspace(path);
  setEditor(emptyEditor());
  setDirtyFiles({});
  setPendingClosePath(null);
  setDrafts({});
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
  if (!runningWsRef.current) {
    setSubagents([]);
    setExpandedAgents({});
  }
  if (!path) {
    setFolderOpen(true);
    return;
  }
  stickToBottomRef.current = true;
  const conv = conversationDraft(kind, newConversationId(), nowIso(), journeyId);
  await api.devSaveConversation(path, conv);
  saveDevConversation(path, conv.id);
  if (!isSameProject(path, workspace)) {
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
  if (!chatHasRunningTurn(runningTurns, conv.id)) {
    runningIdRef.current = "";
    setRunningId("");
    abortRef.current = null;
  }
  setEditor((prev) => selectChatTab(prev));
  setConversations((rows) => [
    {
      id: conv.id,
      title: conv.title,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      kind: conv.kind,
      journey_id: journeyId ?? null,
      sort_order: 0,
    },
    ...rows,
  ]);
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
  saveDevConversation(path, id);
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

async function openChat(id: string) {
  const generation = ++openGeneration.current;
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
    setActiveId(id);
    runningIdRef.current = id;
    setRunningId(id);
    setMessages(openLive.messages);
    setStreamText(openLive.streamText);
    setStreamReasoning(openLive.streamReasoning);
    setLiveTools(openLive.liveTools);
    setRunningActivity(openLive.activity);
    setTurnStartedAt(turn?.startedAt ?? 0);
    abortRef.current = turnsRef.current.get(id) ?? null;
    void api.devGetConversation(workspace, id).then((full) => {
      if (full.compaction?.summary && full.compaction.through > 0) {
        setCompactionByChat((prev) => ({ ...prev, [id]: full.compaction! }));
      }
    }).catch(() => undefined);
    saveDevConversation(workspace, id);
    return;
  }
  if (runningId === id && turnMessagesRef.current) {
    setActiveId(id);
    runningIdRef.current = id;
    setRunningId(id);
    setMessages(turnMessagesRef.current);
    setStreamText(turnLiveRef.current.streamText);
    setStreamReasoning(turnLiveRef.current.streamReasoning);
    setLiveTools(turnLiveRef.current.liveTools);
    setRunningActivity(turnLiveRef.current.activity);
    setTurnStartedAt(runningTurns[id]?.startedAt ?? 0);
    saveDevConversation(workspace, id);
    return;
  }
  if (!chatHasRunningTurn(runningTurns, id) && !runningId) {
    setSubagents([]);
    setExpandedAgents({});
  }
  setStreamText("");
  setStreamReasoning("");
  setLiveTools([]);
  setRunningActivity(null);
  setTurnStartedAt(0);
  setOpeningId(id);
  try {
    const full = await api.devGetConversation(workspace, id);
    if (generation !== openGeneration.current) return;
    setActiveId(id);
    setMessages((full.messages as ChatMessage[]) ?? []);
    setUsageByChat((prev) => putChatUsage(prev, id, full.context_usage));
    if (full.compaction?.summary && full.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [id]: full.compaction! }));
    }
    saveDevConversation(workspace, id);
  } finally {
    setOpeningId("");
  }
}

async function removeChat(id: string, path = workspace) {
  if (!path) return;
  deletedIdsRef.current.add(id);
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
  await api.devDeleteConversation(path, id);
  if (loadDevConversation(path) === id) saveDevConversation(path, "");
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
  const title = conversationTitleFrom(next);
  const now = nowIso();
  const existing = conversations.find((c) => c.id === id);
  const kind = parseConversationKind(existing?.kind);
  await api.devSaveConversation(ws, {
    id,
    title,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    kind,
    journey_id: existing?.journey_id ?? null,
    sort_order: existing?.sort_order ?? 0,
    messages: persistableMessages(next),
    context_usage: usageToPersist(usage, usageByChat[id]),
    compaction: persistableCompaction(compaction ?? compactionByChat[id]),
  });
  setConversations((rows) => {
    const prev = rows.find((row) => row.id === id);
    const next = {
      id,
      title,
      created_at: prev?.created_at ?? existing?.created_at ?? now,
      updated_at: now,
      kind,
      journey_id: prev?.journey_id ?? existing?.journey_id ?? null,
      sort_order: prev?.sort_order ?? existing?.sort_order ?? 0,
    };
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return [next, ...rows];
    return rows.map((r, i) => (i === idx ? { ...r, ...next } : r));
  });
}

async function reorderChats(fromId: string, toId: string, path = workspace) {
  const rows = projectConversations(path);
  const from = rows.find((row) => row.id === fromId);
  const siblings = rows.filter((row) => (row.journey_id ?? null) === (from?.journey_id ?? null));
  const next = moveById(siblings, fromId, toId);
  if (next === siblings) return;
  if (!path) return;
  try {
    const saved = await api.devReorderConversations(
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
  const top: api.DevSidebarItem[] = [];
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
    const saved = await api.devReorderSidebar(path, next);
    applyProjectData(path, saved, await api.devListJourneys(path));
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
    const journey = await api.devCreateJourney(path, id);
    const [rows, nextJourneys] = await Promise.all([
      api.devListConversations(path),
      api.devListJourneys(path),
    ]);
    applyProjectData(path, rows, nextJourneys);
    if (!isSameProject(path, workspace)) return;
    const msgs = id === activeId ? messages : (((await api.devGetConversation(path, id)).messages as ChatMessage[]) ?? []);
    if (id !== activeId) await openChat(id);
    if (!conversationHasSummarizeSource(msgs)) return;
    const next = [...msgs, { role: "user" as const, content: JOURNEY_SUMMARIZE_PROMPT }];
    await runTurn(path, id, next, async (done) => {
      const text = lastAssistantText(done);
      if (!text) return;
      await api.devSaveJourneyKnowledge(path, journey.id, text);
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
    await api.devSetJourneyCollapsed(path, id, collapsed);
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
    const next = await api.devSetJourneyColor(path, id, color);
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
    const next = await api.devRenameJourney(path, id, title);
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
    await api.devDeleteJourney(path, id, deleteChats);
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
        api.devListConversations(path),
        api.devListJourneys(path),
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
    await api.devMoveConversation(path, id, journeyId);
    const [rows, nextJourneys] = await Promise.all([
      api.devListConversations(path),
      api.devListJourneys(path),
    ]);
    applyProjectData(path, rows, nextJourneys);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

  return {
    closeFileTab,
    openFolder,
    setAllProjectsMode,
    toggleProjectCollapsed,
    clearWorkspace,
    deleteProjectFromSidebar,
    applyWorkspace,
    startNewChat,
    openSidebarChat,
    openProjectFromSidebar,
    openChat,
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
