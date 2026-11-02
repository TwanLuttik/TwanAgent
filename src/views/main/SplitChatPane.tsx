import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { insertCompactionEvent } from "../../lib/compact";
import type { ChatMessage } from "../../lib/core";
import { getSecondaryLiveStream, subscribeLiveStream, subscribeSecondaryLiveStream, useSecondaryLiveStream, useSecondaryLiveStreamEmpty } from "../../lib/live-stream";
import { DropImagesHint, PendingUserMessage } from "../../components/ChatTranscript";
import { chatScrollFor, isNearBottom, pinChatToEnd, rememberChatScroll, stickToBottomAfterRestore } from "../../lib/chat-scroll";
import { chatHasRunningTurn, pendingForChat, runningTurnStartedAt, type PendingMessage } from "../../lib/turn";
import { rememberSplitPane, splitGroupForChat, splitPaneCache } from "../../lib/split-pane";
import { useMain } from "./context";
import { SessionComposer } from "./SessionComposer";
import { ComposerDockChrome, LiveTranscript } from "./ChatColumn";

export function SplitRow({ ids }: { ids: string[] }) {
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
        <ComposerDockChrome>
          <SessionComposer placement="chat" chatId={chatId} />
        </ComposerDockChrome>
      </div>
      <span className="sr-only">{conversations.find((row: { id: string }) => row.id === chatId)?.title ?? ""}</span>
    </div>
  );
}
