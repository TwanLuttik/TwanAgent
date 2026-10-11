import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { motion } from "motion/react";
import { Editor } from "../../components/Editor";
import { Workspace } from "../../components/Workspace";
import { GrokTerminal } from "../../components/GrokTerminal";
import { McpDock } from "../../components/McpDock";
import { SkillDock } from "../../components/SkillDock";
import { ConversationDocks, SubagentDock } from "../../components/SubagentDock";
import { ActivityStatus, ChatTranscript, DropImagesHint, PendingUserMessage } from "../../components/ChatTranscript";
import { conversationActivityLabel } from "../../lib/core";
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
import { shellApprovalLabel } from "../../lib/permission";
import { PlanApproval } from "../../components/PlanApproval";
import { parseConversationKind } from "../../lib/terminal-chat";
import { draftForChat, setDraftForChat } from "../../lib/turn";
import { appendSelectionToDraft } from "../../lib/editor-selection";
import { loadMarkdownOpenMode, saveComposerDraft } from "../../lib/prefs";
import { ProjectSettingsView } from "../ProjectSettingsView";
import { SettingsView } from "../SettingsView";
import { UsageView } from "../UsageView";
import { useLiveStream, useLiveStreamEmpty } from "../../lib/live-stream";
import { CenterTabs } from "./AppChrome";
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
    closeChatTab,
    runningTurns,
    showSettings,
    showUsage,
    workspace,
  } = useMain();
  const fullPage = Boolean(showSettings || showUsage || projectSettings);
  const chatKind = parseConversationKind(conversations.find((row: { id: string; kind?: string }) => row.id === activeId)?.kind);
  const [paneWorkspace, setPaneWorkspace] = useState(workspace);
  useEffect(() => {
    if (workspace && opened) setPaneWorkspace(workspace);
  }, [workspace, opened]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-start" data-tauri-drag-region>
        {!fullPage ? (
          <CenterTabs
            editor={editor}
            chats={chatTabs}
            activeChatId={activeId}
            runningTurns={runningTurns}
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
            <ChatColumn key={workspace || "none"} />
          )}
        </div>
        {paneWorkspace && !fullPage ? (
          <Workspace
            workspace={paneWorkspace}
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
  const transcriptPending = Boolean(openingId) && openingId === activeId;
  const centeredWithoutStream =
    !transcriptPending && messages.length === 0 && !activeRunning && queued.length === 0;
  const dock = useRef({ id: activeId, centered: centeredWithoutStream, sliding: false });
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
              onToggle={(id) => toggleSubagent(id)}
            />
          </ConversationDocks>
        ) : null}
        {fileDrag ? <DropImagesHint /> : null}
        <div ref={scroller} className="no-scrollbar absolute inset-0 overflow-auto [overflow-anchor:none]">
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
}) {
  const { streamText, streamReasoning, liveTools, runningActivity } = useLiveStream();
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
