import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { insertCompactionEvent } from "../lib/compact";
import { parseChatUsage, putChatUsage, type ChatUsage } from "../lib/context";
import type { ChatMessage, ConversationActivity, LiveToolRow } from "../lib/core";
import { clearLiveStream, setLiveStream } from "../lib/live-stream";
import { isArchivedConversation, isLocalCloudDraft, isSameProject, preferredOpenConversation } from "../lib/all-projects";
import type { JourneySummary } from "../lib/journey";
import { emptySubagentDock, type SubagentDockState } from "../lib/subagent";
import { parsePermissionMode, type PermissionMode } from "../lib/permission";
import {
  loadContextWindow,
  loadConversation,
  loadEffort,
  loadModel,
  loadPermission,
  saveConversation,
} from "../lib/prefs";
import { clearUnseenFinished, composerSettingsForChat, liveTurnMessages } from "../lib/turn";
import * as api from "../lib/tauri";
import type { ConversationSummary, Runtime } from "../lib/tauri";

type Update<T> = Dispatch<SetStateAction<T>>;

type LiveChat = {
  messages: ChatMessage[];
  streamText: string;
  streamReasoning: string;
  liveTools: LiveToolRow[];
  activity: ConversationActivity | null;
};

/**
 * Loads the open project's chats and the chat on screen. A turn that is still
 * streaming wins over the copy saved on disk.
 */
