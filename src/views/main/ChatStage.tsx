import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { insertCompactionEvent } from "../../lib/compact";
import type { ChatMessage } from "../../lib/core";
import { getSecondaryLiveStream, subscribeLiveStream, subscribeSecondaryLiveStream, useSecondaryLiveStream, useSecondaryLiveStreamEmpty } from "../../lib/live-stream";
import { motion } from "motion/react";
import { Editor } from "../../components/Editor";
import { Workspace } from "../../components/Workspace";
import { GrokTerminal } from "../../components/GrokTerminal";
import { McpDock } from "../../components/McpDock";
import { SkillDock } from "../../components/SkillDock";
import { ConversationDocks, SubagentDock } from "../../components/SubagentDock";
import { ActivityStatus, ChatTranscript, DropImagesHint, PendingUserMessage } from "../../components/ChatTranscript";
import { conversationActivityLabel } from "../../lib/core";
import { chatScrollFor, isNearBottom, pinChatToEnd, rememberChatScroll, stickToBottomAfterRestore } from "../../lib/chat-scroll";
import { filePaneNeedsReload } from "../../lib/pane-sessions";
import { chatHasRunningTurn, runningTurnStartedAt } from "../../lib/turn";
import { providerProfile } from "../../lib/provider";
import {
  editorFileView,
  focusEditor,
  markdownViewForTab,
  pinEditorTab,
  selectChatTab,
  selectEditorTab,
  setEditorMarkdownView,
} from "../../lib/editor";
import { rememberSplitPane, splitGroupForChat, splitPaneCache } from "../../lib/split-pane";
import { shellApprovalLabel } from "../../lib/permission";
import { PlanApproval } from "../../components/PlanApproval";
import { parseConversationKind } from "../../lib/terminal-chat";
import { draftForChat, pendingForChat, setDraftForChat, type PendingMessage } from "../../lib/turn";
import { appendSelectionToDraft } from "../../lib/editor-selection";
import { PANE_DEFAULT, PANE_MAX, PANE_MIN, loadMarkdownOpenMode, loadPaneWidth, saveComposerDraft, savePaneWidth } from "../../lib/prefs";
import { ServersDialog } from "../../components/ServersDialog";
import { ProjectSettingsView } from "../ProjectSettingsView";
import { SettingsView } from "../SettingsView";
import { DocsView } from "../DocsView";
import { UsageView } from "../UsageView";
import { useLiveStream, useLiveStreamEmpty } from "../../lib/live-stream";
import { Symbol } from "../../components/Symbol";
import { isMacOS, isWindows, WindowButtons } from "../../components/WindowButtons";
import { CenterTabs } from "./AppChrome";
import { useMain, useSidebar } from "./context";
import { SessionComposer } from "./SessionComposer";

