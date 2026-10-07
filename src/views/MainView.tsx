import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { CHAT_BOTTOM_PAD_FALLBACK, chatBottomPadding, isNearBottom, scrollChatToEnd } from "../lib/chat-scroll";
import { scrollTopAfterPrepend } from "../lib/chat-window";
import { insertCompactionEvent } from "../lib/compact";
import { contextWindowChoices, parseChatUsage, putChatUsage, resolveContextWindow, type ChatUsage } from "../lib/context";
import { detectMcp, setMcpEnabledInToml, userMcpRel, withMcpAuth, type DetectedMcpServer } from "../lib/mcp";
import { detectSkills, parseSkillOrigin, setSkillEnabledInToml, userSkillRel, type DetectedSkill } from "../lib/skill";
import { closeChatTab as closeChatTabList, openChatTab } from "../lib/chat-tabs";
import { projectKey, type ChatImage, type ChatMessage, type ConversationActivity, type LiveToolRow } from "../lib/core";
import { imagePathsFromDrop, imagesForChat } from "../lib/image";
import { applyLiveProjectChats, isArchivedConversation, isAppProject, isSameProject, placeProjectChats, sidebarProjects, type ProjectChatGroup } from "../lib/all-projects";
import type { JourneySummary } from "../lib/journey";
import { parseConversationKind } from "../lib/terminal-chat";
import { emptyEditor, pinEditorTab, previewEditorTab, setEditorFileView, type EditorState } from "../lib/editor";
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
import { parsePermissionMode, type PermissionMode } from "../lib/permission";
import { collectWorkspaceFiles, type MentionFile } from "../lib/mention";
import type { PasteBlock } from "../lib/paste";
import { draftForChat, effortForModel, liveTurnMessages, pendingForChat, setDraftForChat, type PendingEdit, type PendingMessage, type RunningTurn } from "../lib/turn";
import * as api from "../lib/tauri";
import type { ConversationSummary, Runtime } from "../lib/tauri";
import { useApp } from "../state/app-state";
import { emptySubagentDock, type SubagentDockState, type SubagentRecord } from "../lib/subagent";
import { bindTurn } from "./main/useTurn";
import { useLibrary, type RunTurn } from "./main/useLibrary";
import type { MainModel } from "./main/context";
import { MainProvider } from "./main/context";
import { MainShell } from "./main/MainShell";

export function MainView() {
  const { setFlash } = useApp();
  const [workspace, setWorkspace] = useState(loadWorkspace);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [contextWindow, setContextWindow] = useState(0);
  const [permission, setPermission] = useState<PermissionMode>(() => parsePermissionMode(loadPermission()));
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
  const [recents, setRecents] = useState(loadRecentWorkspaces);
  const [showSettings, setShowSettings] = useState(false);
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
  const subagentsByChatRef = useRef(new Map<string, SubagentDockState>());
  const scroller = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const [composerPad, setComposerPad] = useState(CHAT_BOTTOM_PAD_FALLBACK);
  const stickToBottomRef = useRef(true);
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
    setConversations(rows);
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
      setStreamText(cached?.streamText ?? turnLiveRef.current.streamText);
      setStreamReasoning(cached?.streamReasoning ?? turnLiveRef.current.streamReasoning);
      setLiveTools(cached?.liveTools ?? turnLiveRef.current.liveTools);
    } else {
      setStreamText("");
      setStreamReasoning("");
      setLiveTools([]);
    }
    const dock = subagentsByChatRef.current.get(found.id) ?? emptySubagentDock();
    setSubagents(dock.agents);
    setExpandedAgents(dock.expanded);
    setUsageByChat((prev) => putChatUsage(prev, found.id, full.context_usage));
    if (full.compaction?.summary && full.compaction.through > 0) {
      setCompactionByChat((prev) => ({ ...prev, [found.id]: full.compaction! }));
    }
    saveConversation(ws, found.id);
    const chosen = models.find((row) => row.id === model) ?? models[0];
    const nextEffort = effortForModel(full.effort || found.effort, chosen?.efforts, loadEffort());
    if (nextEffort) setEffort(nextEffort);
  }, [model, models]);

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
    if (!isAppProject(workspace, projectsRootRef.current)) return;
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
        if (saved && !isAppProject(saved, loc.root)) saveWorkspace("");
        setRecents(loadRecentWorkspaces().filter((path) => isAppProject(path, loc.root)));
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
    if (!workspace || !opened) {
      setMentionFiles([]);
      return;
    }
    let gone = false;
    void collectWorkspaceFiles((path) => api.listDir(workspace, path)).then((files) => {
      if (!gone) setMentionFiles(files);
    });
    return () => {
      gone = true;
    };
  }, [workspace, opened, tick]);

  useEffect(() => {
    if (!pathsReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const fromDisk = await api.listProjects();
        const rows = sidebarProjects(fromDisk, projectsRootRef.current);
        const loaded = await Promise.all(
          rows.map(async (row) => {
            const [convs, nextJourneys] = await Promise.all([
              api.listConversations(row.path).catch(() => [] as ConversationSummary[]),
              api.listJourneys(row.path).catch(() => [] as JourneySummary[]),
            ]);
            return { ...row, conversations: convs, journeys: nextJourneys };
          }),
        );
        if (!cancelled) {
          setAllProjectGroups(
            applyLiveProjectChats(loaded, sidebarSyncRef.current, sidebarLoadedForRef.current),
          );
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
    setAllProjectGroups((prev) => placeProjectChats(prev, workspace, conversations, journeys));
  }, [workspace, conversations, journeys]);

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
    return () => {
      cancelled = true;
    };
  }, [pathsReady, workspace, setFlash]);

  useEffect(() => {
    let cancelled = false;
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
      return;
    }
    const pin = () => scrollChatToEnd(scroller.current, stickToBottomRef.current);
    pin();
    const frame = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(frame);
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
    fileRefreshTimer.current = window.setTimeout(() => setTick((n) => n + 1), 200);
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
    models,
    defaultEffort: loadEffort(),
    setEffort,
    openSettings,
    reloadConversations,
    runTurn: (ws, id, next, after, journeyIdOverride) => runTurnRef.current(ws, id, next, after, journeyIdOverride),
    scroller,
    runningWsRef,
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
    subagentsByChatRef,
    stickToBottomRef,
  });
  runTurnRef.current = turn.runTurn;
  const {
    closeFileTab,
    openFolder,
    toggleProjectCollapsed,
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
      setStreamText("");
      setStreamReasoning("");
      setLiveTools([]);
      setRunningActivity(null);
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

  const editMcpServer = useCallback(
    async (server: DetectedMcpServer) => {
      const rel = userMcpRel(server.source);
      try {
        if (rel) await api.openUserMcp(rel);
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
    archiveChat,
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
