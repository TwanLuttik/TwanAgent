import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { CHAT_BOTTOM_PAD_FALLBACK, chatBottomPadding, isNearBottom, pinChatToEnd } from "../lib/chat-scroll";
import { scrollTopAfterPrepend } from "../lib/chat-window";
import { cloudSendWaiting } from "../lib/hosted";
import { type ChatUsage } from "../lib/context";
import { setMcpEnabledInToml, type DetectedMcpServer } from "../lib/mcp";
import { setSkillEnabledInToml, type DetectedSkill } from "../lib/skill";
import { closeChatTab as closeChatTabList, openChatTab } from "../lib/chat-tabs";
import { projectKey, type ChatImage, type ChatMessage, type ConversationActivity, type LiveToolRow } from "../lib/core";
import { clearLiveStream, setLiveStream, subscribeLiveStream } from "../lib/live-stream";
import { bumpFileRefresh, fileStructureFiles, fileStructureSignature, publishFileStructure, subscribeFileStructure } from "../lib/file-structure";
import { imagePathsFromDrop, imagesForChat } from "../lib/image";
import { isSameProject } from "../lib/all-projects";
import type { JourneySummary } from "../lib/journey";
import { parseConversationKind } from "../lib/terminal-chat";
import { emptyEditor, mcpEditorPath, pinEditorTab, previewEditorTab, setEditorFileView, skillEditorPath, type EditorState } from "../lib/editor";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  loadComposerDrafts,
  loadComposerPastes,
  saveComposerPastes,
  loadEffort,
  loadPermission,
  loadSidebarWidth,
  loadWorkspace,
  saveComposerDraft,
  saveSidebarWidth,
  saveWorkspace,
} from "../lib/prefs";
import { parsePermissionMode, type PermissionMode, type RemoteWorkspace } from "../lib/permission";
import { collectWorkspaceFiles, type MentionFile } from "../lib/mention";
import type { PasteBlock } from "../lib/paste";
import { chatHasRunningTurn, draftForChat, pendingForChat, setDraftForChat, type PendingEdit, type PendingMessage, type RunningTurn } from "../lib/turn";
import * as api from "../lib/tauri";
import type { ConversationSummary } from "../lib/tauri";
import { useApp } from "../state/app-state";
import { emptyGrokPlan, planModeEngaged, type GrokPlan, type PlanDecision, type PlanPrompt } from "../lib/plan";
import type { SubagentDockState, SubagentRecord } from "../lib/subagent";
import { bindTurn } from "../hooks/useTurn";
import { useLibrary, type RunTurn } from "../hooks/useLibrary";
import { useCapabilities } from "../hooks/useCapabilities";
import { useChatSession, useLiveRef } from "../hooks/useChatSession";
import { useProjectIndex } from "../hooks/useProjectIndex";
import type { MainModel, SidebarSlice } from "./main/context";
import { MainProvider } from "./main/context";
import { MainShell } from "./main/MainShell";
import { useOverlays } from "../hooks/useOverlays";
import { useRuntime } from "../hooks/useRuntime";
import { useSpeech } from "../hooks/useSpeech";

