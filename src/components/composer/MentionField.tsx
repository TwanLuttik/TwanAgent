import { useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { ChatImage } from "../../lib/core";
import { draftMentionSpans, type MentionFile } from "../../lib/mention";
import {
  flattenPasteToken,
  insertCollapsedPaste,
  PASTE_MIN,
  pasteSpans,
  replacePasteToken,
  type PasteBlock,
} from "../../lib/paste";
import { attachmentFilesFromClipboard, imageSpans } from "../../lib/image";
import { FileIcon } from "../FileIcon";
import { Symbol } from "../Symbol";
import { MODEL_MENU_EASE } from "./menuEase";

/** Caret box inside a textarea, so the mention menu can sit just above it. */
function caretRect(node: HTMLTextAreaElement, cursor: number): DOMRect {
  const frame = node.getBoundingClientRect();
  const mirror = document.createElement("div");
  const cs = getComputedStyle(node);
  mirror.style.position = "fixed";
  mirror.style.left = `${frame.left}px`;
  mirror.style.top = `${frame.top}px`;
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "anywhere";
  mirror.style.wordBreak = "break-word";
  mirror.style.boxSizing = cs.boxSizing;
  mirror.style.width = `${node.clientWidth}px`;
  mirror.style.font = cs.font;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.wordSpacing = cs.wordSpacing;
  mirror.style.paddingTop = cs.paddingTop;
  mirror.style.paddingRight = cs.paddingRight;
  mirror.style.paddingBottom = cs.paddingBottom;
  mirror.style.paddingLeft = cs.paddingLeft;
  mirror.style.borderTopWidth = cs.borderTopWidth;
  mirror.style.borderRightWidth = cs.borderRightWidth;
  mirror.style.borderBottomWidth = cs.borderBottomWidth;
  mirror.style.borderLeftWidth = cs.borderLeftWidth;
  mirror.style.textIndent = cs.textIndent;
  mirror.style.tabSize = cs.tabSize;
  const at = Math.max(0, Math.min(cursor, node.value.length));
  mirror.textContent = node.value.slice(0, at);
  const mark = document.createElement("span");
  mark.textContent = node.value.slice(at, at + 1) || "\u200b";
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  mirror.scrollTop = node.scrollTop;
  mirror.scrollLeft = node.scrollLeft;
  const caret = mark.getBoundingClientRect();
  document.body.removeChild(mirror);
  return caret;
}

export function MentionMenu({
  open,
  anchor,
  cursor,
  rows,
  index,
  onIndex,
  onPick,
}: {
  open: boolean;
  anchor: RefObject<HTMLTextAreaElement | null>;
  cursor: number;
  rows: MentionFile[];
  index: number;
  onIndex: (index: number) => void;
  onPick: (file: MentionFile) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const active = useRef<HTMLButtonElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const node = anchor.current;
      const menu = panel.current;
      if (!node || !menu) return;
      const caret = caretRect(node, cursor);
      const frame = node.getBoundingClientRect();
      const height = menu.getBoundingClientRect().height;
      const width = Math.min(352, Math.max(220, frame.width - 24));
      const left = Math.min(Math.max(8, caret.left), window.innerWidth - width - 8);
      const gap = 6;
      const aboveTop = caret.top - gap - height;
      const belowTop = caret.bottom + gap;
      const above = aboveTop >= 8 || belowTop + height > window.innerHeight - 8;
      const next = {
        left,
        top: above ? Math.max(8, aboveTop) : belowTop,
        width,
      };
      if (!placed.current) {
        placed.current = true;
        setBox(next);
        return;
      }
      setBox((prev) =>
        prev && prev.left === next.left && prev.top === next.top && prev.width === next.width ? prev : next,
      );
    }
    place();
    const node = anchor.current;
    node?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      node?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, cursor, rows]);

  useLayoutEffect(() => {
    const row = active.current;
    const menu = panel.current;
    if (!row || !menu) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }, [index, open, rows]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <motion.div
      ref={panel}
      role="listbox"
      aria-label="Files"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
      style={{ left: box?.left ?? -9999, top: box?.top ?? 0, width: box?.width ?? 320, visibility: box ? "visible" : "hidden" }}
      className="fixed z-50 max-h-56 origin-bottom overflow-auto rounded-lg border border-line/25 bg-canvas py-1 shadow-card"
    >
      {rows.map((file, row) => {
        const current = row === index;
        return (
          <button
            key={file.path}
            ref={current ? active : undefined}
            type="button"
            role="option"
            aria-selected={current}
            onMouseEnter={() => onIndex(row)}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(file);
            }}
            className={`flex h-7 w-full cursor-pointer items-center gap-2 px-2.5 text-left text-[12px] transition-colors duration-150 hover:bg-wash ${
              current ? "bg-wash font-medium text-ink" : "text-ink/80"
            }`}
          >
            <FileIcon name={file.name} className="size-3.5 shrink-0" />
            <span className="shrink-0 truncate">{file.name}</span>
            <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-muted">
              {file.path}
            </span>
          </button>
        );
      })}
    </motion.div>,
    document.body,
  );
}

