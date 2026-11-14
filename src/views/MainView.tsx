import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { CHAT_BOTTOM_PAD_FALLBACK, applyComposerPadResize, chatBottomPadding, chatScrollFor, chatScrollNearBottom, forgetChatScroll, isNearBottom, pinChatToEnd, rememberChatScroll, restoreChatScroll } from "../lib/chat-scroll";
import { insertCompactionEvent } from "../lib/compact";
import { cloudSendWaiting, linkChatsOnServer, projectLink } from "../lib/hosted";
import { type ChatUsage } from "../lib/context";
import { setMcpEnabledInToml, type DetectedMcpServer } from "../lib/mcp";
import { setSkillEnabledInToml, type DetectedSkill } from "../lib/skill";
import {
  chatAfterClosing,
  chatIdsInTabs,
  closeTabChat,
  closeTabChats,
  primaryChatId,
  rememberSplitPane,
  tabItemKey,
  clampSplitShare,
  focusSplitChat,
  focusSplitPane as focusSplitPaneItems,
  forgetSplitPane,
  moveTabItem,
  retainOpenTabs,
  revealTabChat,
  groupTabsByProject,
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
import { keptTabChatIds, projectTabChats, rememberTabTitle, subscribeWorktreeLists, tabTitleFor, worktreeNameRevision } from "../lib/worktree";
import {
  clearLiveStream,
  clearSecondaryLiveStream,
  setLiveStream,
  setSecondaryLiveStream,
  subscribeLiveStream,
} from "../lib/live-stream";
import { bumpFileRefresh, fileStructureFiles, fileStructureSignature, publishFileStructure, subscribeFileStructure } from "../lib/file-structure";
import { attachmentPathsFromDrop, imagesForChat } from "../lib/image";
import { isSameProject } from "../lib/all-projects";

import { codeTabEditor, emptyEditor, mcpEditorPath, pinEditorTab, previewEditorTab, setEditorFileView, skillEditorPath, type EditorState } from "../lib/editor";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  loadActiveTab,
  loadComposerDrafts,
  loadComposerPastes,
  loadOpenTabs,
  saveActiveTab,
  saveOpenTabs,
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
import { mentionProjectsFor, publishMentionProjects } from "../lib/project-mention";
import { useProjectGroups } from "../lib/project-groups";
import type { PasteBlock } from "../lib/paste";
import { chatHasRunningTurn, draftForChat, pendingForChat, setDraftForChat, type PendingEdit, type PendingMessage, type RunningTurn } from "../lib/turn";
import { transcriptOnScreen } from "../lib/transcript-open";
import { sidebarTodoBadge, todosInLatestTurn } from "../lib/todo";
import * as api from "../lib/tauri";
import type { ConversationSummary } from "../lib/tauri";
import { useApp } from "../state/app-state";
import { emptyGrokPlan, planModeEngaged, type GrokPlan, type PlanDecision, type PlanPrompt } from "../lib/plan";
import type { SubagentDockState, SubagentRecord } from "../lib/subagent";
import { bindTurn } from "../hooks/useTurn";
import { useLibrary, type RunTurn } from "../hooks/useLibrary";
import { useCapabilities } from "../hooks/useCapabilities";
import { markLiveLocalTurns, useChatSession, useLiveRef } from "../hooks/useChatSession";
import { useProjectIndex } from "../hooks/useProjectIndex";
import type { MainModel, SidebarSlice } from "./main/context";
import { todoSignature } from "./main/SidebarActivity";
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

type OpenStrip = { items: TabItem[]; homes: Record<string, string> };

function loadStoredStrip(): OpenStrip {
  const items: TabItem[] = [];
  const homes: Record<string, string> = {};
  for (const item of loadOpenTabs()) {
    if (item.kind === "code") {
      items.push({ kind: "code" });
      continue;
    }
    if (item.kind === "chat") {
      items.push({ kind: "chat", id: item.id });
      if (item.workspace) homes[item.id] = item.workspace;
      continue;
    }
    items.push({
      kind: "split",
      group: {
        id: item.id,
        chatIds: item.chatIds,
        activePane: item.activePane,
        leftShare: clampSplitShare(item.leftShare),
      },
    });
    if (item.workspaces[0]) homes[item.chatIds[0]] = item.workspaces[0];
    if (item.workspaces[1]) homes[item.chatIds[1]] = item.workspaces[1];
  }
  return { items, homes };
}

function stripToStored(items: TabItem[], homes: Record<string, string>): StoredTabItem[] {
  const out: StoredTabItem[] = [];
  for (const item of items) {
    if (item.kind === "code") out.push({ kind: "code" });
    else if (item.kind === "chat") out.push({ kind: "chat", id: item.id, workspace: homes[item.id] ?? "" });
    else {
      out.push({
        kind: "split",
        id: item.group.id,
        chatIds: item.group.chatIds,
        workspaces: [homes[item.group.chatIds[0]] ?? "", homes[item.group.chatIds[1]] ?? ""],
        activePane: item.group.activePane,
        leftShare: item.group.leftShare,
      });
    }
  }
  return out;
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
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>(loadComposerDrafts);
  const [pastesByChat, setPastesByChat] = useState<Record<string, PasteBlock[]>>(loadComposerPastes);
  const [mentionFiles, setMentionFiles] = useState<MentionFile[]>([]);
  const [draftImages, setDraftImages] = useState<Record<string, ChatImage[]>>({});
  const [pendingByChat, setPendingByChat] = useState<Record<string, PendingMessage[]>>({});
  const [editingPending, setEditingPending] = useState<PendingEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [openStrip, setOpenStrip] = useState<OpenStrip>(loadStoredStrip);
  const tabHomesRef = useLiveRef(openStrip.homes);
  const paintedChatsRef = useRef(new Set<string>());
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
    overlay,
    showSettings,
    settingsTab,
    setSettingsTab,
    showServers,
    showUsage,
    showDocs,
    projectSettings,
    closeOverlays,
    closeSettings,
    closeServers,
    closeUsage,
    closeDocs,
    closeProjectSettings,
    openSettings,
    openServers,
    openUsage,
    openDocs,
    openProjectSettings,
    dismissProjectSettings,
  } = useOverlays();
  const [usageTick, setUsageTick] = useState(0);
  const [fileDrag, setFileDrag] = useState<string | boolean>(false);
  const [editor, setEditor] = useState<EditorState>(() =>
    loadActiveTab() === "code" ? codeTabEditor() : emptyEditor(),
  );
  const editorRef = useLiveRef(editor);
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
    editor.focus === "chat" && !showSettings && !showUsage && !showDocs && !showServers && !projectSettings;
  runningIdRef.current = runningId;
  const pendingRef = useLiveRef(pendingByChat);
  const editingRef = useRef<PendingEdit | null>(null);
  const busyRef = useRef(false);
  const mcpServersRef = useLiveRef(mcpServers);
  const skillsRef = useLiveRef(skills);
  const [remoteWorkspace, setRemoteWorkspace] = useState<RemoteWorkspace | null>(null);
  const [remoteKnown, setRemoteKnown] = useState(false);
  const [linkReady, setLinkReady] = useState(false);
  const hostedChats = linkChatsOnServer(
    projectLink({
      hasWorkspace: Boolean(workspace),
      known: remoteKnown,
      remote: remoteWorkspace,
      linkReady,
    }),
  );
  const remoteRef = useLiveRef(remoteWorkspace);
  /** The project `remoteWorkspace` was loaded for. Empty until that lookup returns. */
  const remoteForRef = useRef("");
  const remoteKnownRef = useLiveRef(remoteKnown);
  const linkReadyRef = useLiveRef(linkReady);
  const sidebarSyncRef = useLiveRef({ workspace, conversations });
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
  const holdEmptyChatRef = useRef(false);
  const followingRef = useRef(false);
  const followHolds = useRef(0);
  const holdFollow = useCallback(() => {
    followHolds.current += 1;
    followingRef.current = true;
    requestAnimationFrame(() => {
      followHolds.current = Math.max(0, followHolds.current - 1);
      if (followHolds.current === 0) followingRef.current = false;
    });
  }, []);
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
    setActiveId,
    setMessages,
    setUnseenFinished,
    setSubagents,
    setExpandedAgents,
    setUsageByChat,
    setCompactionByChat,
    setOpeningId,
    setRunningTurns,
    setBusy,
    turnsRef,
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
    holdEmptyChatRef,
    libraryRef,
    paintedChatsRef,
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
    sidebarReady,
  } = useProjectIndex({
    workspace,
    setWorkspace,
    conversations,
    remoteWorkspace,
    remoteForRef,
    sidebarSyncRef,
    sidebarLoadedForRef,
    workspaceRef,
    setFlash,
  });
  projectsRootRef.current = projectsRoot;
  const projectGroups = useProjectGroups();
  const mentionProjects = useMemo(
    () => mentionProjectsFor(workspace, allProjectGroups, projectGroups),
    [workspace, allProjectGroups, projectGroups],
  );
  useEffect(() => {
    publishMentionProjects(mentionProjects);
  }, [mentionProjects]);
  const joinedLiveRef = useRef(new Set<string>());
  const sidebarChatIds = allProjectGroups
    .flatMap((group) => group.conversations.map((row) => row.id))
    .filter(Boolean)
    .join("\n");
  useEffect(() => {
    const ids = sidebarChatIds.split("\n").filter(Boolean);
    if (!ids.length) return;
    // A chat started in another project keeps running after this window reloads.
    void markLiveLocalTurns(ids, {
      known: joinedLiveRef.current,
      turns: turnsRef.current,
      liveTurns: turnsRef.current,
      setRunningTurns,
      setBusy,
    });
  }, [sidebarChatIds, setBusy, setRunningTurns]);

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
    // Let the click paint before the project list is read. A chat that is already
    // open is not fetched again, so switching back does not freeze the window.
    const timer = window.setTimeout(() => {
      void reloadConversations(workspace).catch((e) => setFlash({ kind: "err", text: String(e) }));
    }, 0);
    return () => window.clearTimeout(timer);
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
    const apply = (fromResize: boolean) => {
      const next = chatBottomPadding(el.getBoundingClientRect().height);
      if (fromResize) {
        const scrollerEl = scroller.current;
        const top = applyComposerPadResize(scrollerEl, next, stickToBottomRef.current);
        if (scrollerEl && top != null && scrollerEl.scrollTop !== top) {
          holdFollow();
          scrollerEl.scrollTop = top;
        }
      }
      setComposerPad((prev) => (prev === next ? prev : next));
    };
    apply(false);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => apply(true));
    ro.observe(el);
    return () => ro.disconnect();
  }, [editor.focus, showSettings, showUsage, showDocs, showServers, activeId, holdFollow]);

  /** True while a prepend is writing scrollTop. That event is not the user leaving the bottom. */
  const scrollAdjustRef = useRef(false);
  const holdScrollForOlder = useCallback(() => {
    const el = scroller.current;
    if (!el) return null;
    // Reveals only happen at the top. A short page is also near the bottom, and the pin would jump.
    stickToBottomRef.current = false;
    scrollAdjustRef.current = true;
    // The prepend's resize pin runs in this frame. Follow again only after that paint.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollAdjustRef.current = false;
        const node = scroller.current;
        const id = activeIdRef.current;
        if (!node || !id || !transcriptOnScreen(id)) return;
        const near = isNearBottom(node);
        stickToBottomRef.current = near;
        rememberChatScroll(id, node.scrollTop, near);
      });
    });
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
  }, []);

  const scrollSettledFor = useRef("");
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && activeId && scrollSettledFor.current !== activeId) {
      if (!transcriptOnScreen(activeId)) {
        // The loading shell clamps scrollTop. That is not this chat's position, and it must not pin.
        stickToBottomRef.current = false;
      } else {
        const restored = restoreChatScroll(el, chatScrollFor(activeId), chatScrollNearBottom(activeId));
        if (el.scrollTop !== restored.scrollTop) el.scrollTop = restored.scrollTop;
        stickToBottomRef.current = restored.stick;
        scrollSettledFor.current = activeId;
      }
    }
    const scrollerEl = scroller.current;
    if (!scrollerEl) return;
    let frame = 0;
    // One jump to the end. Streaming must not ease across frames.
    const pin = () => {
      if (scrollAdjustRef.current) return;
      if (!activeId || scrollSettledFor.current !== activeId || !stickToBottomRef.current) return;
      holdFollow();
      pinChatToEnd(scroller.current, true);
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
  }, [messages, pendingShell, openingId, pendingByChat, activeId, editor.focus, composerPad, holdFollow]);

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
    allProjectGroups,
    messages,
    activeId,
    runningId,
    runningTurns,
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
    runTurn: (ws, id, next, after) => runTurnRef.current(ws, id, next, after),
    scroller,
    runningWsRef,
    modelRef,
    workspaceRef,
    activeIdRef,
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
    setAllProjectGroups,
    setMessages,
    setActiveId,
    setRunningId,
    setEditor,
    setDirtyFiles,
    setPendingClosePath,
    setFolderOpen,
    closeOverlays,
    dismissProjectSettings,
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
    setOpenTabs: (action) => {
      setOpenStrip((prev) => {
        const next = typeof action === "function" ? action(prev.items) : action;
        return next === prev.items ? prev : { ...prev, items: next };
      });
    },
    openTabs: openStrip.items,
    tabHomesRef,
    rememberTabHome: (id: string, path: string) => {
      if (!id || !path) return;
      const current = tabHomesRef.current[id];
      if (current === path) return;
      // A chat already filed under another project stays there. A different
      // spelling of the same folder is replaced, so the lowercase path does not stick.
      if (current && projectKey(current) !== projectKey(path)) return;
      tabHomesRef.current = { ...tabHomesRef.current, [id]: path };
      setOpenStrip((prev) =>
        prev.homes[id] === path ? prev : { ...prev, homes: { ...prev.homes, [id]: path } },
      );
    },
    paintedChatsRef,
    editorRef,
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
    mentionProjects,
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
    adoptWorktreeName: (ws, branch) => void libraryRef.current?.adoptWorktreeName(ws, branch),
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
    shownMessagesRef: library.shownMessages,
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
    forgetProjectRow,
    applyWorkspace,
    assignDraftProject,
    startNewChat,
    openSidebarChat,
    openProjectFromSidebar,
    switchToProject,
    rememberOpenedProject,
    openChat,
    toggleSubagent,
    removeChat,
    archiveChat,
    archiveChats,
    reorderChats,
  } = library;

  const worktreeTick = useSyncExternalStore(subscribeWorktreeLists, worktreeNameRevision, worktreeNameRevision);
  useEffect(() => {
    if (activeId && messages.length) paintedChatsRef.current.add(activeId);
  }, [activeId, messages]);
  useEffect(() => {
    if (!workspace || !activeId) return;
    setOpenStrip((prev) => {
      const items = revealTabChat(prev.items, activeId);
      const homes = prev.homes[activeId] ? prev.homes : { ...prev.homes, [activeId]: workspace };
      if (items === prev.items && homes === prev.homes) return prev;
      return { items, homes };
    });
  }, [workspace, activeId]);
  const codeTabOpen = editor.tabs.length > 0;
  const tabItems = withCodeTab(openStrip.items, codeTabOpen);
  useEffect(() => {
    setOpenStrip((prev) => {
      const next = groupTabsByProject(prev.items, prev.homes);
      return next === prev.items ? prev : { ...prev, items: next };
    });
  }, [openStrip.items, openStrip.homes]);
  useEffect(() => {
    setOpenStrip((prev) => {
      const next = withCodeTab(prev.items, codeTabOpen);
      return next === prev.items ? prev : { ...prev, items: next };
    });
  }, [codeTabOpen]);
  useEffect(() => {
    saveOpenTabs(stripToStored(tabItems, openStrip.homes));
  }, [tabItems, openStrip.homes]);
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
    if (!activeTabKey) return;
    saveActiveTab(activeTabKey);
  }, [activeTabKey]);
  const restoredTab = useRef(false);
  useEffect(() => {
    if (!workspace || !activeId || restoredTab.current) return;
    restoredTab.current = true;
    const saved = loadActiveTab();
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
    void worktreeTick;
    const key = projectKey(workspace);
    if (seenChats.current.key !== key) seenChats.current = { key, ids: new Set() };
    const known = keptTabChatIds(workspace, conversations, chatIdsInTabs(openStrip.items));
    const seen = seenChats.current.ids;
    setOpenStrip((prev) => {
      const next = retainOpenTabs(prev.items, prev.homes, workspace, known, seen);
      const same = next.length === prev.items.length && next.every((item, index) => item === prev.items[index]);
      return same ? prev : { ...prev, items: next };
    });
    known.forEach((id) => seen.add(id));
  }, [workspace, conversations, allProjectGroups, worktreeTick, openStrip.items]);
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
    const home = openStrip.homes[sideChatId] || workspace;
    const key = `${projectKey(home)}:${sideChatId}`;
    if (sidePrepared.current === key) return;
    sidePrepared.current = key;
    let gone = false;
    const remote = allProjectGroups.some((group) => group.remote && isSameProject(group.path, home));
    const load = remote ? api.getHostedConversation(home, sideChatId) : api.getConversation(home, sideChatId);
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
  }, [workspace, sideChatId, openStrip.homes, allProjectGroups]);
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
    void worktreeTick;
    // The open list is empty until the project finishes loading. The sidebar
    // already has this project's titles, so the strip does not say "Chat" first.
    const row =
      conversations.find((item) => item.id === id) ??
      projectTabChats(workspace).find((item) => item.id === id) ??
      allProjectGroups.flatMap((group) => group.conversations).find((item) => item.id === id);
    const title = row?.title?.trim() || tabTitleFor(id) || "Chat";
    rememberTabTitle(id, title);
    return {
      id,
      title,
      running: chatHasRunningTurn(runningTurns, id),
    };
  });

  const closeChatTab = useCallback(
    (id: string) => {
      if (!id) return;
      const result = closeTabChat(openStrip.items, id);
      if (!result.removed) return;
      setOpenStrip((prev) => ({ ...prev, items: result.items }));
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
    [openStrip.items, activeId, openChat],
  );

  const closeProjectChats = useCallback(
    (ids: string[]) => {
      const items = closeTabChats(openStrip.items, ids);
      if (items === openStrip.items) return;
      const before = chatIdsInTabs(openStrip.items);
      const after = chatIdsInTabs(items);
      setOpenStrip((prev) => ({ ...prev, items }));
      for (const id of ids) {
        if (!id || !before.includes(id)) continue;
        forgetSplitPane(id);
        forgetChatScroll(id);
      }
      setTabMenu(null);
      if (!ids.includes(activeId)) return;
      const next = chatAfterClosing(before, after, activeId);
      if (next) {
        void openChat(next);
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
    [openStrip.items, activeId, openChat],
  );

  const splitSelected = useCallback(
    (ids: string[]) => {
      if (ids.length < 2) return;
      setOpenStrip((prev) => {
        const next = splitSelectedChats(prev.items, ids, undefined, prev.homes);
        return next === prev.items ? prev : { ...prev, items: next };
      });
      setTabMenu(null);
      setEditor((prev) => (prev.focus === "chat" ? prev : { ...prev, focus: "chat" }));
    },
    [],
  );

  const moveChatTab = useCallback((fromKey: string, toKey: string) => {
    setOpenStrip((prev) => {
      const next = moveTabItem(prev.items, fromKey, toKey);
      return next === prev.items ? prev : { ...prev, items: next };
    });
  }, []);

  const setSplitShare = useCallback((groupId: string, share: number) => {
    if (!groupId) return;
    setOpenStrip((prev) => {
      const next = setSplitShareItems(prev.items, groupId, share);
      return next === prev.items ? prev : { ...prev, items: next };
    });
  }, []);

  const splitChat = useCallback(
    (id: string) => {
      if (!id) return;
      setOpenStrip((prev) => {
        const next = splitChatTab(prev.items, id, undefined, prev.homes);
        return next === prev.items ? prev : { ...prev, items: next };
      });
      setTabMenu(null);
      setEditor((prev) => (prev.focus === "chat" ? prev : { ...prev, focus: "chat" }));
    },
    [],
  );

  const unsplitChat = useCallback((groupId: string) => {
    if (!groupId) return;
    setOpenStrip((prev) => {
      const next = unsplitGroup(prev.items, groupId);
      return next === prev.items ? prev : { ...prev, items: next };
    });
    setTabMenu(null);
    clearSecondaryLiveStream();
  }, []);

  const revealSplitRef = useRef<(id: string) => boolean>(() => false);
  revealSplitRef.current = (id: string) => {
    if (!id) return false;
    if (!splitGroupForChat(openStrip.items, id)) return false;
    setEditor((prev) => (prev.focus === "chat" ? prev : { ...prev, focus: "chat" }));
    const next = focusSplitChat(openStrip.items, id);
    if (next !== openStrip.items) setOpenStrip((prev) => ({ ...prev, items: next }));
    if (id !== activeId) void openChat(id, next);
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
      const group = openStrip.items.find((item) => item.kind === "split" && item.group.id === groupId);
      if (!group || group.kind !== "split") return;
      const id = group.group.chatIds[pane];
      const next = focusSplitPaneItems(openStrip.items, groupId, pane);
      if (next !== openStrip.items) setOpenStrip((prev) => ({ ...prev, items: next }));
      // Pass the focused tabs in. State has not committed yet, and openChat must
      // see this chat as already on screen so it does not fetch it and show Loading….
      if (id && id !== activeId) void openChat(id, next);
    },
    [openStrip.items, activeId, openChat],
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
      closeOverlays();
      setEditor((prev) => {
        const next = mode === "preview" ? previewEditorTab(prev, path) : pinEditorTab(prev, path);
        return setEditorFileView(next, path, view);
      });
    },
    [closeOverlays],
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
    closeOverlays();
    setEditor((prev) => pinEditorTab(prev, mcpEditorPath(server.source)));
  }, [closeOverlays]);

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
      closeOverlays();
      const path = skill.source.startsWith("~/") ? skillEditorPath(skill.source) : skill.source;
      setEditor((prev) => pinEditorTab(prev, path));
    },
    [closeOverlays],
  );

  const showLanding = false;
  const chatAcceptsDrop =
    !showSettings && !showUsage && !showDocs && !showServers && (showLanding || editor.focus !== "file");
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
          const images = event.payload.type === "enter" ? attachmentPathsFromDrop(event.payload.paths) : null;
          if (images && images.length === 0) {
            setFileDrag(false);
            return;
          }
          const chatId = dropChatAt(event.payload.position.x, event.payload.position.y);
          // A miss between the field and the thumbnails used to clear the hint, then
          // the next move brought it back. That was the sway while looking for a drop.
          if (chatId) setFileDrag(chatId);
          else if (event.payload.type === "enter") setFileDrag(false);
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
    if (showLanding || showSettings || showUsage || showDocs || showServers || editor.focus === "file") return;
    // A split gives the focused chat its own scroller. The window ref is empty then,
    // and that pane follows itself. This listener is only the single-chat column.
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      if (followingRef.current || scrollAdjustRef.current) return;
      const id = activeIdRef.current;
      // The shell is shorter than the saved offset. Its clamped scrollTop is not where the user was.
      if (!id || !transcriptOnScreen(id)) return;
      const near = isNearBottom(el);
      stickToBottomRef.current = near;
      rememberChatScroll(id, el.scrollTop, near);
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
  }, [showLanding, showSettings, showUsage, showDocs, showServers, editor.focus, splitChatIds.join("|")]);

  const openTodoSig = useMemo(() => todoSignature(messages as ChatMessage[]), [messages]);
  // Same todos keep the same badge object, so a stream token does not rebuild the sidebar.
  const openTodoBadge = useMemo(
    () => sidebarTodoBadge(todosInLatestTurn(messages as ChatMessage[])),
    [openTodoSig],
  );
  const sidebarRef = useRef<SidebarSlice | null>(null);
  if (!sidebarRef.current) sidebarRef.current = {
    activeId,
    allProjectGroups,
    archiveChat,
    archiveChats,
    collapsedProjects,
    conversations,
    deleteProjectFromSidebar,
    forgetProjectRow,
    legacyProjectsRoot,
    openTodoBadge,
    openChat,
    openListedChat,
    openingId,
    openProjectFromSidebar,
    switchToProject,
    rememberOpenedProject,
    openProjectSettings,
    openSidebarChat,
    projectSettings,
    projectsRoot,
    removeChat,
    setProjectMenu,
    reorderChats,
    reorderProjects,
    runningTurns,
    unseenFinished,
    showSettings,
    showUsage,
    showDocs,
    closeSettings,
    closeDocs,
    sidebarReady,
    startNewChat,
    toggleProjectCollapsed,
    workspace,
  };
  const sidebar = sidebarRef.current;
  const sidebarChanged =
    sidebar.activeId !== activeId ||
    sidebar.allProjectGroups !== allProjectGroups ||
    sidebar.collapsedProjects !== collapsedProjects ||
    sidebar.conversations !== conversations ||
    sidebar.legacyProjectsRoot !== legacyProjectsRoot ||
    sidebar.openTodoBadge !== openTodoBadge ||
    sidebar.openingId !== openingId ||
    sidebar.projectSettings !== projectSettings ||
    sidebar.projectsRoot !== projectsRoot ||
    sidebar.runningTurns !== runningTurns ||
    sidebar.unseenFinished !== unseenFinished ||
    sidebar.setProjectMenu !== setProjectMenu ||
    sidebar.showSettings !== showSettings ||
    sidebar.showUsage !== showUsage ||
    sidebar.showDocs !== showDocs ||
    sidebar.sidebarReady !== sidebarReady ||
    sidebar.workspace !== workspace;
  if (sidebarChanged) {
    sidebarRef.current = {
      ...sidebar,
      activeId,
      allProjectGroups,
      archiveChat,
      archiveChats,
      collapsedProjects,
      conversations,
      deleteProjectFromSidebar,
      forgetProjectRow,
      legacyProjectsRoot,
      openTodoBadge,
      openChat,
      openListedChat,
      openingId,
      openProjectFromSidebar,
      switchToProject,
      rememberOpenedProject,
      openProjectSettings,
      openSidebarChat,
      projectSettings,
      projectsRoot,
      removeChat,
      setProjectMenu,
      reorderChats,
      reorderProjects,
      runningTurns,
      unseenFinished,
      showSettings,
      showUsage,
      showDocs,
      closeSettings,
      closeDocs,
      sidebarReady,
      startNewChat,
      toggleProjectCollapsed,
      workspace,
    };
  } else if (sidebarRef.current) {
    const live = sidebarRef.current;
    live.archiveChat = archiveChat;
    live.archiveChats = archiveChats;
    live.deleteProjectFromSidebar = deleteProjectFromSidebar;
    live.forgetProjectRow = forgetProjectRow;
    live.openChat = openChat;
    live.openListedChat = openListedChat;
    live.openProjectFromSidebar = openProjectFromSidebar;
    live.switchToProject = switchToProject;
    live.rememberOpenedProject = rememberOpenedProject;
    live.openProjectSettings = openProjectSettings;
    live.openSidebarChat = openSidebarChat;
    live.removeChat = removeChat;
    live.reorderChats = reorderChats;
    live.reorderProjects = reorderProjects;
    live.startNewChat = startNewChat;
    live.toggleProjectCollapsed = toggleProjectCollapsed;
    live.closeSettings = closeSettings;
    live.closeDocs = closeDocs;
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
    tabHomes: openStrip.homes,
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
    closeProjectChats,
    closeFileTab,
    closePendingEdit,
    closeOverlays,
    closeProjectSettings,
    closeServers,
    closeSettings,
    closeUsage,
    closeDocs,
    collapsedProjects,
    composerDockRef,
    composerPad,
    holdScrollForOlder,
    contextWindow,
    conversations,
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
    mcpBusy,
    mcpServers,
    messages,
    model,
    models,
    onSidebarResizeStart,
    openChat,
    opened,
    openFolder,
    openingId,
    openProjectFromSidebar,
    openProjectSettings,
    openServers,
    openSettings,
    openSidebarChat,
    openUsage,
    openDocs,
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
    overlay,
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
    archiveChats,
    removeChat,
    removePendingAt,
    reorderChats,
    reorderProjects,
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
    setPendingDeleteProject,
    setProjectMenu,
    settingsTab,
    setSettingsTab,
    setSidebarWidth,
    bumpFiles,
    showLanding,
    showServers,
    showSettings,
    showUsage,
    showDocs,
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
