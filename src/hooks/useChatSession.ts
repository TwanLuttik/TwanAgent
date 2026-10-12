import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { insertCompactionEvent } from "../lib/compact";
import { parseChatUsage, putChatUsage, type ChatUsage } from "../lib/context";
import type { ChatMessage, ConversationActivity, LiveToolRow } from "../lib/core";
import { clearLiveStream, setLiveStream } from "../lib/live-stream";
import { isArchivedConversation, isSameProject } from "../lib/all-projects";
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
  runningWsRef,
  runningIdRef,
  sidebarLoadedForRef,
  turnMessagesRef,
  turnLiveRef,
  liveByChatRef,
  subagentsByChatRef,
  stickToBottomRef,
  libraryRef,
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
  libraryRef: RefObject<{
    persist: (
      next: ChatMessage[],
      id: string,
      ws?: string,
      usage?: ChatUsage,
      compaction?: { summary: string; through: number } | null,
    ) => Promise<void>;
  } | null>;
}) {
  const reloadConversations = useCallback(
    async (ws: string, preferId?: string) => {
      if (!ws) {
        sidebarLoadedForRef.current = "";
        setConversations([]);
        setJourneys([]);
        setActiveId("");
        setMessages([]);
        return;
      }
      const rows = hostedChats ? await api.listHostedConversations(ws) : await api.listConversations(ws);
      if (!isSameProject(ws, workspaceRef.current)) return;
      if (conversationsRef.current.length === 0 && rows.length > 0) {
        setConversations(rows);
      }
      const nextJourneys = await api.listJourneys(ws).catch(() => [] as JourneySummary[]);
      if (!isSameProject(ws, workspaceRef.current)) return;
      sidebarLoadedForRef.current = ws;
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
      setJourneys(nextJourneys);
      const visible = rows.filter((row) => !isArchivedConversation(row));
      const saved = loadConversation(ws);
      const savedRow = rows.find((row) => row.id === saved);
      const want =
        preferId || (savedRow && !isArchivedConversation(savedRow) ? saved : "") || visible[0]?.id || "";
      if (!want) {
        setActiveId("");
        setMessages([]);
        return;
      }
      const found = rows.find((row) => row.id === want);
      if (!found) {
        setActiveId("");
        setMessages([]);
        return;
      }
      const full = hostedChats ? await api.getHostedConversation(ws, found.id) : await api.getConversation(ws, found.id);
      if (!isSameProject(ws, workspaceRef.current)) return;
      stickToBottomRef.current = true;
      setActiveId(found.id);
      setUnseenFinished((prev) => clearUnseenFinished(prev, found.id));
      const loaded = (full.messages as ChatMessage[]) ?? [];
      const withNotice =
        full.compaction?.summary && full.compaction.through > 0
          ? insertCompactionEvent(loaded, full.compaction.through)
          : loaded;
      const live = liveTurnMessages({
        workspace: ws,
        conversationId: found.id,
        runningWorkspace: runningWsRef.current,
        runningId: runningIdRef.current,
        live: turnMessagesRef.current,
        liveByChat: liveByChatRef.current,
      });
      setMessages(live ?? withNotice);
      if (!live && withNotice !== loaded) {
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
      runningWsRef,
      runningIdRef,
      sidebarLoadedForRef,
      turnMessagesRef,
      turnLiveRef,
      liveByChatRef,
      subagentsByChatRef,
      stickToBottomRef,
      libraryRef,
    ],
  );

  return reloadConversations;
}

/** Keep the latest value in a ref without an effect. A turn reads this, not the render that started it. */
export function useLiveRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
