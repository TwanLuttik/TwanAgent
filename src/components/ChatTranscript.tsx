import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { PromptImages } from "./PromptImages";
import { Symbol } from "./Symbol";
import { ToolTrail } from "./ToolTrail";
import { chatTurnSlice, hasOlderTurns, revealOlderTurns } from "../lib/chat-window";
import {
  groupTranscriptTurns,
  isLiveToolTrail,
  liveTranscriptItems,
  type ChatImage,
  type ChatMessage,
  type LiveToolInput,
  type TranscriptItem,
  type TranscriptTurn,
} from "../lib/dev";
import { displayFileMentions, type MentionFile } from "../lib/dev-mention";
import { formatElapsed } from "../lib/relative-time";

function FinishedLine({ durationMs }: { durationMs: number }) {
  return (
    <div className="mt-2 text-[11px] text-muted/55">
      Finished
      <span className="ml-1.5 tabular-nums text-muted/40">{formatElapsed(durationMs)}</span>
    </div>
  );
}

function RoleBadge({ role }: { role: "user" | "assistant" }) {
  const user = role === "user";
  return (
    <span
      className={`inline-flex items-center justify-center ${
        user ? "text-accent" : "text-[#7c5cff]"
      }`}
      title={user ? "You" : "Grok"}
      aria-label={user ? "You" : "Grok"}
    >
      <Symbol name={user ? "person.fill" : "sparkles"} className="size-3.5" />
    </span>
  );
}

const USER_MESSAGE_MAX = "max-h-32";

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
    <div className="max-w-[min(100%,36rem)] rounded-2xl bg-inset px-3 py-2">
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
            {shown}
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "";
  return (
    <div className="mb-3 flex items-center gap-1.5 text-[11px] text-muted/55" aria-live="polite">
      <span
        className="size-2.5 shrink-0 animate-spin rounded-full border border-ink/35 border-t-transparent"
        aria-hidden
      />
      <span>{label}</span>
      {elapsed ? <span className="tabular-nums text-muted/40">{elapsed}</span> : null}
    </div>
  );
}

export function DropImagesHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[inherit] bg-canvas/80 text-[14px] text-ink">
      Drop images
    </div>
  );
}

function StickyTurnHeader({ children }: { children: ReactNode }) {
  return (
    <div className="relative sticky top-0 z-10 -mx-1 bg-canvas/95 px-1 pt-1 pb-2 backdrop-blur-[2px]">
      {children}
      <div
        className="pointer-events-none absolute inset-x-0 top-full h-3 bg-gradient-to-b from-canvas/95 to-transparent"
        aria-hidden
      />
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
  onLoadOlder,
}: {
  messages: ChatMessage[];
  streamText: string;
  streamReasoning?: string;
  liveTools: LiveToolInput[];
  busy: boolean;
  conversationId?: string;
  mentionFiles?: MentionFile[];
  /** Called before older turns mount so the scroller can keep its place. */
  onLoadOlder?: () => void;
}) {
  const items = liveTranscriptItems(messages, streamText, liveTools, streamReasoning);
  const turns = groupTranscriptTurns(items);
  const [revealed, setRevealed] = useState(0);
  const chatRef = useRef(conversationId);
  if (chatRef.current !== conversationId) {
    chatRef.current = conversationId;
    if (revealed !== 0) setRevealed(0);
  }
  const slice = chatTurnSlice(turns.length, revealed);
  const older = hasOlderTurns(turns.length, revealed);
  const visible = turns.slice(slice.start);
  const starts = turnItemStarts(turns, slice.start);
  return (
    <>
      {older ? (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            onClick={() => {
              onLoadOlder?.();
              setRevealed((current) => revealOlderTurns(turns.length, current));
            }}
            className="rounded-full border border-line/70 px-3 py-1 text-[12px] text-muted hover:bg-wash hover:text-ink"
          >
            Load earlier messages
          </button>
        </div>
      ) : null}
      {visible.map((turn, i) => (
        <TranscriptTurn
          key={slice.start + i}
          turn={turn}
          items={items}
          start={starts[i] ?? 0}
          busy={busy}
          mentionFiles={mentionFiles}
        />
      ))}
    </>
  );
}

function turnItemStarts(turns: TranscriptTurn[], from: number): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < turns.length; i++) {
    if (i >= from) starts.push(cursor);
    const turn = turns[i];
    cursor += (turn?.user ? 1 : 0) + (turn?.rest.length ?? 0);
  }
  return starts;
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
        <RoleBadge role="user" />
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
  items,
  start,
  busy,
  mentionFiles,
}: {
  turn: TranscriptTurn;
  items: TranscriptItem[];
  start: number;
  busy: boolean;
  mentionFiles?: MentionFile[];
}) {
  const userOffset = turn.user ? 1 : 0;
  return (
    <div className="mb-4">
      {turn.user ? (
        <StickyTurnHeader>
          <div className="mb-1">
            <RoleBadge role="user" />
          </div>
          <UserBubble text={turn.user.content} images={turn.user.images} mentionFiles={mentionFiles} />
        </StickyTurnHeader>
      ) : null}
      {turn.rest.map((item, i) => {
        const index = start + userOffset + i;
        const last = i === turn.rest.length - 1;
        if (item.kind === "thinking") {
          return (
            <div
              key={index}
              className="mb-3 whitespace-pre-wrap border-l border-line pl-2.5 text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]"
            >
              {item.content}
            </div>
          );
        }
        if (item.kind === "tools") {
          return (
            <ToolTrail
              key={index}
              labels={item.labels}
              files={item.files}
              details={item.details}
              commands={item.commands}
              live={isLiveToolTrail(items, index, busy)}
            />
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
        const badge = (
          <div className="mb-1">
            <RoleBadge role="assistant" />
          </div>
        );
        return (
          <div key={index} className={last ? undefined : "mb-4"}>
            {!turn.user && i === 0 ? <StickyTurnHeader>{badge}</StickyTurnHeader> : badge}
            <ChatMarkdown text={item.content} />
            {typeof item.durationMs === "number" ? <FinishedLine durationMs={item.durationMs} /> : null}
          </div>
        );
      })}
    </div>
  );
}
