import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { FilePathTip, PromptImages } from "./PromptImages";
import { Symbol } from "./Symbol";
import { forgetSeenToolSignature, ToolTrail } from "./ToolTrail";
import { chatTurnSlice, hasOlderTurns, revealOlderTurns } from "../lib/chat-window";
import {
  splitLiveTranscript,
  type ChatImage,
  type ChatMessage,
  type LiveToolInput,
  type TranscriptItem,
  type TranscriptTurn,
} from "../lib/core";
import { imageTextParts, imageTokenLabel } from "../lib/image";
import { displayFileMentions, type MentionFile } from "../lib/mention";
import { formatElapsed, formatMessageTime } from "../lib/relative-time";
import { providerProfile } from "../lib/provider";
import { subagentOpenId, type SubagentRecord, type SubagentRun } from "../lib/subagent";
import { RunningElapsed } from "./RunningElapsed";
import { ThinkingTrace } from "./ThinkingTrace";

function FinishedLine({ durationMs, finishedAt }: { durationMs?: number; finishedAt?: string }) {
  const time = finishedAt ? formatMessageTime(finishedAt) : "";
  if (typeof durationMs !== "number" && !time) return null;
  return (
    <div className="mt-2 text-[11px] text-muted/55">
      Finished
      {typeof durationMs === "number" ? (
        <span className="ml-1.5 tabular-nums text-muted/40">{formatElapsed(durationMs)}</span>
      ) : null}
      {time ? (
        <time dateTime={finishedAt} className="ml-1.5 tabular-nums text-muted/40" title={finishedAt}>
          {time}
        </time>
      ) : null}
    </div>
  );
}

function RoleBadge() {
  return (
    <span className="inline-flex items-center justify-center text-accent" title="You" aria-label="You">
      <Symbol name="person.fill" className="size-3.5" />
    </span>
  );
}

/** Provider mark and name for the model that wrote this turn. Same colors as the composer chip. */
function ModelMark({ model, name }: { model: string; name?: string }) {
  const profile = providerProfile(model);
  const color =
    profile.id === "anthropic" ? "text-[#d97757]" : profile.id === "minimax" ? "text-[#e21680]" : "text-ink/80";
  const label = (name ?? "").trim() || profile.agentName || model.trim() || "Assistant";
  return (
    <span className="inline-flex items-center gap-1.5 text-muted" title={label} aria-label={label}>
      <Symbol name={profile.symbol} colored className={`size-3.5 ${color}`} />
      <span className="text-[12px]">{label}</span>
    </span>
  );
}

/** The concluding reply. Narration that is still followed by tool calls is not it. */
function finalAssistantIndex(rest: TranscriptTurn["rest"]): number {
  let last = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i]?.kind === "assistant") last = i;
  }
  if (last < 0) return -1;
  for (let i = last + 1; i < rest.length; i++) {
    if (rest[i]?.kind === "tools") return -1;
  }
  return last;
}

const USER_MESSAGE_MAX = "max-h-32";

function ImageToken({ token, images }: { token: string; images?: ChatImage[] }) {
  const label = token.replace(/^\[/, "").replace(/]$/, "").toLowerCase();
  const image = images?.find((item) => imageTokenLabel(item.name).toLowerCase() === label);
  const linked = image?.sourcePath?.trim() ?? "";
  return (
    <span
      className="group relative inline rounded-[3px] bg-accent/15 text-accent transition-colors hover:bg-accent/25"
      title={linked || undefined}
    >
      {token}
      {linked ? <FilePathTip path={linked} /> : null}
    </span>
  );
}

function UserBubble({
  text,
  images,
  mentionFiles,
}: {
  text: string;
  images?: ChatImage[];
  mentionFiles?: MentionFile[];
}) {
  const shown = displayFileMentions(text, mentionFiles ?? []);
  const parts = imageTextParts(shown, images ?? []);
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      if (open) return;
      setOverflow(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown, open]);
  if (!shown && !images?.length) return null;
  const clipped = Boolean(shown) && !open && overflow;
  return (
    <div className="w-fit max-w-[min(100%,36rem)] rounded-2xl bg-inset px-3 py-2">
      {images?.length ? (
        <div className={text ? "mb-2" : undefined}>
          <PromptImages images={images} />
        </div>
      ) : null}
      {shown ? (
        <div className="relative">
          <div
            ref={body}
            className={`whitespace-pre-wrap text-[13px] leading-relaxed [overflow-wrap:anywhere] ${
              open ? "" : `${USER_MESSAGE_MAX} overflow-hidden`
            }`}
          >
            {parts.map((part, index) =>
              part.image ? (
                <ImageToken key={index} token={part.text} images={images} />
              ) : (
                part.text
              ),
            )}
          </div>
          {clipped ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-inset to-transparent" />
          ) : null}
        </div>
      ) : null}
      {shown && (overflow || open) ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-1 text-[11px] text-muted hover:text-ink"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export function ActivityStatus({ label, startedAt }: { label: string; startedAt?: number }) {
  return (
    <div className="mb-3 flex items-center gap-1.5 text-[11px] text-muted/55" aria-live="polite">
      <span
        className="size-2.5 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
        aria-hidden
      />
      <span>{label}</span>
      <RunningElapsed startedAt={startedAt} />
    </div>
  );
}

