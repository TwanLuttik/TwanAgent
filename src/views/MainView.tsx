import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { CHAT_BOTTOM_PAD_FALLBACK, chatBottomPadding, isNearBottom, scrollChatToEnd } from "../lib/chat-scroll";
import { scrollTopAfterPrepend } from "../lib/chat-window";
import { contextWindowChoices, putChatUsage, resolveContextWindow, type ChatUsage } from "../lib/dev-context";
import { detectMcp, setMcpEnabledInToml, userMcpRel, withMcpAuth, type DetectedMcpServer } from "../lib/dev-mcp";
import { detectSkills, parseSkillOrigin, setSkillEnabledInToml, userSkillRel, type DetectedSkill } from "../lib/dev-skill";
import { folderName, mergeProjectRows, type ChatImage, type ChatMessage, type ConversationActivity, type LiveToolRow } from "../lib/dev";
import { imagePathsFromDrop, imagesForChat } from "../lib/dev-image";
import { isSameProject, upsertProjectGroup, type ProjectChatGroup } from "../lib/dev-all-projects";
import type { JourneySummary } from "../lib/dev-journey";
import { parseConversationKind } from "../lib/dev-terminal-chat";
import { emptyEditor, pinEditorTab, previewEditorTab, setEditorFileView, type EditorState } from "../lib/dev-editor";
import {
  DEV_SIDEBAR_MAX,
  DEV_SIDEBAR_MIN,
  loadAllProjects,
  loadCollapsedProjects,
  loadDevContextWindow,
  loadDevConversation,
  loadDevEffort,
  loadDevModel,
  loadDevPermission,
  loadDevRecentWorkspaces,
  loadDevSidebarWidth,
  loadDevWorkspace,
  pushDevRecentWorkspace,
  rewriteStoredProjectPaths,
  saveDevConversation,
  saveDevSidebarWidth,
  saveDevWorkspace,
} from "../lib/prefs";
import { parsePermissionMode, type PermissionMode } from "../lib/dev-permission";
import { draftForChat, liveTurnMessages, pendingForChat, setDraftForChat, type PendingEdit, type PendingMessage, type RunningTurn } from "../lib/dev-turn";
import * as api from "../lib/tauri";
import type { DevConversationSummary, DevRuntime } from "../lib/tauri";
import { useApp } from "../state/app-state";
import type { SubagentRecord } from "../lib/dev-subagent";
import { bindDevTurn } from "./dev/useDevTurn";
import { useDevLibrary, type RunTurn } from "./dev/useDevLibrary";
import type { MainModel } from "./main/context";
import { MainProvider } from "./main/context";
import { MainShell } from "./main/MainShell";

