import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { completeTurn } from "../../lib/agent";
import {
  activityFromToolCall,
  conversationTitleFrom,
  folderName,
  newConversationId,
  nowIso,
  stampTurnDuration,
  toolActivityLabel,
  toolDetail,
  toolFileChange,
  type ChatImage,
  type ChatMessage,
  type ConversationActivity,
  type LiveToolRow,
} from "../../lib/core";
import { contextWindowChoices, resolveContextWindow, sameChatUsage, type ChatUsage } from "../../lib/context";
import {
  MAX_PROMPT_IMAGES,
  appendPromptImages,
  canSendPrompt,
  fileToBase64,
  imagePathsFromDrop,
  imagesForChat,
  persistableImages,
  setImagesForChat,
} from "../../lib/image";
import { expandFileMentions, type MentionFile } from "../../lib/mention";
import { expandPasteTokens, type PasteBlock } from "../../lib/paste";
import { fileBaseName } from "../../lib/file-icon";
import type { DetectedMcpServer } from "../../lib/mcp";
import { parsePermissionMode, shouldPromptShell, type PermissionMode, type RemoteWorkspace } from "../../lib/permission";
import type { DetectedSkill } from "../../lib/skill";
import {
  applySubagentToChat,
  emptySubagentDock,
  type SubagentDockState,
  type SubagentRecord,
} from "../../lib/subagent";
import { parseConversationKind } from "../../lib/terminal-chat";
import { isTodoTool } from "../../lib/todo";
import {
  clearPendingForChat,
  closeDanglingToolCalls,
  clearUnseenFinished,
  effortForModel,
  isTurnFailureMessage,
  markUnseenFinished,
  enqueuePending,
  pendingIndexAfterRemove,
  removePending,
  restoreStoppedPrompt,
  setDraftForChat,
  shouldQueueForChat,
  takeNextPending,
  turnAppliesToChat,
  updatePending,
  type PendingEdit,
  type PendingMessage,
  type RunningTurn,
} from "../../lib/turn";
import {
  saveComposerDraft,
  saveComposerPastes,
  saveContextWindow,
  saveConversation,
  saveEffort,
  saveModel,
  savePermission,
} from "../../lib/prefs";
import * as api from "../../lib/tauri";
import type { ConversationSummary, Model, Runtime } from "../../lib/tauri";

type Update<T> = Dispatch<SetStateAction<T>>;
type ShellRequest = { chatId: string; command: string; resolve: (ok: boolean) => void };