export function DropImagesHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[inherit] bg-canvas/80 text-[14px] text-ink">
      Drop files
    </div>
  );
}

/**
 * Sticks the user message while the rest of the turn scrolls under it.
 * The fade is in flow. Hanging it past the header painted a shadow across the first tool row.
 */
function StickyTurnHeader({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 -mx-1">
      <div className="bg-canvas/95 px-1 pt-1 pb-2 backdrop-blur-[2px]">{children}</div>
      <div className="pointer-events-none h-3 bg-gradient-to-b from-canvas/95 to-transparent" aria-hidden />
    </div>
  );
}

export function ChatTranscript({
  messages,
  streamText,
  streamReasoning = "",
  liveTools,
  busy,
  conversationId = "",
  mentionFiles = [],
  model = "",
  modelName = "",
  onLoadOlder,
  subagents = [],
  subagentRuns,
  onOpenConversation,
}: {
  messages: ChatMessage[];
  streamText: string;
  streamReasoning?: string;
  liveTools: LiveToolInput[];
  busy: boolean;
  conversationId?: string;
  mentionFiles?: MentionFile[];
  /** Model id for this chat. Its mark sits on each turn's final reply. */
  model?: string;
  /** Catalog name, such as "Grok 4.6". The id is used when this is empty. */
  modelName?: string;
  /** Called before older turns mount so the scroller can keep its place. */
  onLoadOlder?: () => void;
  /** Live subagents for this chat. A running row opens before its result is saved. */
  subagents?: SubagentRecord[];
  /** Latest tool and start time, keyed by subagent conversation id. */
  subagentRuns?: Readonly<Record<string, SubagentRun>>;
  onOpenConversation?: (id: string) => void;
}) {
  // splitLiveTranscript parses messages once and returns the same settled turns
  // while only the stream changes, so SettledTurn does not rebuild per token.
  const split = useMemo(
    () => splitLiveTranscript(messages, streamText, liveTools, streamReasoning),
    [messages, streamText, liveTools, streamReasoning],
  );
  const turnCount = split.settled.length + (split.tail.length ? 1 : 0);
  const [revealed, setRevealed] = useState(0);
  const chatRef = useRef(conversationId);
  if (chatRef.current !== conversationId) {
    // Coming back should paint calls that finished while this chat was hidden, not stagger them.
    forgetSeenToolSignature(chatRef.current);
    chatRef.current = conversationId;
    if (revealed !== 0) setRevealed(0);
  }
  const runningOpenIds = useMemo(() => {
    const ids = new Set<string>();
    for (const agent of subagents) {
      if (agent.status === "running" && agent.id) ids.add(agent.id);
    }
    return ids;
  }, [subagents]);
  const slice = chatTurnSlice(turnCount, revealed);
  const older = hasOlderTurns(turnCount, revealed);
  const settledFrom = Math.min(slice.start, split.settled.length);
  const visibleSettled = split.settled.slice(settledFrom);
  const showTail = split.tail.length > 0 && slice.start < turnCount;
  return (
    <>
      {older ? (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            onClick={() => {
              onLoadOlder?.();
              setRevealed((current) => revealOlderTurns(turnCount, current));
            }}
            className="rounded-full border border-line/70 px-3 py-1 text-[12px] text-muted hover:bg-wash hover:text-ink"
          >
            Load earlier messages
          </button>
        </div>
      ) : null}
      {visibleSettled.map((turn, i) => (
        <SettledTurn
          key={settledFrom + i}
          turn={turn}
          mentionFiles={mentionFiles}
          conversationId={conversationId}
          model={model}
          modelName={modelName}
          runningOpenIds={runningOpenIds}
          subagentRuns={subagentRuns}
          onOpenConversation={onOpenConversation}
        />
      ))}
      {showTail ? (
        <LiveTail
          items={split.tail}
          busy={busy}
          mentionFiles={mentionFiles}
          conversationId={conversationId}
          model={model}
          modelName={modelName}
          subagents={subagents}
          runningOpenIds={runningOpenIds}
          subagentRuns={subagentRuns}
          onOpenConversation={onOpenConversation}
        />
      ) : null}
      <EarlySubagentCards
        items={showTail ? split.tail : []}
        subagents={subagents}
        runningOpenIds={runningOpenIds}
        subagentRuns={subagentRuns}
        model={model}
        modelName={modelName}
        onOpenConversation={onOpenConversation}
      />
    </>
  );
}

