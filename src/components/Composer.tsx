import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ProjectGroupRow } from "../lib/all-projects";
import { folderName, projectKey, type ChatImage, type ProjectRow } from "../lib/core";
import { applyMention, filterMentionFiles, mentionAtCursor, type MentionFile } from "../lib/mention";
import {
  applyProjectMention,
  filterMentionProjects,
  mentionProjectsFor,
  projectMentionAtCursor,
  type MentionProject,
} from "../lib/project-mention";
import { expandPasteTokens, pasteBeforeCursor, removePasteSpan, type PasteBlock } from "../lib/paste";
import {
  canSendPrompt,
  imageBeforeCursor,
  attachmentFilesFromDrop,
  removeImageSpan,
  removeImageTokens,
} from "../lib/image";
import { contextWindowChoices, contextWindowLabel, type ChatUsage } from "../lib/context";
import { isOpenAiModel } from "../lib/model-providers/openai";
import { openaiSpeedChoice, openaiSpeedLabel, openaiSpeedsFor } from "../lib/openai-speed";
import { loadOpenAiSpeed, saveOpenAiSpeed } from "../lib/prefs";
import { shouldRemeasureComposer, textareaFitHeight } from "../lib/composer-size";
import { PERMISSION_MODES, permissionLabel, parsePermissionMode } from "../lib/permission";
import { openMicCapture, pushVoiceTrace, VOICE_TRACE, type MicCapture } from "../lib/mic-capture";
import { audioInputDevices, encodeWav, loadMicDevice, micAudioConstraints, saveMicDevice, type MicDevice } from "../lib/speech";
import { commandRunVisible, useCommandRun } from "../lib/command-run";
import { todosAreOpen, type AgentTodo } from "../lib/todo";
import type { Model } from "../lib/tauri";
import { CommandRunPill } from "./CommandRunPill";
import { ContextUsageChip, ContextUsageReadout } from "./ContextUsageChip";
import { PromptImages } from "./PromptImages";
import { Symbol } from "./Symbol";
import { TodoSteps } from "./TodoSteps";
import { ChipSelect, MicSelect, PlanToggle, VoiceWave } from "./composer/ComposerChips";
import { MentionField, MentionMenu, type MentionMenuRow } from "./composer/MentionField";
import { ModelSelect, orderModels } from "./composer/ModelSelect";
import { ProjectSelect } from "./composer/ProjectSelect";
import { WorktreeBar } from "./composer/WorktreeBar";

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
  projectGroups = [],
  showProject = true,
  onOpenProject,
  onOpenWorktree,
  worktreeLocked = false,
  showWorkspaceName = true,
  onCreateWorktree,
  suggestedWorktree = "",
  onOpenPullRequest,
  checkingOutPullRequest = 0,
  onOpenFolder,
  models,
  model,
  onModel,
  /** A cloud project only runs a model when that provider key was copied to the server. */
  lockedProviders,
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
  /** Groups whose members should appear under the group in the project menu. */
  projectGroups?: ProjectGroupRow[];
  /** Hidden once the open chat already has messages. A saved chat cannot move projects. */
  showProject?: boolean;
  onOpenProject?: (path: string) => void;
  /** Switch the open folder to another checkout of the same repo. */
  onOpenWorktree?: (path: string) => void;
  /** A saved chat keeps its checkout. The worktree name stays, without a menu. */
  worktreeLocked?: boolean;
  /** False when the worktree bar already shows this folder, so the name is not repeated. */
  showWorkspaceName?: boolean;
  /** Create a checkout. An empty name means the model should name it from the first message. */
  onCreateWorktree?: (branch: string) => void;
  /** Fetch an open pull request into a worktree, then open that folder. */
  onOpenPullRequest?: (number: number) => void;
  /** The pull request being fetched. Zero when nothing is loading. */
  checkingOutPullRequest?: number;
  /** Branch the model suggested for this chat, used when the name field is left empty. */
  suggestedWorktree?: string;
  onOpenFolder: () => void;
  models: Model[];
  model: string;
  onModel: (id: string) => void;
  /** Set on a cloud project. Models outside this list cannot run there. */
  lockedProviders?: string[] | null;
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
  const [speed, setSpeed] = useState(() => openaiSpeedChoice(model, loadOpenAiSpeed()));
  useEffect(() => {
    const next = openaiSpeedChoice(model, speed);
    if (next === speed) return;
    setSpeed(next);
    saveOpenAiSpeed(next);
  }, [model, speed]);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micMenu, setMicMenu] = useState(false);
  const [micDevices, setMicDevices] = useState<MicDevice[]>([]);
  const [micDeviceId, setMicDeviceId] = useState(loadMicDevice);
  const recordStream = useRef<MediaStream | null>(null);
  const recordContext = useRef<AudioContext | null>(null);
  const recordCapture = useRef<MicCapture | null>(null);
  const recordChunks = useRef<Float32Array[]>([]);
  const recordSelection = useRef({ start: 0, end: 0 });
  const discardRecording = useRef(false);
  const recordingRef = useRef(false);
  const recordGeneration = useRef(0);
  const voiceTrace = useRef<Float32Array | null>(null);
  const voiceWritten = useRef(0);
  const [cursor, setCursor] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const mentionProjects = useMemo(
    () => mentionProjectsFor(workspace, projects, projectGroups),
    [workspace, projects, projectGroups],
  );
  const mention = mentionClosed ? null : mentionAtCursor(draft, cursor);
  const projectMention = mentionClosed ? null : projectMentionAtCursor(draft, cursor);
  const fileRows = mention ? filterMentionFiles(mentionFiles, mention.query) : [];
  const projectRows = projectMention ? filterMentionProjects(mentionProjects, projectMention.query) : [];
  const menuRows: MentionMenuRow[] = projectMention
    ? projectRows.map((project) => ({
        key: project.path,
        name: project.token,
        detail: project.path,
        icon: "folder" as const,
      }))
    : fileRows.map((file) => ({
        key: file.path,
        name: file.name,
        detail: file.path,
        icon: "file" as const,
      }));
  const canSend = canSendPrompt(expandPasteTokens(draft, pastes), images) && ready;
  const showUsage = Boolean(usage && usageWindow);
  const commandRun = useCommandRun(commandChatId ?? "");
  const showCommand = commandRunVisible(commandRun);

  function stopMic() {
    recordCapture.current?.stop();
    recordCapture.current = null;
    recordStream.current?.getTracks().forEach((track) => track.stop());
    recordStream.current = null;
    const ctx = recordContext.current;
    recordContext.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }

  function finishRecording() {
    recordGeneration.current += 1;
    if (!recordingRef.current) return;
    recordingRef.current = false;
    const chunks = recordChunks.current;
    const rate = recordCapture.current?.sampleRate ?? recordContext.current?.sampleRate ?? 48_000;
    const keep = !discardRecording.current;
    stopMic();
    setRecording(false);
    voiceWritten.current = 0;
    recordChunks.current = [];
    if (!keep || !onDictate) return;
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!length) {
      onDictateError?.("The microphone did not pick up any audio.");
      return;
    }
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
    const generation = recordGeneration.current + 1;
    recordGeneration.current = generation;
    const chosen = loadMicDevice();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints(chosen) });
    } catch {
      if (!chosen) {
        onDictateError?.("Allow the microphone to dictate.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints("") });
      } catch {
        onDictateError?.("Allow the microphone to dictate.");
        return;
      }
    }
    if (recordGeneration.current !== generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      stream.getTracks().forEach((track) => track.stop());
      onDictateError?.("Could not open the microphone.");
      return;
    }
    const ctx = new AudioCtx();
    recordChunks.current = [];
    voiceTrace.current = new Float32Array(VOICE_TRACE);
    voiceWritten.current = 0;
    let capture: MicCapture;
    try {
      capture = await openMicCapture(
        ctx,
        stream,
        (samples) => {
          if (!recordingRef.current) return;
          recordChunks.current.push(samples);
        },
        (level) => {
          const trace = voiceTrace.current;
          if (!trace || !recordingRef.current) return;
          voiceWritten.current = pushVoiceTrace(trace, voiceWritten.current, level);
        },
      );
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
      onDictateError?.("Could not open the microphone.");
      return;
    }
    if (recordGeneration.current !== generation) {
      capture.stop();
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
      return;
    }
    const el = area.current;
    recordSelection.current = {
      start: el?.selectionStart ?? draft.length,
      end: el?.selectionEnd ?? draft.length,
    };
    discardRecording.current = false;
    recordCapture.current = capture;
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
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [recording]);

  useEffect(() => {
    return () => {
      discardRecording.current = true;
      recordGeneration.current += 1;
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

  function acceptsFileDrag(ev: DragEvent<HTMLDivElement>): boolean {
    return [...ev.dataTransfer.types].includes("Files");
  }

  // Enter and leave also fire for children. Clearing on the first leave made the
  // highlight sway while the pointer moved across the images already in the field.
  function onDragEnter(ev: DragEvent<HTMLDivElement>) {
    if (!acceptsFileDrag(ev)) return;
    ev.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }

  function onDragOver(ev: DragEvent<HTMLDivElement>) {
    if (!acceptsFileDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    if (dragDepth.current === 0) dragDepth.current = 1;
    setDragOver(true);
  }

  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    const depth = dragDepth.current;
    requestAnimationFrame(() => {
      if (dragDepth.current === depth) setDragOver(depth > 0);
    });
  }

  function onDrop(ev: DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    takeImageFiles(attachmentFilesFromDrop(ev.dataTransfer.files) as File[]);
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

  function placeMentionCursor(cursor: number) {
    setCursor(cursor);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }

  function pickMention(file: MentionFile) {
    if (!mention) return;
    const next = applyMention(draft, mention, file);
    onDraft(next.text);
    placeMentionCursor(next.cursor);
  }

  function pickProject(project: MentionProject) {
    if (!projectMention) return;
    const next = applyProjectMention(draft, projectMention, project);
    onDraft(next.text);
    placeMentionCursor(next.cursor);
  }

  function pickMenuRow(row: MentionMenuRow) {
    if (projectMention) {
      const project = projectRows.find((item) => item.path === row.key);
      if (project) pickProject(project);
      return;
    }
    const file = fileRows.find((item) => item.path === row.key);
    if (file) pickMention(file);
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
      const start = e.currentTarget.selectionStart ?? 0;
      const end = e.currentTarget.selectionEnd ?? 0;
      const imageSpan = imageBeforeCursor(draft, start, end, images);
      if (imageSpan) {
        e.preventDefault();
        const next = removeImageSpan(draft, imageSpan);
        onImages?.(images.filter((img) => img.id !== imageSpan.id));
        onDraft(next.text);
        setCursor(next.cursor);
        requestAnimationFrame(() => {
          const el = area.current;
          if (!el) return;
          el.setSelectionRange(next.cursor, next.cursor);
        });
        return;
      }
      const span = pasteBeforeCursor(draft, start, end, pastes);
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
    if (menuRows.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((index) => (index + step + menuRows.length) % menuRows.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const row = menuRows[Math.min(mentionIndex, menuRows.length - 1)];
        if (row) pickMenuRow(row);
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
        <div className="pb-2">
          <CommandRunPill key={commandRun.id} run={commandRun} />
        </div>
      ) : null}
      <div className="relative">
      <div
        className={`relative border bg-panel transition-colors duration-200 ease-out focus-within:border-accent/30 ${
          dragOver ? "border-accent/55" : "border-line/35"
        } ${compact ? "rounded-2xl" : "rounded-[22px] shadow-card"}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
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
              className="overflow-visible"
            >
              <TodoSteps
                todos={todos}
                compact={compact}
                meter={
                  usage && usageWindow ? (
                    <ContextUsageReadout usage={usage} windowSize={usageWindow} expanded={usageHover} inline />
                  ) : null
                }
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
        {usage && usageWindow ? (
          <ContextUsageChip usage={usage} windowSize={usageWindow} />
        ) : null}
        {images.length ? (
          <div className={compact ? "px-3.5 pt-2.5" : "px-4 pt-3"}>
            <PromptImages
              images={images}
              onRemove={
                onImages
                  ? (id) => {
                      const image = images.find((img) => img.id === id);
                      if (image) onDraft(removeImageTokens(draft, image));
                      onImages(images.filter((img) => img.id !== id));
                    }
                  : undefined
              }
            />
          </div>
        ) : null}
        {dragOver ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-panel/80 text-[13px] text-ink">
            Drop files
          </div>
        ) : null}
        <MentionMenu
          open={menuRows.length > 0}
          anchor={area}
          cursor={cursor}
          rows={menuRows}
          index={mentionIndex}
          label={projectMention ? "Projects" : "Files"}
          onIndex={setMentionIndex}
          onPick={pickMenuRow}
        />
        <MentionField
          draft={draft}
          files={mentionFiles}
          projects={mentionProjects}
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
          chatId={commandChatId}
          images={images}
          pastes={pastes}
          onPastes={changePastes}
          onKey={onKey}
          onMouseEnter={() => {
            if (showUsage) setUsageHover(true);
          }}
          onMouseLeave={() => setUsageHover(false)}
        />
        <div className={`flex items-center gap-0.5 ${compact ? "px-1.5 pb-1.5" : "px-2 pb-2"}`}>
          <ModelSelect models={ordered} value={model} onChange={onModel} lockedProviders={lockedProviders} />
          {isOpenAiModel(model) ? (
            <ChipSelect
              label={openaiSpeedLabel(speed)}
              title="Speed"
              items={openaiSpeedsFor(model)}
              value={speed}
              onChange={(id) => {
                const next = openaiSpeedChoice(model, id);
                setSpeed(next);
                saveOpenAiSpeed(next);
              }}
            />
          ) : null}
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
          {!showProject && workspace && showWorkspaceName ? (
            <span
              title={workspace}
              className="pointer-events-none max-w-[9rem] select-none truncate px-1.5 text-[11px] text-muted"
            >
              {projects?.find((row) => projectKey(row.path) === projectKey(workspace))?.name || folderName(workspace)}
            </span>
          ) : null}
          <AnimatePresence initial={false}>
            {recording ? (
              <motion.div
                key="voice-wave"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 44 }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: TODO_DURATION, ease: TODO_EASE }}
                className="flex min-w-0 shrink-0 justify-end overflow-hidden"
              >
                <VoiceWave trace={voiceTrace} written={voiceWritten} />
              </motion.div>
            ) : null}
          </AnimatePresence>
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
              className={`flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-wash ${
                recording ? "text-accent" : "text-muted hover:text-ink"
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
          {showProject ? (
            <ProjectSelect
              workspace={workspace}
              projects={projects}
              groups={projectGroups}
              onOpen={onOpenProject ?? (() => onOpenFolder())}
              onNew={onOpenFolder}
            />
          ) : null}
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="ml-0.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-err text-white hover:bg-err/90"
            >
              <Symbol name="stop.fill" className="size-2.5" />
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!canSend}
            aria-label={busy ? "Queue" : "Send"}
            title={busy ? "Queue" : "Send"}
            className="ml-0.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover disabled:cursor-default disabled:bg-wash-strong disabled:text-muted disabled:opacity-70"
          >
            <Symbol name="arrow.up" className="size-3.5" />
          </button>
        </div>
      </div>
      {usage && usageWindow && !todosAreOpen(todos) ? (
        <ContextUsageReadout usage={usage} windowSize={usageWindow} expanded={usageHover} />
      ) : null}
      </div>
      {onOpenWorktree ? (
        <WorktreeBar
          workspace={workspace}
          suggested={suggestedWorktree}
          onOpen={onOpenWorktree}
          locked={worktreeLocked}
          onCreate={onCreateWorktree}
          onOpenPullRequest={onOpenPullRequest}
          checkingOut={checkingOutPullRequest}
        />
      ) : null}
    </form>
  );
}