export function ChatStage() {
  const {
    activeId,
    closeFileTab,
    closeProjectSettings,
    closeServers,
    closeSettings,
    closeUsage,
    closeDocs,
    conversations,
    dirtyFiles,
    editor,
    folderOpen,
    journeys,
    opened,
    openChat,
    openWorkspaceFile,
    pendingClosePath,
    permission,
    pickPermission,
    speechModel,
    speechModels,
    speechProgress,
    speechDownloading,
    pickSpeechModel,
    downloadSpeech,
    projectSettings,
    reloadRuntime,
    setDirtyFiles,
    setDrafts,
    setEditor,
    setShowSettings,
    setShowUsage,
    settingsTab,
    setSettingsTab,
    bumpFiles,
    chatTabs,
    tabItems,
    splitChatIds,
    tabMenu,
    setTabMenu,
    splitChat,
    splitSelected,
    moveChatTab,
    unsplitChat,
    focusSplitPane,
    closeChatTab,
    runningTurns,
    showServers,
    showSettings,
    showUsage,
    showDocs,
    paneCollapsed,
    setPaneCollapsed,
    sidebarCollapsed,
    setSidebarCollapsed,
    workspace,
  } = useMain();
  const { openProjectFromSidebar, rememberOpenedProject } = useSidebar();
  const fullPage = Boolean(showSettings || showUsage || showDocs || showServers || projectSettings);
  const [settingsAlive, setSettingsAlive] = useState(showSettings);
  if (showSettings && !settingsAlive) setSettingsAlive(true);
  const chatKind = parseConversationKind(conversations.find((row: { id: string; kind?: string }) => row.id === activeId)?.kind);
  const [paneWorkspace, setPaneWorkspace] = useState(workspace);
  // A click between chats in this project must not unmount the file pane.
  // `activeId` is empty for a frame while the next transcript loads.
  const [paneChat, setPaneChat] = useState(activeId);
  const paneProjectRef = useRef(workspace);
  const [paneWidth, setPaneWidth] = useState(loadPaneWidth);
  const paneSlotRef = useRef<HTMLDivElement>(null);
  const paneBodyRef = useRef<HTMLDivElement>(null);
  const paneWidthRef = useRef(paneWidth);
  paneWidthRef.current = paneWidth;
  // The slot stays mounted while closed so opening only changes its width.
  // Mounting it at full width on the click left the open with no start frame.
  const [paneSliding, setPaneSliding] = useState(false);
  const [paneResizing, setPaneResizing] = useState(false);
  // Off until the user opens or closes, so a pane that loads open does not slide in.
  const [paneMotion, setPaneMotion] = useState(false);
  function slidePane(collapsed: boolean) {
    const reduce =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) {
      setPaneMotion(true);
      setPaneSliding(true);
    }
    setPaneCollapsed(collapsed);
  }
  useEffect(() => {
    if (!workspace || !opened) return;
    // The same folder can come back under a canonical path. Swapping the key
    // would reset the tree and flash the loading cover.
    if (!filePaneNeedsReload(paneProjectRef.current, workspace)) return;
    paneProjectRef.current = workspace;
    setPaneWorkspace(workspace);
  }, [workspace, opened]);
  useEffect(() => {
    if (activeId) setPaneChat(activeId);
  }, [activeId]);

  return (
    <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col bg-transparent">
      <div className="chrome-tab-row relative z-10 flex h-11 shrink-0 items-stretch bg-transparent" data-tauri-drag-region>
        {sidebarCollapsed ? (
          <button
            type="button"
            aria-label="Show sidebar"
            title="Show sidebar"
            onClick={() => setSidebarCollapsed(false)}
            className={`${isMacOS() ? "ml-9 mr-2" : "ml-2"} flex size-7 shrink-0 items-center justify-center self-center rounded-[6px] text-muted hover:bg-wash hover:text-ink`}
          >
            <Symbol name="sidebar.left" className="size-3.5" />
          </button>
        ) : null}
        {!fullPage ? (
          <CenterTabs
            editor={editor}
            chats={chatTabs}
            items={tabItems}
            activeChatId={activeId}
            splitChatIds={splitChatIds}
            runningTurns={runningTurns}
            menu={tabMenu}
            onChat={(id) => {
              setEditor((prev: typeof editor) => selectChatTab(prev));
              const group = splitGroupForChat(tabItems, id);
              if (group) {
                const pane = group.chatIds[0] === id ? 0 : 1;
                focusSplitPane(group.id, pane);
                return;
              }
              if (id !== activeId) void openChat(id);
            }}
            onCloseChat={closeChatTab}
            onCode={() => setEditor((prev: typeof editor) => focusEditor(prev))}
            onMenu={setTabMenu}
            onSplit={splitChat}
            onSplitSelected={splitSelected}
            onMoveTab={moveChatTab}
            onUnsplit={unsplitChat}
            onCloseMenu={() => setTabMenu(null)}
          />
        ) : (
          <div className="min-h-11 min-w-0 flex-1 self-stretch" data-tauri-drag-region />
        )}
        {isWindows() ? <WindowButtons /> : null}
      </div>
      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden rounded-tl-[12px] border border-r-0 border-b-0 border-line/35 bg-canvas">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Settings stays mounted after the first open. Escape only hides it,
              so closing does not tear the page down or restart its checks. */}
          {showSettings || settingsAlive ? (
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              style={showSettings ? undefined : { display: "none" }}
            >
              <SettingsView
                embedded
                active={showSettings}
                tab={settingsTab}
                onTab={setSettingsTab}
                permission={permission}
                onPermission={pickPermission}
                speechModel={speechModel}
                speechModels={speechModels}
                speechProgress={speechProgress}
                speechDownloading={speechDownloading}
                onSpeechModel={pickSpeechModel}
                onSpeechDownload={downloadSpeech}
                onKeyChange={reloadRuntime}
                onClose={folderOpen || !showSettings ? undefined : closeSettings}
              />
            </div>
          ) : null}
          {projectSettings && !showSettings && !showServers ? (
            <ProjectSettingsView
              name={projectSettings.name}
              path={projectSettings.path}
              onClose={folderOpen ? undefined : closeProjectSettings}
            />
          ) : null}
          {showUsage && !showSettings && !showDocs && !showServers ? (
            <UsageView onClose={folderOpen ? undefined : closeUsage} />
          ) : null}
          {showDocs && !showSettings && !showServers ? (
            <DocsView onClose={folderOpen ? undefined : closeDocs} />
          ) : null}
          {showServers && !showSettings ? (
            <ServersDialog onClose={folderOpen ? () => undefined : closeServers} />
          ) : null}
          {/* Chat and the file editor stay mounted under settings. Closing with
              Escape only hides the page, so it does not have to rebuild them. */}
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            style={fullPage ? { display: "none" } : undefined}
          >
          {editor.focus === "file" && editor.activePath && opened ? (
            <Editor
              workspace={workspace}
              path={editor.activePath}
              fileView={editorFileView(editor.tabs.find((tab: { path: string }) => tab.path === editor.activePath))}
              markdownView={markdownViewForTab(
                editor.activePath,
                loadMarkdownOpenMode(),
                editor.tabs.find((tab: { path: string }) => tab.path === editor.activePath)?.markdownView,
              )}
              editor={editor}
              dirtyFiles={dirtyFiles}
              pendingClosePath={pendingClosePath}
              journeyTitles={Object.fromEntries(journeys.map((row: { id: string; title: string }) => [row.id, row.title]))}
              onMarkdownView={(mode) =>
                setEditor((prev: typeof editor) => setEditorMarkdownView(prev, editor.activePath ?? "", mode))
              }
              onDirty={(path, dirty) => {
                setDirtyFiles((prev: Record<string, boolean>) => (prev[path] === dirty ? prev : { ...prev, [path]: dirty }));
                if (dirty) setEditor((prev: typeof editor) => pinEditorTab(prev, path));
              }}
              onSelectTab={(path) => setEditor((prev: typeof editor) => selectEditorTab(prev, path))}
              onPinTab={(path) => setEditor((prev: typeof editor) => pinEditorTab(prev, path))}
              onCloseTab={closeFileTab}
              onSendToChat={(snippet) => {
                setShowSettings(false);
                setShowUsage(false);
                closeDocs();
                closeServers();
                closeProjectSettings();
                setEditor((prev: typeof editor) => selectChatTab(prev));
                setDrafts((prev: Record<string, string>) => {
                  const next = appendSelectionToDraft(draftForChat(prev, activeId), snippet);
                  saveComposerDraft(activeId, next);
                  return setDraftForChat(prev, activeId, next);
                });
              }}
            />
          ) : chatKind === "terminal" && workspace && opened && activeId ? (
            <GrokTerminal workspace={workspace} conversationId={activeId} active />
          ) : splitChatIds.length > 1 && editor.focus === "chat" ? (
            <SplitRow ids={splitChatIds} />
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1" data-drop-chat={activeId || undefined}>
              <ChatColumn paneClosed={paneCollapsed && !paneSliding} />
            </div>
          )}
          </div>
        </div>
        {paneWorkspace && (activeId || paneChat) && !fullPage && paneCollapsed ? (
          <button
            type="button"
            aria-label="Show files"
            title="Show files"
            onClick={() => slidePane(false)}
            className="absolute top-2 right-2 z-30 flex size-7 items-center justify-center rounded-[6px] text-muted hover:bg-wash hover:text-ink"
          >
            <Symbol name="sidebar.right" className="size-3.5" />
          </button>
        ) : null}
        {paneWorkspace && (activeId || paneChat) && !fullPage ? (
          <div
            ref={paneSlotRef}
            data-pane-sliding={paneSliding ? "" : undefined}
            onTransitionEnd={(event) => {
              if (event.target !== event.currentTarget || event.propertyName !== "width") return;
              setPaneSliding(false);
            }}
            className={`relative flex min-h-0 shrink-0 self-stretch overflow-hidden bg-canvas ${
              paneCollapsed && !paneSliding ? "" : "border-l border-line/35"
            } ${
              paneMotion && !paneResizing
                ? "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                : ""
            } ${paneSliding ? "will-change-[width]" : ""}`}
            style={{ width: paneCollapsed ? 0 : paneWidth }}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize workspace pane"
              title="Drag to resize"
              onPointerDown={(event) => {
                event.preventDefault();
                const handle = event.currentTarget;
                const slot = paneSlotRef.current;
                const body = paneBodyRef.current;
                if (!slot || !body) return;
                handle.setPointerCapture(event.pointerId);
                setPaneResizing(true);
                slot.setAttribute("data-pane-resizing", "");
                const right = slot.getBoundingClientRect().right;
                let latest = paneWidthRef.current;
                const move = (ev: PointerEvent) => {
                  latest = Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(right - ev.clientX)));
                  slot.style.width = `${latest}px`;
                  body.style.width = `${latest}px`;
                };
                const up = (ev: PointerEvent) => {
                  handle.releasePointerCapture(ev.pointerId);
                  handle.removeEventListener("pointermove", move);
                  handle.removeEventListener("pointerup", up);
                  handle.removeEventListener("pointercancel", up);
                  slot.removeAttribute("data-pane-resizing");
                  setPaneResizing(false);
                  paneWidthRef.current = latest;
                  setPaneWidth(latest);
                  savePaneWidth(latest);
                };
                handle.addEventListener("pointermove", move);
                handle.addEventListener("pointerup", up);
                handle.addEventListener("pointercancel", up);
              }}
              onDoubleClick={() => {
                setPaneWidth(PANE_DEFAULT);
                savePaneWidth(PANE_DEFAULT);
              }}
              className="group absolute inset-y-0 left-0 z-30 w-2 cursor-col-resize touch-none"
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 w-0.5 group-hover:bg-accent/30"
              />
            </div>
            <div ref={paneBodyRef} className="relative h-full min-h-0 shrink-0" style={{ width: paneWidth }}>
              <Workspace
                workspace={paneWorkspace}
                selectedPath={editor.activePath}
                onOpenFile={openWorkspaceFile}
                onRefresh={bumpFiles}
                onOpenWorkspace={(path) => {
                  rememberOpenedProject(path);
                  openProjectFromSidebar(path);
                }}
                onCollapse={() => slidePane(true)}
                pending={paneWorkspace !== workspace}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SplitRow({ ids }: { ids: string[] }) {
  const { activeId, tabItems } = useMain();
  const group = splitGroupForChat(tabItems, ids[0] ?? "");
  const share = group?.leftShare ?? 0.5;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0" style={{ width: `${share * 100}%` }} data-drop-chat={ids[0] || undefined}>
        <StableChatPane chatId={ids[0] ?? ""} active={ids[0] === activeId} />
      </div>
      {group ? <SplitDivider groupId={group.id} share={share} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1" data-drop-chat={ids[1] || undefined}>
        <StableChatPane chatId={ids[1] ?? ""} active={ids[1] === activeId} />
      </div>
    </div>
  );
}

