import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { CHAT_BOTTOM_PAD_FALLBACK, chatBottomPadding, isNearBottom, pinChatToEnd } from "../lib/chat-scroll";
import { scrollTopAfterPrepend } from "../lib/chat-window";
import { insertCompactionEvent } from "../lib/compact";
import { cloudSendWaiting } from "../lib/hosted";
import { type ChatUsage } from "../lib/context";
import { setMcpEnabledInToml, type DetectedMcpServer } from "../lib/mcp";
import { setSkillEnabledInToml, type DetectedSkill } from "../lib/skill";
import {
  chatIdsInTabs,
  closeTabChat,
  primaryChatId,
  rememberSplitPane,
  tabItemKey,
  clampSplitShare,
  focusSplitChat,
  focusSplitPane as focusSplitPaneItems,
  forgetSplitPane,
  moveTabItem,
  revealTabChat,
  setSplitShare as setSplitShareItems,
  withCodeTab,
  splitSelectedChats,
  splitChatTab,
  splitGroupForChat,
  unsplitGroup,
  type TabItem,
  type TabMenu,
} from "../lib/split-pane";
import { projectKey, type ChatImage, type ChatMessage, type ConversationActivity, type LiveToolRow } from "../lib/core";
import {
  clearLiveStream,
  clearSecondaryLiveStream,
  setLiveStream,
  setSecondaryLiveStream,
  subscribeLiveStream,
} from "../lib/live-stream";
import { bumpFileRefresh, fileStructureFiles, fileStructureSignature, publishFileStructure, subscribeFileStructure } from "../lib/file-structure";
import { imagePathsFromDrop, imagesForChat } from "../lib/image";
import { isSameProject } from "../lib/all-projects";
import type { JourneySummary } from "../lib/journey";
import { parseConversationKind } from "../lib/terminal-chat";
import { codeTabEditor, emptyEditor, mcpEditorPath, pinEditorTab, previewEditorTab, setEditorFileView, skillEditorPath, type EditorState } from "../lib/editor";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  loadActiveTab,
  loadComposerDrafts,
  loadComposerPastes,
  loadOpenTabs,
  saveActiveTab,
  saveProjectOpenTabs,
  type StoredTabItem,
  saveComposerPastes,
  loadEffort,
  loadConversation,
  loadPermission,
  loadSidebarWidth,
  loadSidebarCollapsed,
  loadPaneCollapsed,
  loadWorkspace,
  saveComposerDraft,
  saveSidebarWidth,
  saveSidebarCollapsed,
  savePaneCollapsed,
  saveWorkspace,
} from "../lib/prefs";
import { parsePermissionMode, type PermissionMode, type RemoteWorkspace } from "../lib/permission";
import { collectWorkspaceFiles, type MentionFile } from "../lib/mention";
import type { PasteBlock } from "../lib/paste";
import { chatHasRunningTurn, draftForChat, pendingForChat, setDraftForChat, type PendingEdit, type PendingMessage, type RunningTurn } from "../lib/turn";
import { chatScrollFor, forgetChatScroll, rememberChatScroll } from "../lib/chat-scroll";
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

/** The split pane under a window drag. Positions arrive in physical pixels. */
function dropChatAt(x: number, y: number): string {
  const scale = window.devicePixelRatio || 1;
  const hit = document.elementFromPoint(x / scale, y / scale);
  const pane = hit?.closest<HTMLElement>("[data-drop-chat]");
  return pane?.dataset.dropChat ?? "";
}

function loadStoredOpenTabs(): Record<string, TabItem[]> {
  const out: Record<string, TabItem[]> = {};
  for (const [path, items] of Object.entries(loadOpenTabs())) {
    const key = projectKey(path);
    if (!key || out[key]) continue;
    out[key] = items.map(storedTabToItem);
  }
  return out;
}

