import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { filterProjectRows, folderName, projectKey, type ChatImage, type ProjectRow } from "../lib/core";
import { applyMention, draftMentionSpans, filterMentionFiles, mentionAtCursor, type MentionFile } from "../lib/mention";
import {
  expandPasteTokens,
  flattenPasteToken,
  insertCollapsedPaste,
  PASTE_MIN,
  pasteBeforeCursor,
  pasteSpans,
  removePasteSpan,
  replacePasteToken,
  type PasteBlock,
} from "../lib/paste";
import { canSendPrompt, imageFilesFromClipboard, imageFilesFromDrop } from "../lib/image";
import { contextWindowChoices, contextWindowLabel, type ChatUsage } from "../lib/context";
import { shouldRemeasureComposer, textareaFitHeight } from "../lib/composer-size";
import { PERMISSION_MODES, permissionLabel, parsePermissionMode } from "../lib/permission";
import { groupModelFamilies, modelFamilyName, sharedModelCapabilities } from "../lib/model-family";
import { providerProfile, type ProviderId } from "../lib/provider";
import pcmCaptureUrl from "../lib/pcm-capture-processor.js?url";
import { audioInputDevices, encodeWav, loadMicDevice, micAudioConstraints, micLevel, saveMicDevice, voiceBars, type MicDevice } from "../lib/speech";
import { commandRunVisible, useCommandRun } from "../lib/command-run";
import { todosAreOpen, type AgentTodo } from "../lib/todo";
import type { Effort, Model } from "../lib/tauri";
import { CommandRunPill } from "./CommandRunPill";
import { ContextUsageChip } from "./ContextUsageChip";
import { FileIcon } from "./FileIcon";
import { PromptImages } from "./PromptImages";
import { Symbol } from "./Symbol";
import { TodoSteps } from "./TodoSteps";

const TODO_EASE = [0.22, 1, 0.36, 1] as const;
const TODO_DURATION = 0.32;

const COMPACT_MAX = 160;
const LANDING_MAX = 220;

