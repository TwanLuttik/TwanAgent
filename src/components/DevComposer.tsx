import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { folderName, type ChatImage } from "../lib/dev";
import { applyMention, draftMentionSpans, filterMentionFiles, mentionAtCursor, type MentionFile } from "../lib/dev-mention";
import { canSendPrompt, imageFilesFromClipboard, imageFilesFromDrop } from "../lib/dev-image";
import { contextWindowChoices, contextWindowLabel, type ChatUsage } from "../lib/dev-context";
import { textareaFitHeight } from "../lib/composer-size";
import { PERMISSION_MODES, permissionLabel, parsePermissionMode } from "../lib/dev-permission";
import { todosAreOpen, type AgentTodo } from "../lib/dev-todo";
import type { DevEffort, DevModel } from "../lib/tauri";
import { ContextUsageChip } from "./ContextUsageChip";
import { FileIcon } from "./FileIcon";
import { PromptImages } from "./PromptImages";
import { Symbol } from "./Symbol";
import { TodoSteps } from "./TodoSteps";

const TODO_EASE = [0.22, 1, 0.36, 1] as const;
const TODO_DURATION = 0.32;

const COMPACT_MAX = 160;
const LANDING_MAX = 220;

export function DevComposer({
  draft,
  onDraft,
  onSend,
  onStop,
  busy,
  ready,
  placeholder,
  workspace,
  onOpenFolder,
  models,
  model,
  onModel,
  effort,
  onEffort,
  contextWindow,
  onContextWindow,
  permission,
  onPermission,
  autoFocus,
  compact,
  usage,
  usageWindow,
  images = [],
  onImages,
  onAddImages,
  mentionFiles = [],
  todos = [],
}: {
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  busy: boolean;
  ready: boolean;
  placeholder: string;
  workspace: string;
  onOpenFolder: () => void;
  models: DevModel[];
  model: string;
  onModel: (id: string) => void;
  effort: string;
  onEffort: (id: string) => void;
  contextWindow?: number;
  onContextWindow?: (tokens: number) => void;
  permission: string;
  onPermission: (id: string) => void;
  autoFocus?: boolean;
  compact?: boolean;
  usage?: ChatUsage | null;
  usageWindow?: number;
  images?: ChatImage[];
  onImages?: (images: ChatImage[]) => void;
  onAddImages?: (files: File[]) => void;
  mentionFiles?: MentionFile[];
  todos?: AgentTodo[];
}) {
  const selected = models.find((m) => m.id === model) ?? models[0];
  const efforts = selected?.efforts ?? [];
  const effortLabel = efforts.find((e) => e.id === effort)?.label ?? "Thinking";
  const windows = contextWindowChoices(selected?.context_windows, selected?.context_window);
  const windowLabel = contextWindow && windows.includes(contextWindow) ? contextWindowLabel(contextWindow) : "";
  const permissionMode = parsePermissionMode(permission);
  const box = useRef<HTMLFormElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [usageHover, setUsageHover] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const mention = mentionClosed ? null : mentionAtCursor(draft, cursor);
  const mentionRows = mention ? filterMentionFiles(mentionFiles, mention.query) : [];
  const canSend = canSendPrompt(draft, images) && ready;
  const showUsage = Boolean(usage && usageWindow);

  function takeImageFiles(list: File[]) {
    if (!list.length) return;
    onAddImages?.(list);
  }

  function onDragOver(ev: DragEvent<HTMLDivElement>) {
    if (![...ev.dataTransfer.types].includes("Files")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function onDrop(ev: DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    setDragOver(false);
    takeImageFiles(imageFilesFromDrop(ev.dataTransfer.files) as File[]);
  }

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const max = compact ? COMPACT_MAX : LANDING_MAX;

    function fit() {
      const node = area.current;
      if (!node) return;
      const cs = getComputedStyle(node);
      const fontSize = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight);
      const lineHeight = Number.isFinite(lh) && cs.lineHeight !== "normal" ? lh : fontSize * 1.625;
      const paddingY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      node.style.height = "0px";
      node.style.height = `${textareaFitHeight({
        value: node.value,
        scrollHeight: node.scrollHeight,
        lineHeight: Number.isFinite(lineHeight) ? lineHeight : 0,
        paddingY,
        max,
      })}px`;
    }

    fit();
    const host = box.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let width = host.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const next = host.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      fit();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [draft, compact]);

  function pickMention(file: MentionFile) {
    if (!mention) return;
    const next = applyMention(draft, mention, file);
    onDraft(next.text);
    setCursor(next.cursor);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function submit(ev?: FormEvent) {
    ev?.preventDefault();
    if (!canSendPrompt(draft, images) || !ready) return;
    onSend();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && mentionRows.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((index) => (index + step + mentionRows.length) % mentionRows.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionRows[Math.min(mentionIndex, mentionRows.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form ref={box} onSubmit={submit} className="w-full">
      <div
        className={`relative border bg-panel focus-within:border-accent/30 ${
          dragOver ? "border-accent/55" : "border-line/35"
        } ${compact ? "rounded-2xl" : "rounded-[22px] shadow-card"}`}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={(ev) => {
          if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <AnimatePresence initial={false}>
          {todosAreOpen(todos) ? (
            <motion.div
              key="todos"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: TODO_DURATION, ease: TODO_EASE }}
              className="overflow-hidden"
            >
              <TodoSteps todos={todos} compact={compact} />
            </motion.div>
          ) : null}
        </AnimatePresence>
        {usage && usageWindow ? (
          <ContextUsageChip usage={usage} windowSize={usageWindow} expanded={usageHover} />
        ) : null}
        {images.length ? (
          <div className={compact ? "px-3.5 pt-2.5" : "px-4 pt-3"}>
            <PromptImages
              images={images}
              onRemove={
                onImages
                  ? (id) => onImages(images.filter((img) => img.id !== id))
                  : undefined
              }
            />
          </div>
        ) : null}
        {dragOver ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-panel/80 text-[13px] text-ink">
            Drop images
          </div>
        ) : null}
        {mention && mentionRows.length ? (
          <div
            role="listbox"
            aria-label="Files"
            className="absolute bottom-full left-3 z-30 mb-1 max-h-56 w-[min(100%-1.5rem,22rem)] overflow-auto rounded-lg border border-line bg-canvas py-1 shadow-card"
          >
            {mentionRows.map((file, index) => (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                onMouseEnter={() => setMentionIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickMention(file);
                }}
                className={`flex h-7 w-full cursor-pointer items-center gap-2 px-2 text-left transition-colors ${
                  index === mentionIndex ? "bg-accent/10 text-accent" : "text-ink/80 hover:bg-accent/10 hover:text-accent"
                }`}
              >
                <FileIcon name={file.name} className="size-3.5 shrink-0" />
                <span className="shrink-0 truncate text-[12px] leading-none">{file.name}</span>
                <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] leading-none opacity-60">
                  {file.path}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <MentionField
          draft={draft}
          files={mentionFiles}
          compact={compact}
          area={area}
          mirror={mirror}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onDraft={onDraft}
          onCursor={(next) => setCursor(next)}
          onEdit={() => {
            setMentionClosed(false);
            setMentionIndex(0);
          }}
          onPasteFiles={takeImageFiles}
          onKey={onKey}
          onMouseEnter={() => {
            if (showUsage) setUsageHover(true);
          }}
          onMouseLeave={() => setUsageHover(false)}
        />
        <div className={`flex items-center gap-0.5 ${compact ? "px-1.5 pb-1.5" : "px-2 pb-2"}`}>
          <ChipSelect
            label={selected?.name ?? "Model"}
            title="Model"
            items={models.map((m) => ({ id: m.id, label: m.name }))}
            value={model}
            onChange={onModel}
          />
          {windows.length > 1 && onContextWindow ? (
            <ChipSelect
              label={windowLabel || "Context"}
              title="Context size"
              items={windows.map((tokens) => ({
                id: String(tokens),
                label: contextWindowLabel(tokens),
              }))}
              value={String(contextWindow ?? "")}
              onChange={(id) => {
                const tokens = Number(id);
                if (tokens > 0) onContextWindow(tokens);
              }}
            />
          ) : null}
          {efforts.length > 0 && (
            <ChipSelect
              label={effortLabel}
              title="Thinking"
              items={efforts}
              value={effort}
              onChange={onEffort}
            />
          )}
          <ChipSelect
            label={permissionLabel(permissionMode)}
            title="Permissions"
            items={[...PERMISSION_MODES]}
            value={permissionMode}
            onChange={onPermission}
          />
          <div className="min-w-0 flex-1" />
          <button
            type="button"
            onClick={onOpenFolder}
            title={workspace || "Open folder"}
            className="flex max-w-[38%] items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-wash hover:text-ink"
          >
            <Symbol name="folder.fill" className="size-3 text-accent" />
            <span className="truncate">{workspace ? folderName(workspace) : "Folder"}</span>
          </button>
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-err text-white hover:bg-err/90"
            >
              <Symbol name="stop.fill" className="size-2.5" />
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!canSend}
            aria-label={busy ? "Queue" : "Send"}
            title={busy ? "Queue" : "Send"}
            className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover disabled:bg-wash-strong disabled:text-muted disabled:opacity-70"
          >
            <Symbol name="arrow.up" className="size-3.5" />
          </button>
        </div>
      </div>
    </form>
  );
}

function MentionField({
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
  onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const pad = compact ? "px-3.5 pt-3 pb-1.5" : "px-4 pt-3.5 pb-2";
  const type = "m-0 whitespace-pre-wrap break-words border-0 font-sans text-[14px] leading-relaxed";
  const spans = draftMentionSpans(draft, files);
  let cursor = 0;
  const parts: ReactNode[] = [];
  spans.forEach((span, index) => {
    if (span.start > cursor) {
      parts.push(
        <span key={`gap-${cursor}`} className="text-transparent">
          {draft.slice(cursor, span.start)}
        </span>,
      );
    }
    parts.push(
      <span key={`${span.start}-${index}`} className="rounded-[3px] bg-panel text-accent">
        {draft.slice(span.start, span.end)}
      </span>,
    );
    cursor = span.end;
  });
  if (cursor < draft.length) {
    parts.push(
      <span key={`tail-${cursor}`} className="text-transparent">
        {draft.slice(cursor)}
      </span>,
    );
  }
  if (draft.endsWith("\n")) parts.push(" ");

  useLayoutEffect(() => {
    const from = area.current;
    const to = mirror.current;
    if (!from || !to) return;
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

  return (
    <div className="relative">
      <div ref={mirror} aria-hidden className={`pointer-events-none absolute top-0 left-0 z-[2] overflow-hidden ${type}`}>
        {draft && spans.length ? parts : null}
      </div>
      <textarea
        ref={area}
        value={draft}
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
        onPaste={(e) => {
          const pasted = imageFilesFromClipboard(e.clipboardData) as File[];
          if (!pasted.length) return;
          e.preventDefault();
          onPasteFiles(pasted);
        }}
        onKeyDown={onKey}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        rows={1}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className={`relative z-[1] block w-full resize-none overflow-y-auto bg-transparent text-ink caret-ink outline-none placeholder:text-muted/80 ${type} ${pad}`}
      />
    </div>
  );
}

function ChipSelect({
  label,
  title,
  items,
  value,
  onChange,
}: {
  label: string;
  title: string;
  items: DevEffort[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: globalThis.KeyboardEvent) {
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
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        <span className="max-w-[132px] truncate">{label}</span>
        <Symbol name="chevron.down" className="size-2.5 opacity-70" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-1 min-w-[168px] overflow-hidden rounded-lg border border-line bg-canvas py-1 shadow-card"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
              className={`flex w-full items-center px-2.5 py-1.5 text-left text-[12px] hover:bg-inset ${
                item.id === value ? "font-medium text-ink" : "text-ink/80"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
