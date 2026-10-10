import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { folderName, type ChatImage } from "../lib/core";
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
import { textareaFitHeight } from "../lib/composer-size";
import { PERMISSION_MODES, permissionLabel, parsePermissionMode } from "../lib/permission";
import pcmCaptureUrl from "../lib/pcm-capture-processor.js?url";
import { audioInputDevices, encodeWav, loadMicDevice, micAudioConstraints, micLevel, saveMicDevice, voiceBars, type MicDevice } from "../lib/speech";
import { todosAreOpen, type AgentTodo } from "../lib/todo";
import type { Effort, Model } from "../lib/tauri";
import { AnchoredMenu } from "./ContextMenu";
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
  pastes = [],
  onPastes,
  todos = [],
  onDictate,
  onDictateError,
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
  models: Model[];
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
  pastes?: PasteBlock[];
  onPastes?: (pastes: PasteBlock[]) => void;
  todos?: AgentTodo[];
  onDictate?: (blob: Blob, mime: string) => Promise<((draft: string, start: number, end: number) => { text: string; cursor: number }) | null>;
  onDictateError?: (message: string) => void;
}) {
  const ordered = [
    ...models.filter((row) => row.provider !== "anthropic"),
    ...models.filter((row) => row.provider === "anthropic"),
  ];
  const selected = ordered.find((m) => m.id === model) ?? ordered[0];
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
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micMenu, setMicMenu] = useState<{ x: number; y: number } | null>(null);
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
      setMicMenu(null);
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") setMicMenu(null);
    }
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [micMenu]);

  async function openMicMenu(x: number, y: number) {
    setMicDeviceId(loadMicDevice());
    setMicMenu({ x, y });
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
    setMicMenu(null);
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
          pastes={pastes}
          onPastes={changePastes}
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
            items={ordered.map((m) => ({ id: m.id, label: m.name }))}
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
          {recording ? <VoiceMeter level={voiceLevel} /> : null}
          {onDictate ? (
            <button
              type="button"
              onClick={() => {
                if (recording) finishRecording();
                else void startRecording();
              }}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                void openMicMenu(ev.clientX, ev.clientY);
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
          {micMenu ? (
            <AnchoredMenu x={micMenu.x} y={micMenu.y} label="Microphone">
              <MicChoice label="System default" selected={micDeviceId === ""} onPick={() => pickMic("")} />
              {micDevices.map((device) => (
                <MicChoice
                  key={device.id}
                  label={device.label}
                  selected={device.id === micDeviceId}
                  onPick={() => pickMic(device.id)}
                />
              ))}
            </AnchoredMenu>
          ) : null}
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

function MicChoice({ label, selected, onPick }: { label: string; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onPick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-inset ${
        selected ? "font-medium text-ink" : "text-ink/80"
      }`}
    >
      <Symbol name={selected ? "checkmark" : "mic"} className={`size-3 shrink-0 ${selected ? "text-accent" : "text-muted"}`} />
      <span className="min-w-0 truncate">{label}</span>
    </button>
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
  items: Effort[];
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
