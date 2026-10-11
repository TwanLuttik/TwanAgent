import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { CHAT_BOTTOM_PAD_FALLBACK, chatBottomPadding, isNearBottom, pinChatToEnd } from "../lib/chat-scroll";
import { scrollTopAfterPrepend } from "../lib/chat-window";
import { insertCompactionEvent } from "../lib/compact";
import { contextWindowChoices, parseChatUsage, putChatUsage, resolveContextWindow, type ChatUsage } from "../lib/context";
import { detectMcp, setMcpEnabledInToml, withMcpAuth, type DetectedMcpServer } from "../lib/mcp";
import { detectSkills, parseSkillOrigin, setSkillEnabledInToml, userSkillRel, type DetectedSkill } from "../lib/skill";
import { closeChatTab as closeChatTabList, openChatTab } from "../lib/chat-tabs";
import { projectKey, type ChatImage, type ChatMessage, type ConversationActivity, type LiveToolRow } from "../lib/core";
import { clearLiveStream, setLiveStream, subscribeLiveStream } from "../lib/live-stream";
import { bumpFileRefresh, fileStructureFiles, fileStructureSignature, publishFileStructure, subscribeFileRefresh, subscribeFileStructure } from "../lib/file-structure";
import { imagePathsFromDrop, imagesForChat } from "../lib/image";
import { applyLiveProjectChats, isArchivedConversation, isSameProject, placeProjectChats, sameJourneyList, sameSidebarConversationList, sidebarProjects, type ProjectChatGroup } from "../lib/all-projects";
import type { JourneySummary } from "../lib/journey";
import { parseConversationKind } from "../lib/terminal-chat";
import { emptyEditor, mcpEditorPath, pinEditorTab, previewEditorTab, setEditorFileView, type EditorState } from "../lib/editor";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  loadCollapsedProjects,
  loadContextWindow,
  loadComposerDrafts,
  loadComposerPastes,
  saveComposerPastes,
  loadConversation,
  loadEffort,
  loadModel,
  loadPermission,
  loadRecentWorkspaces,
  loadSidebarWidth,
  loadWorkspace,
  pushRecentWorkspace,
  rewriteStoredProjectPaths,
  saveComposerDraft,
  saveConversation,
  saveSidebarWidth,
  saveWorkspace,
} from "../lib/prefs";
import { parsePermissionMode, type PermissionMode, type RemoteWorkspace } from "../lib/permission";
import { startAccountUsage } from "../lib/account-usage-store";
import { startProviderStatus } from "../lib/provider-status";
import { normalizeSpeechModel, speechModel, type SpeechModelInfo } from "../lib/speech";
import { collectWorkspaceFiles, type MentionFile } from "../lib/mention";
import type { PasteBlock } from "../lib/paste";
import { chatHasRunningTurn, clearUnseenFinished, composerSettingsForChat, draftForChat, liveTurnMessages, pendingForChat, setDraftForChat, type PendingEdit, type PendingMessage, type RunningTurn } from "../lib/turn";
import * as api from "../lib/tauri";
import type { ConversationSummary, Runtime } from "../lib/tauri";
import { useApp } from "../state/app-state";
import { emptyGrokPlan, planModeEngaged, type GrokPlan, type PlanDecision, type PlanPrompt } from "../lib/plan";
import { emptySubagentDock, type SubagentDockState, type SubagentRecord } from "../lib/subagent";
import { bindTurn } from "./main/useTurn";
import { useLibrary, type RunTurn } from "./main/useLibrary";
import type { MainModel, SidebarSlice } from "./main/context";
import { MainProvider } from "./main/context";
import type { SettingsTab } from "./SettingsView";
import { MainShell } from "./main/MainShell";