const SettledTurn = memo(function SettledTurn({
  turn,
  mentionFiles,
  conversationId,
  model,
  modelName,
  subagents = [],
  runningOpenIds,
  subagentRuns,
  onOpenConversation,
}: {
  turn: TranscriptTurn;
  mentionFiles?: MentionFile[];
  conversationId?: string;
  model?: string;
  modelName?: string;
  subagents?: SubagentRecord[];
  runningOpenIds?: ReadonlySet<string>;
  subagentRuns?: Readonly<Record<string, SubagentRun>>;
  onOpenConversation?: (id: string) => void;
}) {
  return (
    <TranscriptTurn
      turn={turn}
      mentionFiles={mentionFiles}
      conversationId={conversationId}
      model={model}
      modelName={modelName}
      subagents={subagents}
      runningOpenIds={runningOpenIds}
      subagentRuns={subagentRuns}
      onOpenConversation={onOpenConversation}
    />
  );
});

/** Agents that have started but whose tool call is not in the transcript yet. */
function EarlySubagentCards({
  items,
  subagents,
  runningOpenIds,
  subagentRuns,
  model,
  modelName,
  onOpenConversation,
}: {
  items: TranscriptItem[];
  subagents: SubagentRecord[];
  runningOpenIds?: ReadonlySet<string>;
  subagentRuns?: Readonly<Record<string, SubagentRun>>;
  model: string;
  modelName: string;
  onOpenConversation?: (id: string) => void;
}) {
  const shown = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tools") continue;
    for (const id of item.callIds) {
      if (id) shown.add(id);
    }
  }
  const pending = subagents.filter((agent) => agent.callId && !shown.has(agent.callId) && agent.status !== "error");
  if (!pending.length) return null;
  return (
    <ToolTrail
      labels={pending.map((agent) => (agent.description.trim() ? `Subagent: ${agent.description.trim()}` : "Subagent"))}
      openIds={pending.map((agent) => agent.id)}
      live={false}
      model={model}
      modelName={modelName}
      runningOpenIds={runningOpenIds}
      runs={subagentRuns}
      onOpen={onOpenConversation}
    />
  );
}

function LiveTail({
  items,
  busy,
  mentionFiles,
  conversationId,
  model,
  modelName,
  subagents = [],
  runningOpenIds,
  subagentRuns,
  onOpenConversation,
}: {
  items: TranscriptItem[];
  busy: boolean;
  mentionFiles?: MentionFile[];
  conversationId?: string;
  model?: string;
  modelName?: string;
  subagents?: SubagentRecord[];
  runningOpenIds?: ReadonlySet<string>;
  subagentRuns?: Readonly<Record<string, SubagentRun>>;
  onOpenConversation?: (id: string) => void;
}) {
  const head = items[0];
  const hasUser = head?.kind === "user";
  const turn: TranscriptTurn = {
    user: hasUser ? head : undefined,
    rest: (hasUser ? items.slice(1) : items) as TranscriptTurn["rest"],
  };
  const last = items[items.length - 1];
  const liveIndex = busy && last?.kind === "tools" ? items.length - 1 : -1;
  return (
    <TranscriptTurn
      turn={turn}
      liveIndex={liveIndex}
      mentionFiles={mentionFiles}
      conversationId={conversationId}
      model={model}
      modelName={modelName}
      subagents={subagents}
      runningOpenIds={runningOpenIds}
      subagentRuns={subagentRuns}
      onOpenConversation={onOpenConversation}
    />
  );
}

