import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { folderName, type ChatImage } from "../lib/dev";
import { canSendPrompt, imageFilesFromClipboard, imageFilesFromDrop } from "../lib/dev-image";
import { contextWindowChoices, contextWindowLabel, type ChatUsage } from "../lib/dev-context";
import { textareaFitHeight } from "../lib/composer-size";
import { PERMISSION_MODES, permissionLabel, parsePermissionMode } from "../lib/dev-permission";
import { todosAreOpen, type AgentTodo } from "../lib/dev-todo";
import type { DevEffort, DevModel } from "../lib/tauri";
import { ContextUsageChip } from "./ContextUsageChip";
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
  const [usageHover, setUsageHover] = useState(false);
  const [dragOver, setDragOver] = useState(false);
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

  function submit(ev?: FormEvent) {
    ev?.preventDefault();
    if (!canSendPrompt(draft, images) || !ready) return;
    onSend();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
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
        <textarea
          ref={area}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onPaste={(e) => {
            const files = imageFilesFromClipboard(e.clipboardData) as File[];
            if (!files.length) return;
            e.preventDefault();
            takeImageFiles(files);
          }}
          onKeyDown={onKey}
          onMouseEnter={() => {
            if (showUsage) setUsageHover(true);
          }}
          onMouseLeave={() => setUsageHover(false)}
          rows={1}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className={`block w-full resize-none overflow-y-auto border-0 bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-muted/80 ${
            compact ? "px-3.5 pt-3 pb-1.5" : "px-4 pt-3.5 pb-2"
          }`}
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