export function Composer({
  draft,
  onDraft,
  onSend,
  onStop,
  busy,
  ready,
  placeholder,
  workspace,
  projects = [],
  onOpenProject,
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
  planMode,
  onPlanMode,
  autoFocus,
  compact,
  usage,
  usageWindow,
  images = [],
  onImages,
  onAddImages,
  mentionFiles = [],
  pastes = [],
  onPastes,
  todos = [],
  onDictate,
  onDictateError,
  commandChatId = "",
}: {
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  busy: boolean;
  ready: boolean;
  placeholder: string;
  workspace: string;
  /** Known projects. When present, the folder chip opens this list instead of the new-project dialog. */
  projects?: ProjectRow[];
  onOpenProject?: (path: string) => void;
  onOpenFolder: () => void;
  models: Model[];
  model: string;
  onModel: (id: string) => void;
  effort: string;
  onEffort: (id: string) => void;
  contextWindow?: number;
  onContextWindow?: (tokens: number) => void;
  permission: string;
  onPermission: (id: string) => void;
  /** Grok chats only. Omitted for Claude, which has no plan mode here. */
  planMode?: "off" | "pending" | "on";
  onPlanMode?: (mode: "off" | "pending" | "on") => void;
  autoFocus?: boolean;
  compact?: boolean;
  usage?: ChatUsage | null;
  usageWindow?: number;
  images?: ChatImage[];
  onImages?: (images: ChatImage[]) => void;
  onAddImages?: (files: File[]) => void;
  mentionFiles?: MentionFile[];
  pastes?: PasteBlock[];
  onPastes?: (pastes: PasteBlock[]) => void;
  todos?: AgentTodo[];
  onDictate?: (blob: Blob, mime: string) => Promise<((draft: string, start: number, end: number) => { text: string; cursor: number }) | null>;
  onDictateError?: (message: string) => void;
  /** Chat whose running command is pinned above this input. Empty hides it. */
  commandChatId?: string;
}) {
  const ordered = orderModels(models);
  const selected = ordered.find((m) => m.id === model) ?? ordered[0];
  const efforts = selected?.efforts ?? [];
  const effortLabel = efforts.find((e) => e.id === effort)?.label ?? "Thinking";
  const windows = contextWindowChoices(selected?.context_windows, selected?.context_window);
  const windowLabel = contextWindow && windows.includes(contextWindow) ? contextWindowLabel(contextWindow) : "";
  const permissionMode = parsePermissionMode(permission);
  const box = useRef<HTMLFormElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const [usageHover, setUsageHover] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micMenu, setMicMenu] = useState(false);
  const [micDevices, setMicDevices] = useState<MicDevice[]>([]);
  const [micDeviceId, setMicDeviceId] = useState(loadMicDevice);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const voiceLevelRef = useRef(0);
  const recordStream = useRef<MediaStream | null>(null);
  const recordContext = useRef<AudioContext | null>(null);
  const recordChunks = useRef<Float32Array[]>([]);
  const recordSelection = useRef({ start: 0, end: 0 });
  const discardRecording = useRef(false);
  const recordingRef = useRef(false);
  const [cursor, setCursor] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const mention = mentionClosed ? null : mentionAtCursor(draft, cursor);
  const mentionRows = mention ? filterMentionFiles(mentionFiles, mention.query) : [];
  const canSend = canSendPrompt(expandPasteTokens(draft, pastes), images) && ready;
  const showUsage = Boolean(usage && usageWindow);
  const commandRun = useCommandRun(commandChatId ?? "");
  const showCommand = commandRunVisible(commandRun);

  function stopMic() {
    recordStream.current?.getTracks().forEach((track) => track.stop());
    recordStream.current = null;
    const ctx = recordContext.current;
    recordContext.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }

  function finishRecording() {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    const chunks = recordChunks.current;
    const rate = recordContext.current?.sampleRate ?? 48_000;
    const keep = !discardRecording.current;
    stopMic();
    setRecording(false);
    setVoiceLevel(0);
    voiceLevelRef.current = 0;
    recordChunks.current = [];
    if (!keep || !onDictate) return;
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!length) return;
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    const blob = encodeWav(samples, rate);
    const selection = recordSelection.current;
    setTranscribing(true);
    void onDictate(blob, "audio/wav")
      .then((apply) => {
        if (!apply) return;
        const current = area.current?.value ?? draft;
        const next = apply(current, selection.start, selection.end);
        onDraft(next.text);
        requestAnimationFrame(() => {
          const node = area.current;
          if (!node) return;
          node.focus();
          node.setSelectionRange(next.cursor, next.cursor);
        });
      })
      .catch((err) => onDictateError?.(String(err)))
      .finally(() => setTranscribing(false));
  }

  async function startRecording() {
    if (recordingRef.current || transcribing || !onDictate) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onDictateError?.("Allow the microphone to dictate.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints(loadMicDevice()) });
    } catch {
      onDictateError?.("Allow the microphone to dictate.");
      return;
    }
    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      stream.getTracks().forEach((track) => track.stop());
      onDictateError?.("This browser recorded a format the local model cannot read.");
      return;
    }
    const ctx = new AudioCtx();
    try {
      await ctx.audioWorklet.addModule(pcmCaptureUrl);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
      onDictateError?.("This browser recorded a format the local model cannot read.");
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(ctx, "pcm-capture");
    recordChunks.current = [];
    processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!recordingRef.current || !(event.data instanceof Float32Array)) return;
      recordChunks.current.push(new Float32Array(event.data));
      const next = micLevel(event.data);
      voiceLevelRef.current = Math.max(voiceLevelRef.current * 0.72, next);
    };
    source.connect(processor);
    const el = area.current;
    recordSelection.current = {
      start: el?.selectionStart ?? draft.length,
      end: el?.selectionEnd ?? draft.length,
    };
    discardRecording.current = false;
    recordStream.current = stream;
    recordContext.current = ctx;
    recordingRef.current = true;
    setRecording(true);
  }

  useEffect(() => {
    if (!recording) return;
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      discardRecording.current = true;
      finishRecording();
    }
    const timer = window.setTimeout(() => finishRecording(), 60_000);
    const meter = window.setInterval(() => setVoiceLevel(voiceLevelRef.current), 120);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(meter);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [recording]);

  useEffect(() => {
    return () => {
      discardRecording.current = true;
      recordingRef.current = false;
      stopMic();
    };
  }, []);

  useEffect(() => {
    if (!micMenu) return;
    function close() {
      setMicMenu(false);
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") setMicMenu(false);
    }
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [micMenu]);

  async function openMicMenu() {
    setMicDeviceId(loadMicDevice());
    setMicMenu(true);
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;
    try {
      const listed = audioInputDevices(await devices.enumerateDevices());
      const unlabeled = listed.length > 0 && listed.every((row) => /^Microphone \d+$/.test(row.label));
      if (!unlabeled) {
        setMicDevices(listed);
        return;
      }
      const probe = await devices.getUserMedia({ audio: true });
      probe.getTracks().forEach((track) => track.stop());
      setMicDevices(audioInputDevices(await devices.enumerateDevices()));
    } catch {
      setMicDevices([]);
    }
  }

  function pickMic(id: string) {
    saveMicDevice(id);
    setMicDeviceId(id);
    setMicMenu(false);
  }

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

  const draftLenRef = useRef(draft.length);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const max = compact ? COMPACT_MAX : LANDING_MAX;
    const prevLen = draftLenRef.current;
    draftLenRef.current = draft.length;

    function fit(remeasure: boolean) {
      const node = area.current;
      if (!node) return;
      const cs = getComputedStyle(node);
      const fontSize = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight);
      const lineHeight = Number.isFinite(lh) && cs.lineHeight !== "normal" ? lh : fontSize * 1.625;
      const paddingY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      if (remeasure) node.style.height = "0px";
      const next = textareaFitHeight({
        value: node.value,
        scrollHeight: node.scrollHeight,
        lineHeight: Number.isFinite(lineHeight) ? lineHeight : 0,
        paddingY,
        max,
      });
      const height = `${next}px`;
      if (node.style.height !== height) node.style.height = height;
    }

    fit(shouldRemeasureComposer(prevLen, draft.length, false));
    const host = box.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let width = host.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const next = host.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      fit(true);
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
    if (!canSendPrompt(expandPasteTokens(draft, pastes), images) || !ready) return;
    onSend();
  }

  function changePastes(next: PasteBlock[]) {
    onPastes?.(next);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const span = pasteBeforeCursor(draft, e.currentTarget.selectionStart ?? 0, e.currentTarget.selectionEnd ?? 0, pastes);
      if (span) {
        e.preventDefault();
        const next = removePasteSpan(draft, span);
        onPastes?.(pastes.filter((row) => row.id !== span.id));
        onDraft(next.text);
        setCursor(next.cursor);
        requestAnimationFrame(() => {
          const el = area.current;
          if (!el) return;
          el.setSelectionRange(next.cursor, next.cursor);
        });
        return;
      }
    }
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
    <form ref={box} onSubmit={submit} className="relative w-full">
      {commandRun && showCommand ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 pb-1.5">
          <div className="pointer-events-auto">
            <CommandRunPill run={commandRun} />
          </div>
        </div>
      ) : null}
      <div
        className={`relative border bg-panel transition-colors duration-200 ease-out focus-within:border-accent/30 ${
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
        <MentionMenu
          open={Boolean(mention && mentionRows.length)}
          anchor={box}
          rows={mentionRows}
          index={mentionIndex}
          onIndex={setMentionIndex}
          onPick={pickMention}
        />
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
          pastes={pastes}
          onPastes={changePastes}
          onKey={onKey}
          onMouseEnter={() => {
            if (showUsage) setUsageHover(true);
          }}
          onMouseLeave={() => setUsageHover(false)}
        />
        <div className={`flex items-center gap-0.5 ${compact ? "px-1.5 pb-1.5" : "px-2 pb-2"}`}>
          <ModelSelect models={ordered} value={model} onChange={onModel} />
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
          {onPlanMode ? (
            <PlanToggle
              mode={planMode ?? "off"}
              busy={busy}
              onToggle={() => {
                if ((planMode ?? "off") === "off") onPlanMode(busy ? "on" : "pending");
                else onPlanMode("off");
              }}
            />
          ) : null}
          <div className="min-w-0 flex-1" />
          {recording ? <VoiceMeter level={voiceLevel} /> : null}
          {onDictate ? (
            <button
              type="button"
              onClick={() => {
                if (recording) finishRecording();
                else void startRecording();
              }}
              ref={micRef}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                void openMicMenu();
              }}
              disabled={transcribing}
              aria-label={recording ? "Stop dictation" : "Dictate"}
              title={recording ? "Stop dictation" : transcribing ? "Transcribing" : "Dictate. Right-click to choose a microphone."}
              className={`flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-wash ${
                recording ? "text-err" : "text-muted hover:text-ink"
              } disabled:opacity-60`}
            >
              <Symbol name={recording ? "mic.fill" : "mic"} className="size-3.5" />
            </button>
          ) : null}
          <MicSelect
            open={micMenu}
            devices={micDevices}
            value={micDeviceId}
            anchor={micRef}
            onPick={pickMic}
            onClose={() => setMicMenu(false)}
          />
          <ProjectSelect
            workspace={workspace}
            projects={projects}
            onOpen={onOpenProject ?? (() => onOpenFolder())}
            onNew={onOpenFolder}
          />
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

function MentionMenu({
  open,
  anchor,
  rows,
  index,
  onIndex,
  onPick,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  rows: MentionFile[];
  index: number;
  onIndex: (index: number) => void;
  onPick: (file: MentionFile) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const node = anchor.current;
      const menu = panel.current;
      if (!node || !menu) return;
      const frame = node.getBoundingClientRect();
      const height = menu.getBoundingClientRect().height;
      const width = Math.min(352, Math.max(180, frame.width - 24));
      const left = Math.min(Math.max(8, frame.left + 12), window.innerWidth - width - 8);
      const gap = 4;
      const above = frame.top - height - gap >= 8;
      setBox({
        left,
        top: above ? frame.top - gap - height : frame.bottom + gap,
        width,
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, rows]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panel}
      role="listbox"
      aria-label="Files"
      style={{ left: box?.left ?? -9999, top: box?.top ?? 0, width: box?.width ?? 320, visibility: box ? "visible" : "hidden" }}
      className="fixed z-50 max-h-56 overflow-auto rounded-lg border border-line bg-canvas py-1 shadow-card"
    >
      {rows.map((file, row) => (
        <button
          key={file.path}
          type="button"
          role="option"
          aria-selected={row === index}
          onMouseEnter={() => onIndex(row)}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(file);
          }}
          className={`flex h-7 w-full cursor-pointer items-center gap-2 px-2 text-left transition-colors ${
            row === index ? "bg-accent/10 text-accent" : "text-ink/80 hover:bg-accent/10 hover:text-accent"
          }`}
        >
          <FileIcon name={file.name} className="size-3.5 shrink-0" />
          <span className="shrink-0 truncate text-[12px] leading-none">{file.name}</span>
          <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] leading-none opacity-60">
            {file.path}
          </span>
        </button>
      ))}
    </div>,
    document.body,
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
  pastes: PasteBlock[];
  onPastes: (pastes: PasteBlock[]) => void;
  onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const pad = compact ? "px-3.5 pt-3 pb-1.5" : "px-4 pt-3.5 pb-2";
  const type = "m-0 whitespace-pre-wrap break-words border-0 font-sans text-[14px] leading-relaxed";
  const spans = draftHighlightSpans(draft, files, pastes);
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
      <span
        key={`${span.start}-${index}`}
        className={`rounded-[3px] ${span.kind === "paste" ? "bg-ok/15 text-ok" : "bg-panel text-accent"}`}
      >
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
    const images = imageFilesFromClipboard(event.clipboardData) as File[];
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
        onPaste={onPasteText}
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

type HighlightSpan = { start: number; end: number; kind: "mention" | "paste" };

function draftHighlightSpans(draft: string, files: MentionFile[], pastes: PasteBlock[]): HighlightSpan[] {
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
  return [...mentions, ...pasted].sort((a, b) => a.start - b.start || a.end - b.end);
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

function VoiceMeter({ level }: { level: number }) {
  const bars = voiceBars(level);
  return (
    <span className="mr-1 flex h-4 items-center gap-[2px]" aria-hidden title="Microphone level">
      {bars.map((height, index) => (
        <span
          key={index}
          className={`w-[2px] rounded-full ${level > 0.08 ? "bg-err" : "bg-muted/50"}`}
          style={{ height: `${Math.round(height * 14)}px` }}
        />
      ))}
    </span>
  );
}

function MicSelect({
  open,
  devices,
  value,
  anchor,
  onPick,
  onClose,
}: {
  open: boolean;
  devices: MicDevice[];
  value: string;
  anchor: RefObject<HTMLButtonElement | null>;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <PopMenu open={open} anchor={anchor} label="Microphone" align="end" width={240} onClose={onClose}>
      <PopChoice
        label="System default"
        icon="mic"
        selected={value === ""}
        onPick={() => onPick("")}
      />
      {devices.map((device) => (
        <PopChoice
          key={device.id}
          label={device.label}
          icon="mic"
          selected={device.id === value}
          onPick={() => onPick(device.id)}
        />
      ))}
    </PopMenu>
  );
}

const MODEL_MENU_EASE = [0.22, 1, 0.36, 1] as const;

const MODEL_PROVIDERS: { id: ProviderId; label: string; icon: string }[] = [
  { id: "xai", label: "Grok", icon: "logo.grok" },
  { id: "anthropic", label: "Claude", icon: "logo.claude" },
  { id: "minimax", label: "MiniMax", icon: "logo.minimax" },
];

const PROVIDER_ORDER: ProviderId[] = ["xai", "minimax", "anthropic"];

function orderModels(models: Model[]): Model[] {
  return [...models].sort((a, b) => {
    const left = PROVIDER_ORDER.indexOf(modelProvider(a));
    const right = PROVIDER_ORDER.indexOf(modelProvider(b));
    return (left < 0 ? PROVIDER_ORDER.length : left) - (right < 0 ? PROVIDER_ORDER.length : right);
  });
}

function filterModels(models: Model[], query: string): Model[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) => {
    const family = modelFamilyName(model.name).family.toLowerCase();
    return (
      model.name.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle) ||
      family.includes(needle)
    );
  });
}

function modelProvider(model: Model): ProviderId {
  if (model.provider === "anthropic" || model.provider === "xai" || model.provider === "minimax") return model.provider;
  return providerProfile(model.id).id;
}

function providerIconClass(id: ProviderId, on: boolean): string {
  if (!on) return "text-muted hover:bg-wash hover:text-ink";
  if (id === "anthropic") return "bg-wash-strong text-[#d97757]";
  if (id === "minimax") return "bg-wash-strong text-[#e21680]";
  return "bg-wash-strong text-ink";
}

function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: Model[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<ProviderId | null>(() => {
    const current = models.find((row) => row.id === value);
    return current ? modelProvider(current) : null;
  });
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [menuAbove, setMenuAbove] = useState(true);
  const selected = models.find((row) => row.id === value);
  const providers = MODEL_PROVIDERS.filter((row) => models.some((model) => modelProvider(model) === row.id));
  const [providerTip, setProviderTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const needle = query.trim();
  const scoped = focus ? models.filter((model) => modelProvider(model) === focus) : models;
  const shown = filterModels(scoped, needle);
  const families = groupModelFamilies(shown);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = button.current?.getBoundingClientRect();
    if (!frame) return;
    setMenuAbove(frame.top - 320 - 6 >= 8);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    const focusSearch = window.setTimeout(() => search.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusSearch);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={button}
        type="button"
        title="Model"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => {
            if (!current) {
              if (selected) setFocus(modelProvider(selected));
              setQuery("");
            }
            return !current;
          });
        }}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        {selected ? <ModelIcon model={selected} className="size-3" /> : null}
        <span className="max-w-[132px] truncate">{selected?.name ?? "Model"}</span>
        <Symbol name="chevron.down" className="size-2.5 opacity-70" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: menuAbove ? 6 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: menuAbove ? 6 : -6 }}
            transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
            className={`absolute left-0 z-30 flex h-80 w-[420px] overflow-hidden rounded-lg border border-line/25 bg-canvas shadow-card ${
              menuAbove ? "bottom-full mb-1 origin-bottom" : "top-full mt-1 origin-top"
            }`}
          >
            <div className="flex w-9 shrink-0 flex-col gap-0.5 border-r border-line/20 bg-panel/40 p-1" role="group" aria-label="Model providers">
              {providers.map((row) => {
                const on = focus === row.id;
                return (
                  <button
                    key={row.id}
                    type="button"
                    aria-pressed={on}
                    aria-label={row.label}
                    onClick={() => setFocus((current) => (current === row.id ? null : row.id))}
                    onMouseEnter={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      setProviderTip({ label: row.label, top: box.top + box.height / 2, left: box.right + 8 });
                    }}
                    onMouseLeave={() => setProviderTip(null)}
                    className={`flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 ${providerIconClass(row.id, on)}`}
                  >
                    <Symbol name={row.icon} className="size-3.5" />
                  </button>
                );
              })}
            </div>
            {createPortal(
              <AnimatePresence>
                {providerTip ? (
                  <motion.span
                    key={providerTip.label}
                    role="tooltip"
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -4 }}
                    transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
                    style={{ top: providerTip.top, left: providerTip.left }}
                    className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-md border border-line bg-canvas px-2 py-1 text-[12px] font-medium text-ink shadow-card"
                  >
                    {providerTip.label}
                  </motion.span>
                ) : null}
              </AnimatePresence>,
              document.body,
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-line/20 px-2.5">
                <Symbol name="magnifyingglass" className="size-3.5 shrink-0 text-muted" />
                <input
                  ref={search}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const first = shown[0];
                    if (!first) return;
                    onChange(first.id);
                    setOpen(false);
                  }}
                  placeholder="Search models"
                  aria-label="Search models"
                  className="h-9 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto py-1">
              {families.length ? (
              <AnimatePresence initial={false} mode="popLayout">
                {families.map((family) => {
                  const versions = family.models.length > 1;
                  const shared = sharedModelCapabilities(family.models);
                  return (
                    <motion.div
                      key={family.key}
                      role="group"
                      aria-label={family.label}
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.14, ease: MODEL_MENU_EASE }}
                      className="py-0.5"
                    >
                      {versions ? (
                        <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium text-muted">
                          <span className="min-w-0 flex-1 truncate">{family.label}</span>
                          {shared ? <CapabilityIcons ids={shared} /> : null}
                        </div>
                      ) : null}
                      {family.models.map((row) => {
                        const current = row.id === value;
                        const context = contextWindowLabel(row.context_window ?? 0);
                        const label = versions ? modelFamilyName(row.name).version || row.name : row.name;
                        return (
                          <button
                            key={row.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={current}
                            aria-label={row.name}
                            onClick={() => {
                              onChange(row.id);
                              setOpen(false);
                            }}
                            className={`flex h-7 w-full cursor-pointer items-center gap-2 text-left text-[12px] transition-colors duration-150 hover:bg-wash ${
                              versions ? "pr-2.5 pl-6" : "px-2.5"
                            } ${current ? "font-medium text-ink" : "text-ink/80"}`}
                          >
                            <ModelIcon model={row} className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate">{label}</span>
                            {context ? (
                              <span className="shrink-0 text-[11px] font-normal text-muted tabular-nums" title={`${context} context window`}>
                                {context} ctx
                              </span>
                            ) : null}
                            <CapabilityIcons ids={row.capabilities} faded={Boolean(shared)} />
                            <Symbol
                              name="checkmark"
                              className={`size-3 shrink-0 text-accent transition-opacity duration-150 ${current ? "opacity-100" : "opacity-0"}`}
                            />
                          </button>
                        );
                      })}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              ) : (
                <p className="px-2.5 py-2 text-[12px] text-muted">
                  {needle ? "No matching models" : "No models"}
                </p>
              )}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const CAPABILITIES: { id: string; icon: string; label: string; detail: string; className: string }[] = [
  { id: "vision", icon: "photo", label: "Images", detail: "Accepts image input.", className: "text-ok" },
  { id: "pdf", icon: "doc", label: "PDFs", detail: "Reads PDF documents.", className: "text-[#d97757]" },
  { id: "thinking", icon: "brain", label: "Thinking", detail: "Can think before it answers.", className: "text-accent" },
  { id: "effort", icon: "sparkles", label: "Effort", detail: "Effort steers how thoroughly it works.", className: "text-warn" },
];

function CapabilityIcons({ ids, faded = false }: { ids?: string[] | null; faded?: boolean }) {
  const known = new Set(ids ?? []);
  const shown = CAPABILITIES.filter((row) => known.has(row.id));
  const [tip, setTip] = useState<{ label: string; detail: string; className: string; icon: string; top: number; left: number } | null>(null);
  if (!shown.length) return null;
  return (
    <span className={`flex shrink-0 items-center gap-1 ${faded ? "opacity-40" : ""}`}>
      {shown.map((row) => (
        <span
          key={row.id}
          aria-label={row.label}
          className={row.className}
          onMouseEnter={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setTip({
              label: row.label,
              detail: row.detail,
              className: row.className,
              icon: row.icon,
              top: box.top - 8,
              left: Math.min(Math.max(8, box.left - 40), window.innerWidth - 188),
            });
          }}
          onMouseLeave={() => setTip(null)}
        >
          <Symbol name={row.icon} className="size-3" />
        </span>
      ))}
      {createPortal(
        <AnimatePresence>
          {tip ? (
            <motion.span
              key={`${tip.label}-${tip.left}-${tip.top}`}
              role="tooltip"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
              style={{ top: tip.top, left: tip.left }}
              className="pointer-events-none fixed z-50 w-[180px] -translate-y-full rounded-lg border border-line bg-canvas px-2.5 py-2 text-left shadow-card"
            >
              <span className="flex items-center gap-1.5">
                <Symbol name={tip.icon} className={`size-3.5 ${tip.className}`} />
                <span className="text-[12px] font-medium text-ink">{tip.label}</span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug font-normal text-muted">{tip.detail}</span>
            </motion.span>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}

function ProjectSelect({
  workspace,
  projects,
  onOpen,
  onNew,
}: {
  workspace: string;
  projects: ProjectRow[];
  onOpen: (path: string) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [menuAbove, setMenuAbove] = useState(true);
  const needle = query.trim();
  const shown = filterProjectRows(projects, query);
  const current = projects.find((row) => projectKey(row.path) === projectKey(workspace));
  const label = current?.name || (workspace ? folderName(workspace) : "Project");

  useLayoutEffect(() => {
    if (!open) return;
    const frame = button.current?.getBoundingClientRect();
    if (!frame) return;
    setMenuAbove(frame.top - 320 - 6 >= 8);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    const focus = window.setTimeout(() => search.current?.focus(), 0);
    return () => {
      window.clearTimeout(focus);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative max-w-[38%]" ref={ref}>
      <button
        ref={button}
        type="button"
        title={workspace || "Project"}
        aria-expanded={open}
        aria-label="Project"
        onClick={() => {
          setOpen((next) => {
            if (next) return false;
            setQuery("");
            return true;
          });
        }}
        className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        <Symbol name="folder.fill" className="size-3 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <Symbol name="chevron.down" className="size-2.5 shrink-0 opacity-70" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            aria-label="Projects"
            initial={{ opacity: 0, y: menuAbove ? 6 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: menuAbove ? 6 : -6 }}
            transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
            className={`absolute right-0 z-30 flex h-80 w-[320px] flex-col overflow-hidden rounded-lg border border-line/25 bg-canvas shadow-card ${
              menuAbove ? "bottom-full mb-1 origin-bottom" : "top-full mt-1 origin-top"
            }`}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line/20 px-2.5">
              <Symbol name="magnifyingglass" className="size-3.5 shrink-0 text-muted" />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                placeholder="Search projects"
                aria-label="Search projects"
                className="h-9 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {shown.length ? (
                shown.map((row) => {
                  const selected = projectKey(row.path) === projectKey(workspace);
                  return (
                    <button
                      key={row.path}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      title={row.path}
                      onClick={() => {
                        setOpen(false);
                        if (!selected) onOpen(row.path);
                      }}
                      className={`flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left text-[12px] transition-colors duration-150 hover:bg-wash ${
                        selected ? "font-medium text-ink" : "text-ink/80"
                      }`}
                    >
                      <Symbol name="folder.fill" className={`size-3.5 shrink-0 ${selected ? "text-accent" : "text-muted"}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{row.name}</span>
                      </span>
                      {row.remote ? <Symbol name="cloud.fill" className="size-3 shrink-0 text-[#3b82f6]" /> : null}
                      <Symbol
                        name="checkmark"
                        className={`size-3 shrink-0 text-accent transition-opacity duration-150 ${selected ? "opacity-100" : "opacity-0"}`}
                      />
                    </button>
                  );
                })
              ) : (
                <p className="px-2.5 py-2 text-[12px] text-muted">{needle ? "No matching projects" : "No projects yet"}</p>
              )}
            </div>
            <div className="shrink-0 border-t border-line/20 p-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onNew();
                }}
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink/80 transition-colors duration-150 hover:bg-wash"
              >
                <Symbol name="plus" className="size-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">New project</span>
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ModelIcon({ model, className }: { model: Model; className?: string }) {
  const id = modelProvider(model);
  const symbol = id === "anthropic" ? "logo.claude" : id === "minimax" ? "logo.minimax" : "logo.grok";
  const color = id === "anthropic" ? "text-[#d97757]" : id === "minimax" ? "text-[#e21680]" : "text-current";
  return <Symbol name={symbol} className={`${className ?? "size-3.5"} shrink-0 ${color}`} />;
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
  items: Effort[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wide = items.some((item) => item.detail);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        title={title}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        <span className="max-w-[132px] truncate">{label}</span>
        <Symbol name="chevron.down" className="size-2.5 opacity-70" />
      </button>
      <PopMenu open={open} anchor={button} label={title} width={wide ? 280 : 200} onClose={() => setOpen(false)}>
        {items.map((item) => (
          <PopChoice
            key={item.id}
            label={item.label}
            detail={item.detail}
            icon={chipIcon(title, item.id)}
            selected={item.id === value}
            onPick={() => {
              onChange(item.id);
              setOpen(false);
            }}
          />
        ))}
      </PopMenu>
    </div>
  );
}

