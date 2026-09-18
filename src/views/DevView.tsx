import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChatMarkdown, WorkspaceFileLinks } from "../components/ChatMarkdown";
import { ConversationList } from "../components/ConversationList";
import { DevComposer } from "../components/DevComposer";
import { DevEditor } from "../components/DevEditor";
import { DevWorkspace } from "../components/DevWorkspace";
import { GrokTerminal } from "../components/GrokTerminal";
import { Flash } from "../components/Flash";
import { FolderDialog } from "../components/FolderDialog";
import { SpaceCorner } from "../components/SpaceCorner";
import { SubagentDock } from "../components/SubagentDock";
import { ToolTrail } from "../components/ToolTrail";
import { Symbol } from "../components/Symbol";
import { ChromeTab, ChromeTabStrip } from "../components/ChromeTabs";
import { headerBarClass, WindowButtons } from "../components/WindowButtons";
import { isNearBottom } from "../lib/chat-scroll";
import { completeTurn } from "../lib/dev-agent";
import {
  contextWindowForModel,
  putChatUsage,
  sameChatUsage,
  usageToPersist,
  type ChatUsage,
} from "../lib/dev-context";
import { applySubagentEvent, type SubagentRecord } from "../lib/dev-subagent";
import {
  activityFromToolCall,
  conversationActivityLabel,
  conversationTitleFrom,
  folderName,
  isLiveToolTrail,
  liveTranscriptItems,
  moveById,
  newConversationId,
  nowIso,
  toolActivityLabel,
  type ChatMessage,
  type ConversationActivity,
} from "../lib/dev";
import {
  conversationHasSummarizeSource,
  JOURNEY_SUMMARIZE_PROMPT,
  journeyKnowledgePath,
  lastAssistantText,
  parseJourneyColor,
  type JourneyColor,
  type JourneySummary,
} from "../lib/dev-journey";
import {
  conversationDraft,
  parseConversationKind,
  type ConversationKind,
} from "../lib/dev-terminal-chat";
import { terminalSessions } from "../lib/dev-terminal-sessions";
import {
  closeEditorTab,
  editorFileView,
  emptyEditor,
  focusEditor,
  markdownViewForTab,
  pinEditorTab,
  previewEditorTab,
  requestCloseEditorTab,
  selectChatTab,
  selectEditorTab,
  setEditorFileView,
  setEditorMarkdownView,
  type EditorState,
} from "../lib/dev-editor";
import {
  DEV_SIDEBAR_DEFAULT,
  DEV_SIDEBAR_MAX,
  DEV_SIDEBAR_MIN,
  loadDevConversation,
  loadDevEffort,
  loadDevModel,
  loadDevPermission,
  loadDevRecentWorkspaces,
  loadDevSidebarWidth,
  loadDevWorkspace,
  loadMarkdownOpenMode,
  pushDevRecentWorkspace,
  saveDevConversation,
  saveDevEffort,
  saveDevModel,
  saveDevPermission,
  saveDevSidebarWidth,
  saveDevWorkspace,
} from "../lib/prefs";
import { parsePermissionMode, permissionLabel, shouldPromptShell, type PermissionMode } from "../lib/dev-permission";
import { formatElapsed } from "../lib/relative-time";
import {
  canPersistTurn,
  draftForChat,
  setDraftForChat,
  turnAppliesToChat,
} from "../lib/dev-turn";
import * as api from "../lib/tauri";
import type { DevConversationSummary, DevRuntime } from "../lib/tauri";
import { useApp } from "../state/app-state";
import { SettingsView } from "./SettingsView";