export function useChatSession({
  hostedChats,
  models,
  setConversations,
  setJourneys,
  setActiveId,
  setMessages,
  setUnseenFinished,
  setSubagents,
  setExpandedAgents,
  setUsageByChat,
  setCompactionByChat,
  setOpeningId,
  setModel,
  setEffort,
  setContextWindow,
  setPermission,
  journeysRef,
  workspaceRef,
  conversationsRef,
  activeIdRef,
  modelRef,
  effortRef,
  contextWindowRef,
  permissionRef,
  runningWsRef,
  runningIdRef,
  sidebarLoadedForRef,
  turnMessagesRef,
  turnLiveRef,
  liveByChatRef,
  subagentsByChatRef,
  stickToBottomRef,
  holdEmptyChatRef,
  libraryRef,
  cloudTranscriptsRef,
}: {
  hostedChats: boolean;
  models: Runtime["models"];
  setConversations: Update<ConversationSummary[]>;
  setJourneys: Update<JourneySummary[]>;
  setActiveId: Update<string>;
  setMessages: Update<ChatMessage[]>;
  setUnseenFinished: Update<ReadonlySet<string>>;
  setSubagents: Update<ReturnType<typeof emptySubagentDock>["agents"]>;
  setExpandedAgents: Update<Record<string, boolean>>;
  setUsageByChat: Update<Record<string, ChatUsage>>;
  setCompactionByChat: Update<Record<string, { summary: string; through: number }>>;
  setOpeningId?: Update<string>;
  setModel: Update<string>;
  setEffort: Update<string>;
  setContextWindow: Update<number>;
  setPermission: Update<PermissionMode>;
  workspaceRef: RefObject<string>;
  conversationsRef: RefObject<ConversationSummary[]>;
  activeIdRef: RefObject<string>;
  modelRef: RefObject<string>;
  effortRef: RefObject<string>;
  contextWindowRef: RefObject<number>;
  permissionRef: RefObject<PermissionMode>;
  journeysRef: RefObject<JourneySummary[]>;
  runningWsRef: RefObject<string>;
  runningIdRef: RefObject<string>;
  sidebarLoadedForRef: RefObject<string>;
  turnMessagesRef: RefObject<ChatMessage[] | null>;
  turnLiveRef: RefObject<{
    streamText: string;
    streamReasoning: string;
    liveTools: LiveToolRow[];
    activity: ConversationActivity | null;
  }>;
  liveByChatRef: RefObject<Map<string, LiveChat>>;
  subagentsByChatRef: RefObject<Map<string, SubagentDockState>>;
  stickToBottomRef: RefObject<boolean>;
  holdEmptyChatRef?: RefObject<boolean>;
  cloudTranscriptsRef: RefObject<Map<string, import("../lib/tauri").Conversation>>;
  libraryRef: RefObject<{
    persist: (
      next: ChatMessage[],
      id: string,
      ws?: string,
      usage?: ChatUsage,
      compaction?: { summary: string; through: number } | null,
    ) => Promise<void>;
    watchHosted?: (ws: string, id: string) => void;
  } | null>;
}) {
  const cachePaintedForRef = useRef("");

  const reloadConversations = useCallback(
    async (ws: string, preferId?: string) => {
      if (!ws) {
        sidebarLoadedForRef.current = "";
        cachePaintedForRef.current = "";
        setConversations([]);
        setJourneys([]);
        setActiveId("");
        setMessages([]);
        return;
      }
      // Paint the last server copy before this call waits on SSH. The live list
      // below replaces it. A second pass for the same project leaves the rows alone.
      if (hostedChats && !isSameProject(cachePaintedForRef.current, ws) && conversationsRef.current.length === 0) {
        try {
          const cached = await api.hostedSidebarCached(ws);
          if (!isSameProject(ws, workspaceRef.current)) return;
          rememberCloudTranscripts(cloudTranscriptsRef.current, ws, cached.transcripts);
          if (cached.conversations.length > 0 || cached.journeys.length > 0) {
            cachePaintedForRef.current = ws;
            sidebarLoadedForRef.current = ws;
            setConversations(cached.conversations);
            setJourneys(cached.journeys);
            const savedId = preferId || (holdEmptyChatRef?.current ? "" : loadConversation(ws));
            const row = cached.conversations.find((item) => item.id === savedId);
            const transcript = row ? cached.transcripts.find((item) => item.id === row.id) : undefined;
            if (row && transcript && !activeIdRef.current) {
              if (!isSameProject(ws, workspaceRef.current)) return;
              if (!activeIdRef.current) {
                const body = (transcript.messages as ChatMessage[]) ?? [];
                const shown =
                  transcript.compaction?.summary && transcript.compaction.through > 0
                    ? insertCompactionEvent(body, transcript.compaction.through)
                    : body;
                setActiveId(row.id);
                setMessages(shown);
                if (transcript.compaction?.summary && transcript.compaction.through > 0) {
                  setCompactionByChat((prev) => ({ ...prev, [row.id]: transcript.compaction! }));
                }
              }
            }
          }
        } catch {
          /* a missing copy just waits for the server */
        }
        if (!isSameProject(ws, workspaceRef.current)) return;
      }
      const loaded = hostedChats
        ? await api.listHostedConversations(ws)
        : await api.listConversations(ws);
      // The hosted list is the cloud project. An empty "New chat" only exists in the
      // local mount, saved before the server created the real conversation.
      const rows = hostedChats ? loaded.filter((row) => !isLocalCloudDraft(row)) : loaded;
      if (!isSameProject(ws, workspaceRef.current)) return;
      // A new chat has not joined a project yet. Its sidebar stays on the project
      // it was opened from, even when the selector points the first prompt elsewhere.
      // A click on another project's chat saves that id first, so the hold must
      // not keep the empty screen once a conversation is waiting to open.
      if (holdEmptyChatRef?.current && !preferId && !loadConversation(ws)) {
        return;
      }
      if (conversationsRef.current.length === 0 && rows.length > 0) {
        setConversations(rows);
      }
      // A cloud project's journeys are part of the cached server copy. The local
      // journey table is the empty mount, so reading it would wipe that copy.
      const nextJourneys = hostedChats ? [] : await api.listJourneys(ws).catch(() => [] as JourneySummary[]);
      if (!isSameProject(ws, workspaceRef.current)) return;
      sidebarLoadedForRef.current = ws;
      const keptJourneys = hostedChats ? journeysRef.current : nextJourneys;
      // A model switch on an empty chat updates the in-memory row before disk.
      // Replacing the list with the stale row would send the previous model.
      const fresh = conversationsRef.current;
      setConversations(
        rows.map((row) => {
          const live = fresh.find((item) => item.id === row.id);
          if (!live?.model || live.model === row.model) return row;
          return {
            ...row,
            model: live.model,
            effort: live.effort ?? row.effort,
            context_window: live.context_window ?? row.context_window,
            permission: live.permission ?? row.permission,
          };
        }),
      );
      setJourneys(keptJourneys);
      const visible = rows.filter((row) => !isArchivedConversation(row));
      const saved = loadConversation(ws);
      const savedRow = rows.find((row) => row.id === saved);
      const preferred = preferredOpenConversation(visible, savedRow && !isArchivedConversation(savedRow) ? saved : "");
      const want = preferId || preferred?.id || "";
      if (!want) {
        setActiveId("");
        setMessages([]);
        setOpeningId?.("");
        return;
      }
      const found = rows.find((row) => row.id === want);
      if (!found) {
        setActiveId("");
        setMessages([]);
        setOpeningId?.("");
        return;
      }
      const full = hostedChats
        ? await api.getHostedConversation(ws, found.id)
        : await api.getConversation(ws, found.id);
      if (!isSameProject(ws, workspaceRef.current)) return;
      stickToBottomRef.current = true;
      setActiveId(found.id);
      setUnseenFinished((prev) => clearUnseenFinished(prev, found.id));
      const transcript = (full.messages as ChatMessage[]) ?? [];
      const withNotice =
        full.compaction?.summary && full.compaction.through > 0
          ? insertCompactionEvent(transcript, full.compaction.through)
          : transcript;
      const live = liveTurnMessages({
        workspace: ws,
        conversationId: found.id,
        runningWorkspace: runningWsRef.current,
        runningId: runningIdRef.current,
        live: turnMessagesRef.current,
        liveByChat: liveByChatRef.current,
      });
      setMessages(live ?? withNotice);
      setOpeningId?.("");
      if (!live && withNotice !== transcript) {
        void libraryRef.current?.persist(
          withNotice,
          found.id,
          ws,
          parseChatUsage(full.context_usage) ?? undefined,
          full.compaction,
        );
      }
      if (live) {
        const cached = liveByChatRef.current.get(found.id);
        setLiveStream({
          streamText: cached?.streamText ?? turnLiveRef.current.streamText,
          streamReasoning: cached?.streamReasoning ?? turnLiveRef.current.streamReasoning,
          liveTools: cached?.liveTools ?? turnLiveRef.current.liveTools,
          runningActivity: cached?.activity ?? turnLiveRef.current.activity,
        });
      } else {
        clearLiveStream();
      }
      const dock = subagentsByChatRef.current.get(found.id) ?? emptySubagentDock();
      setSubagents(dock.agents);
      setExpandedAgents(dock.expanded);
      setUsageByChat((prev) => putChatUsage(prev, found.id, full.context_usage));
      if (full.compaction?.summary && full.compaction.through > 0) {
        setCompactionByChat((prev) => ({ ...prev, [found.id]: full.compaction! }));
      }
      saveConversation(ws, found.id);
      if (hostedChats) libraryRef.current?.watchHosted?.(ws, found.id);
      // Only retarget the composer when this reload actually opened a different chat.
      // Depending on `model` re-runs this after a chip change, and the row still has
      // the model copied at creation until the settings save lands.
      if (found.id === activeIdRef.current && modelRef.current) return;
      const next = composerSettingsForChat(
        {
          model: full.model ?? found.model,
          effort: full.effort ?? found.effort,
          contextWindow: full.context_window ?? found.context_window,
          permission: full.permission ?? found.permission,
        },
        models,
        {
          model: modelRef.current || loadModel(),
          effort: effortRef.current || loadEffort(),
          contextWindow: contextWindowRef.current || loadContextWindow(),
          permission: permissionRef.current || loadPermission(),
        },
      );
      if (next.model) {
        modelRef.current = next.model;
        setModel(next.model);
      }
      if (next.effort) {
        effortRef.current = next.effort;
        setEffort(next.effort);
      }
      if (next.contextWindow) {
        contextWindowRef.current = next.contextWindow;
        setContextWindow(next.contextWindow);
      }
      setPermission(parsePermissionMode(next.permission));
    },
    [
      hostedChats,
      models,
      setConversations,
      setJourneys,
      setActiveId,
      setMessages,
      setUnseenFinished,
      setSubagents,
      setExpandedAgents,
      setUsageByChat,
      setCompactionByChat,
      setOpeningId,
      setModel,
      setEffort,
      setContextWindow,
      setPermission,
      workspaceRef,
      conversationsRef,
      activeIdRef,
      modelRef,
      effortRef,
      contextWindowRef,
      permissionRef,
      journeysRef,
      runningWsRef,
      runningIdRef,
      sidebarLoadedForRef,
      turnMessagesRef,
      turnLiveRef,
      liveByChatRef,
      subagentsByChatRef,
      stickToBottomRef,
      holdEmptyChatRef,
      libraryRef,
      cloudTranscriptsRef,
    ],
  );

  return reloadConversations;
}

export function rememberCloudTranscripts(
  store: Map<string, import("../lib/tauri").Conversation>,
  workspace: string,
  rows: import("../lib/tauri").Conversation[],
) {
  const prefix = `${workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}\t`;
  // A sidebar pass can arrive before the full message copy. Keep what is already here.
  if (rows.length === 0) return;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
  for (const row of rows) {
    if (!row.id) continue;
    store.set(`${prefix}${row.id}`, row);
  }
}

/** Keep the latest value in a ref without an effect. A turn reads this, not the render that started it. */
export function useLiveRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