export type TurnDeps = {
  workspace: string;
  activeId: string;
  messages: ChatMessage[];
  draft: string;
  draftPastes: PasteBlock[];
  promptImages: ChatImage[];
  mentionFiles: MentionFile[];
  busy: boolean;
  ready: boolean;
  runtime: Runtime | null;
  model: string;
  effort: string;
  contextWindow: number;
  models: Model[];
  conversations: ConversationSummary[];
  usageByChat: Record<string, ChatUsage>;
  compactionByChat: Record<string, { summary: string; through: number }>;
  persist: (
    next: ChatMessage[],
    id: string,
    ws?: string,
    usage?: ChatUsage,
    compaction?: { summary: string; through: number } | null,
  ) => Promise<void>;
  setFlash: (flash: { kind: "ok" | "err"; text: string } | null) => void;
  setModel: Update<string>;
  setEffort: Update<string>;
  setContextWindow: Update<number>;
  setPermission: Update<PermissionMode>;
  setDrafts: Update<Record<string, string>>;
  setPastesByChat: Update<Record<string, PasteBlock[]>>;
  setDraftImages: Update<Record<string, ChatImage[]>>;
  setPendingByChat: Update<Record<string, PendingMessage[]>>;
  setEditingPending: Update<PendingEdit | null>;
  setFolderOpen: Update<boolean>;
  setActiveId: Update<string>;
  setBusy: Update<boolean>;
  setRunningId: Update<string>;
  setRunningTurns: Update<Record<string, RunningTurn>>;
  setUnseenFinished: Update<ReadonlySet<string>>;
  viewingChatRef: RefObject<boolean>;
  setMessages: Update<ChatMessage[]>;
  setConversations: Update<ConversationSummary[]>;
  setTurnStartedAt: Update<number>;
  setStreamText: Update<string>;
  setStreamReasoning: Update<string>;
  setLiveTools: Update<LiveToolRow[]>;
  setRunningActivity: Update<ConversationActivity | null>;
  setSubagents: Update<SubagentRecord[]>;
  setExpandedAgents: Update<Record<string, boolean>>;
  setUsageByChat: Update<Record<string, ChatUsage>>;
  setUsageTick: Update<number>;
  bumpFiles: () => void;
  setShellQueue: Update<ShellRequest[]>;
  permissionRef: RefObject<PermissionMode>;
  activeIdRef: RefObject<string>;
  runningIdRef: RefObject<string>;
  runningWsRef: RefObject<string>;
  busyRef: RefObject<boolean>;
  abortRef: RefObject<AbortController | null>;
  turnsRef: RefObject<Map<string, AbortController>>;
  pendingRef: RefObject<Record<string, PendingMessage[]>>;
  editingRef: RefObject<PendingEdit | null>;
  deletedIdsRef: RefObject<Set<string>>;
  mcpServersRef: RefObject<DetectedMcpServer[]>;
  skillsRef: RefObject<DetectedSkill[]>;
  remoteRef: RefObject<RemoteWorkspace | null>;
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
};