function SplitDivider({ groupId, share }: { groupId: string; share: number }) {
  const { setSplitShare } = useMain();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(share * 100)}
      aria-label="Resize panes"
      title="Drag to resize"
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        const row = handle.parentElement;
        if (!row) return;
        handle.setPointerCapture(event.pointerId);
        const bounds = row.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          const width = bounds.width || 1;
          setSplitShare(groupId, (ev.clientX - bounds.left) / width);
        };
        const up = (ev: PointerEvent) => {
          handle.releasePointerCapture(ev.pointerId);
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      }}
      className="group relative z-20 w-1.5 shrink-0 cursor-col-resize"
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line/70 group-hover:bg-accent/50" />
    </div>
  );
}

/** One side of a split. It stays mounted when focus moves so its scroll does too. */
function StableChatPane({ chatId, active }: { chatId: string; active: boolean }) {
  if (!chatId) return null;
  return <SplitChatPane chatId={chatId} active={active} />;
}

/** The conversation sitting beside the focused one. It keeps its own scroller and input. */
function SplitChatPane({ chatId, active = false }: { chatId: string; active?: boolean }) {
  const {
    beginPendingEdit,
    closePendingEdit,
    conversations,
    editingPending,
    fileDrag,
    focusSplitPane,
    mentionFiles,
    messages: liveMessages,
    model,
    pendingByChat,
    removePendingAt,
    runningTurns,
    savePendingEdit,
    tabItems,
    workspace,
  } = useMain();
  const scroller = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const followingRef = useRef(false);
  /** False until a saved offset can actually be applied. A short first paint must not decide. */
  const settledRef = useRef(false);
  const restoredFor = useRef("");
  const [storedMessages, setStoredMessages] = useState<ChatMessage[]>(() => splitPaneCache(chatId)?.messages ?? []);
  const messages = active ? liveMessages : storedMessages;
  useEffect(() => {
    if (messages.length) rememberSplitPane(chatId, { messages });
  }, [chatId, messages]);
  useLayoutEffect(() => {
    if (restoredFor.current === chatId && settledRef.current) return;
    if (restoredFor.current !== chatId) {
      restoredFor.current = chatId;
      settledRef.current = false;
      stickRef.current = true;
    }
    const el = scroller.current;
    if (!el) return;
    const saved = chatScrollFor(chatId);
    if (saved == null) {
      settledRef.current = true;
      return;
    }
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    if (!stickToBottomAfterRestore(el, saved)) return;
    el.scrollTop = Math.min(saved, max);
    stickRef.current = isNearBottom(el);
    settledRef.current = true;
  }, [chatId, messages]);
  // Only a pane that has nothing to show yet is loading. Flipping focus must not
  // replace a transcript that is already on screen with Loading….
  const [loading, setLoading] = useState(
    () => (splitPaneCache(chatId)?.messages.length ?? 0) === 0,
  );
  const stream = useSecondaryLiveStream();
  const streamEmpty = useSecondaryLiveStreamEmpty();
  const activeRunning = chatHasRunningTurn(runningTurns, chatId);
  const queued = pendingForChat(pendingByChat, chatId);
  const centered = !loading && messages.length === 0 && !activeRunning && queued.length === 0 && streamEmpty;
  const [pad, setPad] = useState(96);

  useEffect(() => {
    if (active) return;
    let gone = false;
    const cached = splitPaneCache(chatId);
    if (cached?.messages.length) {
      setStoredMessages(cached.messages);
      rememberSplitPane(chatId, { messages: cached.messages });
    }
    const load = () => {
      void import("../../lib/tauri").then((api) =>
        api
          .getConversation(workspace, chatId)
          .then((full) => {
            if (gone) return;
            const body = (full.messages as ChatMessage[]) ?? [];
            const shown =
              full.compaction?.summary && full.compaction.through > 0
                ? insertCompactionEvent(body, full.compaction.through)
                : body;
            setStoredMessages(shown);
            // Focusing this pane reads the cache. Without this write the click
            // paints an empty new chat over the transcript that is on screen.
            rememberSplitPane(chatId, { messages: shown });
          })
          .catch(() => {
            if (!gone) setStoredMessages([]);
          })
          .finally(() => {
            if (!gone) setLoading(false);
          }),
      );
    };
    load();
    // A turn on this side keeps its messages in memory. Read them when the tail moves.
    const stop = subscribeSecondaryLiveStream(() => {
      const cached = splitPaneCache(chatId);
      if (cached) setStoredMessages(cached.messages);
      if (getSecondaryLiveStream().streamText || getSecondaryLiveStream().streamReasoning) setLoading(false);
    });
    return () => {
      gone = true;
      stop();
    };
  }, [workspace, chatId, active]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const pin = () => {
      if (!settledRef.current || !stickRef.current) return;
      followingRef.current = true;
      pinChatToEnd(el, true);
      followingRef.current = false;
    };
    const pinAfterLayout = () => {
      if (!stickRef.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        pin();
      });
    };
    pin();
    // The focused pane reads the primary stream. The other pane reads the secondary one.
    const stopStream = active ? subscribeLiveStream(pin) : subscribeSecondaryLiveStream(pin);
    const content = el.firstElementChild;
    const ro = content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(pinAfterLayout) : null;
    if (content) ro?.observe(content);
    return () => {
      followingRef.current = false;
      if (frame) cancelAnimationFrame(frame);
      stopStream();
      ro?.disconnect();
    };
  }, [active, chatId, messages, pad]);

  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => setPad(Math.max(96, Math.round(el.getBoundingClientRect().height) + 24));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [centered]);

  const group = splitGroupForChat(tabItems, chatId);
  const pane = group && group.chatIds[1] === chatId ? 1 : 0;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {fileDrag === chatId ? <DropImagesHint /> : null}
      <div
        ref={scroller}
        className="no-scrollbar absolute inset-0 overflow-auto [overflow-anchor:none]"
        onScroll={() => {
          const el = scroller.current;
          if (!el || followingRef.current) return;
          stickRef.current = isNearBottom(el);
          rememberChatScroll(chatId, el.scrollTop);
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) stickRef.current = false;
        }}
        onMouseDown={() => {
          if (group) focusSplitPane(group.id, pane as 0 | 1);
        }}
      >
        <div className="relative mx-auto w-full min-w-0 max-w-[720px] px-4 pt-5">
          <LiveTranscript
            messages={messages}
            model={model}
            centeredWithoutStream={centered}
            activeRunning={activeRunning}
            transcriptPending={!active && loading && messages.length === 0}
            conversationId={chatId}
            mentionFiles={mentionFiles}
            onLoadOlder={() => undefined}
            pendingShell={false}
            pendingPlan={false}
            activity={runningTurns[chatId]?.activity}
            startedAt={runningTurnStartedAt(runningTurns, chatId)}
            streamText={active ? undefined : stream.streamText}
            streamReasoning={active ? undefined : stream.streamReasoning}
            liveTools={active ? undefined : stream.liveTools}
            runningActivity={active ? undefined : stream.runningActivity}
          />
          {queued.map((item: PendingMessage, i: number) => (
            <PendingUserMessage
              key={`${chatId}-${i}`}
              text={item.text}
              images={item.images}
              mentionFiles={mentionFiles}
              editing={editingPending?.chatId === chatId && editingPending.index === i}
              onEdit={() => beginPendingEdit(i)}
              onSave={(text) => savePendingEdit(i, text)}
              onCancel={() => closePendingEdit(chatId)}
              onRemove={() => removePendingAt(i)}
            />
          ))}
          <div style={{ paddingBottom: centered ? 24 : pad }} />
        </div>
      </div>
      <div ref={dockRef} className={`pointer-events-none absolute inset-x-0 z-10 ${centered ? "top-[42%] -translate-y-1/2" : "bottom-0"}`}>
        <ComposerDockChrome centered={centered}>
          <SessionComposer placement="chat" chatId={chatId} />
        </ComposerDockChrome>
      </div>
      <span className="sr-only">{conversations.find((row: { id: string }) => row.id === chatId)?.title ?? ""}</span>
    </div>
  );
}

