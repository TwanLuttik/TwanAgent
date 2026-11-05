import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import * as api from "../../lib/tauri";
import type { SpeechModelStatus } from "../../lib/tauri";
import {
  SPEECH_MODELS,
  loadMicDevice,
  micAudioConstraints,
  meterLevel,
  saveMicDevice,
  speechModel,
  speechNote,
  speechSizeLabel,
  type MicDevice,
  type SpeechModelInfo,
} from "../../lib/speech";
import { useApp } from "../../state/app-state";
import { fieldClass } from "./SettingsChrome";

function speechRowStatus(models: SpeechModelInfo[], id: string): SpeechModelStatus {
  return models.find((row) => row.id === id)?.status ?? "missing";
}

export function VoiceModelCard({
  modelId,
  models,
  progress,
  downloading,
}: {
  modelId: string;
  models: SpeechModelInfo[];
  progress?: { id?: string; received: number; total: number } | null;
  downloading?: boolean;
}) {
  const model = speechModel(modelId);
  const status = speechRowStatus(models, model.id);
  const active = downloading && (!progress?.id || progress.id === model.id);
  return (
    <div className="px-3.5 py-2.5">
      <div className="text-[13px] font-medium text-ink">{model.label}</div>
      <div className="mt-0.5 text-[12px] leading-snug text-muted">{speechNote(model.id)}</div>
      <div className="mt-1 text-[12px] text-muted">
        {speechSizeLabel(model.bytes)} · {voiceStatusText(status, active ? progress : null, active)}
      </div>
    </div>
  );
}

export function MicTest() {
  const { setFlash } = useApp();
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [deviceId, setDeviceId] = useState(loadMicDevice);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    const rows = await navigator.mediaDevices.enumerateDevices();
    const mics = rows
      .filter((row) => row.kind === "audioinput")
      .map((row, index) => ({
        id: row.deviceId,
        label: row.label || `Microphone ${index + 1}`,
      }));
    setDevices(mics);
  }, []);

  useEffect(() => {
    void refreshDevices().catch(() => undefined);
  }, [refreshDevices]);

  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  async function startTest() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setFlash({ kind: "err", text: "Allow the microphone to test it." });
      return;
    }
    const info = await api.microphoneInfo().catch(() => null);
    if (!info?.ready) {
      setFlash({
        kind: "err",
        text: info?.reason || "This build cannot use the microphone yet. Quit TwanAgent and open it again from a new build.",
      });
      return;
    }
    stopRef.current?.();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints(deviceId) });
    } catch {
      setFlash({ kind: "err", text: "Allow the microphone to test it." });
      return;
    }
    await refreshDevices().catch(() => undefined);
    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      stream.getTracks().forEach((track) => track.stop());
      setFlash({ kind: "err", text: "This browser cannot test the microphone." });
      return;
    }
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* the meter still reads once the context starts */
      }
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    const samples = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    let peak = 0;
    let frame = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      const next = meterLevel(samples);
      peak = Math.max(peak * 0.82, next);
      setLevel(peak);
      if (next > 0.12) setHeard(true);
      frame = requestAnimationFrame(tick);
    };
    setHeard(false);
    setLevel(0);
    setTesting(true);
    frame = requestAnimationFrame(tick);
    stopRef.current = () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
      stopRef.current = null;
      setTesting(false);
      setLevel(0);
    };
  }

  return (
    <div className="grid gap-2">
      <label className="grid gap-1.5">
        <select
          aria-label="Microphone"
          value={devices.some((row) => row.id === deviceId) ? deviceId : ""}
          onChange={(event) => {
            const next = event.target.value;
            setDeviceId(next);
            saveMicDevice(next);
            if (testing) {
              stopRef.current?.();
              void startTest();
            }
          }}
          className={fieldClass}
        >
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.id || "default"} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="h-2 overflow-hidden rounded-full bg-wash">
            <div
              className={`h-full rounded-full ${heard ? "bg-ok" : "bg-accent"}`}
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
          <p className="mt-1 mb-0 text-[12px] text-muted">
            {testing ? (heard ? "Hearing you." : "Speak to see the level move.") : "Check that the selected mic hears you."}
          </p>
        </div>
        <Button
          onClick={() => {
            if (testing) stopRef.current?.();
            else void startTest();
          }}
        >
          {testing ? "Stop" : "Test mic"}
        </Button>
      </div>
    </div>
  );
}

export function VoiceModelDialog({
  currentId,
  models,
  progress,
  downloading,
  onClose,
  onUse,
  onDownload,
}: {
  currentId: string;
  models: SpeechModelInfo[];
  progress?: { id?: string; received: number; total: number } | null;
  downloading: boolean;
  onClose: () => void;
  onUse: (id: string) => void;
  onDownload: (id: string) => void;
}) {
  const [picked, setPicked] = useState(currentId);
  const status = speechRowStatus(models, picked);
  const active = downloading && (!progress?.id || progress.id === picked);
  const ready = status === "ready";

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-labelledby="voice-model-title"
        className="grid w-full max-w-[420px] gap-3 rounded-xl border border-line bg-canvas p-4 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div>
          <h3 id="voice-model-title" className="m-0 text-[15px] font-semibold">
            Add a voice model
          </h3>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">
            Pick a free model. It downloads once and stays on this Mac.
          </p>
        </div>
        <div className="grid gap-1.5" role="listbox" aria-label="Voice models">
          {SPEECH_MODELS.map((model) => {
            const rowStatus = speechRowStatus(models, model.id);
            const on = picked === model.id;
            return (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => setPicked(model.id)}
                className={`rounded-md border px-3 py-2 text-left ${
                  on ? "border-accent bg-wash" : "border-line hover:bg-wash"
                }`}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-medium text-ink">{model.label}</span>
                  <span className="shrink-0 text-[11px] text-muted">{speechSizeLabel(model.bytes)}</span>
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{speechNote(model.id)}</span>
                <span className="mt-1 block text-[11px] text-muted">
                  {rowStatus === "ready" ? "Downloaded" : rowStatus === "partial" ? "Download incomplete" : "Not downloaded"}
                  {model.id === currentId ? " · In use" : ""}
                </span>
              </button>
            );
          })}
        </div>
        {active && progress && progress.total > 0 ? (
          <div className="grid gap-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-wash">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, Math.round((progress.received / progress.total) * 100))}%` }}
              />
            </div>
            <span className="text-[11px] text-muted">{voiceStatusText(status, progress, true)}</span>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {ready ? (
            <Button variant="primary" onClick={() => onUse(picked)}>
              Use model
            </Button>
          ) : (
            <Button variant="primary" disabled={active} onClick={() => onDownload(picked)}>
              {active ? "Downloading…" : status === "partial" ? "Resume download" : "Download"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function voiceStatusText(
  status: SpeechModelStatus | undefined,
  progress: { received: number; total: number } | null | undefined,
  downloading: boolean | undefined,
): string {
  if (downloading && progress && progress.total > 0) {
    return `Downloading… ${speechSizeLabel(progress.received)} / ${speechSizeLabel(progress.total)}`;
  }
  if (status === "ready") return "Ready";
  if (status === "partial") return "Download incomplete";
  return "Not downloaded";
}