export function MainView() {
  const { setFlash } = useApp();
  const [workspace, setWorkspace] = useState(loadDevWorkspace);
  const [runtime, setRuntime] = useState<DevRuntime | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [contextWindow, setContextWindow] = useState(0);
  const [permission, setPermission] = useState<PermissionMode>(() => parsePermissionMode(loadDevPermission()));
  const [conversations, setConversations] = useState<DevConversationSummary[]>([]);
  const [journeys, setJourneys] = useState<JourneySummary[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftImages, setDraftImages] = useState<Record<string, ChatImage[]>>({});
  const [pendingByChat, setPendingByChat] = useState<Record<string, PendingMessage[]>>({});
  const [editingPending, setEditingPending] = useState<PendingEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState("");
  const [runningTurns, setRunningTurns] = useState<Record<string, RunningTurn>>({});
  const [streamText, setStreamText] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [usageByChat, setUsageByChat] = useState<Record<string, ChatUsage>>({});
  const [compactionByChat, setCompactionByChat] = useState<Record<string, { summary: string; through: number }>>({});
  const [liveTools, setLiveTools] = useState<LiveToolRow[]>([]);
  const [runningActivity, setRunningActivity] = useState<ConversationActivity | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState(0);
  const [openingId, setOpeningId] = useState("");
  const [shellQueue, setShellQueue] = useState<
    { command: string; resolve: (ok: boolean) => void }[]
  >([]);
  const [subagents, setSubagents] = useState<SubagentRecord[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [mcpServers, setMcpServers] = useState<DetectedMcpServer[]>([]);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [skills, setSkills] = useState<DetectedSkill[]>([]);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [opened, setOpened] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [recents, setRecents] = useState(loadDevRecentWorkspaces);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [projectSettings, setProjectSettings] = useState<{ path: string; name: string } | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  const [fileDrag, setFileDrag] = useState(false);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadDevSidebarWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(loadAllProjects);
  const [allProjectGroups, setAllProjectGroups] = useState<ProjectChatGroup[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState(loadCollapsedProjects);
  const [projectsRoot, setProjectsRoot] = useState("");
  const [legacyProjectsRoot, setLegacyProjectsRoot] = useState("");
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
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  runningIdRef.current = runningId;
  const pendingRef = useRef(pendingByChat);
  pendingRef.current = pendingByChat;
  const editingRef = useRef<PendingEdit | null>(null);
  const busyRef = useRef(false);
  const mcpServersRef = useRef(mcpServers);
  mcpServersRef.current = mcpServers;
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const sidebarSyncRef = useRef({ workspace, conversations, journeys });
  sidebarSyncRef.current = { workspace, conversations, journeys };
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
  const scroller = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const [composerPad, setComposerPad] = useState(CHAT_BOTTOM_PAD_FALLBACK);
  const stickToBottomRef = useRef(true);
  const prependRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const draft = draftForChat(drafts, activeId);
  const promptImages = imagesForChat(draftImages, activeId);
  const queued = pendingForChat(pendingByChat, activeId);

  const setDraft = useCallback((text: string) => {
    setDrafts((prev) => setDraftForChat(prev, activeId, text));
  }, [activeId]);

  const ready = Boolean(runtime?.ready);
  const models = runtime?.models ?? [];

  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const openGeneration = useRef(0);

  const reloadConversations = useCallback(async (ws: string, preferId?: string) => {
    if (!ws) {
      sidebarLoadedForRef.current = "";
      setConversations([]);
      setJourneys([]);
      setActiveId("");
      setMessages([]);
      return;
    }
    const rows = await api.devListConversations(ws);
    if (!isSameProject(ws, workspaceRef.current)) return;
    const nextJourneys = await api.devListJourneys(ws).catch(() => [] as JourneySummary[]);
    if (!isSameProject(ws, workspaceRef.current)) return;
    sidebarLoadedForRef.current = ws;
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
    if (!isSameProject(ws, workspaceRef.current)) return;
    stickToBottomRef.current = true;
    setActiveId(found.id);
    const live = liveTurnMessages({
      workspace: ws,
      conversationId: found.id,
      runningWorkspace: runningWsRef.current,
      runningId: runningIdRef.current,
      live: turnMessagesRef.current,
      liveByChat: liveByChatRef.current,
    });
    setMessages(live ?? ((full.messages as ChatMessage[]) ?? []));
    if (live) {
      const cached = liveByChatRef.current.get(found.id);
      setStreamText(cached?.streamText ?? turnLiveRef.current.streamText);
      setStreamReasoning(cached?.streamReasoning ?? turnLiveRef.current.streamReasoning);
      setLiveTools(cached?.liveTools ?? turnLiveRef.current.liveTools);
    } else {
      setStreamText("");
      setStreamReasoning("");
      setLiveTools([]);
    }
    setUsageByChat((prev) => putChatUsage(prev, found.id, full.context_usage));
    if (full.compaction?.summary && full.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [found.id]: full.compaction! }));
    }
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
    const choices = contextWindowChoices(chosen?.context_windows, chosen?.context_window);
    setContextWindow(resolveContextWindow(choices, loadDevContextWindow(), chosen?.context_window, nextModel));
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
              context_window: 256000,
              context_windows: [256000, 500000],
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
    if (!pathsReady || !workspace) return;
    setRecents(pushDevRecentWorkspace(workspace));
  }, [pathsReady, workspace]);

  useEffect(() => {
    let cancelled = false;
    void api
      .devProjectsLocation()
      .then((loc) => {
        if (cancelled) return;
        rewriteStoredProjectPaths(loc.moves);
        setProjectsRoot(loc.root);
        setLegacyProjectsRoot(loc.legacy_root);
        setRecents(loadDevRecentWorkspaces());
        setCollapsedProjects(loadCollapsedProjects());
        const next = loadDevWorkspace();
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
    if (!pathsReady || !showAllProjects) return;
    let cancelled = false;
    void (async () => {
      try {
        const fromDisk = await api.devListProjects();
        const rows = mergeProjectRows(fromDisk, loadDevRecentWorkspaces());
        const loaded = await Promise.all(
          rows.map(async (row) => {
            const [convs, nextJourneys] = await Promise.all([
              api.devListConversations(row.path).catch(() => [] as DevConversationSummary[]),
              api.devListJourneys(row.path).catch(() => [] as JourneySummary[]),
            ]);
            return { ...row, conversations: convs, journeys: nextJourneys };
          }),
        );
        if (!cancelled) {
          const live = sidebarSyncRef.current;
          let next = loaded.map((group) =>
            isSameProject(group.path, live.workspace)
              ? { ...group, conversations: live.conversations, journeys: live.journeys }
              : group,
          );
          if (live.workspace && !next.some((group) => isSameProject(group.path, live.workspace))) {
            next = [
              {
                name: folderName(live.workspace),
                path: live.workspace,
                conversations: live.conversations,
                journeys: live.journeys,
              },
              ...next,
            ];
          }
          setAllProjectGroups(next);
        }
      } catch (e) {
        if (!cancelled) setFlash({ kind: "err", text: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathsReady, showAllProjects, setFlash]);

  useEffect(() => {
    if (!showAllProjects || !workspace) return;
    if (!isSameProject(sidebarLoadedForRef.current, workspace)) return;
    setAllProjectGroups((prev) =>
      upsertProjectGroup(prev, workspace, {
        name: folderName(workspace),
        conversations,
        journeys,
      }),
    );
  }, [showAllProjects, workspace, conversations, journeys]);

  useEffect(() => {
    if (!pathsReady) return;
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
  }, [pathsReady, workspace, setFlash]);

  useEffect(() => {
    let cancelled = false;
    void detectMcp({
      readHome: async (path) => {
        try {
          return await api.devReadUserMcp(path);
        } catch {
          return null;
        }
      },
      readWorkspace: workspace
        ? async (path) => {
            try {
              return await api.devReadFile(workspace, path);
            } catch {
              return null;
            }
          }
        : undefined,
    }).then(async (rows) => {
      let authed: string[] = [];
      try {
        authed = await api.devMcpAuthNames();
      } catch {
        authed = [];
      }
      if (!cancelled) setMcpServers(withMcpAuth(rows, authed));
    });
    void (async () => {
      try {
        const files = await api.devListSkillFiles(workspace || null);
        let grokToml: string | null = null;
        try {
          grokToml = await api.devReadUserMcp(".grok/config.toml");
        } catch {
          grokToml = null;
        }
        const inputs = [];
        for (const file of files) {
          try {
            const contents = file.home
              ? await api.devReadUserSkill(file.read_path)
              : workspace
                ? await api.devReadFile(workspace, file.read_path)
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
    };
  }, [workspace, tick]);

  const pendingShell = shellQueue[0] ?? null;

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
    }
    const pin = () => scrollChatToEnd(el, stickToBottomRef.current);
    pin();
    if (!el) return;
    const inner = el.firstElementChild;
    let ro: ResizeObserver | null = null;
    if (inner && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(pin);
      ro.observe(inner);
    }
    const frames = [0, 0];
    frames[0] = requestAnimationFrame(() => {
      pin();
      frames[1] = requestAnimationFrame(pin);
    });
    return () => {
      cancelAnimationFrame(frames[0]);
      cancelAnimationFrame(frames[1]);
      ro?.disconnect();
    };
  }, [messages, streamText, streamReasoning, pendingShell, runningActivity, liveTools, openingId, pendingByChat, activeId, editor.focus, composerPad]);

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

  const runTurnRef = useRef<RunTurn>(async () => {});
  const fileRefreshTimer = useRef(0);
  const bumpFiles = useCallback(() => {
    window.clearTimeout(fileRefreshTimer.current);
    fileRefreshTimer.current = window.setTimeout(() => setTick((n) => n + 1), 200);
  }, []);

  const library = useDevLibrary({
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
    openSettings,
    reloadConversations,
    runTurn: (ws, id, next, after, journeyIdOverride) => runTurnRef.current(ws, id, next, after, journeyIdOverride),
    scroller,
    runningWsRef,
    runningIdRef,
    abortRef,
    turnsRef,
    pendingRef,
    deletedIdsRef,
    turnMessagesRef,
    turnLiveRef,
    liveByChatRef,
    stickToBottomRef,
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
    setShowAllProjects,
    setShowSettings,
    setShowUsage,
    setProjectSettings,
    setCollapsedProjects,
    setRecents,
    setDrafts,
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
    setPendingByChat,
    setFlash,
    bumpFiles,
  });
  const turn = bindDevTurn({
    workspace,
    activeId,
    messages,
    draft,
    promptImages,
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
    setDraftImages,
    setPendingByChat,
    setEditingPending,
    setFolderOpen,
    setActiveId,
    setBusy,
    setRunningId,
    setRunningTurns,
    setMessages,
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
    permissionRef,
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
    turnMessagesRef,
    turnLiveRef,
    liveByChatRef,
    stickToBottomRef,
  });
  runTurnRef.current = turn.runTurn;
  const {
    closeFileTab,
    openFolder,
    setAllProjectsMode,
    toggleProjectCollapsed,
    deleteProjectFromSidebar,
    applyWorkspace,
    startNewChat,
    openSidebarChat,
    openProjectFromSidebar,
    openChat,
    removeChat,
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
  const {
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
        const raw = await api.devReadUserMcp(".grok/config.toml");
        await api.devWriteUserMcp(".grok/config.toml", setMcpEnabledInToml(raw, server.name, enabled));
        bumpFiles();
      } catch (e) {
        setFlash({ kind: "err", text: String(e) });
      } finally {
        setMcpBusy(null);
      }
    },
    [setFlash],
  );

  const editMcpServer = useCallback(
    async (server: DetectedMcpServer) => {
      const rel = userMcpRel(server.source);
      try {
        if (rel) await api.devOpenUserMcp(rel);
        else openWorkspaceFile(server.source);
      } catch (e) {
        setFlash({ kind: "err", text: String(e) });
      }
    },
    [openWorkspaceFile, setFlash],
  );

  const reauthMcpServer = useCallback(
    async (server: DetectedMcpServer) => {
      setMcpBusy(server.name);
      try {
        await api.devMcpClearAuth(server.name);
        bumpFiles();
        setFlash({
          kind: "ok",
          text: server.authed
            ? `Cleared the saved ${server.name} login. In Grok, open /mcps and press i to sign in again.`
            : `Sign in from Grok: /mcps, select ${server.name}, then press i.`,
        });
      } catch (e) {
        setFlash({ kind: "err", text: String(e) });
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
        const raw = await api.devReadUserMcp(".grok/config.toml");
        await api.devWriteUserMcp(".grok/config.toml", setSkillEnabledInToml(raw, skill.name, enabled));
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
        if (rel) await api.devOpenUserSkill(rel);
        else openWorkspaceFile(skill.source);
      } catch (e) {
        setFlash({ kind: "err", text: String(e) });
      }
    },
    [openWorkspaceFile, setFlash],
  );

  const showLanding =
    pathsReady &&
    !showAllProjects &&
    !showSettings &&
    !showUsage &&
    !activeId &&
    messages.length === 0 &&
    conversations.length === 0 &&
    !busy &&
    !streamText;
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

  const main: MainModel = {
    activeId,
    addPromptImages,
    allProjectGroups,
    answerShell,
    applyWorkspace,
    beginPendingEdit,
    busy,
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
    editingPending,
    editMcpServer,
    editor,
    editSkill,
    effort,
    expandedAgents,
    fileDrag,
    folderOpen,
    journeys,
    liveTools,
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
    pendingShell,
    permission,
    pickContextWindow,
    pickEffort,
    pickModel,
    pickPermission,
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
    removeChat,
    removePendingAt,
    renameJourney,
    reorderChats,
    reorderSidebar,
    runningActivity,
    runningId,
    runningTurns,
    runtime,
    savePendingEdit,
    scroller,
    send,
    stop,
    setAllProjectsMode,
    setDirtyFiles,
    setDraft,
    setDraftImages,
    setDrafts,
    setEditor,
    setExpandedAgents,
    setFolderOpen,
    setJourneyColor,
    setPendingDeleteProject,
    setProjectMenu,
    setShowSettings,
    setShowUsage,
    setSidebarWidth,
    bumpFiles,
    showAllProjects,
    showLanding,
    showSettings,
    showUsage,
    sidebarDragging,
    sidebarWidth,
    skillBusy,
    skills,
    startNewChat,
    streamText,
    streamReasoning,
    subagents,
    tick,
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
    <MainProvider value={main}>
      <MainShell />
    </MainProvider>
  );
}
