import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SpeechModelStatus = "missing" | "partial" | "ready";

export type SpeechModelInfo = {
  id: string;
  label: string;
  file: string;
  bytes: number;
  english: boolean;
  status: SpeechModelStatus;
};

export type SpeechDownloadEvent = {
  id: string;
  received: number;
  total: number;
  done: boolean;
};

export type MicrophoneInfo = {
  ready: boolean;
  exe: string;
  reason: string;
};

export function microphoneInfo(): Promise<MicrophoneInfo> {
  return invoke("dev_microphone_info");
}

export function microphoneReady(): Promise<boolean> {
  return invoke("dev_microphone_ready");
}

export function speechModels(): Promise<SpeechModelInfo[]> {
  return invoke("dev_speech_models");
}

export function speechDownload(id: string): Promise<SpeechModelInfo> {
  return invoke("dev_speech_download", { id });
}

export function onSpeechDownload(fn: (event: SpeechDownloadEvent) => void): Promise<UnlistenFn> {
  return listen<SpeechDownloadEvent>("speech-download", (ev) => fn(ev.payload));
}

export function transcribe(bytesBase64: string, filename: string): Promise<string> {
  return invoke("dev_transcribe", {
    bytesBase64,
    bytes_base64: bytesBase64,
    filename,
  });
}