function PlanToggle({
  mode,
  busy,
  onToggle,
}: {
  mode: "off" | "pending" | "on";
  busy: boolean;
  onToggle: () => void;
}) {
  const on = mode !== "off";
  const title =
    mode === "on"
      ? busy
        ? "Plan mode is on. Click to leave it after this turn."
        : "Plan mode is on. Click to turn it off."
      : mode === "pending"
        ? "The next message will be planned. Click to cancel."
        : "Plan the next message before Grok edits anything.";
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onToggle}
      className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
        on ? "bg-accent/15 text-accent" : "text-muted hover:text-ink"
      }`}
    >
      <Symbol name="doc.fill" className="size-3" />
      <span>Plan</span>
    </button>
  );
}

function chipIcon(title: string, id: string): string | undefined {
  if (title === "Thinking") return effortIcon(id);
  if (title === "Permissions") return permissionIcon(id);
  return undefined;
}

function effortIcon(id: string): string {
  if (id === "low") return "leaf";
  if (id === "medium") return "gauge.medium";
  if (id === "high" || id === "xhigh") return "bolt";
  if (id === "max") return "sparkles";
  return "brain";
}

function permissionIcon(id: string): string {
  if (id === "approve-all") return "bolt";
  if (id === "read-only") return "eye";
  return "lock";
}

function PopMenu({
  open,
  anchor,
  label,
  align = "start",
  width,
  onClose,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  align?: "start" | "end";
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const node = anchor.current;
      const menu = panel.current;
      if (!node || !menu) return;
      const frame = node.getBoundingClientRect();
      const height = menu.getBoundingClientRect().height;
      const left = align === "end" ? frame.right - width : frame.left;
      const clamped = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      const gap = 6;
      const above = frame.top - height - gap >= 8;
      setBox({
        left: clamped,
        top: above ? frame.top - gap - height : frame.bottom + gap,
        above,
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, align, width, children]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      const target = ev.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      onClose();
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, anchor, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={panel}
          role="menu"
          aria-label={label}
          initial={{ opacity: 0, y: box?.above === false ? -6 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: box?.above === false ? -6 : 6 }}
          transition={{ duration: 0.16, ease: MODEL_MENU_EASE }}
          style={{ left: box?.left ?? -9999, top: box?.top ?? 0, width, visibility: box ? "visible" : "hidden" }}
          className={`fixed z-50 overflow-hidden rounded-lg border border-line/25 bg-canvas py-1 shadow-card ${
            box?.above === false ? "origin-top" : "origin-bottom"
          }`}
          onMouseDown={(ev) => ev.stopPropagation()}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function PopChoice({
  label,
  detail,
  icon,
  selected,
  onPick,
}: {
  label: string;
  detail?: string;
  icon?: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onPick}
      className={`flex w-full items-center gap-2 px-2.5 text-left transition-colors duration-150 hover:bg-wash ${
        detail ? "py-1.5" : "h-7"
      } ${selected ? "font-medium text-ink" : "text-ink/80"}`}
    >
      {icon ? <Symbol name={icon} className="size-3.5 shrink-0 text-muted" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]">{label}</span>
        {detail ? <span className="mt-0.5 block text-[11px] leading-snug font-normal text-muted">{detail}</span> : null}
      </span>
      <Symbol
        name="checkmark"
        className={`size-3 shrink-0 text-accent transition-opacity duration-150 ${selected ? "opacity-100" : "opacity-0"}`}
      />
    </button>
  );
}