export function DevView() {
  const { setFlash } = useApp();
  const [workspace, setWorkspace] = useState(loadDevWorkspace);
  const [runtime, setRuntime] = useState<DevRuntime | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [permission, setPermission] = useState<PermissionMode>(() => parsePermissionMode(loadDevPermission()));
  const [conversations, setConversations] = useState<DevConversationSummary[]>([]);
  const [journeys, setJourneys] = useState<JourneySummary[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState("");
  const [streamText, setStreamText] = useState("");
  const [usageByChat, setUsageByChat] = useState<Record<string, ChatUsage>>({});
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const [runningActivity, setRunningActivity] = useState<ConversationActivity | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState(0);
  const [openingId, setOpeningId] = useState("");
  const [shellQueue, setShellQueue] = useState<
    { command: string; resolve: (ok: boolean) => void }[]
  >([]);
  const [subagents, setSubagents] = useState<SubagentRecord[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [tick, setTick] = useState(0);
  const [opened, setOpened] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [recents, setRecents] = useState(loadDevRecentWorkspaces);
  const [showSettings, setShowSettings] = useState(false);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadDevSidebarWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const permissionRef = useRef(permission);
  permissionRef.current = permission;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const deletedIdsRef = useRef(new Set<string>());
  const turnMessagesRef = useRef<ChatMessage[] | null>(null);
  const turnLiveRef = useRef({
    streamText: "",
    liveTools: [] as string[],
    activity: null as ConversationActivity | null,
  });
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const draft = draftForChat(drafts, activeId);

  const setDraft = useCallback((text: string) => {
    setDrafts((prev) => setDraftForChat(prev, activeId, text));
  }, [activeId]);

  const ready = Boolean(runtime?.ready);
  const models = runtime?.models ?? [];

  const reloadConversations = useCallback(async (ws: string, preferId?: string) => {
    if (!ws) {
      setConversations([]);
      setJourneys([]);
      setActiveId("");
      setMessages([]);
      return;
    }
    const rows = await api.devListConversations(ws);
    const nextJourneys = await api.devListJourneys(ws).catch(() => [] as JourneySummary[]);
    setConversations(rows);
    setJourneys(nextJourneys);
    const want = preferId || loadDevConversation(ws) || rows[0]?.id || "";
    if (!want) {
      setActiveId("");
      setMessages([]);
      return;
    }
    const found = rows.find((r) => r.id === want);
    if (!found) {
      setActiveId("");
      setMessages([]);
      return;
    }
    const full = await api.devGetConversation(ws, found.id);
    setActiveId(found.id);
    setMessages((full.messages as ChatMessage[]) ?? []);
    setUsageByChat((prev) => putChatUsage(prev, found.id, full.context_usage));
    saveDevConversation(ws, found.id);
  }, []);

  const applyRuntime = useCallback((next: DevRuntime) => {
    setRuntime(next);
    const savedModel = loadDevModel();
    const nextModel = next.models.some((m) => m.id === savedModel)
      ? savedModel
      : next.default_model;
    const chosen = next.models.find((m) => m.id === nextModel) ?? next.models[0];
    const savedEffort = loadDevEffort();
    const nextEffort = chosen?.efforts.some((e) => e.id === savedEffort)
      ? savedEffort
      : next.default_effort;
    setModel(nextModel);
    setEffort(
      chosen?.efforts.some((e) => e.id === nextEffort)
        ? nextEffort
        : (chosen?.efforts[0]?.id ?? ""),
    );
  }, []);

  const reloadRuntime = useCallback(() => {
    void api
      .devRuntime()
      .then(applyRuntime)
      .catch(() =>
        applyRuntime({
          installed: false,
          logged_in: false,
          version: null,
          email: null,
          default_model: "grok-4.6",
          default_effort: "high",
          models: [
            {
              id: "grok-4.6",
              name: "Grok 4.6",
              efforts: [
                { id: "xhigh", label: "Extra high" },
                { id: "high", label: "High" },
                { id: "medium", label: "Medium" },
                { id: "low", label: "Low" },
              ],
            },
          ],
          has_key: false,
          ready: false,
          hint: "Install the Grok CLI, or add an xAI API key in Settings.",
        }),
      );
  }, [applyRuntime]);

  useEffect(() => {
    reloadRuntime();
  }, [reloadRuntime]);

  useEffect(() => {
    if (workspace) setRecents(pushDevRecentWorkspace(workspace));
  }, [workspace]);

  useEffect(() => {
    if (workspace) void reloadConversations(workspace).catch((e) => setFlash({ kind: "err", text: String(e) }));
  }, [workspace, reloadConversations, setFlash]);

  useEffect(() => {
    if (!workspace) {
      setOpened(false);
      return;
    }
    let cancelled = false;
    setOpened(false);
    void api
      .devOpenFolder(workspace)
      .then((path) => {
        if (cancelled) return;
        if (path !== workspace) {
          saveDevWorkspace(path);
          setWorkspace(path);
          return;
        }
        setOpened(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setOpened(false);
        setFlash({ kind: "err", text: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, setFlash]);

  const pendingShell = shellQueue[0] ?? null;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, pendingShell, runningActivity, liveTools, openingId]);

  const closeSettings = useCallback(() => setShowSettings(false), []);

  const onSidebarResizeStart = useCallback((ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startWidth = sidebarWidth;
    setSidebarDragging(true);

    function onMove(move: PointerEvent) {
      const next = Math.min(
        DEV_SIDEBAR_MAX,
        Math.max(DEV_SIDEBAR_MIN, Math.round(startWidth + (move.clientX - startX))),
      );
      setSidebarWidth(next);
    }
    function onUp(up: PointerEvent) {
      handle.releasePointerCapture(up.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setSidebarDragging(false);
      setSidebarWidth((next) => {
        saveDevSidebarWidth(next);
        return next;
      });
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, [sidebarWidth]);

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

  function applyWorkspace(path: string) {
    abortRef.current?.abort();
    void terminalSessions.disposeAll();
    saveDevWorkspace(path);
    setRecents(pushDevRecentWorkspace(path));
    setWorkspace(path);
    setEditor(emptyEditor());
    setDirtyFiles({});
    setPendingClosePath(null);
    setSubagents([]);
    setExpandedAgents({});
    setDrafts({});
    setUsageByChat({});
    setJourneys([]);
    setFolderOpen(false);
  }

  async function startNewChat(kind: ConversationKind = "chat", journeyId?: string) {
    setShowSettings(false);
    setSubagents([]);
    setExpandedAgents({});
    if (!workspace) {
      setFolderOpen(true);
      return;
    }
    stickToBottomRef.current = true;
    const conv = conversationDraft(kind, newConversationId(), nowIso(), journeyId);
    await api.devSaveConversation(workspace, conv);
    saveDevConversation(workspace, conv.id);
    setActiveId(conv.id);
    setMessages([]);
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

  async function openChat(id: string) {
    setShowSettings(false);
    if (!workspace || id === activeId) return;
    stickToBottomRef.current = true;
    setSubagents([]);
    setExpandedAgents({});
    if (runningId === id && turnMessagesRef.current) {
      setActiveId(id);
      setMessages(turnMessagesRef.current);
      setStreamText(turnLiveRef.current.streamText);
      setLiveTools(turnLiveRef.current.liveTools);
      saveDevConversation(workspace, id);
      return;
    }
    setStreamText("");
    setLiveTools([]);
    setOpeningId(id);
    try {
      const full = await api.devGetConversation(workspace, id);
      setActiveId(id);
      setMessages((full.messages as ChatMessage[]) ?? []);
      setUsageByChat((prev) => putChatUsage(prev, id, full.context_usage));
      saveDevConversation(workspace, id);
    } finally {
      setOpeningId("");
    }
  }

  async function removeChat(id: string) {
    if (!workspace) return;
    deletedIdsRef.current.add(id);
    if (runningId === id) abortRef.current?.abort();
    setUsageByChat((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    await terminalSessions.dispose(id);
    await api.devDeleteConversation(workspace, id);
    if (activeId === id) {
      saveDevConversation(workspace, "");
      await reloadConversations(workspace);
    } else {
      setConversations((rows) => rows.filter((r) => r.id !== id));
    }
  }

  async function persist(next: ChatMessage[], id: string, ws = workspace, usage?: ChatUsage) {
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
      messages: next,
      context_usage: usageToPersist(usage, usageByChat[id]),
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

  async function reorderChats(fromId: string, toId: string) {
    const from = conversations.find((row) => row.id === fromId);
    const siblings = conversations.filter((row) => (row.journey_id ?? null) === (from?.journey_id ?? null));
    const next = moveById(siblings, fromId, toId);
    if (next === siblings) return;
    if (!workspace) return;
    try {
      const saved = await api.devReorderConversations(
        workspace,
        next.map((row) => row.id),
      );
      setConversations(saved);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      await reloadConversations(workspace);
    }
  }

  async function reorderSidebar(
    fromId: string,
    fromKind: "journey" | "conversation",
    toId: string,
    toKind: "journey" | "conversation",
  ) {
    if (!workspace) return;
    const top: api.DevSidebarItem[] = [];
    const seen = new Set<string>();
    const ordered = [...journeys.map((j) => ({ kind: "journey" as const, id: j.id, sort: j.sort_order })),
      ...conversations
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
      const saved = await api.devReorderSidebar(workspace, next);
      setConversations(saved);
      setJourneys(await api.devListJourneys(workspace));
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      await reloadConversations(workspace);
    }
  }

  async function createJourneyFromChat(id: string) {
    if (!workspace) return;
    const seed = conversations.find((row) => row.id === id);
    if (!seed || seed.journey_id || runningId === id) return;
    try {
      const journey = await api.devCreateJourney(workspace, id);
      const [rows, nextJourneys] = await Promise.all([
        api.devListConversations(workspace),
        api.devListJourneys(workspace),
      ]);
      setConversations(rows);
      setJourneys(nextJourneys);
      const msgs = id === activeId ? messages : (((await api.devGetConversation(workspace, id)).messages as ChatMessage[]) ?? []);
      if (id !== activeId) await openChat(id);
      if (!conversationHasSummarizeSource(msgs)) return;
      const next = [...msgs, { role: "user" as const, content: JOURNEY_SUMMARIZE_PROMPT }];
      await runTurn(workspace, id, next, async (done) => {
        const text = lastAssistantText(done);
        if (!text) return;
        await api.devSaveJourneyKnowledge(workspace, journey.id, text);
        setTick((n) => n + 1);
      }, journey.id);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
    }
  }

  async function openJourneyKnowledge(id: string) {
    setShowSettings(false);
    setEditor((prev) => pinEditorTab(prev, journeyKnowledgePath(id)));
  }

  async function toggleJourney(id: string) {
    const current = journeys.find((row) => row.id === id);
    if (!current || !workspace) return;
    const collapsed = !current.collapsed;
    setJourneys((rows) => rows.map((row) => (row.id === id ? { ...row, collapsed } : row)));
    try {
      await api.devSetJourneyCollapsed(workspace, id, collapsed);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      await reloadConversations(workspace);
    }
  }

  async function setJourneyColor(id: string, color: JourneyColor) {
    if (!workspace) return;
    setJourneys((rows) => rows.map((row) => (row.id === id ? { ...row, color } : row)));
    try {
      const next = await api.devSetJourneyColor(workspace, id, color);
      setJourneys((rows) => rows.map((row) => (row.id === id ? { ...row, color: parseJourneyColor(next.color) } : row)));
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      await reloadConversations(workspace);
    }
  }

  async function renameJourney(id: string, title: string) {
    if (!workspace) return;
    try {
      const next = await api.devRenameJourney(workspace, id, title);
      setJourneys((rows) => rows.map((row) => (row.id === id ? next : row)));
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
    }
  }

  async function deleteJourney(id: string, deleteChats: boolean) {
    if (!workspace) return;
    const kids = conversations.filter((row) => row.journey_id === id);
    try {
      if (deleteChats) {
        for (const kid of kids) {
          deletedIdsRef.current.add(kid.id);
          if (runningId === kid.id) abortRef.current?.abort();
          await terminalSessions.dispose(kid.id);
        }
      }
      await api.devDeleteJourney(workspace, id, deleteChats);
      setEditor((prev) => closeEditorTab(prev, journeyKnowledgePath(id)));
      setDirtyFiles((prev) => {
        const next = { ...prev };
        delete next[journeyKnowledgePath(id)];
        return next;
      });
      const prefer = deleteChats && kids.some((kid) => kid.id === activeId) ? undefined : activeId;
      await reloadConversations(workspace, prefer);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
    }
  }

  async function moveConversation(id: string, journeyId: string | null) {
    if (!workspace) return;
    try {
      await api.devMoveConversation(workspace, id, journeyId);
      const [rows, nextJourneys] = await Promise.all([
        api.devListConversations(workspace),
        api.devListJourneys(workspace),
      ]);
      setConversations(rows);
      setJourneys(nextJourneys);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
    }
  }

  function confirmShell(command: string): Promise<boolean> {
    if (!shouldPromptShell(permissionRef.current)) {
      return Promise.resolve(permissionRef.current === "approve-all");
    }
    return new Promise((resolve) => setShellQueue((q) => [...q, { command, resolve }]));
  }

  function answerShell(ok: boolean) {
    setShellQueue((q) => {
      const [head, ...rest] = q;
      head?.resolve(ok);
      return rest;
    });
  }

  function pickModel(id: string) {
    setModel(id);
    saveDevModel(id);
    const next = models.find((m) => m.id === id);
    if (next && !next.efforts.some((e) => e.id === effort)) {
      const fallback = next.efforts[0]?.id ?? "";
      setEffort(fallback);
      if (fallback) saveDevEffort(fallback);
    }
  }

  function pickEffort(id: string) {
    setEffort(id);
    saveDevEffort(id);
  }

  function pickPermission(id: string) {
    const next = parsePermissionMode(id);
    setPermission(next);
    saveDevPermission(next);
    if (shouldPromptShell(next)) return;
    const ok = next === "approve-all";
    setShellQueue((q) => {
      for (const item of q) item.resolve(ok);
      return [];
    });
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
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
      ws = await api.devOpenFolder(ws);
    } catch (e) {
      setFlash({ kind: "err", text: String(e) });
      return;
    }
    let id = activeId;
    if (!id) {
      const now = nowIso();
      id = newConversationId();
      await api.devSaveConversation(ws, {
        id,
        title: conversationTitleFrom([{ role: "user", content: text }]),
        created_at: now,
        updated_at: now,
        kind: "chat",
        messages: [],
      });
      setActiveId(id);
      activeIdRef.current = id;
      saveDevConversation(ws, id);
    }
    stickToBottomRef.current = true;
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setDrafts((prev) => setDraftForChat(prev, id, ""));
    await runTurn(ws, id, next);
  }

  async function runTurn(
    ws: string,
    id: string,
    next: ChatMessage[],
    after?: (done: ChatMessage[]) => Promise<void>,
    journeyIdOverride?: string,
  ) {
    setMessages(next);
    setBusy(true);
    setRunningId(id);
    setTurnStartedAt(Date.now());
    setStreamText("");
    setLiveTools([]);
    setRunningActivity(null);
    turnLiveRef.current = { streamText: "", liveTools: [], activity: null };
    turnMessagesRef.current = next;
    const ac = new AbortController();
    abortRef.current = ac;
    const visible = () => turnAppliesToChat(id, activeIdRef.current);
    let latestUsage = usageByChat[id];
    const journeyId =
      journeyIdOverride || conversations.find((row) => row.id === id)?.journey_id || undefined;
    const kind = parseConversationKind(conversations.find((row) => row.id === id)?.kind);
    let knowledge = "";
    if (journeyId && kind === "chat") {
      try {
        knowledge = await api.devGetJourneyKnowledge(ws, journeyId);
      } catch {
        knowledge = "";
      }
    }
    try {
      const done = await completeTurn({
        workspace: ws,
        messages: next,
        model,
        effort,
        allowSpawn: true,
        journeyId: kind === "chat" ? journeyId : undefined,
        journeyKnowledge: kind === "chat" ? knowledge : undefined,
        onDelta: (chunk) => {
          turnLiveRef.current.streamText += chunk;
          if (visible()) setStreamText(turnLiveRef.current.streamText);
        },
        onError: (err) => {
          if (visible()) setFlash({ kind: "err", text: err });
        },
        confirmShell,
        getPermission: () => permissionRef.current,
        onTool: (call) => {
          if (call.name === "spawn_subagent") return;
          const activity = activityFromToolCall(call);
          const labels = [...turnLiveRef.current.liveTools, toolActivityLabel(call)];
          turnLiveRef.current.activity = activity;
          turnLiveRef.current.liveTools = labels;
          setRunningActivity(activity);
          if (visible()) setLiveTools(labels);
        },
        onSubagent: (event) => {
          if (!visible()) return;
          setSubagents((rows) => applySubagentEvent(rows, event));
          if (event.type === "start") {
            setExpandedAgents((prev) => ({ ...prev, [event.record.id]: true }));
          }
        },
        onUpdate: (nextMessages) => {
          turnMessagesRef.current = nextMessages;
          turnLiveRef.current.streamText = "";
          turnLiveRef.current.activity = null;
          setRunningActivity(null);
          if (!visible()) return;
          setMessages(nextMessages);
          setStreamText("");
        },
        onRefresh: () => setTick((n) => n + 1),
        onUsage: (usage) => {
          latestUsage = usage;
          setUsageByChat((prev) => (sameChatUsage(prev[id], usage) ? prev : { ...prev, [id]: usage }));
        },
        signal: ac.signal,
      });
      turnMessagesRef.current = done;
      turnLiveRef.current = { streamText: "", liveTools: [], activity: null };
      setRunningActivity(null);
      if (visible()) {
        setMessages(done);
        setStreamText("");
        setLiveTools([]);
      }
      await persist(done, id, ws, latestUsage);
      await after?.(done);
    } catch (e) {
      const pending = turnMessagesRef.current;
      if (pending) await persist(pending, id, ws, latestUsage);
      if (visible()) setFlash({ kind: "err", text: String(e) });
    } finally {
      abortRef.current = null;
      turnMessagesRef.current = null;
      setBusy(false);
      setRunningId("");
      setRunningActivity(null);
      setTurnStartedAt(0);
      turnLiveRef.current = { streamText: "", liveTools: [], activity: null };
      setShellQueue((q) => {
        for (const item of q) item.resolve(false);
        return [];
      });
    }
  }

  function stop() {
    abortRef.current?.abort();
    setShellQueue((q) => {
      for (const item of q) item.resolve(false);
      return [];
    });
  }

  const openWorkspaceFile = useCallback(
    (path: string, mode: "preview" | "pin" = "pin", view: "edit" | "diff" = "edit") => {
      setShowSettings(false);
      setEditor((prev) => {
        const next = mode === "preview" ? previewEditorTab(prev, path) : pinEditorTab(prev, path);
        return setEditorFileView(next, path, view);
      });
    },
    [],
  );

  const showLanding =
    !showSettings && messages.length === 0 && conversations.length === 0 && !busy && !streamText;

  useEffect(() => {
    if (showLanding || showSettings || editor.focus === "file") return;
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottomRef.current = isNearBottom(el);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickToBottomRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [showLanding, showSettings, editor.focus]);

  const folderDialog = folderOpen ? (
    <FolderDialog
      onClose={() => setFolderOpen(false)}
      onPick={applyWorkspace}
      showProjects
      recents={recents}
    />
  ) : null;

  if (showLanding) {
    return (
      <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-canvas">
        <Flash />
        <SpaceCorner />
        <div className={`relative z-10 flex shrink-0 items-center ${headerBarClass()}`} data-tauri-drag-region>
          <WindowButtons />
          <div className="min-w-0 flex-1" data-tauri-drag-region />
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setShowSettings(true)}
            className="mr-1 flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
          >
            <Symbol name="gearshape" className="size-3.5" />
          </button>
        </div>
        {folderDialog}
        <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-16">
          <div className="w-full max-w-[640px]">
            <DevComposer
              draft={draft}
              onDraft={setDraft}
              onSend={() => void send()}
              onStop={stop}
              busy={busy}
              ready={ready}
              placeholder={ready ? "Ask Grok…" : "Sign in to Grok to start"}
              workspace={workspace}
              onOpenFolder={openFolder}
              models={models}
              model={model}
              onModel={pickModel}
              effort={effort}
              onEffort={pickEffort}
              permission={permission}
              onPermission={pickPermission}
              autoFocus
            />
            {runtime && !runtime.ready && runtime.hint && (
              <p className="mt-3 text-center text-[12px] text-muted">{runtime.hint}</p>
            )}
            {workspace ? (
              <p className="mt-4 text-center">
                <button
                  type="button"
                  onClick={() => void startNewChat("terminal")}
                  className="text-[12px] text-muted hover:text-ink"
                >
                  Open a Grok terminal
                </button>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <WorkspaceFileLinks workspace={workspace || null} tick={tick} onOpenFile={openWorkspaceFile}>
    <div className="flex h-full min-w-0 overflow-hidden bg-sidebar">
      <Flash />
      {folderDialog}
      <aside className="relative flex shrink-0 flex-col bg-sidebar" style={{ width: sidebarWidth }}>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
          onPointerDown={onSidebarResizeStart}
          onDoubleClick={() => {
            setSidebarWidth(DEV_SIDEBAR_DEFAULT);
            saveDevSidebarWidth(DEV_SIDEBAR_DEFAULT);
          }}
          className={`absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize touch-none ${
            sidebarDragging ? "bg-accent/20" : "hover:bg-accent/15"
          }`}
        />
        <SpaceCorner />
        <div className={`relative z-10 flex shrink-0 items-center ${headerBarClass()}`} data-tauri-drag-region>
          <WindowButtons />
          <div className="min-w-0 flex-1" data-tauri-drag-region />
          <button
            type="button"
            aria-label="Open project"
            title="Open project"
            onClick={openFolder}
            className="mr-2 flex size-7 items-center justify-center rounded-[6px] text-ink hover:bg-wash"
          >
            <Symbol name="plus" className="size-3.5" />
          </button>
        </div>
        <div className="relative z-20 flex items-center justify-between px-4 pt-1.5 pb-1">
          <div className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
            Conversations
          </div>
          <NewChatMenu disabled={!workspace} onPick={(kind) => void startNewChat(kind)} />
        </div>
        <div className="relative z-10 min-h-0 flex-1 overflow-auto px-2 pb-2">
          {conversations.length === 0 && journeys.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-muted">{workspace ? "No chats yet" : "Open a folder"}</p>
          ) : (
            <ConversationList
              conversations={conversations}
              journeys={journeys}
              activeId={activeId}
              runningId={runningId}
              loadingId={openingId}
              runningPreview={conversationActivityLabel(runningActivity)}
              showSettings={showSettings}
              onOpen={(id) => void openChat(id)}
              onDelete={(id) => void removeChat(id)}
              onReorder={(fromId, toId) => void reorderChats(fromId, toId)}
              onReorderSidebar={(fromId, fromKind, toId, toKind) =>
                void reorderSidebar(fromId, fromKind, toId, toKind)
              }
              onCreateJourney={(id) => void createJourneyFromChat(id)}
              onOpenKnowledge={(id) => void openJourneyKnowledge(id)}
              onNewChat={(journeyId, kind) => void startNewChat(kind, journeyId)}
              onToggleCollapse={(id) => void toggleJourney(id)}
              onRenameJourney={(id, title) => void renameJourney(id, title)}
              onDeleteJourney={(id, deleteChats) => void deleteJourney(id, deleteChats)}
              onRemoveFromJourney={(id) => void moveConversation(id, null)}
              onMoveToJourney={(id, journeyId) => void moveConversation(id, journeyId)}
              onSetColor={(id, color) => void setJourneyColor(id, color)}
            />
          )}
        </div>
        <div className="relative z-10 flex flex-col gap-1 px-2.5 pb-3">
          <button
            type="button"
            onClick={openFolder}
            className="flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] text-ink/90 hover:bg-wash"
            title={workspace || "Open folder"}
          >
            <Symbol name="folder.fill" className="size-4 text-accent" />
            <span className="min-w-0 truncate">{workspace ? folderName(workspace) : "Open folder"}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] ${
              showSettings ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
            }`}
          >
            <Symbol name="gearshape" className="size-4 text-muted" />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={`flex shrink-0 items-end ${headerBarClass()}`} data-tauri-drag-region>
          {!showSettings ? (
            <CenterTabs
              editor={editor}
              chatKind={parseConversationKind(conversations.find((c) => c.id === activeId)?.kind)}
              onChat={() => setEditor((prev) => selectChatTab(prev))}
              onCode={() => setEditor((prev) => focusEditor(prev))}
            />
          ) : (
            <div className="min-w-0 flex-1" data-tauri-drag-region />
          )}
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-t-[12px] border border-r-0 border-b-0 border-line bg-canvas">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {showSettings ? (
              <SettingsView
                embedded
                initialTab="grok"
                onKeyChange={reloadRuntime}
                onClose={folderOpen ? undefined : closeSettings}
              />
            ) : editor.focus === "file" && editor.activePath && opened ? (
                <DevEditor
                  workspace={workspace}
                  path={editor.activePath}
                  tick={tick}
                  fileView={editorFileView(editor.tabs.find((tab) => tab.path === editor.activePath))}
                  markdownView={markdownViewForTab(
                    editor.activePath,
                    loadMarkdownOpenMode(),
                    editor.tabs.find((tab) => tab.path === editor.activePath)?.markdownView,
                  )}
                  editor={editor}
                  dirtyFiles={dirtyFiles}
                  pendingClosePath={pendingClosePath}
                  journeyTitles={Object.fromEntries(journeys.map((row) => [row.id, row.title]))}
                  onMarkdownView={(mode) =>
                    setEditor((prev) => setEditorMarkdownView(prev, editor.activePath ?? "", mode))
                  }
                  onDirty={(path, dirty) => {
                    setDirtyFiles((prev) => (prev[path] === dirty ? prev : { ...prev, [path]: dirty }));
                    if (dirty) setEditor((prev) => pinEditorTab(prev, path));
                  }}
                  onSelectTab={(path) => setEditor((prev) => selectEditorTab(prev, path))}
                  onPinTab={(path) => setEditor((prev) => pinEditorTab(prev, path))}
                  onCloseTab={closeFileTab}
                />
              ) : parseConversationKind(conversations.find((c) => c.id === activeId)?.kind) === "terminal" &&
                workspace &&
                opened &&
                activeId ? (
                <GrokTerminal workspace={workspace} conversationId={activeId} active />
              ) : (
                <>
                  <SubagentDock
                    agents={subagents}
                    expanded={expandedAgents}
                    onToggle={(id) =>
                      setExpandedAgents((prev) => ({ ...prev, [id]: !prev[id] }))
                    }
                  />
                  <div className="relative min-h-0 min-w-0 flex-1">
                    <div ref={scroller} className="no-scrollbar absolute inset-0 overflow-auto">
                      <div
                        className="mx-auto w-full min-w-0 max-w-[720px] px-6 pt-5 pb-5"
                      >
                        <div className="mb-5">
                          <div className="truncate text-[15px] font-semibold">
                            {workspace ? folderName(workspace) : "TwanAgent"}
                          </div>
                          <div className="truncate text-[12px] text-muted">
                            {models.find((m) => m.id === model)?.name ?? "Grok"}
                            {effort
                              ? ` · ${models.find((m) => m.id === model)?.efforts.find((e) => e.id === effort)?.label ?? effort}`
                              : ""}
                            {` · ${permissionLabel(permission)}`}
                            {workspace ? ` · ${workspace}` : ""}
                          </div>
                        </div>
                        {messages.length === 0 && !streamText && !busy && (
                          <p className="m-0 text-center text-[13px] text-muted">
                            Ask Grok to inspect, edit, or run something in this folder.
                          </p>
                        )}
                        <ChatTranscript
                          messages={messages}
                          streamText={streamText}
                          liveTools={liveTools}
                          busy={busy}
                        />
                        {openingId && openingId !== runningId ? (
                          <ActivityStatus label="Loading…" />
                        ) : null}
                        {busy && activeId === runningId && !pendingShell && (
                          <ActivityStatus
                            label={conversationActivityLabel(runningActivity)}
                            startedAt={turnStartedAt}
                          />
                        )}
                        {pendingShell && (
                          <div className="mb-4 rounded-md border border-line bg-panel px-3 py-2.5">
                            <div className="text-[12px] font-medium">Run this command?</div>
                            <pre className="mt-1 mb-2 overflow-auto rounded bg-canvas px-2 py-1.5 font-mono text-[12px]">
                              {pendingShell.command}
                            </pre>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent"
                                onClick={() => answerShell(true)}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                className="rounded-md border border-line px-2.5 py-1 text-[12px]"
                                onClick={() => answerShell(false)}
                              >
                                Skip
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <div className="mx-auto w-full min-w-0 max-w-[720px] px-6 py-3">
                      <DevComposer
                        draft={draft}
                        onDraft={setDraft}
                        onSend={() => void send()}
                        onStop={stop}
                        busy={busy}
                        ready={ready}
                        placeholder={ready ? "Message Grok…" : "Sign in to Grok to continue"}
                        workspace={workspace}
                        onOpenFolder={openFolder}
                        models={models}
                        model={model}
                        onModel={pickModel}
                        effort={effort}
                        onEffort={pickEffort}
                        permission={permission}
                        onPermission={pickPermission}
                        compact
                        usage={activeId ? usageByChat[activeId] : undefined}
                        usageWindow={contextWindowForModel(
                          model,
                          models.find((m) => m.id === model)?.context_window,
                        )}
                      />
                    </div>
                  </div>
                </>
              )}
          </div>
          {workspace && opened && !showSettings ? (
            <DevWorkspace
              workspace={workspace}
              tick={tick}
              selectedPath={editor.activePath}
              onOpenFile={openWorkspaceFile}
              onRefresh={() => setTick((n) => n + 1)}
            />
          ) : null}
        </div>
      </div>
    </div>
    </WorkspaceFileLinks>
  );
}

function NewChatMenu({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (kind: ConversationKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-[11px] text-muted hover:text-ink disabled:opacity-35"
      >
        New chat
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 min-w-[148px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-card"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPick("chat");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
          >
            <Symbol name="bubble.left" className="size-3.5 text-muted" />
            Chat
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPick("terminal");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
          >
            <Symbol name="terminal" className="size-3.5 text-muted" />
            Terminal
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CenterTabs({
  editor,
  chatKind,
  onChat,
  onCode,
}: {
  editor: EditorState;
  chatKind: ConversationKind;
  onChat: () => void;
  onCode: () => void;
}) {
  const chatOn = editor.focus === "chat";
  const codeOn = editor.focus === "file";
  const terminal = chatKind === "terminal";
  return (
    <ChromeTabStrip>
      <ChromeTab
        selected={chatOn}
        label={terminal ? "Terminal" : "Chat"}
        icon={<Symbol name={terminal ? "terminal.fill" : "bubble.left.fill"} className="size-3.5 shrink-0" />}
        onClick={onChat}
      />
      {editor.tabs.length > 0 ? (
        <ChromeTab
          selected={codeOn}
          label="Code"
          icon={<Symbol name="doc.fill" className="size-3.5 shrink-0" />}
          onClick={onCode}
        />
      ) : null}
    </ChromeTabStrip>
  );
}

function ActivityStatus({ label, startedAt }: { label: string; startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "";
  return (
    <div className="mb-3 flex items-center gap-1.5 text-[11px] text-muted/55" aria-live="polite">
      <span
        className="size-2.5 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
        aria-hidden
      />
      <span>{label}</span>
      {elapsed ? <span className="tabular-nums text-muted/40">{elapsed}</span> : null}
    </div>
  );
}

function ChatTranscript({
  messages,
  streamText,
  liveTools,
  busy,
}: {
  messages: ChatMessage[];
  streamText: string;
  liveTools: string[];
  busy: boolean;
}) {
  const items = liveTranscriptItems(messages, streamText, liveTools);
  return (
    <>
      {items.map((item, i) => (
        <TranscriptBlock key={i} item={item} live={isLiveToolTrail(items, i, busy)} />
      ))}
    </>
  );
}

function TranscriptBlock({
  item,
  live,
}: {
  item: ReturnType<typeof liveTranscriptItems>[number];
  live: boolean;
}) {
  if (item.kind === "tools") return <ToolTrail labels={item.labels} files={item.files} live={live} />;
  if (item.kind === "error") {
    return <p className="mb-4 text-[13px] leading-relaxed text-err [overflow-wrap:anywhere]">{item.content}</p>;
  }
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {item.kind === "user" ? "You" : "Grok"}
      </div>
      {item.kind === "assistant" ? (
        <ChatMarkdown text={item.content} />
      ) : (
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed [overflow-wrap:anywhere]">
          {item.content}
        </div>
      )}
    </div>
  );
}