export function MainView() {
  const { setFlash } = useApp();
  const [workspace, setWorkspace] = useState(loadWorkspace);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [contextWindow, setContextWindow] = useState(0);
  const [permission, setPermission] = useState<PermissionMode>(() => parsePermissionMode(loadPermission()));
  const [speechModelId, setSpeechModelId] = useState(speechModel(null).id);
  const [speechRows, setSpeechRows] = useState<SpeechModelInfo[]>([]);
  const [speechProgress, setSpeechProgress] = useState<{ id: string; received: number; total: number } | null>(null);
  const [speechDownloading, setSpeechDownloading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [journeys, setJourneys] = useState<JourneySummary[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>(loadComposerDrafts);
  const [pastesByChat, setPastesByChat] = useState<Record<string, PasteBlock[]>>(loadComposerPastes);
  const [mentionFiles, setMentionFiles] = useState<MentionFile[]>([]);
  const [draftImages, setDraftImages] = useState<Record<string, ChatImage[]>>({});
  const [pendingByChat, setPendingByChat] = useState<Record<string, PendingMessage[]>>({});
  const [editingPending, setEditingPending] = useState<PendingEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatTabsByProject, setChatTabsByProject] = useState<Record<string, string[]>>({});
  const [runningId, setRunningId] = useState("");
  const [runningTurns, setRunningTurns] = useState<Record<string, RunningTurn>>({});
  const [unseenFinished, setUnseenFinished] = useState<ReadonlySet<string>>(() => new Set());
  const [usageByChat, setUsageByChat] = useState<Record<string, ChatUsage>>({});
  const [compactionByChat, setCompactionByChat] = useState<Record<string, { summary: string; through: number }>>({});
  // Foreground live tail lives in the external store so a token does not render MainView.
  const setStreamText = useCallback((value: string | ((prev: string) => string)) => {
    setLiveStream((prev) => ({
      streamText: typeof value === "function" ? value(prev.streamText) : value,
    }));
  }, []);
  const setStreamReasoning = useCallback((value: string | ((prev: string) => string)) => {
    setLiveStream((prev) => ({
      streamReasoning: typeof value === "function" ? value(prev.streamReasoning) : value,
    }));
  }, []);
  const setLiveTools = useCallback((value: LiveToolRow[] | ((prev: LiveToolRow[]) => LiveToolRow[])) => {
    setLiveStream((prev) => ({
      liveTools: typeof value === "function" ? value(prev.liveTools) : value,
    }));
  }, []);
  const setRunningActivity = useCallback(
    (value: ConversationActivity | null | ((prev: ConversationActivity | null) => ConversationActivity | null)) => {
      setLiveStream((prev) => ({
        runningActivity: typeof value === "function" ? value(prev.runningActivity) : value,
      }));
    },
    [],
  );
  const [turnStartedAt, setTurnStartedAt] = useState(0);
  const [openingId, setOpeningId] = useState("");
  const [shellQueue, setShellQueue] = useState<
    { chatId: string; command: string; resolve: (ok: boolean) => void }[]
  >([]);
  const [planTick, setPlanTick] = useState(0);
  const [planQueue, setPlanQueue] = useState<
    {
      chatId: string;
      prompt: PlanPrompt;
      resolve: (answer: { decision: PlanDecision; note: string }) => void;
    }[]
  >([]);
  const [subagents, setSubagents] = useState<SubagentRecord[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [mcpServers, setMcpServers] = useState<DetectedMcpServer[]>([]);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [skills, setSkills] = useState<DetectedSkill[]>([]);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [recents, setRecents] = useState(loadRecentWorkspaces);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("providers");
  const [showUsage, setShowUsage] = useState(false);
  const [projectSettings, setProjectSettings] = useState<{ path: string; name: string } | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  const [fileDrag, setFileDrag] = useState(false);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [allProjectGroups, setAllProjectGroups] = useState<ProjectChatGroup[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState(loadCollapsedProjects);
  const [projectsRoot, setProjectsRoot] = useState("");
  const [legacyProjectsRoot, setLegacyProjectsRoot] = useState("");
  const projectsRootRef = useRef("");
  projectsRootRef.current = projectsRoot;
  const [pathsReady, setPathsReady] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; path: string; name: string } | null>(
    null,
  );
  const [pendingDeleteProject, setPendingDeleteProject] = useState<{ path: string; name: string } | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef(new Map<string, AbortController>());
  const runningWsRef = useRef("");
  const runningIdRef = useRef("");
  const permissionRef = useRef(permission);
  permissionRef.current = permission;
  const modelRef = useRef(model);
  const effortRef = useRef(effort);
  const contextWindowRef = useRef(contextWindow);
  modelRef.current = model;
  effortRef.current = effort;
  contextWindowRef.current = contextWindow;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const viewingChatRef = useRef(true);
  viewingChatRef.current =
    editor.focus === "chat" && !showSettings && !showUsage && !projectSettings;
  runningIdRef.current = runningId;
  const pendingRef = useRef(pendingByChat);
  pendingRef.current = pendingByChat;
  const editingRef = useRef<PendingEdit | null>(null);
  const busyRef = useRef(false);
  const mcpServersRef = useRef(mcpServers);
  mcpServersRef.current = mcpServers;
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const [remoteWorkspace, setRemoteWorkspace] = useState<RemoteWorkspace | null>(null);
  const remoteRef = useRef<RemoteWorkspace | null>(null);
  remoteRef.current = remoteWorkspace;
  const sidebarSyncRef = useRef({ workspace, conversations, journeys });
  sidebarSyncRef.current = { workspace, conversations, journeys };
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const sidebarLoadedForRef = useRef("");
  const deletedIdsRef = useRef(new Set<string>());
  const turnMessagesRef = useRef<ChatMessage[] | null>(null);
  const turnLiveRef = useRef({
    streamText: "",
    streamReasoning: "",
    liveTools: [] as LiveToolRow[],
    activity: null as ConversationActivity | null,
  });
  const liveByChatRef = useRef(
    new Map<
      string,
      {
        messages: ChatMessage[];
        streamText: string;
        streamReasoning: string;
        liveTools: LiveToolRow[];
        activity: ConversationActivity | null;
      }
    >(),
  );
  const subagentsByChatRef = useRef(new Map<string, SubagentDockState>());
  const planByChatRef = useRef(new Map<string, GrokPlan>());
  const bumpPlan = useCallback(() => setPlanTick((n) => n + 1), []);
  const scroller = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const [composerPad, setComposerPad] = useState(CHAT_BOTTOM_PAD_FALLBACK);
  const stickToBottomRef = useRef(true);
  const followingRef = useRef(false);
  const prependRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const draft = draftForChat(drafts, activeId);
  const draftPastes = pastesByChat[activeId] ?? [];
  const promptImages = imagesForChat(draftImages, activeId);
  const queued = pendingForChat(pendingByChat, activeId);

  const setDraft = useCallback((text: string) => {
    saveComposerDraft(activeId, text);
    setDrafts((prev) => setDraftForChat(prev, activeId, text));
  }, [activeId]);

  const setDraftPastes = useCallback((next: PasteBlock[]) => {
    saveComposerPastes(activeId, next);
    setPastesByChat((prev) => {
      if (!next.length) {
        if (!(activeId in prev)) return prev;
        const copy = { ...prev };
        delete copy[activeId];
        return copy;
      }
      return { ...prev, [activeId]: next };
    });
  }, [activeId]);

  const ready = Boolean(runtime?.ready);
  const models = runtime?.models ?? [];

  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const openGeneration = useRef(0);
  const libraryRef = useRef<ReturnType<typeof useLibrary> | null>(null);

  const reloadConversations = useCallback(async (ws: string, preferId?: string) => {
    if (!ws) {
      sidebarLoadedForRef.current = "";
      setConversations([]);
      setJourneys([]);
      setActiveId("");
      setMessages([]);
      return;
    }
    const rows = await api.listConversations(ws);
    if (!isSameProject(ws, workspaceRef.current)) return;
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
        return { ...row, model: live.model, effort: live.effort ?? row.effort, context_window: live.context_window ?? row.context_window, permission: live.permission ?? row.permission };
      }),
    );
    setJourneys(nextJourneys);
    const visible = rows.filter((row) => !isArchivedConversation(row));
    const saved = loadConversation(ws);
    const savedRow = rows.find((row) => row.id === saved);
    const want =
      preferId ||
      (savedRow && !isArchivedConversation(savedRow) ? saved : "") ||
      visible[0]?.id ||
      "";
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
    const full = await api.getConversation(ws, found.id);
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
  }, [models]);

  const applyRuntime = useCallback((next: Runtime) => {
    setRuntime(next);
    const savedModel = loadModel();
    const nextModel = next.models.some((m) => m.id === savedModel)
      ? savedModel
      : next.default_model;
    const chosen = next.models.find((m) => m.id === nextModel) ?? next.models[0];
    const savedEffort = loadEffort();
    const nextEffort = chosen?.efforts.some((e) => e.id === savedEffort)
      ? savedEffort
      : next.default_effort;
    setModel(nextModel);
    setEffort(
      chosen?.efforts.some((e) => e.id === nextEffort)
        ? nextEffort
        : (chosen?.efforts[0]?.id ?? ""),
    );
    const choices = contextWindowChoices(chosen?.context_windows, chosen?.context_window);
    setContextWindow(resolveContextWindow(choices, loadContextWindow(), chosen?.context_window, nextModel));
  }, []);

  const reloadRuntime = useCallback(() => {
    void api
      .runtime()
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
              context_window: 256000,
              context_windows: [256000, 500000],
              provider: "xai",
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
    // Provider, storage, folder, and account allowance checks start with the app.
    // Opening settings only reads them, and closing settings does not cancel them.
    startProviderStatus();
    startAccountUsage();
  }, [reloadRuntime]);

  const refreshSpeech = useCallback(() => {
    void api
      .speechModels()
      .then((rows) => setSpeechRows(rows))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshSpeech();
    let gone = false;
    void api
      .getAppSetting("speech.model")
      .then((saved) => {
        if (!gone) setSpeechModelId(normalizeSpeechModel(saved));
      })
      .catch(() => undefined);
    let unlisten: (() => void) | undefined;
    void api
      .onSpeechDownload((event) => {
        setSpeechProgress({ id: event.id, received: event.received, total: event.total });
        if (event.done) {
          setSpeechDownloading(false);
          setSpeechProgress(null);
          refreshSpeech();
        }
      })
      .then((fn) => {
        if (gone) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [refreshSpeech]);

  const pickSpeechModel = useCallback((id: string) => {
    const next = normalizeSpeechModel(id);
    setSpeechModelId(next);
    void api.setAppSetting("speech.model", next).catch((e) => setFlash({ kind: "err", text: String(e) }));
  }, [setFlash]);

  const downloadSpeech = useCallback((id: string) => {
    setSpeechDownloading(true);
    setSpeechProgress({ id: normalizeSpeechModel(id), received: 0, total: speechModel(id).bytes });
    void api
      .speechDownload(normalizeSpeechModel(id))
      .then((row) => {
        setSpeechRows((prev) => prev.map((item) => (item.id === row.id ? row : item)));
      })
      .catch((e) => setFlash({ kind: "err", text: String(e) }))
      .finally(() => {
        setSpeechDownloading(false);
        setSpeechProgress(null);
        refreshSpeech();
      });
  }, [refreshSpeech, setFlash]);

  const dictate = useCallback(async (bytesBase64: string, filename: string) => {
    return api.transcribe(bytesBase64, filename);
  }, []);

  useEffect(() => {
    if (!pathsReady || !workspace) return;
    setRecents(pushRecentWorkspace(workspace));
  }, [pathsReady, workspace]);

  useEffect(() => {
    let cancelled = false;
    void api
      .projectsLocation()
      .then((loc) => {
        if (cancelled) return;
        rewriteStoredProjectPaths(loc.moves);
        projectsRootRef.current = loc.root;
        setProjectsRoot(loc.root);
        setLegacyProjectsRoot(loc.legacy_root);
        const saved = loadWorkspace();
        if (saved) setRecents(pushRecentWorkspace(saved));
        setCollapsedProjects(loadCollapsedProjects());
        const next = loadWorkspace();
        setWorkspace((current) => (current === next ? current : next));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPathsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onDoc() {
      setProjectMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setProjectMenu(null);
        setPendingDeleteProject(null);
      }
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!pathsReady || !workspace) return;
    void reloadConversations(workspace).catch((e) => setFlash({ kind: "err", text: String(e) }));
  }, [pathsReady, workspace, reloadConversations, setFlash]);

  useEffect(() => {
    if (!workspace || !opened) return;
    let gone = false;
    let timer = 0;
    const watch = () => {
      const again = () => {
        if (!gone) timer = window.setTimeout(watch, remoteRef.current ? 15000 : 8000);
      };
      if (typeof document !== "undefined" && document.hidden) {
        again();
        return;
      }
      void api
        .treeSignature(workspace)
        .then((snapshot) => {
          if (!gone) {
            publishFileStructure(
              workspace,
              snapshot.signature,
              snapshot.dirs ?? [],
              (snapshot.files ?? []).map((path) => {
                const slash = path.lastIndexOf("/");
                return { path, name: slash < 0 ? path : path.slice(slash + 1) };
              }),
            );
          }
        })
        .catch(() => undefined)
        .finally(again);
    };
    watch();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [workspace, opened]);

  useEffect(() => {
    if (!workspace || !opened) {
      setMentionFiles([]);
      return;
    }
    let gone = false;
    let seenSignature = "";
    const apply = () => {
      const signature = fileStructureSignature(workspace);
      if (signature === seenSignature && signature) return;
      seenSignature = signature;
      const known = fileStructureFiles(workspace);
      if (known.length) {
        setMentionFiles(known);
        return;
      }
      // A signature with no files is an empty project, not a snapshot that forgot its list.
      if (signature) {
        setMentionFiles([]);
        return;
      }
      void collectWorkspaceFiles((path) => api.listDir(workspace, path)).then((files) => {
        if (!gone && !fileStructureFiles(workspace).length) setMentionFiles(files);
      });
    };
    apply();
    const stop = subscribeFileStructure(apply);
    return () => {
      gone = true;
      stop();
    };
  }, [workspace, opened]);

  useEffect(() => {
    if (!pathsReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const fromDisk = await api.listProjects();
        let remoteMounts = new Set<string>();
        try {
          const remotes = await api.listRemoteProjects();
          remoteMounts = new Set(remotes.map((row) => projectKey(row.mount_path)));
        } catch {
          remoteMounts = new Set();
        }
        const saved = sidebarProjects(fromDisk);
        const rows = saved.map((row) =>
          remoteMounts.has(projectKey(row.path)) ? { ...row, remote: true } : row,
        );
        const ordered = rows;
        const loaded: ProjectChatGroup[] = [];
        for (const row of ordered) {
          if (cancelled) return;
          const [convs, nextJourneys] = await Promise.all([
            api.listConversations(row.path).catch(() => [] as ConversationSummary[]),
            api.listJourneys(row.path).catch(() => [] as JourneySummary[]),
          ]);
          let next = { ...row, conversations: convs, journeys: nextJourneys };
          if (next.remote && isSameProject(next.path, workspaceRef.current)) {
            try {
              const remote = await api.workspaceRemote(next.path);
              if (remote) {
                next = {
                  ...next,
                  server: {
                    machineName: remote.machine_name,
                    host: remote.host,
                    user: remote.user,
                    port: remote.port,
                    remotePath: remote.remote_path,
                    online: remote.online,
                  },
                };
              }
            } catch {
              /* leave the cloud without a status */
            }
          }
          loaded.push(next);
          if (!cancelled) {
            setAllProjectGroups(
              applyLiveProjectChats(loaded, sidebarSyncRef.current, sidebarLoadedForRef.current),
            );
          }
        }
      } catch (e) {
        if (!cancelled) setFlash({ kind: "err", text: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathsReady, setFlash]);

  useEffect(() => {
    if (!workspace) return;
    if (!isSameProject(sidebarLoadedForRef.current, workspace)) return;
    setAllProjectGroups((prev) => {
      const placed = placeProjectChats(prev, workspace, conversations, journeys).map((group) =>
        isSameProject(group.path, workspace)
          ? {
              ...group,
              remote: Boolean(remoteWorkspace) || group.remote,
              server: remoteWorkspace
                ? {
                    machineName: remoteWorkspace.machineName,
                    host: remoteWorkspace.host,
                    user: remoteWorkspace.user,
                    port: remoteWorkspace.port,
                    remotePath: remoteWorkspace.remotePath,
                    online: remoteWorkspace.online,
                  }
                : group.server,
            }
          : group,
      );
      if (
        placed.length === prev.length &&
        placed.every((group, i) => {
          const before = prev[i];
          return (
            before &&
            before.path === group.path &&
            before.remote === group.remote &&
            before.server === group.server &&
            sameSidebarConversationList(before.conversations, group.conversations) &&
            sameJourneyList(before.journeys, group.journeys)
          );
        })
      ) {
        return prev;
      }
      return placed;
    });
  }, [workspace, conversations, journeys, remoteWorkspace]);

  useEffect(() => {
    if (!pathsReady) return;
    if (!workspace) {
      setOpened(false);
      return;
    }
    let cancelled = false;
    setOpened(false);
    void api
      .openFolder(workspace)
      .then((path) => {
        if (cancelled) return;
        if (path !== workspace) {
          saveWorkspace(path);
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
    let remoteTimer = 0;
    const watchRemote = () => {
      void api
        .workspaceRemote(workspace)
        .then((row) => {
          if (cancelled) return;
          setRemoteWorkspace(
            row
              ? {
                  machineName: row.machine_name,
                  host: row.host,
                  user: row.user,
                  port: row.port,
                  remotePath: row.remote_path,
                  online: row.online,
                }
              : null,
          );
        })
        .catch(() => {
          if (!cancelled) setRemoteWorkspace(null);
        })
        .finally(() => {
          if (!cancelled) remoteTimer = window.setTimeout(watchRemote, 15000);
        });
    };
    watchRemote();
    return () => {
      cancelled = true;
      window.clearTimeout(remoteTimer);
    };
  }, [pathsReady, workspace, setFlash]);

  useEffect(() => {
    let cancelled = false;
    const loadMcp = () => {
      void detectMcp({
        readHome: async (path) => {
          try {
            return await api.readUserMcp(path);
          } catch {
            return null;
          }
        },
        readWorkspace: workspace
          ? async (path) => {
              try {
                return await api.readFile(workspace, path);
              } catch {
                return null;
              }
            }
          : undefined,
      }).then(async (rows) => {
        let authed: string[] = [];
        try {
          authed = await api.mcpAuthNames();
        } catch {
          authed = [];
        }
        if (!cancelled) setMcpServers(withMcpAuth(rows, authed));
      });
    };
    loadMcp();
    const stopRefresh = subscribeFileRefresh(loadMcp);
    void (async () => {
      try {
        const files = await api.listSkillFiles(workspace || null);
        let grokToml: string | null = null;
        try {
          grokToml = await api.readUserMcp(".grok/config.toml");
        } catch {
          grokToml = null;
        }
        const inputs = [];
        for (const file of files) {
          try {
            const contents = file.home
              ? await api.readUserSkill(file.read_path)
              : workspace
                ? await api.readFile(workspace, file.read_path)
                : null;
            if (contents == null) continue;
            inputs.push({
              source: file.path,
              origin: parseSkillOrigin(file.origin, file.path),
              contents,
            });
          } catch {
            /* skip unreadable skill files */
          }
        }
        if (!cancelled) setSkills(detectSkills(inputs, grokToml));
      } catch {
        if (!cancelled) setSkills([]);
      }
    })();
    return () => {
      cancelled = true;
      stopRefresh();
    };
  }, [workspace]);

  const pendingShell = shellQueue.find((item) => item.chatId === activeId) ?? null;
  const pendingPlan = planQueue.find((item) => item.chatId === activeId) ?? null;

  useLayoutEffect(() => {
    const el = composerDockRef.current;
    if (!el) return;
    const apply = () => {
      const next = chatBottomPadding(el.getBoundingClientRect().height);
      setComposerPad((prev) => (prev === next ? prev : next));
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [editor.focus, showSettings, showUsage, activeId]);

  const holdScrollForOlder = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stickToBottomRef.current = false;
    prependRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    const prepend = prependRef.current;
    if (prepend && el) {
      prependRef.current = null;
      el.scrollTop = scrollTopAfterPrepend(prepend, el.scrollHeight);
      return;
    }
    const scrollerEl = scroller.current;
    if (!scrollerEl) return;
    let frame = 0;
    // One jump to the end. Streaming must not ease across frames.
    const pin = () => {
      if (!stickToBottomRef.current) return;
      followingRef.current = true;
      pinChatToEnd(scroller.current, true);
      followingRef.current = false;
    };
    const pinAfterLayout = () => {
      if (!stickToBottomRef.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        pin();
      });
    };
    pin();
    // Tokens no longer re-render MainView. Pin once per store update, no setState.
    const stopStream = subscribeLiveStream(pin);
    const content = scrollerEl.firstElementChild;
    const ro =
      content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(pinAfterLayout)
        : null;
    if (content) ro?.observe(content);
    return () => {
      followingRef.current = false;
      if (frame) cancelAnimationFrame(frame);
      stopStream();
      ro?.disconnect();
    };
  }, [messages, pendingShell, openingId, pendingByChat, activeId, editor.focus, composerPad]);

  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeUsage = useCallback(() => setShowUsage(false), []);
  const closeProjectSettings = useCallback(() => setProjectSettings(null), []);
  const openSettings = useCallback(() => {
    setShowUsage(false);
    setProjectSettings(null);
    setShowSettings(true);
  }, []);
  const openUsage = useCallback(() => {
    setShowSettings(false);
    setProjectSettings(null);
    setShowUsage(true);
  }, []);
  const openProjectSettings = useCallback((path: string, name: string) => {
    setShowSettings(false);
    setShowUsage(false);
    setProjectSettings({ path, name });
  }, []);

  const onSidebarResizeStart = useCallback((ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startWidth = sidebarWidth;
    setSidebarDragging(true);

    function onMove(move: PointerEvent) {
      const next = Math.min(
        SIDEBAR_MAX,
        Math.max(SIDEBAR_MIN, Math.round(startWidth + (move.clientX - startX))),
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
        saveSidebarWidth(next);
        return next;
      });
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, [sidebarWidth]);

  const runTurnRef = useRef<RunTurn>(async () => {});
  const fileRefreshTimer = useRef(0);
  const bumpFiles = useCallback(() => {
    window.clearTimeout(fileRefreshTimer.current);
    fileRefreshTimer.current = window.setTimeout(() => bumpFileRefresh(), 400);
  }, []);

  const library = useLibrary({
    workspace,
    conversations,
    journeys,
    allProjectGroups,
    messages,
    activeId,
    runningId,
    runningTurns,
    projectsRoot,
    legacyProjectsRoot,
    pendingClosePath,
    dirtyFiles,
    usageByChat,
    compactionByChat,
    setCompactionByChat,
    model,
    effort,
    contextWindow,
    permission,
    models,
    defaultEffort: loadEffort(),
    setModel,
    setEffort,
    setContextWindow,
    setPermission,
    openSettings,
    reloadConversations,
    runTurn: (ws, id, next, after, journeyIdOverride) => runTurnRef.current(ws, id, next, after, journeyIdOverride),
    scroller,
    runningWsRef,
    modelRef,
    workspaceRef,
    runningIdRef,
    abortRef,
    turnsRef,
    pendingRef,
    deletedIdsRef,
    turnMessagesRef,
    turnLiveRef,
    liveByChatRef,
    subagentsByChatRef,
    planByChatRef,
    onPlanChange: bumpPlan,
    stickToBottomRef,
    conversationsRef,
    openGeneration,
    setWorkspace,
    setConversations,
    setJourneys,
    setAllProjectGroups,
    setMessages,
    setActiveId,
    setRunningId,
    setEditor,
    setDirtyFiles,
    setPendingClosePath,
    setFolderOpen,
    setShowSettings,
    setShowUsage,
    setProjectSettings,
    setCollapsedProjects,
    setRecents,
    setDrafts,
    setPastesByChat,
    setDraftImages,
    setUsageByChat,
    setStreamText,
    setStreamReasoning,
    setLiveTools,
    setRunningActivity,
    setTurnStartedAt,
    setSubagents,
    setExpandedAgents,
    setOpeningId,
    setUnseenFinished,
    setPendingByChat,
    setChatTabsByProject,
    setFlash,
    bumpFiles,
  });
  libraryRef.current = library;
  const turn = bindTurn({
    workspace,
    activeId,
    messages,
    draft,
    draftPastes,
    promptImages,
    mentionFiles,
    busy,
    ready,
    runtime,
    model,
    effort,
    contextWindow,
    models,
    conversations,
    usageByChat,
    compactionByChat,
    persist: library.persist,
    setFlash,
    setModel,
    setEffort,
    setContextWindow,
    setPermission,
    setDrafts,
    setPastesByChat,
    setDraftImages,
    setPendingByChat,
    setEditingPending,
    setFolderOpen,
    setActiveId,
    setBusy,
    setRunningId,
    setRunningTurns,
    setUnseenFinished,
    viewingChatRef,
    setMessages,
    setConversations,
    setTurnStartedAt,
    setStreamText,
    setStreamReasoning,
    setLiveTools,
    setRunningActivity,
    setSubagents,
    setExpandedAgents,
    setUsageByChat,
    setUsageTick,
    bumpFiles,
    setShellQueue,
    setPlanQueue,
    planByChatRef,
    onPlanChange: bumpPlan,
    permissionRef,
    modelRef,
    effortRef,
    contextWindowRef,
    conversationsRef,
    activeIdRef,
    runningIdRef,
    runningWsRef,
    busyRef,
    abortRef,
    turnsRef,
    pendingRef,
    editingRef,
    deletedIdsRef,
    mcpServersRef,
    skillsRef,
    remoteRef,
    turnMessagesRef,
    turnLiveRef,
    liveByChatRef,
    subagentsByChatRef,
    stickToBottomRef,
  });
  runTurnRef.current = turn.runTurn;
  const {
    closeFileTab,
    openFolder,
    toggleProjectCollapsed,
    reorderProjects,
    deleteProjectFromSidebar,
    applyWorkspace,
    startNewChat,
    openSidebarChat,
    openProjectFromSidebar,
    openChat,
    toggleSubagent,
    removeChat,
    archiveChat,
    reorderChats,
    reorderSidebar,
    createJourneyFromChat,
    openJourneyKnowledge,
    toggleJourney,
    setJourneyColor,
    renameJourney,
    deleteJourney,
    moveConversation,
  } = library;

  const chatTabKey = workspace ? projectKey(workspace) : "";
  const chatTabIds = chatTabKey ? (chatTabsByProject[chatTabKey] ?? []) : [];
  const chatTabs = chatTabIds.map((id) => {
    const row = conversations.find((item) => item.id === id);
    return {
      id,
      title: row?.title?.trim() || "Chat",
      kind: row?.kind === "terminal" ? ("terminal" as const) : ("chat" as const),
      running: chatHasRunningTurn(runningTurns, id),
    };
  });

  useEffect(() => {
    if (!workspace || !activeId) return;
    const key = projectKey(workspace);
    setChatTabsByProject((prev) => {
      const tabs = prev[key] ?? [];
      const next = openChatTab(tabs, activeId);
      return next === tabs ? prev : { ...prev, [key]: next };
    });
  }, [workspace, activeId]);

  const closeChatTab = useCallback(
    (id: string) => {
      if (!workspace) return;
      const key = projectKey(workspace);
      const result = closeChatTabList(chatTabsByProject[key] ?? [], id);
      setChatTabsByProject((prev) => ({ ...prev, [key]: result.tabs }));
      if (id !== activeId) return;
      if (result.next) {
        void openChat(result.next);
        return;
      }
      setActiveId("");
      setMessages([]);
      clearLiveStream();
      setTurnStartedAt(0);
      setSubagents([]);
      setExpandedAgents({});
      runningIdRef.current = "";
      setRunningId("");
      abortRef.current = null;
    },
    [workspace, chatTabsByProject, activeId, openChat],
  );

  const {
    answerPlan,
    answerShell,
    pickModel,
    pickEffort,
    pickContextWindow,
    pickPermission,
    pickPlanMode,
    addPromptImages,
    addPromptImagePaths,
    beginPendingEdit,
    savePendingEdit,
    closePendingEdit,
    removePendingAt,
    send,
    stop,
  } = turn;


  const openWorkspaceFile = useCallback(
    (path: string, mode: "preview" | "pin" = "pin", view: "edit" | "diff" = "edit") => {
      setShowSettings(false);
      setShowUsage(false);
      setProjectSettings(null);
      setEditor((prev) => {
        const next = mode === "preview" ? previewEditorTab(prev, path) : pinEditorTab(prev, path);
        return setEditorFileView(next, path, view);
      });
    },
    [],
  );

  const toggleMcpServer = useCallback(
    async (server: DetectedMcpServer, enabled: boolean) => {
      setMcpBusy(server.name);
      try {
        const raw = await api.readUserMcp(".grok/config.toml");
        await api.writeUserMcp(".grok/config.toml", setMcpEnabledInToml(raw, server.name, enabled));
        bumpFiles();
      } catch (e) {
        setFlash({ kind: "err", text: String(e) });
      } finally {
        setMcpBusy(null);
      }
    },
    [setFlash],
  );

  const editMcpServer = useCallback((server: DetectedMcpServer) => {
    setShowSettings(false);
    setShowUsage(false);
    setProjectSettings(null);
    setEditor((prev) => pinEditorTab(prev, mcpEditorPath(server.source)));
  }, []);

  const reauthMcpServer = useCallback(
    async (server: DetectedMcpServer) => {
      setMcpBusy(server.name);
      try {
        if (server.authed) await api.mcpClearAuth(server.name);
        await api.mcpSignIn(server.name);
        bumpFiles();
        setFlash({ kind: "ok", text: `Signed in to ${server.name}.` });
      } catch (e) {
        setFlash({ kind: "err", text: String(e) });
        bumpFiles();
      } finally {
        setMcpBusy(null);
      }
    },
    [setFlash],
  );

  const toggleSkill = useCallback(
    async (skill: DetectedSkill, enabled: boolean) => {
      setSkillBusy(skill.name);
      try {
        const raw = await api.readUserMcp(".grok/config.toml");
        await api.writeUserMcp(".grok/config.toml", setSkillEnabledInToml(raw, skill.name, enabled));
        bumpFiles();
      } catch (e) {
        setFlash({ kind: "err", text: String(e) });
      } finally {
        setSkillBusy(null);
      }
    },
    [setFlash],
  );

  const editSkill = useCallback(
    async (skill: DetectedSkill) => {
      const rel = userSkillRel(skill.source);
      try {
        if (rel) await api.openUserSkill(rel);
        else openWorkspaceFile(skill.source);
      } catch (e) {
        setFlash({ kind: "err", text: String(e) });
      }
    },
    [openWorkspaceFile, setFlash],
  );

  const showLanding = false;
  const chatKind = parseConversationKind(conversations.find((c) => c.id === activeId)?.kind);
  const chatAcceptsDrop =
    !showSettings && !showUsage && (showLanding || (editor.focus !== "file" && chatKind !== "terminal"));
  const addImagePathsRef = useRef(addPromptImagePaths);
  addImagePathsRef.current = addPromptImagePaths;
  const chatAcceptsDropRef = useRef(chatAcceptsDrop);
  chatAcceptsDropRef.current = chatAcceptsDrop;

  useEffect(() => {
    let gone = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!chatAcceptsDropRef.current) {
          setFileDrag(false);
          return;
        }
        if (event.payload.type === "enter") {
          setFileDrag(imagePathsFromDrop(event.payload.paths).length > 0);
          return;
        }
        if (event.payload.type === "over") {
          return;
        }
        if (event.payload.type === "leave") {
          setFileDrag(false);
          return;
        }
        setFileDrag(false);
        void addImagePathsRef.current(event.payload.paths);
      })
      .then((fn) => {
        if (gone) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (showLanding || showSettings || showUsage || editor.focus === "file") return;
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      if (followingRef.current) return;
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
  }, [showLanding, showSettings, showUsage, editor.focus]);

  const sidebarRef = useRef<SidebarSlice | null>(null);
  if (!sidebarRef.current) sidebarRef.current = {
    activeId,
    allProjectGroups,
    archiveChat,
    collapsedProjects,
    conversations,
    createJourneyFromChat,
    deleteJourney,
    deleteProjectFromSidebar,
    journeys,
    legacyProjectsRoot,
    messages,
    moveConversation,
    openChat,
    openingId,
    openJourneyKnowledge,
    openProjectFromSidebar,
    openProjectSettings,
    openSidebarChat,
    projectSettings,
    projectsRoot,
    removeChat,
    renameJourney,
    setProjectMenu,
    reorderChats,
    reorderProjects,
    reorderSidebar,
    runningTurns,
    unseenFinished,
    setJourneyColor,
    showSettings,
    showUsage,
    startNewChat,
    toggleJourney,
    toggleProjectCollapsed,
    workspace,
  };
  const sidebar = sidebarRef.current;
  const sidebarChanged =
    sidebar.activeId !== activeId ||
    sidebar.allProjectGroups !== allProjectGroups ||
    sidebar.collapsedProjects !== collapsedProjects ||
    sidebar.conversations !== conversations ||
    sidebar.journeys !== journeys ||
    sidebar.legacyProjectsRoot !== legacyProjectsRoot ||
    sidebar.messages !== messages ||
    sidebar.openingId !== openingId ||
    sidebar.projectSettings !== projectSettings ||
    sidebar.projectsRoot !== projectsRoot ||
    sidebar.runningTurns !== runningTurns ||
    sidebar.unseenFinished !== unseenFinished ||
    sidebar.setProjectMenu !== setProjectMenu ||
    sidebar.showSettings !== showSettings ||
    sidebar.showUsage !== showUsage ||
    sidebar.workspace !== workspace;
  if (sidebarChanged) {
    sidebarRef.current = {
      ...sidebar,
      activeId,
      allProjectGroups,
      archiveChat,
      collapsedProjects,
      conversations,
      createJourneyFromChat,
      deleteJourney,
      deleteProjectFromSidebar,
      journeys,
      legacyProjectsRoot,
      messages,
      moveConversation,
      openChat,
      openingId,
      openJourneyKnowledge,
      openProjectFromSidebar,
      openProjectSettings,
      openSidebarChat,
      projectSettings,
      projectsRoot,
      removeChat,
      renameJourney,
      setProjectMenu,
      reorderChats,
      reorderProjects,
      reorderSidebar,
      runningTurns,
      unseenFinished,
      setJourneyColor,
      showSettings,
      showUsage,
      startNewChat,
      toggleJourney,
      toggleProjectCollapsed,
      workspace,
    };
  } else if (sidebarRef.current) {
    const live = sidebarRef.current;
    live.archiveChat = archiveChat;
    live.createJourneyFromChat = createJourneyFromChat;
    live.deleteJourney = deleteJourney;
    live.deleteProjectFromSidebar = deleteProjectFromSidebar;
    live.moveConversation = moveConversation;
    live.openChat = openChat;
    live.openJourneyKnowledge = openJourneyKnowledge;
    live.openProjectFromSidebar = openProjectFromSidebar;
    live.openProjectSettings = openProjectSettings;
    live.openSidebarChat = openSidebarChat;
    live.removeChat = removeChat;
    live.renameJourney = renameJourney;
    live.reorderChats = reorderChats;
    live.reorderProjects = reorderProjects;
    live.reorderSidebar = reorderSidebar;
    live.setJourneyColor = setJourneyColor;
    live.startNewChat = startNewChat;
    live.toggleJourney = toggleJourney;
    live.toggleProjectCollapsed = toggleProjectCollapsed;
  }
  const sidebarValue = sidebarRef.current;

  const main: MainModel = {
    activeId,
    addPromptImages,
    allProjectGroups,
    answerPlan,
    answerShell,
    applyWorkspace,
    beginPendingEdit,
    busy,
    chatTabs,
    closeChatTab,
    closeFileTab,
    closePendingEdit,
    closeProjectSettings,
    closeSettings,
    closeUsage,
    collapsedProjects,
    composerDockRef,
    composerPad,
    holdScrollForOlder,
    contextWindow,
    conversations,
    createJourneyFromChat,
    deleteJourney,
    deleteProjectFromSidebar,
    dirtyFiles,
    draft,
    draftPastes,
    mentionFiles,
    editingPending,
    editMcpServer,
    editor,
    editSkill,
    effort,
    expandedAgents,
    fileDrag,
    folderOpen,
    journeys,
    mcpBusy,
    mcpServers,
    messages,
    model,
    models,
    moveConversation,
    onSidebarResizeStart,
    openChat,
    opened,
    openFolder,
    openingId,
    openJourneyKnowledge,
    openProjectFromSidebar,
    openProjectSettings,
    openSettings,
    openSidebarChat,
    openUsage,
    openWorkspaceFile,
    pendingClosePath,
    pendingDeleteProject,
    pendingPlan,
    pendingShell,
    permission,
    pickContextWindow,
    pickEffort,
    pickModel,
    pickPermission,
    pickPlanMode,
    planMode: (() => {
      void planTick;
      const plan = planByChatRef.current.get(activeId) ?? emptyGrokPlan();
      if (plan.state === "Pending") return "pending" as const;
      return planModeEngaged(plan.state) ? ("on" as const) : ("off" as const);
    })(),
    pickSpeechModel,
    dictate,
    speechModel: speechModelId,
    speechModels: speechRows,
    speechProgress,
    speechDownloading,
    refreshSpeech,
    downloadSpeech,
    projectMenu,
    projectSettings,
    projectsRoot,
    legacyProjectsRoot,
    promptImages,
    queued,
    ready,
    reauthMcpServer,
    recents,
    reloadRuntime,
    remoteWorkspace,
    archiveChat,
    removeChat,
    removePendingAt,
    renameJourney,
    reorderChats,
    reorderProjects,
    reorderSidebar,
    runningId,
    runningTurns,
    unseenFinished,
    runtime,
    savePendingEdit,
    scroller,
    send,
    stop,
    setDirtyFiles,
    setDraft,
    setDraftPastes,
    setDraftImages,
    setDrafts,
    setEditor,
    toggleSubagent,
    setFolderOpen,
    setJourneyColor,
    setPendingDeleteProject,
    setProjectMenu,
    setShowSettings,
    setShowUsage,
    settingsTab,
    setSettingsTab,
    setSidebarWidth,
    bumpFiles,
    showLanding,
    showSettings,
    showUsage,
    sidebarDragging,
    sidebarWidth,
    skillBusy,
    skills,
    startNewChat,
    subagents,
    toggleJourney,
    toggleMcpServer,
    toggleProjectCollapsed,
    toggleSkill,
    turnStartedAt,
    usageByChat,
    usageTick,
    workspace,
  };

  return (
    <MainProvider value={main} sidebar={sidebarValue}>
      <MainShell />
    </MainProvider>
  );
}