export function MentionField({
  draft,
  files,
  compact,
  area,
  mirror,
  placeholder,
  autoFocus,
  onDraft,
  onCursor,
  onEdit,
  onPasteFiles,
  chatId = "",
  images,
  pastes,
  onPastes,
  onKey,
  onMouseEnter,
  onMouseLeave,
}: {
  draft: string;
  files: MentionFile[];
  compact?: boolean;
  area: RefObject<HTMLTextAreaElement | null>;
  mirror: RefObject<HTMLDivElement | null>;
  placeholder: string;
  autoFocus?: boolean;
  onDraft: (value: string) => void;
  onCursor: (cursor: number) => void;
  onEdit: () => void;
  onPasteFiles: (files: File[]) => void;
  chatId?: string;
  images: ChatImage[];
  pastes: PasteBlock[];
  onPastes: (pastes: PasteBlock[]) => void;
  onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const pad = compact ? "px-3.5 pt-3 pb-1.5" : "px-4 pt-3.5 pb-2";
  const type = "m-0 whitespace-pre-wrap break-words border-0 font-sans text-[14px] leading-relaxed";
  const spans = draftHighlightSpans(draft, files, pastes, images);
  const showImageText = spans.some((span) => span.kind === "image");
  let cursor = 0;
  const parts: ReactNode[] = [];
  spans.forEach((span, index) => {
    if (span.start > cursor) {
      parts.push(
        <span key={`gap-${cursor}`} className={showImageText ? "text-ink" : "text-transparent"}>
          {draft.slice(cursor, span.start)}
        </span>,
      );
    }
    parts.push(
      <span
        key={`${span.start}-${index}`}
        className={`rounded-[3px] ${
          span.kind === "paste"
            ? "bg-ok/15 text-ok"
            : span.kind === "image"
              ? "bg-accent/15 text-accent"
              : showImageText
                ? "text-accent"
                : "bg-panel text-accent"
        }`}
      >
        {draft.slice(span.start, span.end)}
      </span>,
    );
    cursor = span.end;
  });
  if (cursor < draft.length) {
    parts.push(
      <span key={`tail-${cursor}`} className={showImageText ? "text-ink" : "text-transparent"}>
        {draft.slice(cursor)}
      </span>,
    );
  }
  if (draft.endsWith("\n")) parts.push(" ");

  useLayoutEffect(() => {
    const from = area.current;
    const to = mirror.current;
    if (!from || !to || spans.length === 0) return;
    const sync = () => {
      const cs = getComputedStyle(from);
      to.style.boxSizing = cs.boxSizing;
      to.style.width = `${from.offsetWidth}px`;
      to.style.height = `${from.offsetHeight}px`;
      to.style.font = cs.font;
      to.style.lineHeight = cs.lineHeight;
      to.style.letterSpacing = cs.letterSpacing;
      to.style.wordSpacing = cs.wordSpacing;
      to.style.paddingTop = cs.paddingTop;
      to.style.paddingRight = cs.paddingRight;
      to.style.paddingBottom = cs.paddingBottom;
      to.style.paddingLeft = cs.paddingLeft;
      to.style.borderTopWidth = cs.borderTopWidth;
      to.style.borderRightWidth = cs.borderRightWidth;
      to.style.borderBottomWidth = cs.borderBottomWidth;
      to.style.borderLeftWidth = cs.borderLeftWidth;
      to.style.textAlign = cs.textAlign;
      to.style.textIndent = cs.textIndent;
      to.style.tabSize = cs.tabSize;
      to.style.whiteSpace = "pre-wrap";
      to.style.overflowWrap = "anywhere";
      to.style.wordBreak = "break-word";
      to.scrollTop = from.scrollTop;
      to.scrollLeft = from.scrollLeft;
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(from);
    return () => ro.disconnect();
  }, [draft, compact, area, mirror, spans.length]);

  function placeCursor(cursor: number) {
    onCursor(cursor);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }

  function onPasteText(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = attachmentFilesFromClipboard(event.clipboardData) as File[];
    if (images.length) {
      event.preventDefault();
      onPasteFiles(images);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const el = event.currentTarget;
    const inserted = insertCollapsedPaste(draft, el.selectionStart ?? draft.length, el.selectionEnd ?? draft.length, text);
    if (inserted.paste) onPastes([...pastes, inserted.paste]);
    onEdit();
    onDraft(inserted.draft);
    placeCursor(inserted.cursor);
  }

  function flattenPaste(paste: PasteBlock) {
    onPastes(pastes.filter((row) => row.id !== paste.id));
    onDraft(flattenPasteToken(draft, paste));
  }

  function savePaste(paste: PasteBlock, text: string) {
    const next = text.trim() ? text : "";
    if (!next || next.length <= PASTE_MIN) {
      onPastes(pastes.filter((row) => row.id !== paste.id));
      onDraft(replacePasteToken(draft, paste, next));
      return;
    }
    onPastes(pastes.map((row) => (row.id === paste.id ? { ...row, text: next } : row)));
  }

  return (
    <div className="relative">
      <div ref={mirror} aria-hidden className={`pointer-events-none absolute top-0 left-0 z-[2] overflow-hidden ${type}`}>
        {draft && spans.length ? parts : null}
      </div>
      <PasteHover
        draft={draft}
        pastes={pastes}
        area={area}
        mirror={mirror}
        onFlatten={flattenPaste}
        onSave={savePaste}
      />
      <textarea
        ref={area}
        data-composer-input=""
        data-composer-chat={chatId || undefined}
        value={draft}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        data-gramm="false"
        data-enable-grammarly="false"
        onChange={(e) => {
          onEdit();
          onCursor(e.target.selectionStart ?? e.target.value.length);
          onDraft(e.target.value);
        }}
        onScroll={() => {
          const from = area.current;
          const to = mirror.current;
          if (!from || !to) return;
          to.scrollTop = from.scrollTop;
          to.scrollLeft = from.scrollLeft;
        }}
        onSelect={(e) => onCursor(e.currentTarget.selectionStart ?? 0)}
        onClick={(e) => onCursor(e.currentTarget.selectionStart ?? 0)}
        onPaste={onPasteText}
        onKeyDown={onKey}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        rows={1}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className={`relative z-[1] block w-full resize-none overflow-y-auto bg-transparent caret-ink outline-none placeholder:text-muted/80 ${
          showImageText ? "text-transparent" : "text-ink"
        } ${type} ${pad}`}
      />
    </div>
  );
}

type HighlightSpan = { start: number; end: number; kind: "mention" | "paste" | "image" };

function draftHighlightSpans(
  draft: string,
  files: MentionFile[],
  pastes: PasteBlock[],
  images: ChatImage[],
): HighlightSpan[] {
  const mentions = draftMentionSpans(draft, files).map((span) => ({
    start: span.start,
    end: span.end,
    kind: "mention" as const,
  }));
  const pasted = pasteSpans(draft, pastes).map((span) => ({
    start: span.start,
    end: span.end,
    kind: "paste" as const,
  }));
  const pictures = imageSpans(draft, images).map((span) => ({
    start: span.start,
    end: span.end,
    kind: "image" as const,
  }));
  return [...mentions, ...pasted, ...pictures].sort((a, b) => a.start - b.start || a.end - b.end);
}

function PasteHover({
  draft,
  pastes,
  area,
  mirror,
  onFlatten,
  onSave,
}: {
  draft: string;
  pastes: PasteBlock[];
  area: RefObject<HTMLTextAreaElement | null>;
  mirror: RefObject<HTMLDivElement | null>;
  onFlatten: (paste: PasteBlock) => void;
  onSave: (paste: PasteBlock, text: string) => void;
}) {
  const spans = pasteSpans(draft, pastes);
  const [hover, setHover] = useState<string | null>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const [editing, setEditing] = useState<PasteBlock | null>(null);
  const [editText, setEditText] = useState("");
  const paste = pastes.find((row) => row.id === hover) ?? null;

  useLayoutEffect(() => {
    const host = mirror.current;
    if (!host || !paste) {
      setBox(null);
      return;
    }
    const span = pasteSpans(draft, [paste])[0];
    if (!span) {
      setBox(null);
      return;
    }
    const range = textRange(host, span.start, span.end);
    if (!range) {
      setBox(null);
      return;
    }
    const chip = range.getBoundingClientRect();
    setBox({ left: chip.left, top: chip.top });
  }, [area, draft, hover, mirror, paste]);

  return (
    <>
      {spans.map((span) => (
        <button
          key={span.id}
          type="button"
          aria-label="Pasted text"
          className="absolute z-[3] cursor-pointer bg-transparent"
          style={chipStyle(mirror.current, span.start, span.end)}
          onMouseEnter={() => setHover(span.id)}
          onMouseLeave={() => setHover((current) => (current === span.id ? null : current))}
          onClick={() => setHover(span.id)}
        />
      ))}
      {paste && box
        ? createPortal(
        <div
          className="fixed z-[80] flex items-center gap-0.5 rounded-md border border-line bg-canvas p-0.5 shadow-card"
          style={{ left: box.left, top: Math.max(8, box.top - 30) }}
          onMouseEnter={() => setHover(paste.id)}
          onMouseLeave={() => setHover((current) => (current === paste.id ? null : current))}
        >
          <button
            type="button"
            aria-label="Edit pasted text"
            title="Edit text"
            className="flex size-6 items-center justify-center rounded text-muted hover:bg-wash hover:text-ink"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setEditText(paste.text);
              setEditing(paste);
            }}
          >
            <Symbol name="pencil" className="size-3" />
          </button>
          <button
            type="button"
            aria-label="Flatten pasted text"
            title="Flatten"
            className="flex size-6 items-center justify-center rounded text-muted hover:bg-wash hover:text-ink"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onFlatten(paste)}
          >
            <Symbol name="arrow.down.to.line" className="size-3" />
          </button>
        </div>,
        document.body,
          )
        : null}
      {editing ? (
        <PasteEditor
          text={editText}
          onText={setEditText}
          onCancel={() => setEditing(null)}
          onSave={() => {
            onSave(editing, editText);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function chipStyle(host: HTMLDivElement | null, start: number, end: number): CSSProperties {
  const range = host ? textRange(host, start, end) : null;
  const frame = host?.getBoundingClientRect();
  const chip = range?.getBoundingClientRect();
  if (!frame || !chip) return { display: "none" };
  return {
    left: chip.left - frame.left,
    top: chip.top - frame.top,
    width: Math.max(chip.width, 8),
    height: Math.max(chip.height, 16),
  };
}

function textRange(host: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let from: { node: Text; offset: number } | null = null;
  let to: { node: Text; offset: number } | null = null;
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const next = seen + text.length;
    if (!from && start <= next) from = { node: text, offset: Math.max(0, start - seen) };
    if (!to && end <= next) {
      to = { node: text, offset: Math.max(0, end - seen) };
      break;
    }
    seen = next;
    node = walker.nextNode();
  }
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function PasteEditor({
  text,
  onText,
  onSave,
  onCancel,
}: {
  text: string;
  onText: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-x-2 bottom-full z-30 mb-1 rounded-lg border border-line bg-canvas p-2 shadow-card">
      <textarea
        value={text}
        aria-label="Edit pasted text"
        onChange={(event) => onText(event.target.value)}
        rows={6}
        className="block max-h-48 w-full resize-y bg-transparent font-mono text-[12px] leading-relaxed outline-none"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onSave}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent"
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
  );
}