export function PendingUserMessage({
  text,
  images,
  editing,
  onEdit,
  onSave,
  onCancel,
  onRemove,
  mentionFiles,
}: {
  text: string;
  images?: ChatImage[];
  editing: boolean;
  onEdit: () => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  onRemove: () => void;
  mentionFiles?: MentionFile[];
}) {
  const [draft, setDraft] = useState(text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) return;
    setDraft(text);
    area.current?.focus();
  }, [editing, text]);
  const canSave = Boolean(draft.trim() || images?.length);

  return (
    <div className={`mb-4 ${editing ? "" : "opacity-60"}`}>
      <div className="mb-1 flex items-center gap-2">
        <RoleBadge />
        <span className="text-[11px] font-medium text-muted/70">{editing ? "Editing" : "Pending"}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {editing ? null : (
            <button
              type="button"
              aria-label="Edit pending message"
              title="Edit"
              onClick={onEdit}
              className="flex size-5 items-center justify-center rounded-md text-muted hover:bg-wash hover:text-ink"
            >
              <Symbol name="pencil" className="size-2.5" />
            </button>
          )}
          <button
            type="button"
            aria-label="Remove pending message"
            title="Remove"
            onClick={onRemove}
            className="flex size-5 items-center justify-center rounded-md text-muted hover:bg-wash hover:text-ink"
          >
            <Symbol name="xmark" className="size-2.5" />
          </button>
        </div>
      </div>
      {editing ? (
        <div className="max-w-[min(100%,36rem)] rounded-2xl bg-inset px-3 py-2">
          {images?.length ? (
            <div className="mb-2">
              <PromptImages images={images} />
            </div>
          ) : null}
          <textarea
            ref={area}
            value={draft}
            rows={1}
            aria-label="Edit pending message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (canSave) onSave(draft);
              }
            }}
            className="block w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={!canSave}
              onClick={() => onSave(draft)}
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-line px-2.5 py-1 text-[12px]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <UserBubble text={text} images={images} mentionFiles={mentionFiles} />
      )}
    </div>
  );
}

function TranscriptTurn({
  turn,
  liveIndex = -1,
  mentionFiles,
  conversationId,
  model = "",
  modelName = "",
  subagents = [],
  runningOpenIds,
  subagentRuns,
  onOpenConversation,
}: {
  turn: TranscriptTurn;
  /** Index of the streaming tool row, or -1 when nothing in this turn is live. */
  liveIndex?: number;
  mentionFiles?: MentionFile[];
  conversationId?: string;
  model?: string;
  modelName?: string;
  subagents?: SubagentRecord[];
  runningOpenIds?: ReadonlySet<string>;
  subagentRuns?: Readonly<Record<string, SubagentRun>>;
  onOpenConversation?: (id: string) => void;
}) {
  const userOffset = turn.user ? 1 : 0;
  const finalReply = finalAssistantIndex(turn.rest);
  return (
    <div className="mb-4">
      {turn.user ? (
        <StickyTurnHeader>
          <div className="mb-1">
            <RoleBadge />
          </div>
          <UserBubble text={turn.user.content} images={turn.user.images} mentionFiles={mentionFiles} />
        </StickyTurnHeader>
      ) : null}
      {turn.rest.map((item, i) => {
        const index = userOffset + i;
        const last = i === turn.rest.length - 1;
        if (item.kind === "thinking") {
          return <ThinkingTrace key={index} text={item.content} live={item.live} />;
        }
        if (item.kind === "tools") {
          const live = liveIndex === index;
          return (
            <div key={index}>
              <ToolTrail
                labels={item.labels}
                files={item.files}
                details={item.details}
                commands={item.commands}
                openIds={item.labels.map((label, index) =>
                  subagentOpenId(label, item.opens?.[index] ?? "", item.callIds[index] ?? "", subagents),
                )}
                live={live}
                conversationId={conversationId}
                model={model}
                modelName={modelName}
                runningOpenIds={runningOpenIds}
                runs={subagentRuns}
                onOpen={onOpenConversation}
              />
              {!live && (typeof item.durationMs === "number" || item.finishedAt) ? (
                <FinishedLine durationMs={item.durationMs} finishedAt={item.finishedAt} />
              ) : null}
            </div>
          );
        }
        if (item.kind === "compaction") {
          return (
            <div key={index} className="mb-4 flex items-center gap-2 text-[11px] text-muted/70">
              <span className="h-px min-w-4 flex-1 bg-line/70" />
              <span>Conversation compacted</span>
              <span className="h-px min-w-4 flex-1 bg-line/70" />
            </div>
          );
        }
        if (item.kind === "error") {
          return (
            <p
              key={index}
              className={`text-[13px] leading-relaxed text-err [overflow-wrap:anywhere] ${last ? "" : "mb-4"}`}
            >
              {item.content}
            </p>
          );
        }
        const streaming = liveIndex >= 0 && last && item.kind === "assistant" && typeof item.durationMs !== "number";
        return (
          <div key={index} className={last ? undefined : "mb-4"}>
            {i === finalReply ? (
              <div className="mb-1">
                <ModelMark model={model} name={modelName} />
              </div>
            ) : null}
            <ChatMarkdown text={item.content} live={streaming} />
            {typeof item.durationMs === "number" || item.finishedAt ? (
              <FinishedLine durationMs={item.durationMs} finishedAt={item.finishedAt} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
