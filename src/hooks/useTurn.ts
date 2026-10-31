import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { nextTopSort } from "../lib/all-projects";
import { completeTurn, resumeLocalTurn } from "../lib/agent";
import { keepCompaction } from "../lib/compact";
import { cloudSendWaiting, hostedTurnStaysOnServer } from "../lib/hosted";
import {
  activityFromToolCall,
  conversationTitleFrom,
  systemPrompt,
  worktreeCheckoutFor,
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
} from "../lib/core";
import { sameChatUsage, type ChatUsage } from "../lib/context";
import {
  MAX_PROMPT_IMAGES,
  appendPromptImages,
  canSendPrompt,
  attachmentPathsFromDrop,
  fileToBase64,
  imagesForChat,
  isImageFile,
  insertImageToken,
  persistableImages,
  removeImageTokens,
  stripImageTokens,
  setImagesForChat,
  uniqueImageTokenLabel,
} from "../lib/image";
import { expandFileMentions, type MentionFile } from "../lib/mention";
import { expandPasteTokens, type PasteBlock } from "../lib/paste";
import { fileBaseName } from "../lib/file-icon";
import type { DetectedMcpServer } from "../lib/mcp";
import { parsePermissionMode, shouldPromptShell, type PermissionMode, type RemoteWorkspace } from "../lib/permission";
import {
  emptyGrokPlan,
  grokPlanFromPayload,
  planModeEngaged,
  planModeSystemLine,
  type GrokPlan,
  type PlanDecision,
  type PlanModeState,
  type PlanPrompt,
} from "../lib/plan";
import { providerProfile, providerReadyFor } from "../lib/provider";
import {
  freshWorktreeName,
  hideOpenWorktreeMarker,
  promptWithWorktreeName,
  rememberWorktreeName,
  takeWorktreeName,
  worktreeListsFor,
} from "../lib/worktree.ts";
import type { DetectedSkill } from "../lib/skill";
import {
  applySubagentToChat,
  emptySubagentDock,
  subagentFromLocalEvent,
  type SubagentDockState,
  type SubagentRecord,
} from "../lib/subagent";
import { beginTurnClock, endTurnClock } from "../lib/turn-clock";
import { isTodoTool, todoBadge, todosInLatestTurn } from "../lib/todo";
import { setSecondaryLiveStream } from "../lib/live-stream";
import { rememberSplitPane } from "../lib/split-pane";
import {
  clearPendingForChat,
  closeDanglingToolCalls,
  clearUnseenFinished,
  composerSettingsForChat,
  claimDraftForChat,
  draftForChat,
  isTurnFailureMessage,
  mergeHostedTranscript,
  modelForTurn,
  markUnseenFinished,
  patchRunningTurn,
  enqueuePending,
  pendingIndexAfterRemove,
  removePending,
  commitPartialReply,
  setDraftForChat,
  takeNextPending,
  turnAppliesToChat,
  updatePending,
  type PendingEdit,
  type PendingMessage,
  type RunningTurn,
} from "../lib/turn";
import {
  saveComposerDraft,
  saveComposerPastes,
  saveContextWindow,
  saveConversation,
  saveEffort,
  saveModel,
  savePermission,
} from "../lib/prefs";
import * as api from "../lib/tauri";
import type { ConversationSummary, Model, Runtime } from "../lib/tauri";

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
  draftsRef: RefObject<Record<string, string>>;
  draftImagesRef: RefObject<Record<string, ChatImage[]>>;
  promptImages: ChatImage[];
  mentionFiles: MentionFile[];
  busy: boolean;
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
  /** Rename the open linked worktree once a reply names a branch. */
  adoptWorktreeName?: (ws: string, branch: string) => void;
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
  remoteKnownRef: RefObject<boolean>;
  linkReadyRef: RefObject<boolean>;
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
  /** The other conversation in a split. Its tokens go to the secondary stream. */
  sideChatIdRef?: RefObject<string>;
  subagentsByChatRef: RefObject<Map<string, SubagentDockState>>;
  stickToBottomRef: RefObject<boolean>;
};