export function MainView() {
  const { setFlash } = useApp();
  const [workspace, setWorkspace] = useState(loadWorkspace);
  const { runtime, model, setModel, effort, setEffort, contextWindow, setContextWindow, reloadRuntime } = useRuntime();
  const [permission, setPermission] = useState<PermissionMode>(() => parsePermissionMode(loadPermission()));
  const {
    speechModelId,
    speechRows,
    speechProgress,
    speechDownloading,
    refreshSpeech,
    pickSpeechModel,
    downloadSpeech,
    dictate,
  } = useSpeech(setFlash);
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
  const [skills, setSkills] = useState<DetectedSkill[]>([]);
  const [opened, setOpened] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const {
    showSettings,
    setShowSettings,
    settingsTab,
    setSettingsTab,
    showServers,
    setShowServers,
    showUsage,
    setShowUsage,
    projectSettings,
    setProjectSettings,
    closeSettings,
    closeServers,
    closeUsage,
    closeProjectSettings,
    openSettings,
    openServers,
    openUsage,
    openProjectSettings,
  } = useOverlays();
  const [usageTick, setUsageTick] = useState(0);
  const [fileDrag, setFileDrag] = useState(false);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const projectsRootRef = useRef("");
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
  const permissionRef = useLiveRef(permission);
  const modelRef = useLiveRef(model);
  const effortRef = useLiveRef(effort);
  const contextWindowRef = useLiveRef(contextWindow);
  const activeIdRef = useLiveRef(activeId);
  const viewingChatRef = useRef(true);
  viewingChatRef.current =
    editor.focus === "chat" && !showSettings && !showUsage && !showServers && !projectSettings;
  runningIdRef.current = runningId;
  const pendingRef = useLiveRef(pendingByChat);
  const editingRef = useRef<PendingEdit | null>(null);
  const busyRef = useRef(false);
  const mcpServersRef = useLiveRef(mcpServers);
  const skillsRef = useLiveRef(skills);
  const [remoteWorkspace, setRemoteWorkspace] = useState<RemoteWorkspace | null>(null);
  const [remoteKnown, setRemoteKnown] = useState(false);
  const [linkReady, setLinkReady] = useState(false);
  const hostedChats = Boolean(remoteWorkspace?.paired && linkReady);
  const remoteRef = useLiveRef(remoteWorkspace);
  /** The project `remoteWorkspace` was loaded for. Empty until that lookup returns. */
  const remoteForRef = useRef("");
  const remoteKnownRef = useLiveRef(remoteKnown);
  const linkReadyRef = useLiveRef(linkReady);
  const sidebarSyncRef = useLiveRef({ workspace, conversations, journeys });
  const conversationsRef = useLiveRef(conversations);
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

  const workspaceRef = useLiveRef(workspace);
  const openGeneration = useRef(0);
  const libraryRef = useRef<ReturnType<typeof useLibrary> | null>(null);
  const reloadConversations = useChatSession({
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
  });
  const {
    recents,
    setRecents,
    allProjectGroups,
    setAllProjectGroups,
    collapsedProjects,
    setCollapsedProjects,
    projectsRoot,
    legacyProjectsRoot,
    pathsReady,
  } = useProjectIndex({
    workspace,
    setWorkspace,
    conversations,
    journeys,
    remoteWorkspace,
    remoteForRef,
    sidebarSyncRef,
    sidebarLoadedForRef,
    workspaceRef,
    setFlash,
  });
  projectsRootRef.current = projectsRoot;

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
    if (cloudSendWaiting(remoteKnown, remoteWorkspace, linkReady)) return;
    void reloadConversations(workspace).catch((e) => setFlash({ kind: "err", text: String(e) }));
  }, [pathsReady, workspace, remoteKnown, remoteWorkspace, linkReady, reloadConversations, setFlash]);

  useEffect(() => {
    if (!workspace || !opened || cloudSendWaiting(remoteKnown, remoteWorkspace, linkReady)) return;
    let gone = false;
    let timer = 0;
    // The file pane lists the top folder itself. The full walk feeds @ mentions,
    // so it waits until the window has had a chance to take a click.
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
    const start = window.setTimeout(watch, 1500);
    return () => {
      gone = true;
      window.clearTimeout(start);
      window.clearTimeout(timer);
    };
  }, [workspace, opened, remoteKnown, remoteWorkspace, linkReady]);

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
    // Drop the previous project's cloud mark before this lookup returns.
    // Otherwise the project just opened inherits that icon.
    remoteForRef.current = "";
    remoteKnownRef.current = false;
    linkReadyRef.current = false;
    setRemoteKnown(false);
    setLinkReady(false);
    setRemoteWorkspace(null);
    const watchRemote = () => {
      const asked = workspace;
      void api
        .workspaceRemote(asked)
        .then((row) => {
          if (cancelled || !isSameProject(asked, workspaceRef.current)) return;
          remoteForRef.current = asked;
          const next = row
            ? {
                machineName: row.machine_name,
                host: row.host,
                user: row.user,
                port: row.port,
                remotePath: row.remote_path,
                online: row.online,
                providers: row.providers ?? [],
                paired: row.paired,
              }
            : null;
          setRemoteWorkspace(next);
          remoteKnownRef.current = true;
          setRemoteKnown(true);
          if (!next?.paired || !next.online) {
            linkReadyRef.current = false;
            setLinkReady(false);
            return;
          }
          if (linkReadyRef.current) return;
          void api
            .warmWorkspaceLink(asked)
            .then((ready) => {
              if (cancelled || !isSameProject(asked, workspaceRef.current)) return;
              linkReadyRef.current = ready;
              setLinkReady(ready);
            })
            .catch(() => {
              if (cancelled || !isSameProject(asked, workspaceRef.current)) return;
              linkReadyRef.current = false;
              setLinkReady(false);
            });
        })
        .catch(() => {
          if (cancelled || !isSameProject(asked, workspaceRef.current)) return;
          remoteForRef.current = asked;
          remoteKnownRef.current = true;
          linkReadyRef.current = false;
          setRemoteKnown(true);
          setLinkReady(false);
          setRemoteWorkspace(null);
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

  const { mcpBusy, setMcpBusy, skillBusy, setSkillBusy } = useCapabilities({
    workspace,
    remoteWorkspace,
    remoteKnown,
    linkReady,
    setMcpServers,
    setSkills,
  });

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
  }, [editor.focus, showSettings, showUsage, showServers, activeId]);

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
    hostedChats,
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
    sidebarLoadedForRef,
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
    setShowServers,
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
    remoteKnownRef,
    linkReadyRef,
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
      setShowServers(false);
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
    setShowServers(false);
    setProjectSettings(null);
    setEditor((prev) => pinEditorTab(prev, mcpEditorPath(server.source)));
  }, []);

  const reauthMcpServer = useCallback(
    async (server: DetectedMcpServer) => {
      setMcpBusy(server.name);
      try {
        if (remoteWorkspace && workspace) {
          const remoteId = await api.workspaceServerId(workspace);
          if (remoteId) {
            await api.syncServerCapabilities(remoteId, server.name);
            bumpFiles();
            setFlash({ kind: "ok", text: `Signed in to ${server.name} and sent it to the server.` });
            return;
          }
        }
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
    [remoteWorkspace, workspace, setFlash],
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
    (skill: DetectedSkill) => {
      setShowSettings(false);
      setShowUsage(false);
      setShowServers(false);
      setProjectSettings(null);
      const path = skill.source.startsWith("~/") ? skillEditorPath(skill.source) : skill.source;
      setEditor((prev) => pinEditorTab(prev, path));
    },
    [],
  );

  const showLanding = false;
  const chatKind = parseConversationKind(conversations.find((c) => c.id === activeId)?.kind);
  const chatAcceptsDrop =
    !showSettings && !showUsage && !showServers && (showLanding || (editor.focus !== "file" && chatKind !== "terminal"));
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
    if (showLanding || showSettings || showUsage || showServers || editor.focus === "file") return;
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
  }, [showLanding, showSettings, showUsage, showServers, editor.focus]);

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
    closeServers,
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
    openServers,
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
    cloudConnecting: cloudSendWaiting(remoteKnown, remoteWorkspace, linkReady),
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
    showServers,
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
