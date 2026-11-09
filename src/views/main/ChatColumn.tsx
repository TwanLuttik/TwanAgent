import { memo, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { motion } from "motion/react";
import { McpDock } from "../../components/McpDock";
import { SkillDock } from "../../components/SkillDock";
import { ConversationDocks } from "../../components/SubagentDock";
import { ActivityStatus, ChatTranscript, DropImagesHint, PendingUserMessage } from "../../components/ChatTranscript";
import { SubagentCrumb, useSubagentParentId } from "../../components/SubagentCrumb";
import { conversationActivityLabel } from "../../lib/core";
import { rememberSubagentParent } from "../../lib/subagent-parent";
import { subagentRunInfo, type SubagentRecord } from "../../lib/subagent";
import { holdTranscript } from "../../lib/chat-window";
import { chatScrollFor, rememberChatScroll } from "../../lib/chat-scroll";
import { chatHasRunningTurn, runningTurnStartedAt, type PendingMessage } from "../../lib/turn";
import { providerProfile } from "../../lib/provider";
import { rememberSplitPane } from "../../lib/split-pane";
import { shellApprovalLabel } from "../../lib/permission";
import { PlanApproval } from "../../components/PlanApproval";
import { useLiveStream, useLiveStreamEmpty } from "../../lib/live-stream";
import { useMain } from "./context";
import { SessionComposer } from "./SessionComposer";

export function ChatColumn({ paneClosed = false }: { paneClosed?: boolean }) {
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
    fileDrag,
    holdScrollForOlder,
    mcpBusy,
    mcpServers,
    mentionFiles,
    messages,
    model,
    models,
    conversations,
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
    skillBusy,
    skills,
    subagents,
    openChat,
    toggleMcpServer,
    toggleSkill,
    turnStartedAt,
    workspace,
  } = useMain();
  const activeRunning = chatHasRunningTurn(runningTurns, activeId);
  const subagentRuns = useMemo(() => subagentRunInfo(subagents, runningTurns), [subagents, runningTurns]);
  const subagentParent = useSubagentParentId(activeId);
  const subagentTitle = conversations.find((row: { id: string; title?: string }) => row.id === activeId)?.title?.trim() || "Subagent";
  const parentTitle = conversations.find((row: { id: string; title?: string }) => row.id === subagentParent)?.title?.trim() || "Chat";
  const heldRef = useRef({ id: activeId, messages, model });
  const held = holdTranscript(heldRef.current, messages, activeId, model);
  heldRef.current = held;
  const showingTranscript = held.id === activeId;
  useLayoutEffect(() => {
    if (!showingTranscript) return;
    const el = scroller.current;
    const saved = chatScrollFor(held.id);
    if (!el || saved == null) return;
    el.scrollTop = saved;
  }, [showingTranscript, held.id, scroller]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    // activeId changes before its messages arrive. Writing now would store the
    // chat we left under the one just selected.
    if (!showingTranscript || !held.id) return;
    rememberSplitPane(held.id, { messages: messagesRef.current });
  }, [showingTranscript, held.id, messages]);
  const transcriptPending = Boolean(openingId) && openingId === activeId && (!showingTranscript || messages.length === 0);
  const centeredWithoutStream =
    !transcriptPending && showingTranscript && messages.length === 0 && !activeRunning && queued.length === 0;
  const dock = useRef({ id: activeId, centered: centeredWithoutStream, sliding: false });
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
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
        {fileDrag === activeId ? <DropImagesHint /> : null}
        {showingTranscript && subagentParent ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-canvas from-65% to-transparent pb-4">
            <div className="mx-auto w-full min-w-0 max-w-[720px] px-6 pt-3">
              <SubagentCrumb
                parentTitle={parentTitle}
                title={subagentTitle}
                onOpenParent={() => void openChat(subagentParent)}
              />
            </div>
          </div>
        ) : null}
        <div
          ref={scroller}
          onScroll={() => {
            if (!showingTranscript || !scroller.current || !held.id) return;
            rememberChatScroll(held.id, scroller.current.scrollTop);
          }}
          className="no-scrollbar absolute inset-0 overflow-auto [overflow-anchor:none]"
        >
          <div className={`relative mx-auto w-full min-w-0 max-w-[720px] px-6 ${showingTranscript && subagentParent ? "pt-14" : "pt-5"}`}>
            {showingTranscript ? (
              <LiveTranscript
                key={held.id}
                messages={held.messages}
                model={held.model}
                modelName={catalogModelName(models, held.model)}
                centeredWithoutStream={centeredWithoutStream}
                activeRunning={activeRunning}
                transcriptPending={transcriptPending}
                conversationId={held.id}
                mentionFiles={mentionFiles}
                subagents={subagents}
                subagentRuns={subagentRuns}
                onOpenConversation={(id) => {
                  if (activeId && activeId !== id) rememberSubagentParent(id, activeId);
                  void openChat(id);
                }}
                onLoadOlder={holdScrollForOlder}
                pendingShell={Boolean(pendingShell)}
                pendingPlan={Boolean(pendingPlan)}
                activity={runningTurns[activeId]?.activity}
                startedAt={runningTurnStartedAt(runningTurns, activeId) || turnStartedAt}
              />
            ) : transcriptPending ? (
              <ActivityStatus label="Loading…" />
            ) : null}
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
      <ComposerDockChrome>{children}</ComposerDockChrome>
    </motion.div>
  );
}

export const ComposerDockChrome = memo(function ComposerDockChrome({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-auto px-6 pb-3">
      <div className="mx-auto w-full min-w-0 max-w-[720px]">{children}</div>
    </div>
  );
});

/** True while the composer should sit in the middle. The empty flag is stable across tokens. */
function useComposerCentered(centeredWithoutStream: boolean): boolean {
  const streamEmpty = useLiveStreamEmpty();
  return centeredWithoutStream && streamEmpty;
}

export function catalogModelName(models: { id?: string; name?: string }[] | null | undefined, id: string): string {
  const name = models?.find((row) => row.id === id)?.name;
  return typeof name === "string" ? name.trim() : "";
}

export const LiveTranscript = memo(function LiveTranscript({
  messages,
  model,
  modelName = "",
  centeredWithoutStream,
  activeRunning,
  transcriptPending,
  conversationId,
  mentionFiles,
  subagents = [],
  subagentRuns,
  onOpenConversation,
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
  /** Catalog name, such as "Grok 4.6". Looked up by the parent so a composer resize does not rebuild the turns. */
  modelName?: string;
  centeredWithoutStream: boolean;
  activeRunning: boolean;
  transcriptPending: boolean;
  conversationId: string;
  mentionFiles: Parameters<typeof ChatTranscript>[0]["mentionFiles"];
  subagents?: SubagentRecord[];
  subagentRuns?: ReturnType<typeof subagentRunInfo>;
  onOpenConversation?: (id: string) => void;
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
        model={model}
        modelName={modelName}
        subagents={subagents}
        subagentRuns={subagentRuns}
        onOpenConversation={onOpenConversation}
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
});