function ChatColumn({ paneClosed = false }: { paneClosed?: boolean }) {
  const {
    activeId,
    answerPlan,
    answerShell,
    beginPendingEdit,
    closePendingEdit,
    composerDockRef,
    composerPad,
    editingPending,
    editMcpServer,
    editSkill,
    expandedAgents,
    fileDrag,
    holdScrollForOlder,
    mcpBusy,
    mcpServers,
    mentionFiles,
    messages,
    model,
    openingId,
    pendingPlan,
    pendingShell,
    remoteWorkspace,
    queued,
    reauthMcpServer,
    removePendingAt,
    runningTurns,
    savePendingEdit,
    scroller,
    toggleSubagent,
    skillBusy,
    skills,
    subagents,
    toggleMcpServer,
    toggleSkill,
    turnStartedAt,
    workspace,
  } = useMain();
  const activeRunning = chatHasRunningTurn(runningTurns, activeId);
  useLayoutEffect(() => {
    const el = scroller.current;
    const saved = chatScrollFor(activeId);
    if (!el || saved == null) return;
    el.scrollTop = saved;
  }, [activeId, scroller]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    if (activeId) rememberSplitPane(activeId, { messages: messagesRef.current });
  }, [activeId, messages]);
  const transcriptPending = Boolean(openingId) && openingId === activeId && messages.length === 0;
  const centeredWithoutStream =
    !transcriptPending && messages.length === 0 && !activeRunning && queued.length === 0;
  const dock = useRef({ id: activeId, centered: centeredWithoutStream, sliding: false });
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ConversationDocks align="end" insetEnd={paneClosed}>
          <McpDock
            servers={mcpServers}
            busyName={mcpBusy}
            onToggle={(server, enabled) => void toggleMcpServer(server, enabled)}
            onEdit={(server) => void editMcpServer(server)}
            onReauth={(server) => void reauthMcpServer(server)}
          />
          <SkillDock
            skills={skills}
            busyName={skillBusy}
            onToggle={(skill, enabled) => void toggleSkill(skill, enabled)}
            onEdit={(skill) => void editSkill(skill)}
          />
        </ConversationDocks>
        {activeRunning ? (
          <ConversationDocks>
            <SubagentDock
              agents={subagents}
              expanded={expandedAgents}
              onToggle={(id) => toggleSubagent(id)}
            />
          </ConversationDocks>
        ) : null}
        {fileDrag === activeId ? <DropImagesHint /> : null}
        <div
          ref={scroller}
          onScroll={() => {
            if (scroller.current) rememberChatScroll(activeId, scroller.current.scrollTop);
          }}
          className="no-scrollbar absolute inset-0 overflow-auto [overflow-anchor:none]"
        >
          <div className="relative mx-auto w-full min-w-0 max-w-[720px] px-6 pt-5">
            <LiveTranscript
              messages={messages}
              model={model}
              centeredWithoutStream={centeredWithoutStream}
              activeRunning={activeRunning}
              transcriptPending={transcriptPending}
              conversationId={activeId}
              mentionFiles={mentionFiles}
              onLoadOlder={holdScrollForOlder}
              pendingShell={Boolean(pendingShell)}
              pendingPlan={Boolean(pendingPlan)}
              activity={runningTurns[activeId]?.activity}
              startedAt={runningTurnStartedAt(runningTurns, activeId) || turnStartedAt}
            />
            {pendingShell && (
              <div className="mb-4">
                <div className="text-[13px] text-ink">
                  {shellApprovalLabel(pendingShell.command, remoteWorkspace?.machineName)}
                </div>
                <pre className="mt-1.5 mb-2.5 overflow-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-muted">
                  {pendingShell.command}
                </pre>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent hover:bg-accent-hover"
                    onClick={() => answerShell(true)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2.5 py-1 text-[12px] text-muted hover:bg-wash hover:text-ink"
                    onClick={() => answerShell(false)}
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}
            {queued.map((item: PendingMessage, i: number) => (
              <PendingUserMessage
                key={`${activeId}-${i}`}
                text={item.text}
                images={item.images}
                mentionFiles={mentionFiles}
                editing={editingPending?.chatId === activeId && editingPending.index === i}
                onEdit={() => beginPendingEdit(i)}
                onSave={(text) => savePendingEdit(i, text)}
                onCancel={() => closePendingEdit(activeId)}
                onRemove={() => removePendingAt(i)}
              />
            ))}
            <StreamBottomPad composerPad={composerPad} centeredWithoutStream={centeredWithoutStream} />
          </div>
        </div>
        {pendingPlan ? (
          <PlanApproval
            prompt={pendingPlan.prompt}
            workspace={workspace}
            onAnswer={(decision, note) => answerPlan(decision, note)}
          />
        ) : null}
        <StreamComposerDock
          dockRef={composerDockRef}
          dock={dock}
          activeId={activeId}
          centeredWithoutStream={centeredWithoutStream}
        >
          <SessionComposer placement="chat" />
        </StreamComposerDock>
      </div>
    );
}

