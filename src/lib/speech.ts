export type SpeechModel = {
  id: string;
  label: string;
  file: string;
  bytes: number;
  english: boolean;
};

export const SPEECH_MODELS: SpeechModel[] = [
  { id: "tiny.en", label: "Tiny English", file: "ggml-tiny.en.bin", bytes: 77_704_715, english: true },
  { id: "base.en", label: "Base English", file: "ggml-base.en.bin", bytes: 147_964_211, english: true },
  { id: "small.en", label: "Small English", file: "ggml-small.en.bin", bytes: 487_614_201, english: true },
  { id: "tiny", label: "Tiny multilingual", file: "ggml-tiny.bin", bytes: 77_691_713, english: false },
];

const SPEECH_NOTES: Record<string, string> = {
  "tiny.en": "Fastest. Good for short English notes.",
  "base.en": "Better English, still quick on this Mac.",
  "small.en": "Clearest English. Slower to run.",
  tiny: "Many languages. Less accurate than the English models.",
};

export function speechNote(id: string): string {
  return SPEECH_NOTES[id] ?? "";
}

export const DEFAULT_SPEECH_MODEL = SPEECH_MODELS[0].id;
export const TRANSCRIPT_CAP = 8_000;

export type SpeechModelStatus = "missing" | "partial" | "ready";

export type SpeechModelInfo = SpeechModel & { status: SpeechModelStatus };

export function normalizeSpeechModel(id: string | null | undefined): string {
  const trimmed = id?.trim() ?? "";
  return SPEECH_MODELS.some((model) => model.id === trimmed) ? trimmed : DEFAULT_SPEECH_MODEL;
}

export function speechModel(id: string | null | undefined): SpeechModel {
  const next = normalizeSpeechModel(id);
  return SPEECH_MODELS.find((model) => model.id === next) ?? SPEECH_MODELS[0];
}

export function speechSizeLabel(bytes: number): string {
  const mb = Math.max(1, Math.round(bytes / (1024 * 1024)));
  return `${mb} MB`;
}

export type TranscriptInsert = { text: string; cursor: number };

const BLANK_AUDIO = /^(?:\[BLANK_AUDIO\]|\(blank audio\))$/i;

export function cleanTranscript(text: string): string {
  const withoutMarks = text
    .replace(/\[[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3} --> [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutMarks || BLANK_AUDIO.test(withoutMarks)) return "";
  return withoutMarks.slice(0, TRANSCRIPT_CAP);
}

export function insertTranscript(draft: string, start: number, end: number, text: string): TranscriptInsert {
  const from = clampOffset(draft, Math.min(start, end));
  const to = clampOffset(draft, Math.max(start, end));
  const cleaned = cleanTranscript(text);
  if (!cleaned) return { text: draft, cursor: from };
  const before = draft.slice(0, from);
  const prev = before.slice(-1);
  const nextChar = draft.slice(to, to + 1);
  const lead = /[A-Za-z0-9]/.test(prev) ? " " : "";
  const trail = /^\s/.test(nextChar) ? "" : " ";
  const chunk = `${lead}${cleaned}${trail}`;
  const next = `${before}${chunk}${draft.slice(to)}`;
  return { text: next, cursor: before.length + chunk.length };
}

function clampOffset(draft: string, offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(draft.length, Math.floor(offset));
}

export function dictationFilename(mime: string): string | null {
  const kind = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  if (kind === "audio/wav" || kind === "audio/wave" || kind === "audio/x-wav") return "dictation.wav";
  if (kind === "audio/mpeg" || kind === "audio/mp3") return "dictation.mp3";
  if (kind === "audio/ogg" || kind === "audio/opus") return "dictation.ogg";
  if (kind === "audio/mp4" || kind === "audio/m4a" || kind === "audio/aac" || kind === "audio/x-m4a") {
    return "dictation.m4a";
  }
  return null;
}

export function preferredRecorderMime(supported: (mime: string) => boolean): string {
  const choices = ["audio/wav", "audio/mp4", "audio/ogg"];
  return choices.find((mime) => supported(mime)) ?? "";
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const rate = Math.max(1, Math.round(sampleRate) || 1);
  const body = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(body);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([body], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

export const MIC_DEVICE_KEY = "twanagent.micDevice";

export type MicDevice = { id: string; label: string };

export function loadMicDevice(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(MIC_DEVICE_KEY) ?? "";
}

export function saveMicDevice(id: string): void {
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(MIC_DEVICE_KEY, id);
  else localStorage.removeItem(MIC_DEVICE_KEY);
}

/** Audio inputs from `enumerateDevices`. Blank labels stay generic until permission is granted. */
export function audioInputDevices(rows: Array<{ kind: string; deviceId: string; label: string }>): MicDevice[] {
  return rows
    .filter((row) => row.kind === "audioinput" && row.deviceId)
    .map((row, index) => ({
      id: row.deviceId,
      label: row.label.trim() || `Microphone ${index + 1}`,
    }));
}

export function micAudioConstraints(deviceId: string): MediaTrackConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

export function micLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(0, Math.min(1, rms * 4));
}

const VOICE_BARS = 12;

/** Bar heights from 0 to 1. The loudness sits in the middle and trails off to the sides. */
export function voiceBars(level: number): number[] {
  const loud = Math.max(0, Math.min(1, level));
  const mid = (VOICE_BARS - 1) / 2;
  return Array.from({ length: VOICE_BARS }, (_, index) => {
    const falloff = 1 - Math.abs(index - mid) / (mid + 0.35);
    return Math.max(0.14, Math.min(1, 0.14 + loud * falloff));
  });
}
