import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { completeTurn } from "../../lib/agent";
import { hostedTurnStaysOnServer } from "../../lib/hosted";
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
import { sameChatUsage, type ChatUsage } from "../../lib/context";
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
import {
  emptyGrokPlan,
  grokPlanFromPayload,
  planModeEngaged,
  type GrokPlan,
  type PlanDecision,
  type PlanModeState,
  type PlanPrompt,
} from "../../lib/plan";
import { providerProfile } from "../../lib/provider";
import type { DetectedSkill } from "../../lib/skill";
import {
  applySubagentToChat,
  emptySubagentDock,
  type SubagentDockState,
  type SubagentRecord,
} from "../../lib/subagent";
import { parseConversationKind } from "../../lib/terminal-chat";
import { isTodoTool, todoBadge, todosInLatestTurn } from "../../lib/todo";
import {
  clearPendingForChat,
  closeDanglingToolCalls,
  clearUnseenFinished,
  composerSettingsForChat,
  isTurnFailureMessage,
  modelForTurn,
  markUnseenFinished,
  patchRunningTurn,
  enqueuePending,
  pendingIndexAfterRemove,
  removePending,
  commitPartialReply,
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
type PlanRequest = {
  chatId: string;
  prompt: PlanPrompt;
  resolve: (answer: { decision: PlanDecision; note: string }) => void;
};

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
    options?: { flush?: boolean },
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
  setPlanQueue: Update<PlanRequest[]>;
  planByChatRef: RefObject<Map<string, GrokPlan>>;
  onPlanChange?: () => void;
  permissionRef: RefObject<PermissionMode>;
  modelRef: RefObject<string>;
  effortRef: RefObject<string>;
  contextWindowRef: RefObject<number>;
  conversationsRef: RefObject<ConversationSummary[]>;
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
    workspace, activeId, messages, draft, draftPastes, promptImages, mentionFiles, ready, runtime, models,
    conversations, usageByChat, compactionByChat, persist, setFlash, setModel, setEffort, setContextWindow, setPermission, setDraftImages,
    setPendingByChat, setEditingPending, setFolderOpen, setActiveId, setBusy, setRunningId, setRunningTurns, setUnseenFinished, setMessages, setConversations, setDrafts, setPastesByChat, setTurnStartedAt,
    setStreamText, setStreamReasoning, setLiveTools, setRunningActivity, setSubagents, setExpandedAgents, setUsageByChat, setUsageTick, bumpFiles,
    setShellQueue, setPlanQueue, planByChatRef, onPlanChange, permissionRef, modelRef, effortRef, contextWindowRef, conversationsRef, activeIdRef, runningIdRef, runningWsRef, busyRef, abortRef, turnsRef, pendingRef, editingRef,
    deletedIdsRef, mcpServersRef, skillsRef, remoteRef, turnMessagesRef, turnLiveRef, liveByChatRef, subagentsByChatRef, stickToBottomRef, viewingChatRef,
  } = deps;

function permissionForChat(chatId: string): PermissionMode {
  const stored = conversations.find((row) => row.id === chatId)?.permission;
  if (stored) return parsePermissionMode(stored);
  if (chatId === activeIdRef.current) return permissionRef.current;
  return parsePermissionMode(permissionRef.current);
}

