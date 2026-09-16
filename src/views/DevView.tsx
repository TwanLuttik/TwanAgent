import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { ConversationList } from "../components/ConversationList";
import { DevComposer } from "../components/DevComposer";
import { DevEditor } from "../components/DevEditor";
import { DevWorkspace } from "../components/DevWorkspace";
import { GrokTerminal } from "../components/GrokTerminal";
import { Flash } from "../components/Flash";
import { FolderDialog } from "../components/FolderDialog";
import { SpaceCorner } from "../components/SpaceCorner";
import { SubagentDock } from "../components/SubagentDock";
import { FileIcon } from "../components/FileIcon";
import { Symbol } from "../components/Symbol";
import { headerBarClass, WindowButtons } from "../components/WindowButtons";
import { completeTurn } from "../lib/dev-agent";
import { applySubagentEvent, type SubagentRecord } from "../lib/dev-subagent";
import {
  conversationTitleFrom,
  folderName,
  latestAssistantPreview,
  liveTranscriptItems,
  moveById,
  newConversationId,
  nowIso,
  toolActivityLabel,
  type ChatMessage,
} from "../lib/dev";
import {
  conversationDraft,
  parseConversationKind,
  type ConversationKind,
} from "../lib/dev-terminal-chat";
import { terminalSessions } from "../lib/dev-terminal-sessions";
import {
  closeEditorTab,
  editorTabTitle,
  emptyEditor,
  markdownViewForTab,
  pinEditorTab,
  previewEditorTab,
  requestCloseEditorTab,
  selectChatTab,
  selectEditorTab,
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
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState("");
  const [streamText, setStreamText] = useState("");
  const [liveTools, setLiveTools] = useState<string[]>([]);
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
  const scroller = useRef<HTMLDivElement>(null);
  const draft = draftForChat(drafts, activeId);

  const setDraft = useCallback((text: string) => {
    setDrafts((prev) => setDraftForChat(prev, activeId, text));
  }, [activeId]);

  const ready = Boolean(runtime?.ready);
  const models = runtime?.models ?? [];

  const reloadConversations = useCallback(async (ws: string, preferId?: string) => {
    if (!ws) {
      setConversations([]);
      setActiveId("");
      setMessages([]);
      return;
    }
    const rows = await api.devListConversations(ws);
    setConversations(rows);
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

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, pendingShell]);

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
    setFolderOpen(false);
  }

  async function startNewChat(kind: ConversationKind = "chat") {
    setShowSettings(false);
    setSubagents([]);
    setExpandedAgents({});
    if (!workspace) {
      setFolderOpen(true);
      return;
    }
    const conv = conversationDraft(kind, newConversationId(), nowIso());
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
      },
      ...rows,
    ]);
  }

  async function openChat(id: string) {
    setShowSettings(false);
    if (!workspace || id === activeId) return;
    setSubagents([]);
    setExpandedAgents({});
    if (runningId === id && turnMessagesRef.current) {
      setActiveId(id);
      setMessages(turnMessagesRef.current);
      saveDevConversation(workspace, id);
      return;
    }
    setStreamText("");
    setLiveTools([]);
    const full = await api.devGetConversation(workspace, id);
    setActiveId(id);
    setMessages((full.messages as ChatMessage[]) ?? []);
    saveDevConversation(workspace, id);
  }

  async function removeChat(id: string) {
    if (!workspace) return;
    deletedIdsRef.current.add(id);
    if (runningId === id) abortRef.current?.abort();
    await terminalSessions.dispose(id);
    await api.devDeleteConversation(workspace, id);
    if (activeId === id) {
      saveDevConversation(workspace, "");
      await reloadConversations(workspace);
    } else {
      setConversations((rows) => rows.filter((r) => r.id !== id));
    }
  }

  async function persist(next: ChatMessage[], id: string, ws = workspace) {
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
      messages: next,
    });
    setConversations((rows) => {
      const next = {
        id,
        title,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        kind,
      };
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) return [next, ...rows];
      return rows.map((r, i) => (i === idx ? { ...r, ...next } : r));
    });
  }

  async function reorderChats(fromId: string, toId: string) {
    const next = moveById(conversations, fromId, toId);
    if (next === conversations) return;
    setConversations(next);
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
      saveDevConversation(ws, id);
    }
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDrafts((prev) => setDraftForChat(prev, id, ""));
    setBusy(true);
    setRunningId(id);
    setStreamText("");
    setLiveTools([]);
    turnMessagesRef.current = next;
    const ac = new AbortController();
    abortRef.current = ac;
    const visible = () => turnAppliesToChat(id, activeIdRef.current);
    try {
      const done = await completeTurn({
        workspace: ws,
        messages: next,
        model,
        effort,
        allowSpawn: true,
        onDelta: (chunk) => {
          if (visible()) setStreamText((s) => s + chunk);
        },
        onError: (err) => {
          if (visible()) setFlash({ kind: "err", text: err });
        },
        confirmShell,
        getPermission: () => permissionRef.current,
        onTool: (call) => {
          if (call.name === "spawn_subagent") return;
          if (visible()) setLiveTools((rows) => [...rows, toolActivityLabel(call)]);
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
          if (!visible()) return;
          setMessages(nextMessages);
          setStreamText("");
        },
        onRefresh: () => setTick((n) => n + 1),
        signal: ac.signal,
      });
      turnMessagesRef.current = done;
      if (visible()) {
        setMessages(done);
        setStreamText("");
        setLiveTools([]);
      }
      await persist(done, id, ws);
    } catch (e) {
      if (visible()) setFlash({ kind: "err", text: String(e) });
    } finally {
      abortRef.current = null;
      turnMessagesRef.current = null;
      setBusy(false);
      setRunningId("");
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

  const showLanding =
    !showSettings && messages.length === 0 && conversations.length === 0 && !busy && !streamText;

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
          {conversations.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-muted">{workspace ? "No chats yet" : "Open a folder"}</p>
          ) : (
            <ConversationList
              conversations={conversations}
              activeId={activeId}
              runningId={runningId}
              runningPreview={latestAssistantPreview(messages, streamText, liveTools)}
              showSettings={showSettings}
              onOpen={(id) => void openChat(id)}
              onDelete={(id) => void removeChat(id)}
              onReorder={(fromId, toId) => void reorderChats(fromId, toId)}
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
        <div className={`flex shrink-0 items-center gap-2 px-2 ${headerBarClass()}`} data-tauri-drag-region>
          {!showSettings ? (
            <CenterTabs
              editor={editor}
              dirtyFiles={dirtyFiles}
              pendingClosePath={pendingClosePath}
              chatKind={parseConversationKind(conversations.find((c) => c.id === activeId)?.kind)}
              onChat={() => setEditor((prev) => selectChatTab(prev))}
              onFile={(path) => setEditor((prev) => selectEditorTab(prev, path))}
              onPinFile={(path) => setEditor((prev) => pinEditorTab(prev, path))}
              onCloseFile={closeFileTab}
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
                  markdownView={markdownViewForTab(
                    editor.activePath,
                    loadMarkdownOpenMode(),
                    editor.tabs.find((tab) => tab.path === editor.activePath)?.markdownView,
                  )}
                  onMarkdownView={(mode) =>
                    setEditor((prev) => setEditorMarkdownView(prev, editor.activePath ?? "", mode))
                  }
                  onDirty={(path, dirty) => {
                    setDirtyFiles((prev) => (prev[path] === dirty ? prev : { ...prev, [path]: dirty }));
                    if (dirty) setEditor((prev) => pinEditorTab(prev, path));
                  }}
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
                  <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-auto">
                    <div className="mx-auto w-full min-w-0 max-w-[720px] px-6 py-5">
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
                      {liveTranscriptItems(messages, streamText, liveTools).map((item, i) => (
                        <TranscriptBlock key={i} item={item} />
                      ))}
                      {busy && !streamText && liveTools.length === 0 && !pendingShell && (
                        <div className="mb-3 text-[11px] text-muted/55">Working…</div>
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
                  <div className="shrink-0 border-t border-line">
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
              onOpenFile={(path, mode) => {
                setShowSettings(false);
                setEditor((prev) =>
                  mode === "preview" ? previewEditorTab(prev, path) : pinEditorTab(prev, path),
                );
              }}
              onRefresh={() => setTick((n) => n + 1)}
            />
          ) : null}
        </div>
      </div>
    </div>
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
  dirtyFiles,
  pendingClosePath,
  chatKind,
  onChat,
  onFile,
  onPinFile,
  onCloseFile,
}: {
  editor: EditorState;
  dirtyFiles: Record<string, boolean>;
  pendingClosePath: string | null;
  chatKind: ConversationKind;
  onChat: () => void;
  onFile: (path: string) => void;
  onPinFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}) {
  const chatOn = editor.focus === "chat";
  const terminal = chatKind === "terminal";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist" aria-label="Main view">
        <button
          type="button"
          role="tab"
          aria-selected={chatOn}
          onClick={onChat}
          className={`flex shrink-0 items-center gap-1 rounded-[7px] px-2 py-[4px] text-[12px] ${
            chatOn ? "bg-wash-strong text-ink" : "text-muted hover:text-ink"
          }`}
        >
          <Symbol name={terminal ? "terminal" : "bubble.left"} className="size-3" />
          <span>{terminal ? "Terminal" : "Chat"}</span>
        </button>
        {editor.tabs.map((tab) => (
          <EditorFileTab
            key={tab.path}
            path={tab.path}
            preview={Boolean(tab.preview)}
            selected={editor.focus === "file" && tab.path === editor.activePath}
            dirty={Boolean(dirtyFiles[tab.path])}
            warnClose={Boolean(dirtyFiles[tab.path]) && pendingClosePath === tab.path}
            onFile={onFile}
            onPinFile={onPinFile}
            onCloseFile={onCloseFile}
          />
        ))}
      </div>
    </div>
  );
}

function EditorFileTab({
  path,
  preview,
  selected,
  dirty,
  warnClose,
  onFile,
  onPinFile,
  onCloseFile,
}: {
  path: string;
  preview: boolean;
  selected: boolean;
  dirty: boolean;
  warnClose: boolean;
  onFile: (path: string) => void;
  onPinFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!warnClose) {
      setTip(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setTip({ left: box.left + box.width / 2, top: box.bottom + 6 });
  }, [warnClose]);

  const title = editorTabTitle(path);
  return (
    <div
      ref={ref}
      className={`group flex max-w-[12rem] shrink-0 items-center rounded-[7px] ${
        selected ? "bg-wash-strong text-ink" : "text-muted hover:text-ink"
      }`}
      onMouseDown={(ev) => {
        if (ev.button === 1) ev.preventDefault();
      }}
      onAuxClick={(ev) => {
        if (ev.button !== 1) return;
        ev.preventDefault();
        ev.stopPropagation();
        onCloseFile(path);
      }}
      onDoubleClick={() => {
        if (preview) onPinFile(path);
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={
          warnClose
            ? "Needs to be saved — click again to close"
            : preview
              ? `${path} — preview, double-click to keep open`
              : path
        }
        onClick={() => onFile(path)}
        className="flex min-w-0 items-center gap-1 py-[4px] pr-0.5 pl-2 text-left text-[12px]"
      >
        <FileIcon name={path} className="size-3 shrink-0 text-muted" />
        <span className={`min-w-0 truncate ${preview ? "italic" : ""}`}>{title}</span>
        {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unsaved" /> : null}
      </button>
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={() => onCloseFile(path)}
        className={`mr-0.5 flex size-4 items-center justify-center rounded text-muted hover:bg-wash hover:text-ink ${
          selected ? "opacity-70" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <Symbol name="xmark" className="size-2.5" />
      </button>
      {warnClose && tip ? (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 w-max max-w-[13rem] -translate-x-1/2 rounded-md border border-line bg-canvas px-2 py-1 text-[11px] leading-snug text-ink shadow-card"
          style={{ left: tip.left, top: tip.top }}
        >
          Needs to be saved — click again to close
        </div>
      ) : null}
    </div>
  );
}

function TranscriptBlock({ item }: { item: ReturnType<typeof liveTranscriptItems>[number] }) {
  if (item.kind === "tools") return <ToolTrail labels={item.labels} />;
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

function ToolTrail({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <div className="mb-3 space-y-0.5 px-0.5" aria-label="Tool activity">
      {labels.map((label, i) => (
        <div key={`${label}-${i}`} className="truncate text-[11px] text-muted/55">
          {label}
        </div>
      ))}
    </div>
  );
}