export function bindTurn(deps: TurnDeps) {
  const {
    workspace, activeId, messages, draft, draftPastes, promptImages, mentionFiles, ready, runtime, model, effort, contextWindow, models,
    conversations, usageByChat, compactionByChat, persist, setFlash, setModel, setEffort, setContextWindow, setPermission, setDraftImages,
    setPendingByChat, setEditingPending, setFolderOpen, setActiveId, setBusy, setRunningId, setRunningTurns, setUnseenFinished, setMessages, setConversations, setDrafts, setPastesByChat, setTurnStartedAt,
    setStreamText, setStreamReasoning, setLiveTools, setRunningActivity, setSubagents, setExpandedAgents, setUsageByChat, setUsageTick, bumpFiles,
    setShellQueue, permissionRef, activeIdRef, runningIdRef, runningWsRef, busyRef, abortRef, turnsRef, pendingRef, editingRef,
    deletedIdsRef, mcpServersRef, skillsRef, remoteRef, turnMessagesRef, turnLiveRef, liveByChatRef, subagentsByChatRef, stickToBottomRef, viewingChatRef,
  } = deps;

function confirmShell(command: string, chatId = activeIdRef.current): Promise<boolean> {
  if (!shouldPromptShell(permissionRef.current)) {
    return Promise.resolve(permissionRef.current === "approve-all");
  }
  return new Promise((resolve) => setShellQueue((q) => [...q, { chatId, command, resolve }]));
}

function answerShell(ok: boolean) {
  const chatId = activeIdRef.current;
  setShellQueue((q) => {
    const index = q.findIndex((item) => item.chatId === chatId);
    if (index < 0) return q;
    const next = q.slice();
    const [item] = next.splice(index, 1);
    item?.resolve(ok);
    return next;
  });
}

function rejectShells(chatId: string) {
  setShellQueue((q) => {
    let changed = false;
    const next = q.filter((item) => {
      if (item.chatId !== chatId) return true;
      item.resolve(false);
      changed = true;
      return false;
    });
    return changed ? next : q;
  });
}

function pickModel(id: string) {
  setModel(id);
  saveModel(id);
  const next = models.find((m) => m.id === id);
  if (next && !next.efforts.some((e) => e.id === effort)) {
    const fallback = next.efforts[0]?.id ?? "";
    setEffort(fallback);
    if (fallback) {
      saveEffort(fallback);
      const chatId = activeIdRef.current;
      if (chatId && workspace) {
        setConversations((rows) => rows.map((row) => (row.id === chatId ? { ...row, effort: fallback } : row)));
        rememberChatEffort(chatId, fallback);
      }
    }
  }
  const choices = contextWindowChoices(next?.context_windows, next?.context_window);
  if (!contextWindow || !choices.includes(contextWindow)) {
    setContextWindow(resolveContextWindow(choices, 0, next?.context_window, id));
  }
}

function rememberChatEffort(chatId: string, next: string) {
  if (!chatId || !next) return;
  void api.getConversation(workspace, chatId).then((full) => {
    if (activeIdRef.current !== chatId) return;
    return api.saveConversation(workspace, { ...full, effort: next });
  }).then((saved) => {
    if (!saved || activeIdRef.current !== chatId) return;
    setConversations((rows) => rows.map((row) => (row.id === chatId ? { ...row, effort: next } : row)));
  }).catch((e) => {
    setFlash({ kind: "err", text: String(e) });
  });
}

function pickEffort(id: string) {
  const next = id.trim();
  if (!next) return;
  setEffort(next);
  saveEffort(next);
  const chatId = activeIdRef.current;
  if (!chatId || !workspace) return;
  setConversations((rows) => rows.map((row) => (row.id === chatId ? { ...row, effort: next } : row)));
  rememberChatEffort(chatId, next);
}

function pickContextWindow(tokens: number) {
  setContextWindow(tokens);
  saveContextWindow(tokens);
}

function pickPermission(id: string) {
  const next = parsePermissionMode(id);
  setPermission(next);
  savePermission(next);
  if (shouldPromptShell(next)) return;
  const ok = next === "approve-all";
  setShellQueue((q) => {
    for (const item of q) item.resolve(ok);
    return [];
  });
}

async function addPromptImages(files: File[]) {
  if (!files.length) return;
  const room = MAX_PROMPT_IMAGES - promptImages.length;
  if (room <= 0) {
    setFlash({ kind: "err", text: `You can attach up to ${MAX_PROMPT_IMAGES} images.` });
    return;
  }
  const take = files.slice(0, room);
  try {
    const prepared: ChatImage[] = [];
    for (const file of take) {
      const bytes = await fileToBase64(file);
      const next = await api.prepareImage(bytes, file.name || "image.png", activeId || undefined);
      prepared.push(next);
    }
    setDraftImages((prev) =>
      setImagesForChat(prev, activeId, appendPromptImages(imagesForChat(prev, activeId), prepared)),
    );
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

async function addPromptImagePaths(paths: string[]) {
  const images = imagePathsFromDrop(paths);
  if (!images.length) return;
  const room = MAX_PROMPT_IMAGES - promptImages.length;
  if (room <= 0) {
    setFlash({ kind: "err", text: `You can attach up to ${MAX_PROMPT_IMAGES} images.` });
    return;
  }
  const take = images.slice(0, room);
  try {
    const prepared: ChatImage[] = [];
    for (const path of take) {
      const next = await api.prepareImagePath(path, activeId || undefined);
      prepared.push({ ...next, name: next.name || fileBaseName(path) });
    }
    setDraftImages((prev) =>
      setImagesForChat(prev, activeId, appendPromptImages(imagesForChat(prev, activeId), prepared)),
    );
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
  }
}

function setPending(next: Record<string, PendingMessage[]>) {
  pendingRef.current = next;
  setPendingByChat(next);
}

function rememberLive(
  id: string,
  patch: Partial<{
    messages: ChatMessage[];
    streamText: string;
    streamReasoning: string;
    liveTools: LiveToolRow[];
    activity: ConversationActivity | null;
  }>,
) {
  const prev = liveByChatRef.current.get(id) ?? {
    messages: [],
    streamText: "",
    streamReasoning: "",
    liveTools: [],
    activity: null,
  };
  const next = { ...prev, ...patch };
  liveByChatRef.current.set(id, next);
  if (runningIdRef.current === id) {
    turnMessagesRef.current = next.messages;
    turnLiveRef.current = {
      streamText: next.streamText,
      streamReasoning: next.streamReasoning,
      liveTools: next.liveTools,
      activity: next.activity,
    };
  }
  return next;
}

function showSubagents(id: string) {
  const dock = subagentsByChatRef.current.get(id) ?? emptySubagentDock();
  setSubagents(dock.agents);
  setExpandedAgents(dock.expanded);
}

function showLive(id: string) {
  if (!turnAppliesToChat(id, activeIdRef.current)) return;
  const live = liveByChatRef.current.get(id);
  if (!live) return;
  setMessages(live.messages);
  setStreamText(live.streamText);
  setStreamReasoning(live.streamReasoning);
  setLiveTools(live.liveTools);
  setRunningActivity(live.activity);
  setRunningId(id);
  showSubagents(id);
}

function markRunning(id: string, patch: Partial<RunningTurn> = {}) {
  setRunningTurns((prev) => {
    const current = prev[id] ?? { activity: null, startedAt: Date.now() };
    return { ...prev, [id]: { ...current, ...patch } };
  });
}

function clearRunning(id: string) {
  setRunningTurns((prev) => {
    if (!(id in prev)) return prev;
    const next = { ...prev };
    delete next[id];
    return next;
  });
}

function syncRunningFromTurns() {
  const ids = [...turnsRef.current.keys()];
  busyRef.current = ids.length > 0;
  setBusy(ids.length > 0);
  if (ids.length === 0) {
    runningWsRef.current = "";
    runningIdRef.current = "";
    abortRef.current = null;
    setRunningId("");
    return;
  }
  const visible = activeIdRef.current;
  const shown = ids.includes(visible) ? visible : runningIdRef.current;
  if (!shown || !ids.includes(shown)) return;
  runningIdRef.current = shown;
  abortRef.current = turnsRef.current.get(shown) ?? null;
  setRunningId(shown);
}

function takeLivePending(finishedId: string) {
  while (true) {
    const taken = takeNextPending(pendingRef.current, finishedId, editingRef.current);
    setPending(taken.pending);
    if (!taken.chatId || !taken.item) return null;
    if (deletedIdsRef.current.has(taken.chatId)) {
      setPending(clearPendingForChat(pendingRef.current, taken.chatId));
      continue;
    }
    return taken;
  }
}

function rememberEdit(next: PendingEdit | null) {
  editingRef.current = next;
  setEditingPending(next);
}

async function continueWithPending(finishedId: string, ws: string, latestMessages: ChatMessage[]) {
  const queued = takeLivePending(finishedId);
  if (!queued) return false;
  let msgs = latestMessages;
  if (queued.chatId !== finishedId) {
    try {
      const full = await api.getConversation(ws, queued.chatId);
      msgs = (full.messages as ChatMessage[]) ?? [];
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      return false;
    }
  }
  await runTurn(ws, queued.chatId, [
    ...msgs,
    userMessage(queued.item.text, queued.item.images ?? []),
  ]);
  return true;
}

function flushPending(chatId: string) {
  if (!workspace || !chatId || turnsRef.current.has(chatId)) return;
  void continueWithPending(chatId, workspace, messages);
}

function closePendingEdit(chatId: string) {
  rememberEdit(null);
  if (!busyRef.current) flushPending(chatId);
}

function beginPendingEdit(index: number) {
  rememberEdit({ chatId: activeId, index });
}

function savePendingEdit(index: number, text: string) {
  const chatId = activeId;
  const saved = updatePending(pendingRef.current, chatId, index, text);
  if (!saved.saved) return;
  setPending(saved.pending);
  closePendingEdit(chatId);
}

function removePendingAt(index: number) {
  const chatId = activeId;
  const editing = editingRef.current?.chatId === chatId ? editingRef.current.index : null;
  setPending(removePending(pendingRef.current, chatId, index));
  const nextIndex = pendingIndexAfterRemove(editing, index);
  if (editing == null) return;
  if (nextIndex == null) closePendingEdit(chatId);
  else rememberEdit({ chatId, index: nextIndex });
}

function clearPrompt(id: string) {
  saveComposerDraft(id, "");
  saveComposerPastes(id, []);
  setDrafts((prev) => setDraftForChat(prev, id, ""));
  setPastesByChat((prev) => {
    if (!(id in prev)) return prev;
    const next = { ...prev };
    delete next[id];
    return next;
  });
  setDraftImages((prev) => {
    let next = setImagesForChat(prev, activeId, []);
    if (id !== activeId) next = setImagesForChat(next, id, []);
    return next;
  });
}

function userMessage(text: string, images: ChatImage[]): ChatMessage {
  return images.length ? { role: "user", content: text, images } : { role: "user", content: text };
}

function fillPrompt(id: string, text: string, images: ChatImage[]) {
  saveComposerDraft(id, text);
  setDrafts((prev) => setDraftForChat(prev, id, text));
  setDraftImages((prev) => setImagesForChat(prev, id, images));
}

/** Put the stopped turn's user message back in the composer and drop it from the transcript. */
function restorePrompt(id: string, messages: ChatMessage[]): ChatMessage[] | null {
  const restored = restoreStoppedPrompt(messages);
  if (!restored) return null;
  fillPrompt(id, restored.text, restored.images);
  return restored.messages;
}

async function send() {
  const text = expandFileMentions(expandPasteTokens(draft, draftPastes), mentionFiles).trim();
  const images = persistableImages(promptImages);
  if (!canSendPrompt(text, images)) return;
  if (remoteRef.current && remoteRef.current.online === false) {
    setFlash({
      kind: "err",
      text: `${remoteRef.current.machineName} is offline. Messages stay here until it answers.`,
    });
    return;
  }
  if (!ready) {
    setFlash({ kind: "err", text: runtime?.hint || "Grok isn’t signed in." });
    return;
  }
  let ws = workspace;
  if (!ws) {
    setFolderOpen(true);
    return;
  }
  try {
    ws = await api.openFolder(ws);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    return;
  }
  let id = activeId;
  if (!id) {
    const now = nowIso();
    id = newConversationId();
    await api.saveConversation(ws, {
      id,
      title: conversationTitleFrom([userMessage(text, images)]),
      created_at: now,
      updated_at: now,
      kind: "chat",
      effort: effort || null,
      messages: [],
    });
    setActiveId(id);
    activeIdRef.current = id;
    saveConversation(ws, id);
  }
  stickToBottomRef.current = true;
  clearPrompt(id);
  if (shouldQueueForChat(runningIdRef.current, id) || turnsRef.current.has(id)) {
    setPending(enqueuePending(pendingRef.current, id, text, images));
    return;
  }
  let history = closeDanglingToolCalls(messages);
  if (!turnAppliesToChat(id, activeIdRef.current)) {
    try {
      const full = await api.getConversation(ws, id);
      history = closeDanglingToolCalls((full.messages as ChatMessage[]) ?? []);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      return;
    }
  }
  await runTurn(ws, id, [...history, userMessage(text, images)]);
}

async function runTurn(
  ws: string,
  id: string,
  next: ChatMessage[],
  after?: (done: ChatMessage[]) => Promise<void>,
  journeyIdOverride?: string,
) {
  rememberLive(id, { messages: next, streamText: "", streamReasoning: "", liveTools: [], activity: null });
  showLive(id);
  const ac = new AbortController();
  const previous = turnsRef.current.get(id);
  previous?.abort();
  turnsRef.current.set(id, ac);
  let stoppedByUser = false;
  ac.signal.addEventListener("abort", () => {
    stoppedByUser = true;
  });
  busyRef.current = true;
  setBusy(true);
  const startedAt = Date.now();
  markRunning(id, { activity: null, startedAt });
  setUnseenFinished((prev) => clearUnseenFinished(prev, id));
  const foreground = turnAppliesToChat(id, activeIdRef.current);
  if (foreground) {
    setRunningId(id);
    runningIdRef.current = id;
    runningWsRef.current = ws;
    abortRef.current = ac;
    setStreamText("");
    setStreamReasoning("");
    setLiveTools([]);
    setRunningActivity(null);
    setTurnStartedAt(startedAt);
  } else if (!runningIdRef.current) {
    runningWsRef.current = ws;
  }
  const visible = () => turnAppliesToChat(id, activeIdRef.current);
  let latestMessages = closeDanglingToolCalls(next);
  let latestUsage = usageByChat[id];
  let latestCompaction: { summary: string; through: number } | null = compactionByChat[id] ?? null;
  let persistQueue = Promise.resolve();
  const saveMessages = (snapshot: ChatMessage[]) => {
    latestMessages = snapshot;
    persistQueue = persistQueue
      .then(() => persist(snapshot, id, ws, latestUsage, latestCompaction))
      .catch(() => undefined);
  };
  const journeyId =
    journeyIdOverride || conversations.find((row) => row.id === id)?.journey_id || undefined;
  const kind = parseConversationKind(conversations.find((row) => row.id === id)?.kind);
  let knowledge = "";
  if (journeyId && kind === "chat") {
    try {
      knowledge = await api.getJourneyKnowledge(ws, journeyId);
    } catch {
      knowledge = "";
    }
  }
  try {
    const done = await completeTurn({
      workspace: ws,
      messages: next,
      model,
      effort: effortForModel(
        conversations.find((row) => row.id === id)?.effort || effort,
        models.find((row) => row.id === model)?.efforts,
        effort,
      ),
      contextWindow: contextWindow || undefined,
      allowSpawn: true,
      journeyId: kind === "chat" ? journeyId : undefined,
      journeyKnowledge: kind === "chat" ? knowledge : undefined,
      mcpServers: mcpServersRef.current,
      skills: skillsRef.current,
      remote: remoteRef.current,
      onDelta: (chunk) => {
        const live = liveByChatRef.current.get(id);
        const streamText = `${live?.streamText ?? ""}` + chunk;
        rememberLive(id, { streamText });
        if (visible()) setStreamText(streamText);
      },
      onReasoning: (text) => {
        rememberLive(id, { streamReasoning: text });
        if (visible()) setStreamReasoning(text);
      },
      onError: (err) => {
        if (visible()) setFlash({ kind: "err", text: err });
      },
      confirmShell: (command) => confirmShell(command, id),
      getPermission: () => permissionRef.current,
      priorPromptTokens: usageByChat[id]?.promptTokens,
      compaction: latestCompaction,
      onCompact: (state) => {
        latestCompaction = state;
        saveMessages(latestMessages);
      },
      onTool: (call) => {
        if (call.name === "spawn_subagent" || isTodoTool(call.name)) return;
        const activity = activityFromToolCall(call);
        const rows = [
          ...(liveByChatRef.current.get(id)?.liveTools ?? []),
          { label: toolActivityLabel(call), change: toolFileChange(call), detail: toolDetail(call) },
        ];
        rememberLive(id, { activity, liveTools: rows });
        markRunning(id, { activity });
        if (visible()) {
          setRunningActivity(activity);
          setLiveTools(rows);
        }
      },
      onSubagent: (event) => {
        const dock = applySubagentToChat(subagentsByChatRef.current, id, event);
        if (visible()) {
          setSubagents(dock.agents);
          setExpandedAgents(dock.expanded);
        }
      },
      onUpdate: (nextMessages) => {
        saveMessages(nextMessages);
        rememberLive(id, { messages: nextMessages, streamText: "", streamReasoning: "", activity: null });
        markRunning(id, { activity: null });
        if (!visible()) return;
        setMessages(nextMessages);
        setStreamText("");
        setStreamReasoning("");
        setRunningActivity(null);
      },
      onRefresh: bumpFiles,
      onUsage: (usage) => {
        latestUsage = usage;
        setUsageByChat((prev) => (sameChatUsage(prev[id], usage) ? prev : { ...prev, [id]: usage }));
        void api
          .usageRecord({
            workspace_path: ws,
            workspace_name: folderName(ws),
            conversation_id: id,
            conversation_title: conversationTitleFrom(liveByChatRef.current.get(id)?.messages ?? next),
            model,
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            duration_ms: Math.max(0, Date.now() - startedAt),
          })
          .then(() => setUsageTick((n) => n + 1))
          .catch(() => undefined);
      },
      signal: ac.signal,
    });
    latestMessages = stampTurnDuration(closeDanglingToolCalls(done), Date.now() - startedAt);
    if (stoppedByUser && !pendingRef.current[id]?.length) {
      const restored = restorePrompt(id, latestMessages);
      if (restored) latestMessages = restored;
    }
    saveMessages(latestMessages);
    rememberLive(id, { messages: latestMessages, streamText: "", streamReasoning: "", liveTools: [], activity: null });
    if (visible()) {
      setMessages(latestMessages);
      setStreamText("");
      setStreamReasoning("");
      setLiveTools([]);
      setRunningActivity(null);
    }
    await persistQueue;
    const last = latestMessages[latestMessages.length - 1];
    const failed = Boolean(last && isTurnFailureMessage(last));
    const looking = visible() && viewingChatRef.current;
    const queued = Boolean(pendingRef.current[id]?.length);
    if (!ac.signal.aborted && !failed && !looking && !queued) {
      setUnseenFinished((prev) =>
        markUnseenFinished(prev, id, { aborted: false, failed: false, looking: false, queued: false }),
      );
    }
    await after?.(latestMessages);
  } catch (e) {
    latestMessages = closeDanglingToolCalls(liveByChatRef.current.get(id)?.messages ?? next);
    if (stoppedByUser && !pendingRef.current[id]?.length) {
      const restored = restorePrompt(id, latestMessages);
      if (restored) latestMessages = restored;
    }
    if (latestMessages.length) {
      saveMessages(latestMessages);
      if (visible()) setMessages(latestMessages);
      await persistQueue;
    }
    if (visible()) setFlash({ kind: "err", text: String(e) });
  } finally {
    if (turnsRef.current.get(id) === ac) turnsRef.current.delete(id);
    if (abortRef.current === ac) abortRef.current = null;
    liveByChatRef.current.delete(id);
    subagentsByChatRef.current.delete(id);
    clearRunning(id);
    if (visible()) {
      setRunningActivity(null);
      setLiveTools([]);
      setStreamText("");
      setStreamReasoning("");
      setTurnStartedAt(0);
      if (!turnsRef.current.has(id)) {
        runningIdRef.current = "";
        setRunningId("");
      }
    }
    if (runningIdRef.current === id) {
      turnMessagesRef.current = null;
      turnLiveRef.current = { streamText: "", streamReasoning: "", liveTools: [], activity: null };
    }
    rejectShells(id);
    syncRunningFromTurns();
    if (visible()) {
      setSubagents([]);
      setExpandedAgents({});
    }
  }

  await continueWithPending(id, ws, latestMessages);
}

function stop() {
  const visibleId = activeIdRef.current;
  const target = visibleId ? turnsRef.current.get(visibleId) : undefined;
  (target ?? abortRef.current)?.abort();
  if (visibleId) rejectShells(visibleId);
}

  return {
    confirmShell,
    answerShell,
    pickModel,
    pickEffort,
    pickContextWindow,
    pickPermission,
    addPromptImages,
    addPromptImagePaths,
    beginPendingEdit,
    savePendingEdit,
    closePendingEdit,
    removePendingAt,
    send,
    runTurn,
    stop,
  };
}
