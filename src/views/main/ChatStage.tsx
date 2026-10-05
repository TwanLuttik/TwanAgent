import { DevEditor } from "../../components/DevEditor";
import { DevWorkspace } from "../../components/DevWorkspace";
import { GrokTerminal } from "../../components/GrokTerminal";
import { McpDock } from "../../components/McpDock";
import { SkillDock } from "../../components/SkillDock";
import { ConversationDocks, SubagentDock } from "../../components/SubagentDock";
import { ActivityStatus, ChatTranscript, DropImagesHint, PendingUserMessage } from "../../components/ChatTranscript";
import { conversationActivityLabel, folderName } from "../../lib/dev";
import { chatHasRunningTurn, runningTurnStartedAt } from "../../lib/dev-turn";
import { contextWindowChoices, contextWindowLabel } from "../../lib/dev-context";
import {
  editorFileView,
  focusEditor,
  markdownViewForTab,
  pinEditorTab,
  selectChatTab,
  selectEditorTab,
  setEditorMarkdownView,
} from "../../lib/dev-editor";
import { permissionLabel } from "../../lib/dev-permission";
import { parseConversationKind } from "../../lib/dev-terminal-chat";
import { draftForChat, setDraftForChat } from "../../lib/dev-turn";
import { appendSelectionToDraft } from "../../lib/editor-selection";
import { loadMarkdownOpenMode, saveComposerDraft } from "../../lib/prefs";
import { ProjectSettingsView } from "../ProjectSettingsView";
import { SettingsView } from "../SettingsView";
import { UsageView } from "../UsageView";
import { CenterTabs } from "../dev/DevChrome";
import { useMain } from "./context";
import { SessionComposer } from "./SessionComposer";

export function ChatStage() {
  const {
    activeId,
    closeFileTab,
    closeProjectSettings,
    closeSettings,
    closeUsage,
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
    projectSettings,
    reloadRuntime,
    setDirtyFiles,
    setDrafts,
    setEditor,
    setShowSettings,
    setShowUsage,
    bumpFiles,
    chatTabs,
    closeChatTab,
    showSettings,
    showUsage,
    tick,
    workspace,
  } = useMain();
  const fullPage = Boolean(showSettings || showUsage || projectSettings);
  const chatKind = parseConversationKind(conversations.find((row: { id: string; kind?: string }) => row.id === activeId)?.kind);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-start" data-tauri-drag-region>
        {!fullPage ? (
          <CenterTabs
            editor={editor}
            chats={chatTabs}
            activeChatId={activeId}
            onChat={(id) => {
              setEditor((prev: typeof editor) => selectChatTab(prev));
              if (id !== activeId) void openChat(id);
            }}
            onCloseChat={closeChatTab}
            onCode={() => setEditor((prev: typeof editor) => focusEditor(prev))}
          />
        ) : (
          <div className="min-w-0 flex-1" data-tauri-drag-region />
        )}
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-tl-[12px] border border-r-0 border-b-0 border-line/35 bg-canvas">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showSettings ? (
            <SettingsView
              embedded
              initialTab="grok"
              permission={permission}
              onPermission={pickPermission}
              onKeyChange={reloadRuntime}
              onClose={folderOpen ? undefined : closeSettings}
            />
          ) : projectSettings ? (
            <ProjectSettingsView
              name={projectSettings.name}
              path={projectSettings.path}
              onClose={folderOpen ? undefined : closeProjectSettings}
            />
          ) : showUsage ? (
            <UsageView onClose={folderOpen ? undefined : closeUsage} />
          ) : editor.focus === "file" && editor.activePath && opened ? (
            <DevEditor
              workspace={workspace}
              path={editor.activePath}
              tick={tick}
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
          ) : (
            <ChatColumn />
          )}
        </div>
        {workspace && opened && !fullPage ? (
          <DevWorkspace
            workspace={workspace}
            tick={tick}
            selectedPath={editor.activePath}
            onOpenFile={openWorkspaceFile}
            onRefresh={bumpFiles}
          />
        ) : null}
      </div>
    </div>
  );
}