function storedTabToItem(item: StoredTabItem): TabItem {
  if (item.kind === "code") return { kind: "code" };
  if (item.kind === "chat") return { kind: "chat", id: item.id };
  return {
    kind: "split",
    group: {
      id: item.id,
      chatIds: item.chatIds,
      activePane: item.activePane,
      leftShare: clampSplitShare(item.leftShare),
    },
  };
}

/** Drop a tab only after its chat was listed and then disappeared. A chat that
 * has not loaded yet stays, so a restart does not wipe the saved strip. */
function pruneMissingTab(item: TabItem, known: ReadonlySet<string>, seen: ReadonlySet<string>): TabItem[] {
  if (item.kind === "code") return [item];
  if (item.kind === "chat") return !seen.has(item.id) || known.has(item.id) ? [item] : [];
  const [left, right] = item.group.chatIds;
  const leftGone = seen.has(left) && !known.has(left);
  const rightGone = seen.has(right) && !known.has(right);
  if (!leftGone && !rightGone) return [item];
  if (leftGone && rightGone) return [];
  return [{ kind: "chat", id: leftGone ? right : left }];
}

function tabItemToStored(item: TabItem): StoredTabItem {
  if (item.kind === "code") return { kind: "code" };
  if (item.kind === "chat") return { kind: "chat", id: item.id };
  return {
    kind: "split",
    id: item.group.id,
    chatIds: item.group.chatIds,
    activePane: item.group.activePane,
    leftShare: item.group.leftShare,
  };
}

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
  const [chatTabsByProject, setChatTabsByProject] = useState<Record<string, TabItem[]>>(loadStoredOpenTabs);
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null);
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
  const [fileDrag, setFileDrag] = useState<string | boolean>(false);
  const [editor, setEditor] = useState<EditorState>(() =>
    loadActiveTab(loadWorkspace()) === "code" ? codeTabEditor() : emptyEditor(),
  );
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(loadSidebarCollapsed);
  const [paneCollapsed, setPaneCollapsedState] = useState(loadPaneCollapsed);
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    saveSidebarCollapsed(collapsed);
  }, []);
  const setPaneCollapsed = useCallback((collapsed: boolean) => {
    setPaneCollapsedState(collapsed);
    savePaneCollapsed(collapsed);
  }, []);
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
  const sideChatIdRef = useRef("");
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
  const journeysRef = useLiveRef(journeys);
  const cloudTranscriptsRef = useRef(new Map<string, import("../lib/tauri").Conversation>());
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
  const holdEmptyChatRef = useRef(false);
  const followingRef = useRef(false);
  const prependRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const draft = draftForChat(drafts, activeId);
  const draftsRef = useLiveRef(drafts);
  const draftImagesRef = useLiveRef(draftImages);
  const draftPastes = pastesByChat[activeId] ?? [];
  const promptImages = imagesForChat(draftImages, activeId);
  const queued = pendingForChat(pendingByChat, activeId);

  const setDraft = useCallback((text: string) => {
    saveComposerDraft(activeId, text);
    setDrafts((prev) => setDraftForChat(prev, activeId, text));
  }, [activeId]);

  const setChatDraft = useCallback((chatId: string, text: string) => {
    if (!chatId) return;
    saveComposerDraft(chatId, text);
    setDrafts((prev) => setDraftForChat(prev, chatId, text));
  }, []);

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
    cloudTranscriptsRef,
    setFlash,
  });
  projectsRootRef.current = projectsRoot;

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      const target = ev.target;
      if (target instanceof Element && target.closest("[role='menu']")) return;
      setProjectMenu(null);
      setTabMenu(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setProjectMenu(null);
        setTabMenu(null);
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

  holdEmptyChatRef.current = !activeId && messages.length === 0;
  useEffect(() => {
    if (!pathsReady || !workspace) return;
    // A new chat has not joined a project. Loading the one just picked would
    // replace the empty screen and rebuild the composer. A conversation saved
    // for this project is a click from the sidebar, so it still has to open.
    if (holdEmptyChatRef.current && !loadConversation(workspace)) return;
    if (cloudSendWaiting(Boolean(workspace), remoteKnown, remoteWorkspace, linkReady)) return;
    void reloadConversations(workspace).catch((e) => setFlash({ kind: "err", text: String(e) }));
  }, [pathsReady, workspace, remoteKnown, remoteWorkspace, linkReady, reloadConversations, setFlash]);

  useEffect(() => {
    if (!workspace || !opened || cloudSendWaiting(Boolean(workspace), remoteKnown, remoteWorkspace, linkReady)) return;
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

  const openProjectFolder = useCallback(() => {
    const asked = workspaceRef.current;
    if (!asked) return;
    void api
      .openFolder(asked)
      .then((path) => {
        if (!isSameProject(asked, workspaceRef.current)) return;
        if (path !== workspaceRef.current) {
          saveWorkspace(path);
          setWorkspace(path);
          return;
        }
        setOpened(true);
      })
      .catch((e) => {
        if (!isSameProject(asked, workspaceRef.current)) return;
        setOpened(false);
        setFlash({ kind: "err", text: String(e) });
      });
  }, [setFlash]);

  useEffect(() => {
    if (!pathsReady) return;
    if (!workspace) {
      setOpened(false);
      return;
    }
    // The empty chat only points at a project. Opening the folder waits until a
    // real chat is on screen, so the composer does not rebuild on each pick.
    if (activeIdRef.current) openProjectFolder();
    let cancelled = false;
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
  }, [pathsReady, workspace, openProjectFolder, setFlash]);

  const openedForRef = useRef("");
  useEffect(() => {
    if (!pathsReady || !workspace || !activeId) return;
    const key = projectKey(workspace);
    // The first chat in this project opens the folder. Later chats do not.
    if (openedForRef.current === key) return;
    openedForRef.current = key;
    openProjectFolder();
  }, [pathsReady, workspace, activeId, openProjectFolder]);

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

  const restoredFor = useRef("");
  useLayoutEffect(() => {
    const el = scroller.current;
    const prepend = prependRef.current;
    if (el && activeId && restoredFor.current !== activeId) {
      restoredFor.current = activeId;
      const saved = chatScrollFor(activeId);
      if (saved != null) {
        stickToBottomRef.current = isNearBottom({
          scrollTop: saved,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
        el.scrollTop = saved;
      }
    }
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
    cloudTranscriptsRef,
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
    chatTabsByProject,
    setFlash,
    bumpFiles,
  });
  libraryRef.current = library;
  const hostedWatchRef = useRef("");
  useEffect(() => {
    if (!hostedChats || !workspace || !activeId) {
      hostedWatchRef.current = "";
      return;
    }
    const key = `${projectKey(workspace)}:${activeId}`;
    if (hostedWatchRef.current === key) return;
    hostedWatchRef.current = key;
    void library.watchHosted(workspace, activeId);
  }, [hostedChats, workspace, activeId, library]);
  const turn = bindTurn({
    workspace,
    activeId,
    messages,
    draft,
    draftPastes,
    draftsRef,
    draftImagesRef,
    promptImages,
    mentionFiles,
    busy,
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
    sideChatIdRef,
  });
  runTurnRef.current = turn.runTurn;
  const {
    closeFileTab,
    openFolder,
    toggleProjectCollapsed,
    reorderProjects,
    deleteProjectFromSidebar,
    applyWorkspace,
    assignDraftProject,
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
  const codeTabOpen = editor.tabs.length > 0;
  const tabItems = withCodeTab(chatTabKey ? (chatTabsByProject[chatTabKey] ?? []) : [], codeTabOpen);
  useEffect(() => {
    if (!workspace) return;
    const key = projectKey(workspace);
    setChatTabsByProject((prev) => {
      const current = prev[key] ?? [];
      const next = withCodeTab(current, codeTabOpen);
      return next === current ? prev : { ...prev, [key]: next };
    });
  }, [workspace, codeTabOpen]);
  useEffect(() => {
    if (!workspace) return;
    saveProjectOpenTabs(workspace, tabItems.map(tabItemToStored));
  }, [workspace, tabItems]);
  const activeTabKey = (() => {
    if (editor.focus === "file") return "code";
    const item = tabItems.find((row) => {
      if (row.kind === "chat") return row.id === activeId;
      if (row.kind === "split") return row.group.chatIds.includes(activeId);
      return false;
    });
    return item ? tabItemKey(item) : "";
  })();
  useEffect(() => {
    if (!workspace || !activeTabKey) return;
    saveActiveTab(workspace, activeTabKey);
  }, [workspace, activeTabKey]);
  const restoredTabFor = useRef("");
  useEffect(() => {
    if (!workspace || !activeId) return;
    const key = projectKey(workspace);
    if (restoredTabFor.current === key) return;
    restoredTabFor.current = key;
    const saved = loadActiveTab(workspace);
    if (!saved.startsWith("split:")) return;
    // A sidebar click names one chat. Restoring the split would replace it
    // with the pane that was focused last time.
    if (tabItems.some((item) => item.kind === "chat" && item.id === activeId)) return;
    const groupId = saved.slice("split:".length);
    const group = tabItems.find((item) => item.kind === "split" && item.group.id === groupId);
    if (!group || group.kind !== "split") return;
    const paneId = primaryChatId(group);
    if (paneId && paneId !== activeId) void openChat(paneId);
  }, [workspace, activeId, tabItems, openChat]);
  const seenChats = useRef({ key: "", ids: new Set<string>() });
  useEffect(() => {
    if (!workspace || conversations.length === 0) return;
    const key = projectKey(workspace);
    if (seenChats.current.key !== key) seenChats.current = { key, ids: new Set() };
    const known = new Set(conversations.map((row) => row.id));
    const seen = seenChats.current.ids;
    setChatTabsByProject((prev) => {
      const current = prev[key] ?? [];
      const next = current.flatMap((item) => pruneMissingTab(item, known, seen));
      const same = next.length === current.length && next.every((item, index) => item === current[index]);
      return same ? prev : { ...prev, [key]: next };
    });
    known.forEach((id) => seen.add(id));
  }, [workspace, conversations]);
  const openSplit = splitGroupForChat(tabItems, activeId);
  const splitChatIds = openSplit ? [...openSplit.chatIds] : [];
  const sideChatId = splitChatIds.find((id) => id !== activeId) ?? "";
  sideChatIdRef.current = sideChatId;
  const sidePrepared = useRef("");
  useEffect(() => {
    if (!workspace || !sideChatId) {
      sidePrepared.current = "";
      return;
    }
    const key = `${projectKey(workspace)}:${sideChatId}`;
    if (sidePrepared.current === key) return;
    sidePrepared.current = key;
    let gone = false;
    const load = hostedChats ? api.getHostedConversation(workspace, sideChatId) : api.getConversation(workspace, sideChatId);
    void load
      .then((full) => {
        if (gone) return;
        const body = (full.messages as ChatMessage[]) ?? [];
        const shown =
          full.compaction?.summary && full.compaction.through > 0
            ? insertCompactionEvent(body, full.compaction.through)
            : body;
        if (!shown.length) return;
        rememberSplitPane(sideChatId, { messages: shown });
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [workspace, sideChatId, hostedChats]);
  useEffect(() => {
    if (!sideChatId) {
      clearSecondaryLiveStream();
      return;
    }
    const paint = () => {
      const live = liveByChatRef.current.get(sideChatId);
      if (!live) {
        clearSecondaryLiveStream();
        return;
      }
      setSecondaryLiveStream({
        streamText: live.streamText,
        streamReasoning: live.streamReasoning,
        liveTools: live.liveTools,
        runningActivity: live.activity,
      });
    };
    paint();
    return subscribeLiveStream(paint);
  }, [sideChatId]);
  const chatTabs = chatIdsInTabs(tabItems).map((id) => {
    // The open list is empty until the project finishes loading. The sidebar
    // already has this project's titles, so the strip does not say "Chat" first.
    const row =
      conversations.find((item) => item.id === id) ??
      allProjectGroups.find((group) => isSameProject(group.path, workspace))?.conversations.find((item) => item.id === id);
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
      const next = revealTabChat(tabs, activeId);
      return next === tabs ? prev : { ...prev, [key]: next };
    });
  }, [workspace, activeId]);

  const closeChatTab = useCallback(
    (id: string) => {
      if (!workspace || !id) return;
      const key = projectKey(workspace);
      const result = closeTabChat(chatTabsByProject[key] ?? [], id);
      if (!result.removed) return;
      setChatTabsByProject((prev) => ({ ...prev, [key]: result.items }));
      forgetSplitPane(id);
      forgetChatScroll(id);
      setTabMenu(null);
      if (id !== activeId) return;
      if (result.next) {
        void openChat(result.next);
        return;
      }
      setActiveId("");
      setMessages([]);
      clearLiveStream();
      clearSecondaryLiveStream();
      setTurnStartedAt(0);
      setSubagents([]);
      setExpandedAgents({});
      runningIdRef.current = "";
      setRunningId("");
      abortRef.current = null;
    },
    [workspace, chatTabsByProject, activeId, openChat],
  );

  const splitSelected = useCallback(
    (ids: string[]) => {
      if (!workspace || ids.length < 2) return;
      const blocked = ids.some((id) => conversations.find((item) => item.id === id)?.kind === "terminal");
      if (blocked) return;
      const key = projectKey(workspace);
      setChatTabsByProject((prev) => {
        const current = prev[key] ?? [];
        const next = splitSelectedChats(current, ids);
        return next === current ? prev : { ...prev, [key]: next };
      });
      setTabMenu(null);
      setEditor((prev) => (prev.focus === "chat" ? prev : { ...prev, focus: "chat" }));
    },
    [workspace, conversations],
  );

  const moveChatTab = useCallback(
    (fromKey: string, toKey: string) => {
      if (!workspace) return;
      const key = projectKey(workspace);
      setChatTabsByProject((prev) => {
        const current = prev[key] ?? [];
        const next = moveTabItem(current, fromKey, toKey);
        return next === current ? prev : { ...prev, [key]: next };
      });
    },
    [workspace],
  );

  const setSplitShare = useCallback(
    (groupId: string, share: number) => {
      if (!workspace || !groupId) return;
      const key = projectKey(workspace);
      setChatTabsByProject((prev) => {
        const current = prev[key] ?? [];
        const next = setSplitShareItems(current, groupId, share);
        return next === current ? prev : { ...prev, [key]: next };
      });
    },
    [workspace],
  );

  const splitChat = useCallback(
    (id: string) => {
      if (!workspace || !id) return;
      const row = conversations.find((item) => item.id === id);
      if (row?.kind === "terminal") return;
      const key = projectKey(workspace);
      setChatTabsByProject((prev) => {
        const current = prev[key] ?? [];
        const next = splitChatTab(current, id);
        return next === current ? prev : { ...prev, [key]: next };
      });
      setTabMenu(null);
      setEditor((prev) => (prev.focus === "chat" ? prev : { ...prev, focus: "chat" }));
    },
    [workspace, conversations],
  );

  const unsplitChat = useCallback(
    (groupId: string) => {
      if (!workspace || !groupId) return;
      const key = projectKey(workspace);
      setChatTabsByProject((prev) => {
        const current = prev[key] ?? [];
        const next = unsplitGroup(current, groupId);
        return next === current ? prev : { ...prev, [key]: next };
      });
      setTabMenu(null);
      clearSecondaryLiveStream();
    },
    [workspace],
  );

  const revealSplitRef = useRef<(id: string) => boolean>(() => false);
  revealSplitRef.current = (id: string) => {
    if (!id || !workspace) return false;
    const key = projectKey(workspace);
    const items = chatTabsByProject[key] ?? [];
    if (!splitGroupForChat(items, id)) return false;
    setEditor((prev) => (prev.focus === "chat" ? prev : { ...prev, focus: "chat" }));
    const current = chatTabsByProject[key] ?? [];
    const next = focusSplitChat(current, id);
    if (next !== current) setChatTabsByProject((prev) => ({ ...prev, [key]: next }));
    if (id !== activeId) void openChat(id, { ...chatTabsByProject, [key]: next });
    return true;
  };
  library.revealListedChatRef.current = (id) => revealSplitRef.current(id);

  const openListedChat = useCallback(
    (id: string) => {
      if (!id || !revealSplitRef.current(id)) void openChat(id);
    },
    [openChat],
  );

  const focusSplitChatPane = useCallback(
    (groupId: string, pane: 0 | 1) => {
      if (!workspace) return;
      const key = projectKey(workspace);
      const group = (chatTabsByProject[key] ?? []).find(
        (item) => item.kind === "split" && item.group.id === groupId,
      );
      if (!group || group.kind !== "split") return;
      const id = group.group.chatIds[pane];
      const current = chatTabsByProject[key] ?? [];
      const next = focusSplitPaneItems(current, groupId, pane);
      if (next !== current) setChatTabsByProject((prev) => ({ ...prev, [key]: next }));
      // Pass the focused tabs in. State has not committed yet, and openChat must
      // see this chat as already on screen so it does not fetch it and show Loading….
      if (id && id !== activeId) void openChat(id, { ...chatTabsByProject, [key]: next });
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
  const fileDragRef = useRef(fileDrag);
  fileDragRef.current = fileDrag;
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
        if (event.payload.type === "enter" || event.payload.type === "over") {
          const images = event.payload.type === "enter" ? imagePathsFromDrop(event.payload.paths) : null;
          if (images && images.length === 0) {
            setFileDrag(false);
            return;
          }
          const chatId = dropChatAt(event.payload.position.x, event.payload.position.y);
          setFileDrag(chatId || false);
          return;
        }
        if (event.payload.type === "leave") {
          setFileDrag(false);
          return;
        }
        const chatId = typeof fileDragRef.current === "string" ? fileDragRef.current : dropChatAt(event.payload.position.x, event.payload.position.y);
        setFileDrag(false);
        void addImagePathsRef.current(event.payload.paths, chatId || undefined);
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
    // A split gives the focused chat its own scroller. The window ref is empty then,
    // and that pane follows itself. This listener is only the single-chat column.
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      if (followingRef.current) return;
      stickToBottomRef.current = isNearBottom(el);
      if (activeIdRef.current) rememberChatScroll(activeIdRef.current, el.scrollTop);
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
  }, [showLanding, showSettings, showUsage, showServers, editor.focus, splitChatIds.join("|")]);

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
    openListedChat,
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
      openListedChat,
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
    live.openListedChat = openListedChat;
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
    assignDraftProject,
    beginPendingEdit,
    busy,
    chatTabs,
    tabItems,
    splitChatIds,
    tabMenu,
    setTabMenu,
    splitChat,
    splitSelected,
    moveChatTab,
    setSplitShare,
    unsplitChat,
    focusSplitPane: focusSplitChatPane,
    openListedChat,
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
    drafts,
    draftImages,
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
    pendingByChat,
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
    reauthMcpServer,
    recents,
    reloadRuntime,
    remoteWorkspace,
    cloudConnecting: cloudSendWaiting(Boolean(workspace), remoteKnown, remoteWorkspace, linkReady),
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
    setChatDraft,
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
    sidebarCollapsed,
    setSidebarCollapsed,
    paneCollapsed,
    setPaneCollapsed,
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
