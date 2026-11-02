import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Editor } from "../../components/Editor";
import { Workspace } from "../../components/Workspace";
import { GrokTerminal } from "../../components/GrokTerminal";
import { filePaneNeedsReload } from "../../lib/pane-sessions";
import {
  editorFileView,
  focusEditor,
  markdownViewForTab,
  pinEditorTab,
  selectChatTab,
  selectEditorTab,
  setEditorMarkdownView,
} from "../../lib/editor";
import { splitGroupForChat } from "../../lib/split-pane";
import { parseConversationKind } from "../../lib/terminal-chat";
import { draftForChat, setDraftForChat } from "../../lib/turn";
import { appendSelectionToDraft } from "../../lib/editor-selection";
import { PANE_DEFAULT, PANE_MAX, PANE_MIN, loadMarkdownOpenMode, loadPaneWidth, saveComposerDraft, savePaneWidth } from "../../lib/prefs";
import { markPaneResizing, markPaneSliding, requestPaneFit } from "../../lib/terminal-fit";
import { ServersDialog } from "../../components/ServersDialog";
import { ProjectSettingsView } from "../ProjectSettingsView";
import { SettingsView } from "../SettingsView";
import { DocsView } from "../DocsView";
import { UsageView } from "../UsageView";
import { Symbol } from "../../components/Symbol";
import { isMacOS, isWindows, WindowButtons } from "../../components/WindowButtons";
import { CenterTabs } from "./AppChrome";
import { useMain, useSidebar } from "./context";
import { ChatColumn } from "./ChatColumn";
import { SplitRow } from "./SplitChatPane";

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
  const wasPaneSliding = useRef(false);
  useLayoutEffect(() => {
    markPaneSliding(paneSliding);
    if (wasPaneSliding.current && !paneSliding) requestPaneFit();
    wasPaneSliding.current = paneSliding;
    return () => markPaneSliding(false);
  }, [paneSliding]);
  useEffect(() => () => markPaneResizing(false), []);

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
      <div className="relative z-10 flex min-h-0 flex-1 rounded-tl-[12px] border border-line/35 bg-canvas">
        {/* Clip sits inside the stroke so the top-left curve is not cut off. */}
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-tl-[11px]">
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
            className={`relative min-h-0 shrink-0 self-stretch bg-canvas ${
              paneCollapsed && !paneSliding ? "" : "border-l border-line/35"
            } ${
              paneMotion && !paneResizing
                ? "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                : ""
            } ${paneSliding ? "will-change-[width]" : ""}`}
            style={{ width: paneCollapsed ? 0 : paneWidth }}
          >
            <div className="absolute inset-0 flex overflow-hidden">
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
                markPaneResizing(true);
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
                  markPaneResizing(false);
                  setPaneResizing(false);
                  paneWidthRef.current = latest;
                  setPaneWidth(latest);
                  savePaneWidth(latest);
                  requestPaneFit();
                };
                handle.addEventListener("pointermove", move);
                handle.addEventListener("pointerup", up);
                handle.addEventListener("pointercancel", up);
              }}
              onDoubleClick={() => {
                setPaneWidth(PANE_DEFAULT);
                savePaneWidth(PANE_DEFAULT);
                requestPaneFit();
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
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );
}