function confirmShell(command: string, chatId = activeIdRef.current): Promise<boolean> {
  const mode = permissionForChat(chatId);
  if (!shouldPromptShell(mode)) {
    return Promise.resolve(mode === "approve-all");
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

function planForChat(chatId: string): GrokPlan {
  return planByChatRef.current.get(chatId) ?? emptyGrokPlan();
}

function confirmPlan(prompt: PlanPrompt, chatId: string): Promise<{ decision: PlanDecision; note: string }> {
  return new Promise((resolve) => setPlanQueue((q) => [...q, { chatId, prompt, resolve }]));
}

function answerPlan(decision: PlanDecision, note = "") {
  const chatId = activeIdRef.current;
  setPlanQueue((q) => {
    const index = q.findIndex((item) => item.chatId === chatId);
    if (index < 0) return q;
    const next = q.slice();
    const [item] = next.splice(index, 1);
    item?.resolve({ decision, note });
    return next;
  });
}

function rejectPlans(chatId: string) {
  setPlanQueue((q) => {
    let changed = false;
    const next = q.filter((item) => {
      if (item.chatId !== chatId) return true;
      item.resolve({ decision: item.prompt.kind === "exit" ? "quit" : "decline", note: "" });
      changed = true;
      return false;
    });
    return changed ? next : q;
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

function rememberChatSettings(
  chatId: string,
  patch: { model?: string; effort?: string; contextWindow?: number; permission?: string },
) {
  if (!chatId || !workspace) return;
  const modelId = patch.model?.trim() ?? "";
  const effortId = patch.effort?.trim() ?? "";
  const permissionId = patch.permission?.trim() ?? "";
  const contextWindow = patch.contextWindow && patch.contextWindow > 0 ? Math.floor(patch.contextWindow) : 0;
  const rows = conversationsRef.current.map((row) =>
    row.id === chatId
      ? {
          ...row,
          ...(modelId ? { model: modelId } : {}),
          ...(effortId ? { effort: effortId } : {}),
          ...(contextWindow ? { context_window: contextWindow } : {}),
          ...(permissionId ? { permission: permissionId } : {}),
        }
      : row,
  );
  conversationsRef.current = rows;
  setConversations(rows);
  // Save even if the user has already moved to another chat. Dropping the write
  // leaves the model copied at creation, and the next open restores it.
  void api.getConversation(workspace, chatId).then((full) => {
    const current = conversationsRef.current.find((row) => row.id === chatId);
    return api.saveConversation(workspace, {
      ...full,
      ...(modelId ? { model: current?.model || modelId } : {}),
      ...(effortId ? { effort: current?.effort || effortId } : {}),
      ...(contextWindow ? { context_window: current?.context_window || contextWindow } : {}),
      ...(permissionId ? { permission: current?.permission || permissionId } : {}),
    });
  }).catch((e) => {
    setFlash({ kind: "err", text: String(e) });
  });
}

function pickModel(id: string) {
  modelRef.current = id;
  setModel(id);
  saveModel(id);
  const chatId = activeIdRef.current;
  const row = conversationsRef.current.find((item) => item.id === chatId);
  const resolved = composerSettingsForChat(
    {
      model: id,
      effort: row?.effort || effortRef.current,
      contextWindow: row?.context_window || contextWindowRef.current,
      permission: permissionRef.current,
    },
    models,
    { model: id, effort: effortRef.current, contextWindow: contextWindowRef.current, permission: permissionRef.current },
  );
  if (resolved.effort !== effortRef.current) {
    effortRef.current = resolved.effort;
    setEffort(resolved.effort);
    if (resolved.effort) saveEffort(resolved.effort);
  }
  if (resolved.contextWindow !== contextWindowRef.current) {
    contextWindowRef.current = resolved.contextWindow;
    setContextWindow(resolved.contextWindow);
    if (resolved.contextWindow) saveContextWindow(resolved.contextWindow);
  }
  if (chatId) {
    rememberChatSettings(chatId, {
      model: id,
      ...(resolved.effort !== (row?.effort || "") ? { effort: resolved.effort } : {}),
      ...(resolved.contextWindow !== (row?.context_window || 0) ? { contextWindow: resolved.contextWindow } : {}),
    });
  }
}

function pickEffort(id: string) {
  const next = id.trim();
  if (!next) return;
  effortRef.current = next;
  setEffort(next);
  saveEffort(next);
  const chatId = activeIdRef.current;
  if (!chatId || !workspace) return;
  rememberChatSettings(chatId, { effort: next });
}

function pickContextWindow(tokens: number) {
  contextWindowRef.current = tokens;
  setContextWindow(tokens);
  saveContextWindow(tokens);
  const chatId = activeIdRef.current;
  if (!chatId || !workspace) return;
  rememberChatSettings(chatId, { contextWindow: tokens });
}

function rememberPlan(chatId: string, plan: GrokPlan) {
  planByChatRef.current.set(chatId, plan);
  onPlanChange?.();
}

function pickPlanMode(mode: "off" | "pending" | "on") {
  const chatId = activeIdRef.current;
  if (!chatId || !workspace || !providerProfile(modelRef.current).planMode) return;
  const running = turnsRef.current.has(chatId);
  const state: PlanModeState =
    mode === "on"
      ? "Active"
      : mode === "pending"
        ? "Pending"
        : running && planModeEngaged(planForChat(chatId).state)
          ? "ExitPending"
          : "Inactive";
  const current = planForChat(chatId);
  rememberPlan(chatId, { ...current, found: true, state, awaitingApproval: false });
  void api.grokPlanSet(workspace, chatId, state, false).then((row) => {
    rememberPlan(chatId, grokPlanFromPayload(row));
  }).catch((e) => {
    setFlash({ kind: "err", text: String(e) });
  });
}

function pickPermission(id: string) {
  const next = parsePermissionMode(id);
  setPermission(next);
  savePermission(next);
  const chatId = activeIdRef.current;
  if (!chatId || !workspace) return;
  rememberChatSettings(chatId, { permission: next });
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
  setRunningTurns((prev) => patchRunningTurn(prev, id, patch));
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

function partialReply(id: string): { text: string; reasoning: string } {
  const live = liveByChatRef.current.get(id);
  return { text: live?.streamText ?? "", reasoning: live?.streamReasoning ?? "" };
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
  if (remoteRef.current && remoteRef.current.paired === false) {
    setFlash({
      kind: "err",
      text: `Pair ${remoteRef.current.machineName} before sending. Cloud chats run on that server.`,
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
    const chosenModel = modelRef.current;
    const chosenEffort = effortRef.current;
    const chosenWindow = contextWindowRef.current;
    await api.saveConversation(ws, {
      id,
      title: conversationTitleFrom([userMessage(text, images)]),
      created_at: now,
      updated_at: now,
      kind: "chat",
      model: chosenModel || null,
      effort: chosenEffort || null,
      context_window: chosenWindow || null,
      permission: permissionRef.current || null,
      messages: [],
    });
    const created: ConversationSummary = {
      id,
      title: conversationTitleFrom([userMessage(text, images)]),
      created_at: now,
      updated_at: now,
      kind: "chat",
      model: chosenModel || null,
      effort: chosenEffort || null,
      context_window: chosenWindow || null,
      permission: permissionRef.current || null,
    };
    conversationsRef.current = [created, ...conversationsRef.current.filter((row) => row.id !== id)];
    setConversations(conversationsRef.current);
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
  const saveMessages = (snapshot: ChatMessage[], options?: { flush?: boolean }) => {
    latestMessages = snapshot;
    persistQueue = persistQueue
      .then(() => persist(snapshot, id, ws, latestUsage, latestCompaction, options))
      .catch(() => undefined);
  };
  const chat = conversationsRef.current.find((row) => row.id === id) ?? conversations.find((row) => row.id === id);
  const chip = {
    model: modelRef.current,
    effort: effortRef.current,
    contextWindow: contextWindowRef.current,
    permission: permissionRef.current,
  };
  // Before the first reply the composer chip is the choice, even when the empty
  // chat was created with the previous conversation's model.
  const unanswered = !next.some((message) => message.role === "assistant");
  const chosenModel = modelForTurn(next, chat?.model, chip.model);
  const turnSettings = composerSettingsForChat(
    {
      model: unanswered ? null : chosenModel,
      effort: chat?.effort,
      contextWindow: chat?.context_window,
      permission: chat?.permission,
    },
    models,
    { ...chip, model: chosenModel || chip.model },
  );
  const journeyId = journeyIdOverride || chat?.journey_id || undefined;
  const kind = parseConversationKind(chat?.kind);
  if (hostedTurnStaysOnServer(remoteRef.current)) {
    const prompt = [...next].reverse().find((message) => message.role === "user");
    const text = String(prompt?.content ?? "").trim();
    if (!text) {
      if (visible()) setFlash({ kind: "err", text: "prompt is empty" });
      turnsRef.current.delete(id);
      syncRunningFromTurns();
      return;
    }
    const streamId = crypto.randomUUID();
    let unlisten: (() => void) | undefined;
    let finishWait: (() => void) | undefined;
    const onAbort = () => {
      void api.hostedCancel(streamId);
      finishWait?.();
    };
    ac.signal.addEventListener("abort", onAbort);
    try {
      const finished = new Promise<void>((resolve) => {
        finishWait = resolve;
      });
      unlisten = await api.onChat((ev) => {
        if (ev.stream_id !== streamId) return;
        if (ev.kind === "delta" && ev.text) {
          const live = liveByChatRef.current.get(id);
          const streamText = `${live?.streamText ?? ""}` + ev.text;
          rememberLive(id, { streamText });
          if (visible()) setStreamText(streamText);
        } else if (ev.kind === "status" && ev.text) {
          const activity = { kind: "tool" as const, label: ev.text };
          rememberLive(id, { activity });
          markRunning(id, { activity });
          if (visible()) setRunningActivity(activity);
        } else if (ev.kind === "error") {
          if (visible()) setFlash({ kind: "err", text: ev.text || "the server could not finish the turn" });
          finishWait?.();
        } else if (ev.kind === "done") {
          const saved = ev.conversation;
          const messages = (saved?.messages as ChatMessage[] | undefined) ?? [];
          if (messages.length) {
            latestMessages = messages;
            rememberLive(id, { messages, streamText: "", streamReasoning: "", liveTools: [], activity: null });
            if (visible()) {
              setMessages(messages);
              setStreamText("");
              setRunningActivity(null);
            }
          }
          finishWait?.();
        }
      });
      await api.hostedTurn({
        workspace: ws,
        streamId,
        conversationId: id,
        prompt: text,
        model: turnSettings.model,
        effort: turnSettings.effort,
        permission: turnSettings.permission,
      });
      await finished;
    } catch (e) {
      if (visible()) setFlash({ kind: "err", text: String(e) });
    } finally {
      ac.signal.removeEventListener("abort", onAbort);
      unlisten?.();
      if (turnsRef.current.get(id) === ac) turnsRef.current.delete(id);
      clearRunning(id);
      syncRunningFromTurns();
      if (visible()) {
        setRunningActivity(null);
        setStreamText("");
        setTurnStartedAt(0);
        runningIdRef.current = "";
        setRunningId("");
      }
    }
    return;
  }
  if (providerProfile(turnSettings.model).planMode && planForChat(id).state === "Pending") {
    try {
      const armed = grokPlanFromPayload(await api.grokPlanSet(ws, id, "Active", false));
      rememberPlan(id, armed);
    } catch (e) {
      if (visible()) setFlash({ kind: "err", text: String(e) });
    }
  }
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
      model: turnSettings.model,
      effort: turnSettings.effort,
      contextWindow: turnSettings.contextWindow || undefined,
      allowSpawn: true,
      journeyId: kind === "chat" ? journeyId : undefined,
      journeyKnowledge: kind === "chat" ? knowledge : undefined,
      mcpServers: mcpServersRef.current,
      skills: skillsRef.current,
      remote: remoteRef.current,
      conversationId: id,
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
      getPermission: () => permissionForChat(id),
      plan: providerProfile(turnSettings.model).planMode
        ? {
            sessionId: id,
            enabled: true,
            getState: () => planForChat(id).state,
            setState: async (state: PlanModeState, awaitingApproval: boolean) => {
              const next = grokPlanFromPayload(await api.grokPlanSet(ws, id, state, awaitingApproval));
              rememberPlan(id, next);
            },
            readContent: async () => {
              const next = grokPlanFromPayload(await api.grokPlan(ws, id));
              rememberPlan(id, { ...planForChat(id), content: next.content, found: next.found });
              return next.content;
            },
            writePlan: (contents: string) => api.grokPlanWrite(ws, id, contents),
            editPlan: (oldString: string, newString: string) => api.grokPlanEdit(ws, id, oldString, newString),
            messages: () => liveByChatRef.current.get(id)?.messages ?? next,
            confirm: (prompt) => confirmPlan(prompt, id),
          }
        : undefined,
      priorPromptTokens: usageByChat[id]?.promptTokens,
      compaction: latestCompaction,
      onCompact: (state) => {
        latestCompaction = state;
        saveMessages(latestMessages);
      },
      onTool: (call) => {
        if (isTodoTool(call.name)) {
          const live = liveByChatRef.current.get(id);
          const badge = todoBadge(todosInLatestTurn(live?.messages ?? next));
          markRunning(id, { todo: badge && !badge.finished ? { done: badge.done, total: badge.total } : null });
          return;
        }
        if (call.name === "run_command") {
          const activity = activityFromToolCall(call);
          rememberLive(id, { activity });
          markRunning(id, { activity });
          if (visible()) setRunningActivity(activity);
          return;
        }
        if (call.name === "spawn_subagent") return;
        const activity = activityFromToolCall(call);
        const rows = [
          ...(liveByChatRef.current.get(id)?.liveTools ?? []),
          {
            label: toolActivityLabel(call),
            change: toolFileChange(call),
            detail: toolDetail(call),
            callId: call.id,
          },
        ];
        rememberLive(id, { activity, liveTools: rows });
        markRunning(id, { activity });
        if (visible()) {
          setRunningActivity(activity);
          setLiveTools(rows);
        }
      },
      onToolProgress: (callId, detail) => {
        const rows = liveByChatRef.current.get(id)?.liveTools ?? [];
        let changed = false;
        const next = rows.map((row) => {
          if (row.callId !== callId || row.detail === detail) return row;
          changed = true;
          return { ...row, detail };
        });
        if (!changed) return;
        rememberLive(id, { liveTools: next });
        if (visible()) setLiveTools(next);
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
        const kept = liveByChatRef.current.get(id)?.activity;
        const last = nextMessages[nextMessages.length - 1];
        const commandStillOpen =
          last?.role === "assistant" && (last.tool_calls ?? []).some((call) => call.name === "run_command");
        const activity =
          commandStillOpen && kept?.kind === "tool" && kept.label.startsWith("Run ") ? kept : null;
        rememberLive(id, { messages: nextMessages, streamText: "", streamReasoning: "", activity });
        const badge = todoBadge(todosInLatestTurn(nextMessages));
        markRunning(id, {
          activity,
          ...(badge ? { todo: badge.finished ? null : { done: badge.done, total: badge.total } } : {}),
        });
        if (!visible()) return;
        setMessages(nextMessages);
        setStreamText("");
        setStreamReasoning("");
        setRunningActivity(activity);
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
            model: turnSettings.model,
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
    latestMessages = stampTurnDuration(
      commitPartialReply(closeDanglingToolCalls(done), partialReply(id)),
      Date.now() - startedAt,
      nowIso(),
    );
    saveMessages(latestMessages, { flush: true });
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
    latestMessages = commitPartialReply(
      closeDanglingToolCalls(liveByChatRef.current.get(id)?.messages ?? next),
      partialReply(id),
    );
    if (latestMessages.length) {
      saveMessages(latestMessages, { flush: true });
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
    rejectPlans(id);
    if (planForChat(id).state === "ExitPending") {
      rememberPlan(id, { ...planForChat(id), state: "Inactive", awaitingApproval: false });
      void api.grokPlanSet(ws, id, "Inactive", false).catch(() => undefined);
    }
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
    answerPlan,
    pickPlanMode,
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