/** Bottom padding flips with stream emptiness, not with each token. */
function StreamBottomPad({
  composerPad,
  centeredWithoutStream,
}: {
  composerPad: number;
  centeredWithoutStream: boolean;
}) {
  const centered = useComposerCentered(centeredWithoutStream);
  return <div style={{ paddingBottom: centered ? 24 : composerPad }} />;
}

/**
 * The dock slides when the first token arrives. It subscribes only to the
 * centered boolean, so later tokens do not move the composer.
 */
function StreamComposerDock({
  dockRef,
  dock,
  activeId,
  centeredWithoutStream,
  children,
}: {
  dockRef: RefObject<HTMLDivElement | null>;
  dock: RefObject<{ id: string; centered: boolean; sliding: boolean }>;
  activeId: string;
  centeredWithoutStream: boolean;
  children: ReactNode;
}) {
  const composerCentered = useComposerCentered(centeredWithoutStream);
  if (dock.current.id !== activeId) {
    dock.current = { id: activeId, centered: composerCentered, sliding: false };
  } else if (dock.current.centered && !composerCentered) {
    dock.current.sliding = true;
  }
  dock.current.centered = composerCentered;
  return (
    <motion.div
      ref={dockRef}
      initial={false}
      animate={{ top: composerCentered ? "42%" : "100%", y: composerCentered ? "-50%" : "-100%" }}
      transition={dock.current.sliding ? { duration: 0.42, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      onAnimationComplete={() => {
        dock.current.sliding = false;
      }}
      className="pointer-events-none absolute inset-x-0 z-10"
    >
      <ComposerDockChrome centered={composerCentered}>{children}</ComposerDockChrome>
    </motion.div>
  );
}

const ComposerDockChrome = memo(function ComposerDockChrome({
  centered,
  children,
}: {
  centered: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {centered ? null : <div className="h-16 bg-gradient-to-t from-canvas from-15% to-transparent" aria-hidden />}
      <div className="pointer-events-auto bg-canvas px-6 pb-3">
        <div className="mx-auto w-full min-w-0 max-w-[720px]">{children}</div>
      </div>
    </>
  );
});

/** True while the composer should sit in the middle. The empty flag is stable across tokens. */
function useComposerCentered(centeredWithoutStream: boolean): boolean {
  const streamEmpty = useLiveStreamEmpty();
  return centeredWithoutStream && streamEmpty;
}

function LiveTranscript({
  messages,
  model,
  centeredWithoutStream,
  activeRunning,
  transcriptPending,
  conversationId,
  mentionFiles,
  onLoadOlder,
  pendingShell,
  pendingPlan,
  activity,
  startedAt,
  streamText: givenText,
  streamReasoning: givenReasoning,
  liveTools: givenTools,
  runningActivity: givenActivity,
}: {
  messages: Parameters<typeof ChatTranscript>[0]["messages"];
  model: string;
  centeredWithoutStream: boolean;
  activeRunning: boolean;
  transcriptPending: boolean;
  conversationId: string;
  mentionFiles: Parameters<typeof ChatTranscript>[0]["mentionFiles"];
  onLoadOlder: () => void;
  pendingShell: boolean;
  pendingPlan: boolean;
  activity: Parameters<typeof conversationActivityLabel>[0];
  startedAt: number;
  streamText?: string;
  streamReasoning?: string;
  liveTools?: Parameters<typeof ChatTranscript>[0]["liveTools"];
  runningActivity?: Parameters<typeof conversationActivityLabel>[0];
}) {
  const live = useLiveStream();
  const streamText = givenText ?? live.streamText;
  const streamReasoning = givenReasoning ?? live.streamReasoning;
  const liveTools = givenTools ?? live.liveTools;
  const runningActivity = givenActivity === undefined ? live.runningActivity : givenActivity;
  const showEmpty = centeredWithoutStream && !streamText && !streamReasoning;
  return (
    <>
      {showEmpty ? (
        <p className="m-0 text-center text-[13px] text-muted">
          Ask {providerProfile(model).agentName} to inspect, edit, or run something in this folder.
        </p>
      ) : null}
      <ChatTranscript
        messages={messages}
        streamText={streamText}
        streamReasoning={streamReasoning}
        liveTools={liveTools}
        busy={activeRunning}
        conversationId={conversationId}
        mentionFiles={mentionFiles}
        onLoadOlder={onLoadOlder}
      />
      {transcriptPending && !activeRunning ? <ActivityStatus label="Loading…" /> : null}
      {activeRunning && !pendingShell && !pendingPlan && (
        <ActivityStatus
          label={conversationActivityLabel(activity ?? runningActivity)}
          startedAt={startedAt}
        />
      )}
    </>
  );
}