export function bindTurn(deps: TurnDeps) {
  const {
    workspace, activeId, messages, draft, draftPastes, draftsRef, draftImagesRef, mentionFiles, runtime, models,
    conversations, usageByChat, compactionByChat, persist, setFlash, setModel, setEffort, setContextWindow, setPermission, setDraftImages,
    setPendingByChat, setEditingPending, setFolderOpen, setActiveId, setBusy, setRunningId, setRunningTurns, setUnseenFinished, setMessages, setConversations, setDrafts, setPastesByChat, setTurnStartedAt,
    setStreamText, setStreamReasoning, setLiveTools, setRunningActivity, setSubagents, setExpandedAgents, setUsageByChat, setUsageTick, bumpFiles, adoptWorktreeName,
    setShellQueue, setPlanQueue, planByChatRef, onPlanChange, permissionRef, modelRef, effortRef, contextWindowRef, conversationsRef, activeIdRef, runningIdRef, runningWsRef, busyRef, abortRef, turnsRef, pendingRef, editingRef,
    deletedIdsRef, mcpServersRef, skillsRef, remoteRef, remoteKnownRef, linkReadyRef, turnMessagesRef, turnLiveRef, liveByChatRef, sideChatIdRef, subagentsByChatRef, stickToBottomRef, viewingChatRef,
  } = deps;

function systemForDetached(ws: string, id: string, settings: { model: string; permission: string }): string {
  const checkout = worktreeCheckoutFor(ws, worktreeListsFor(ws));
  const planLine = providerProfile(settings.model).planMode
    ? planModeSystemLine(planForChat(id).state, `~/.grok/sessions/<workspace>/${id}/plan.md`)
    : "";
  return String(
    systemPrompt(
      ws,
      parsePermissionMode(settings.permission),
      "",
      mcpServersRef.current,
      skillsRef.current,
      remoteRef.current,
      settings.model,
      planLine,
      checkout,
    ).content ?? "",
  );
}

function applyDetachedEvent(
  id: string,
  ws: string,
  visible: () => boolean,
  event: {
    kind: string;
    text?: string | null;
    tool?: { id: string; name: string; arguments: string } | null;
    messages?: ChatMessage[] | null;
    usage?: ChatUsage | null;
  },
) {
  if (event.kind === "saved" && event.messages) {
    const messages = event.messages;
    rememberLive(id, { messages, streamText: "", streamReasoning: "" });
    if (event.usage) {
      setUsageByChat((prev) => (sameChatUsage(prev[id], event.usage!) ? prev : { ...prev, [id]: event.usage! }));
      setUsageTick((n) => n + 1);
    }
    if (visible()) {
      setMessages(messages);
      setStreamText("");
      setStreamReasoning("");
    }
    return;
  }
  if (event.kind === "delta" && event.text) {
    const live = liveByChatRef.current.get(id);
    const streamText = hideWorktreeName(`${live?.streamText ?? ""}${event.text}`, id, ws);
    rememberLive(id, { streamText });
    if (visible()) setStreamText(streamText);
    return;
  }
  if (event.kind === "reasoning" && event.text) {
    const live = liveByChatRef.current.get(id);
    const streamReasoning = `${live?.streamReasoning ?? ""}${event.text}`;
    rememberLive(id, { streamReasoning });
    if (visible()) setStreamReasoning(streamReasoning);
    return;
  }
  if (event.kind === "subagent" && event.text) {
    const subagent = subagentFromLocalEvent(event.text);
    if (!subagent) return;
    const dock = applySubagentToChat(subagentsByChatRef.current, id, subagent);
    if (visible()) {
      setSubagents(dock.agents);
      setExpandedAgents(dock.expanded);
    }
    return;
  }
  if (event.kind === "tool" && event.tool) {
    const call = event.tool;
    if (call.name === "spawn_subagent" || isTodoTool(call.name)) return;
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
    return;
  }
  if (event.kind === "shell" && event.text) {
    const command = event.text;
    void confirmShell(command, id).then((ok) => {
      void api.localTurnShell(id, command, ok);
    });
    return;
  }
  if (event.kind === "plan" && event.text) {
    let prompt: PlanPrompt = { kind: "enter" };
    try {
      const parsed = JSON.parse(event.text) as { kind?: string; content?: string };
      if (parsed.kind === "exit") prompt = { kind: "exit", content: parsed.content ?? "" };
    } catch {
      prompt = { kind: "enter" };
    }
    void confirmPlan(prompt, id).then((answer) => {
      void api.localTurnPlan(id, answer.decision, answer.note);
    });
    return;
  }
  if (event.kind === "command" && event.text) {
    return;
  }
  if (event.kind === "refresh") bumpFiles();
  if (event.kind === "error" && event.text && visible()) setFlash({ kind: "err", text: event.text });
}

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
  const load = hostedTurnStaysOnServer(remoteRef.current)
    ? api.getConversationById(chatId)
    : api.getConversation(workspace, chatId);
  void load.then((full) => {
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

function pickModel(id: string, chatId = activeIdRef.current) {
  const focused = !chatId || chatId === activeIdRef.current;
  const row = conversationsRef.current.find((item) => item.id === chatId);
  const resolved = composerSettingsForChat(
    {
      model: id,
      effort: focused ? effortRef.current : row?.effort,
      contextWindow: focused ? contextWindowRef.current : row?.context_window,
      permission: focused ? permissionRef.current : row?.permission,
    },
    models,
    { model: id, effort: effortRef.current, contextWindow: contextWindowRef.current, permission: permissionRef.current },
  );
  if (focused) {
    modelRef.current = id;
    setModel(id);
    saveModel(id);
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
  }
  if (chatId) {
    rememberChatSettings(chatId, {
      model: id,
      ...(resolved.effort !== (row?.effort || "") ? { effort: resolved.effort } : {}),
      ...(resolved.contextWindow !== (row?.context_window || 0) ? { contextWindow: resolved.contextWindow } : {}),
    });
  }
}

function pickEffort(id: string, chatId = activeIdRef.current) {
  const next = id.trim();
  if (!next) return;
  if (!chatId || chatId === activeIdRef.current) {
    effortRef.current = next;
    setEffort(next);
    saveEffort(next);
  }
  if (!chatId || !workspace) return;
  rememberChatSettings(chatId, { effort: next });
}

function pickContextWindow(tokens: number, chatId = activeIdRef.current) {
  if (!chatId || chatId === activeIdRef.current) {
    contextWindowRef.current = tokens;
    setContextWindow(tokens);
    saveContextWindow(tokens);
  }
  if (!chatId || !workspace) return;
  rememberChatSettings(chatId, { contextWindow: tokens });
}

function rememberPlan(chatId: string, plan: GrokPlan) {
  planByChatRef.current.set(chatId, plan);
  onPlanChange?.();
}

function pickPlanMode(mode: "off" | "pending" | "on", chatId = activeIdRef.current) {
  const modelId = chatId === activeIdRef.current
    ? modelRef.current
    : conversationsRef.current.find((row) => row.id === chatId)?.model || modelRef.current;
  if (!chatId || !workspace || !providerProfile(modelId).planMode) return;
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

function pickPermission(id: string, chatId = activeIdRef.current) {
  const next = parsePermissionMode(id);
  if (!chatId || chatId === activeIdRef.current) {
    setPermission(next);
    savePermission(next);
  }
  if (chatId && workspace) rememberChatSettings(chatId, { permission: next });
  if (shouldPromptShell(next)) return;
  const ok = next === "approve-all";
  setShellQueue((q) => {
    let changed = false;
    const rest = q.filter((item) => {
      if (chatId && item.chatId !== chatId) return true;
      item.resolve(ok);
      changed = true;
      return false;
    });
    return changed ? rest : q;
  });
}

function imageSelection(chatId = activeId): { start: number; end: number; value: string } {
  const field = composerField(chatId);
  const current = chatId === activeId ? draft : draftForChat(draftsRef.current, chatId);
  if (!field) return { start: current.length, end: current.length, value: current };
  return {
    start: field.selectionStart ?? field.value.length,
    end: field.selectionEnd ?? field.value.length,
    value: field.value,
  };
}

/** The composer the drop landed in. A split has two, so the focused one is not enough. */
function composerField(chatId: string): HTMLTextAreaElement | null {
  if (chatId) {
    const owned = document.querySelector<HTMLTextAreaElement>(`[data-composer-chat="${CSS.escape(chatId)}"]`);
    if (owned) return owned;
  }
  return document.querySelector<HTMLTextAreaElement>("[data-composer-input]");
}

const preparesByChat = new Map<string, Set<Promise<void>>>();

function trackPrepare(chatId: string, work: Promise<void>) {
  let set = preparesByChat.get(chatId);
  if (!set) {
    set = new Set();
    preparesByChat.set(chatId, set);
  }
  set.add(work);
  void work.finally(() => {
    set?.delete(work);
    if (set && set.size === 0) preparesByChat.delete(chatId);
  });
}

async function waitPrepares(chatId: string) {
  for (;;) {
    const set = preparesByChat.get(chatId);
    if (!set || set.size === 0) return;
    await Promise.all([...set]);
  }
}

function commitImages(chatId: string, images: ChatImage[]) {
  const stored = setImagesForChat(draftImagesRef.current, chatId, images);
  draftImagesRef.current = stored;
  setDraftImages(stored);
}

function commitDraft(chatId: string, text: string) {
  const stored = setDraftForChat(draftsRef.current, chatId, text);
  draftsRef.current = stored;
  setDrafts(stored);
  saveComposerDraft(chatId, text);
}

/** Swap a dropped file for the copy on disk. Keeps the label already in the draft. */
function replaceDraftImage(chatId: string, id: string, next: ChatImage) {
  const current = imagesForChat(draftImagesRef.current, chatId);
  const prev = current.find((img) => img.id === id);
  if (!prev) return;
  if (prev.previewUrl) URL.revokeObjectURL(prev.previewUrl);
  commitImages(
    chatId,
    current.map((img) => (img.id === id ? { ...next, id, name: img.name, previewUrl: undefined } : img)),
  );
}

function dropFailedAttachment(chatId: string, id: string) {
  const current = imagesForChat(draftImagesRef.current, chatId);
  const image = current.find((img) => img.id === id);
  if (!image) return;
  if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  commitDraft(chatId, removeImageTokens(draftForChat(draftsRef.current, chatId), image));
  commitImages(
    chatId,
    current.filter((img) => img.id !== id),
  );
}

/** Insert `[name]` into the draft that was open when the drop started. */
function attachPreparedImages(
  prepared: ChatImage[],
  selection: { start: number; end: number; value: string },
  chatId = activeId,
) {
  const existing = imagesForChat(draftImagesRef.current, chatId);
  const current = draftForChat(draftsRef.current, chatId);
  const unchanged = selection.value === current;
  const start = unchanged ? selection.start : current.length;
  const end = unchanged ? selection.end : current.length;
  const labels = new Set<string>();
  const token = /\[([^\[\]\r\n]+)]/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(current))) {
    const label = match[1]?.trim();
    if (label) labels.add(label);
  }
  for (const image of existing) {
    if (image.name.trim()) labels.add(image.name.trim());
  }
  let text = current;
  let caret = start;
  const named: ChatImage[] = [];
  for (const image of prepared) {
    const label = uniqueImageTokenLabel(image.name || (image.kind === "file" ? "file" : "image.png"), labels);
    labels.add(label);
    const inserted = insertImageToken(text, caret, caret === start ? end : caret, label);
    text = inserted.draft;
    caret = inserted.cursor;
    named.push({ ...image, name: label });
  }
  commitDraft(chatId, text);
  commitImages(chatId, appendPromptImages(existing, named));
  const cursor = caret;
  requestAnimationFrame(() => {
    const node = composerField(chatId);
    if (!node || node.value !== text) return;
    node.focus();
    node.setSelectionRange(cursor, cursor);
  });
}

function placeholderAttachment(file: { name?: string; type?: string }, previewUrl?: string): ChatImage {
  const image = isImageFile(file);
  return {
    id: crypto.randomUUID(),
    path: "",
    name: file.name || (image ? "image.png" : "file"),
    mime: file.type || (image ? "image/png" : "application/octet-stream"),
    width: 0,
    height: 0,
    resized: false,
    ...(previewUrl ? { previewUrl } : {}),
    ...(image ? {} : { kind: "file" as const }),
  };
}

async function addPromptImages(files: File[], chatId = activeId) {
  if (!files.length) return;
  const held = imagesForChat(draftImagesRef.current, chatId);
  const room = MAX_PROMPT_IMAGES - held.length;
  if (room <= 0) {
    setFlash({ kind: "err", text: `You can attach up to ${MAX_PROMPT_IMAGES} files.` });
    return;
  }
  const take = files.slice(0, room);
  const selection = imageSelection(chatId);
  // Show the chip before decoding. A screenshot is large, and waiting for the
  // resized copy is what made the drop look like it missed.
  const pending = take.map((file) =>
    placeholderAttachment(file, isImageFile(file) ? URL.createObjectURL(file) : undefined),
  );
  attachPreparedImages(pending, selection, chatId);
  const work = Promise.all(
    pending.map(async (row, index) => {
      const file = take[index];
      if (!file) return;
      try {
        const name = file.name || (row.kind === "file" ? "file" : "image.png");
        const bytes = await fileToBase64(file);
        const next = row.kind === "file"
          ? await api.prepareFile(bytes, name, chatId || undefined)
          : await api.prepareImage(bytes, name, chatId || undefined);
        replaceDraftImage(chatId, row.id, next);
      } catch (e) {
        dropFailedAttachment(chatId, row.id);
        setFlash({ kind: "err", text: String(e) });
      }
    }),
  ).then(() => undefined);
  trackPrepare(chatId, work);
  await work;
}

async function addPromptImagePaths(paths: string[], chatId = activeId) {
  const images = attachmentPathsFromDrop(paths);
  if (!images.length) return;
  const held = imagesForChat(draftImagesRef.current, chatId);
  const room = MAX_PROMPT_IMAGES - held.length;
  if (room <= 0) {
    setFlash({ kind: "err", text: `You can attach up to ${MAX_PROMPT_IMAGES} files.` });
    return;
  }
  const take = images.slice(0, room);
  const selection = imageSelection(chatId);
  const pending = take.map((path) => placeholderAttachment({ name: fileBaseName(path) || path }));
  attachPreparedImages(pending, selection, chatId);
  const work = Promise.all(
    pending.map(async (row, index) => {
      const path = take[index];
      if (!path) return;
      try {
        const staged = await api.stageDropPath(path, chatId || undefined);
        replaceDraftImage(chatId, row.id, staged);
        if (row.kind !== "file") {
          try {
            const finished = await api.finalizeImage(staged.path);
            replaceDraftImage(chatId, row.id, finished);
          } catch (e) {
            // The copy is already on screen. Resizing is only for the model.
            setFlash({ kind: "err", text: String(e) });
          }
        }
      } catch (e) {
        dropFailedAttachment(chatId, row.id);
        setFlash({ kind: "err", text: String(e) });
      }
    }),
  ).then(() => undefined);
  trackPrepare(chatId, work);
  await work;
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
  if (sideChatIdRef?.current === id) {
    rememberSplitPane(id, {
      messages: next.messages,
      streamText: next.streamText,
      streamReasoning: next.streamReasoning,
      liveTools: next.liveTools,
      activity: next.activity,
    });
    setSecondaryLiveStream({
      streamText: next.streamText,
      streamReasoning: next.streamReasoning,
      liveTools: next.liveTools,
      runningActivity: next.activity,
    });
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

/** A prompt is starting. Drop the previous stamp so this turn does not inherit it. */
function startRunningTurn(id: string, startedAt: number) {
  const stamp = beginTurnClock(id, startedAt);
  setRunningTurns((prev) => {
    const cleared = { ...prev };
    delete cleared[id];
    return patchRunningTurn(cleared, id, { activity: null, startedAt: stamp });
  });
}

function clearRunning(id: string) {
  endTurnClock(id);
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
      const full = hostedTurnStaysOnServer(remoteRef.current)
        ? await api.getConversationById(queued.chatId)
        : await api.getConversation(ws, queued.chatId);
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
  const images = imagesForChat(draftImagesRef.current, id);
  for (const image of images) {
    if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  }
  commitImages(id, []);
}

/**
 * The first prompt of a new chat is stored under "". Sending creates the real
 * id and clears that. A keystroke can still land on "" before the composer
 * rebinds, which is what the next new chat shows. Clear it once that settles.
 */
function releaseUnsavedDraft(id: string) {
  const drop = () => {
    if (activeIdRef.current !== id) return;
    clearPrompt("");
  };
  queueMicrotask(drop);
  requestAnimationFrame(drop);
}

function userMessage(text: string, images: ChatImage[]): ChatMessage {
  return images.length ? { role: "user", content: text, images } : { role: "user", content: text };
}

/** Drop the name marker from what is on screen. A half-written marker stays hidden. */
function hideWorktreeName(text: string, chatId = "", ws = ""): string {
  const closed = takeWorktreeName(text);
  const fresh = closed.name ? freshWorktreeName(chatId, closed.name) : "";
  if (closed.name) rememberWorktreeName(chatId, closed.name);
  if (fresh && ws) adoptWorktreeName?.(ws, fresh);
  return hideOpenWorktreeMarker(closed.text).text;
}

/** Save the suggested branch and take the marker out of the stored reply. */
function storeWorktreeName(messages: ChatMessage[], chatId: string, ws = ""): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const content = String(message.content ?? "");
    const taken = takeWorktreeName(content);
    if (!taken.name && taken.text === content) return message;
    const fresh = taken.name ? freshWorktreeName(chatId, taken.name) : "";
    if (taken.name) rememberWorktreeName(chatId, taken.name);
    if (fresh && ws) adoptWorktreeName?.(ws, fresh);
    changed = true;
    return { ...message, content: taken.text };
  });
  return changed ? next : messages;
}

function partialReply(id: string): { text: string; reasoning: string } {
  const live = liveByChatRef.current.get(id);
  return { text: live?.streamText ?? "", reasoning: live?.streamReasoning ?? "" };
}

async function send(targetId = activeIdRef.current) {
  const sendingSide = Boolean(targetId) && targetId !== activeIdRef.current;
  const imageKey = sendingSide ? targetId : activeIdRef.current;
  await waitPrepares(imageKey);
  const heldImages = imagesForChat(draftImagesRef.current, imageKey);
  const text = sendingSide
    ? expandFileMentions(
        stripImageTokens(draftForChat(draftsRef.current, targetId), heldImages),
        mentionFiles,
      ).trim()
    : expandFileMentions(expandPasteTokens(draftForChat(draftsRef.current, imageKey) || draft, draftPastes), mentionFiles).trim();
  const images = persistableImages(heldImages);
  if (!canSendPrompt(text, images)) return;
  if (cloudSendWaiting(Boolean(workspace), remoteKnownRef.current, remoteRef.current, linkReadyRef.current)) {
    setFlash({ kind: "err", text: "Still connecting to the server. Try again in a moment." });
    return;
  }
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
  if (!workspace) {
    setFolderOpen(true);
    return;
  }
  const sendingChat = targetId ? conversationsRef.current.find((row) => row.id === targetId) : undefined;
  const focusedChip = !targetId || targetId === activeIdRef.current;
  const sendingModel = focusedChip ? modelRef.current : sendingChat?.model || modelRef.current;
  const signedIn = providerReadyFor(sendingModel, runtime?.providers, runtime?.ready);
  if (!signedIn.ready) {
    const profile = providerProfile(sendingModel);
    setFlash({
      kind: "err",
      text: signedIn.hint || (profile.id === "xai" ? runtime?.hint || "Grok isn’t signed in." : `Sign in to ${profile.agentName}.`),
    });
    return;
  }
  let ws = workspace;
  try {
    ws = await api.openFolder(ws);
  } catch (e) {
    setFlash({ kind: "err", text: String(e) });
    return;
  }
  let id = targetId;
  if (!id) {
    const now = nowIso();
    id = newConversationId();
    const chosenModel = modelRef.current;
    const chosenEffort = effortRef.current;
    const chosenWindow = contextWindowRef.current;
    const title = conversationTitleFrom([userMessage(text, images)]);
    const sortOrder = nextTopSort(conversationsRef.current.map((row) => row.sort_order));
    let created: ConversationSummary = {
      id,
      title,
      created_at: now,
      updated_at: now,
      kind: "chat",
      sort_order: sortOrder,
      model: chosenModel || null,
      effort: chosenEffort || null,
      context_window: chosenWindow || null,
      permission: permissionRef.current || null,
    };
    // A paired cloud project creates the chat on the server from the prompt.
    // Writing the empty row locally is what shows a second "New chat".
    if (!hostedTurnStaysOnServer(remoteRef.current)) {
      const saved = await api.saveConversation(ws, { ...created, messages: [] });
      // The database places a new chat above the list. The payload's zero is not that place.
      if (typeof saved.sort_order === "number") created = { ...created, sort_order: saved.sort_order };
    }
    conversationsRef.current = [created, ...conversationsRef.current.filter((row) => row.id !== id)];
    setConversations(conversationsRef.current);
    setActiveId(id);
    activeIdRef.current = id;
    saveConversation(ws, id);
    // The prompt was typed against the unsaved new chat (id ""). Sending gives it a
    // real id. Leave the text on that id so clearPrompt removes it, instead of
    // leaving it under "" for the next new chat.
    setDrafts((prev) => claimDraftForChat(prev, id, (value) => !value));
    setPastesByChat((prev) => claimDraftForChat(prev, id, (value) => value.length === 0));
    setDraftImages((prev) => claimDraftForChat(prev, id, (value) => value.length === 0));
    releaseUnsavedDraft(id);
  }
  if (turnAppliesToChat(id, activeIdRef.current)) stickToBottomRef.current = true;
  clearPrompt(id);
  if (turnsRef.current.has(id)) {
    setPending(enqueuePending(pendingRef.current, id, text, images));
    return;
  }
  let history = closeDanglingToolCalls(messages);
  if (!turnAppliesToChat(id, activeIdRef.current)) {
    try {
      const full = hostedTurnStaysOnServer(remoteRef.current)
        ? await api.getConversationById(id)
        : await api.getConversation(ws, id);
      history = closeDanglingToolCalls((full.messages as ChatMessage[]) ?? []);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      return;
    }
  }
  await runTurn(ws, id, [...history, userMessage(promptWithWorktreeName(text, history, id, ws), images)]);
}

async function runTurn(
  ws: string,
  id: string,
  next: ChatMessage[],
  after?: (done: ChatMessage[]) => Promise<void>,
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
  startRunningTurn(id, startedAt);
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
  const focusedChip = id === activeIdRef.current;
  const chip = {
    model: focusedChip ? modelRef.current : chat?.model || modelRef.current,
    effort: focusedChip ? effortRef.current : chat?.effort || effortRef.current,
    contextWindow: focusedChip ? contextWindowRef.current : chat?.context_window || contextWindowRef.current,
    permission: focusedChip ? permissionRef.current : chat?.permission || permissionRef.current,
  };
  // Before the first reply the composer chip is the choice, even when the empty
  // chat was created with the previous conversation's model.
  const unanswered = !next.some((message) => message.role === "assistant");
  const chosenModel = modelForTurn(next, chat?.model, chip.model);
  // Opening this chat while it runs reads the model from the row. Without this,
  // the row still says the model from before the turn and the input stays there.
  if (chosenModel && chosenModel !== (chat?.model || "").trim()) {
    rememberChatSettings(id, { model: chosenModel });
  }
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
      void api.hostedCancel(id);
      void api.hostedCancel(streamId);
      finishWait?.();
    };
    ac.signal.addEventListener("abort", onAbort);
    try {
      const finished = new Promise<void>((resolve) => {
        finishWait = resolve;
      });
      unlisten = await api.onChat((ev) => {
        // The sender joins under streamId. A chat that was already open joined under another id.
        // Both publish the same conversation, so either `done` ends this wait.
        const own = ev.stream_id === streamId;
        const followedDone = ev.kind === "done" && ev.conversation?.id === id;
        if (!own && !followedDone) return;
        if (ev.kind === "delta" && ev.text && own) {
          const live = liveByChatRef.current.get(id);
          const streamText = `${live?.streamText ?? ""}` + ev.text;
          rememberLive(id, { streamText });
          if (visible()) setStreamText(streamText);
        } else if (ev.kind === "status" && ev.text && own) {
          const activity = { kind: "tool" as const, label: ev.text };
          rememberLive(id, { activity });
          markRunning(id, { activity });
          if (visible()) setRunningActivity(activity);
        } else if (ev.kind === "shell_approval" && ev.text && own) {
          const command = ev.text;
          void confirmShell(command, id).then((ok) => {
            void api.hostedShellAnswer(id, ok);
          });
        } else if (ev.kind === "error" && own) {
          if (visible()) setFlash({ kind: "err", text: ev.text || "the server could not finish the turn" });
          finishWait?.();
        } else if (ev.kind === "done") {
          const saved = ev.conversation;
          const incoming = (saved?.messages as ChatMessage[] | undefined) ?? [];
          // A stopped turn can publish the transcript from before this prompt.
          // The optimistic copy is already on screen, so a shorter one does not replace it.
          const messages = mergeHostedTranscript(liveByChatRef.current.get(id)?.messages ?? [], incoming);
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
        contextWindow: turnSettings.contextWindow || undefined,
      });
      // The open chat joins under another stream id. Its `done` replaces the live copy
      // and clears the stream. The sender's own join resolves `finished` directly.
      await finished;
    } catch (e) {
      if (visible()) setFlash({ kind: "err", text: String(e) });
    } finally {
      ac.signal.removeEventListener("abort", onAbort);
      unlisten?.();
      if (turnsRef.current.get(id) === ac) turnsRef.current.delete(id);
      clearRunning(id);
      syncRunningFromTurns();
      // Stop ends the wait, not the transcript. The prompt stays in the live map
      // so the next send and a sidebar reload cannot paint the previous chat.
      const kept = liveByChatRef.current.get(id);
      if (kept && visible()) setMessages(kept.messages);
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
  try {
    const done = !hostedTurnStaysOnServer(remoteRef.current)
      ? await resumeLocalTurn({
          workspace: ws,
          conversationId: id,
          messages: next,
          model: turnSettings.model,
          effort: turnSettings.effort,
          contextWindow: turnSettings.contextWindow || undefined,
          permission: turnSettings.permission,
          system: systemForDetached(ws, id, turnSettings),
          allowSpawn: true,
          signal: ac.signal,
          onEvent: (event) => {
            latestCompaction = keepCompaction(latestCompaction, event.compaction);
            if (event.usage) latestUsage = event.usage;
            applyDetachedEvent(id, ws, visible, event);
          },
        })
      : await completeTurn({
      workspace: ws,
      messages: next,
      model: turnSettings.model,
      effort: turnSettings.effort,
      contextWindow: turnSettings.contextWindow || undefined,
      allowSpawn: true,
      mcpServers: mcpServersRef.current,
      skills: skillsRef.current,
      remote: remoteRef.current,
      worktrees: worktreeListsFor(ws),
      conversationId: id,
      onDelta: (chunk) => {
        const live = liveByChatRef.current.get(id);
        const streamText = hideWorktreeName(`${live?.streamText ?? ""}` + chunk, id, ws);
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
      commitPartialReply(closeDanglingToolCalls(storeWorktreeName(done, id, ws)), partialReply(id)),
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

function stop(targetId = activeIdRef.current) {
  const visibleId = targetId || activeIdRef.current;
  const target = visibleId ? turnsRef.current.get(visibleId) : undefined;
  (target ?? (visibleId === activeIdRef.current ? abortRef.current : null))?.abort();
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