function ChatColumn() {
  const {
    activeId,
    answerShell,
    beginPendingEdit,
    closePendingEdit,
    composerDockRef,
    composerPad,
    contextWindow,
    editingPending,
    editMcpServer,
    editSkill,
    effort,
    expandedAgents,
    fileDrag,
    holdScrollForOlder,
    liveTools,
    mcpBusy,
    mcpServers,
    mentionFiles,
    messages,
    model,
    models,
    openingId,
    pendingShell,
    permission,
    queued,
    reauthMcpServer,
    removePendingAt,
    runningActivity,
    runningTurns,
    savePendingEdit,
    scroller,
    setExpandedAgents,
    skillBusy,
    skills,
    streamReasoning,
    streamText,
    subagents,
    toggleMcpServer,
    toggleSkill,
    turnStartedAt,
    workspace,
  } = useMain();
  const current = models.find((row: { id: string; name: string; context_windows?: number[]; context_window?: number; efforts: { id: string; label: string }[] }) => row.id === model);
  const activeRunning = chatHasRunningTurn(runningTurns, activeId);
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ConversationDocks align="end">
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
              onToggle={(id) => setExpandedAgents((prev: Record<string, boolean>) => ({ ...prev, [id]: !prev[id] }))}
            />
          </ConversationDocks>
        ) : null}
        {fileDrag ? <DropImagesHint /> : null}
        <div ref={scroller} className="no-scrollbar absolute inset-0 overflow-auto [overflow-anchor:none]">
          <div
            className="relative mx-auto w-full min-w-0 max-w-[720px] px-6 pt-5"
            style={{ paddingBottom: composerPad }}
          >
            <div className="mb-5">
              <div className="truncate text-[15px] font-semibold">
                {workspace ? folderName(workspace) : "TwanAgent"}
              </div>
              <div className="truncate text-[12px] text-muted">
                {current?.name ?? "Grok"}
                {contextWindow > 0 &&
                contextWindowChoices(current?.context_windows, current?.context_window).includes(contextWindow)
                  ? ` · ${contextWindowLabel(contextWindow)}`
                  : ""}
                {effort ? ` · ${current?.efforts.find((row: { id: string }) => row.id === effort)?.label ?? effort}` : ""}
                {` · ${permissionLabel(permission)}`}
                {workspace ? ` · ${workspace}` : ""}
              </div>
            </div>
            {messages.length === 0 && !streamText && !streamReasoning && !activeRunning && queued.length === 0 && (
              <p className="m-0 text-center text-[13px] text-muted">
                Ask Grok to inspect, edit, or run something in this folder.
              </p>
            )}
            <ChatTranscript
              messages={messages}
              streamText={streamText}
              streamReasoning={streamReasoning}
              liveTools={liveTools}
              busy={activeRunning}
              conversationId={activeId}
              mentionFiles={mentionFiles}
              onLoadOlder={holdScrollForOlder}
            />
            {openingId && !activeRunning ? <ActivityStatus label="Loading…" /> : null}
            {activeRunning && !pendingShell && (
              <ActivityStatus
                label={conversationActivityLabel(runningTurns[activeId]?.activity ?? runningActivity)}
                startedAt={runningTurnStartedAt(runningTurns, activeId) || turnStartedAt}
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
            {queued.map((item: { text: string; images?: [] }, i: number) => (
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
          </div>
        </div>
        <div ref={composerDockRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
          <div className="h-16 bg-gradient-to-t from-canvas from-15% to-transparent" aria-hidden />
          <div className="pointer-events-auto bg-canvas px-6 pb-3">
            <div className="mx-auto w-full min-w-0 max-w-[720px]">
              <SessionComposer placement="chat" />
            </div>
          </div>
        </div>
      </div>
    );
}
