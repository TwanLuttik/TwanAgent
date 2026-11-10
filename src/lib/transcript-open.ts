import { useSyncExternalStore } from "react";
import type { ChatMessage } from "./core.ts";

/** The last turns of a chat, shown while the rest of the transcript is still being read. */
export type TranscriptPreview = { id: string; messages: ChatMessage[] };

let preview: TranscriptPreview | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setTranscriptPreview(id: string, messages: ChatMessage[]) {
  if (!id) return;
  preview = { id, messages };
  emit();
}

export function clearTranscriptPreview(id: string) {
  if (!preview || preview.id !== id) return;
  preview = null;
  emit();
}

function previewSnapshot(): TranscriptPreview | null {
  return preview;
}

export function useTranscriptPreview(): TranscriptPreview | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    previewSnapshot,
    previewSnapshot,
  );
}

const loads = new Map<string, Promise<ChatMessage[] | null>>();

/** Send waits on this instead of the rows already on screen, which may still be the previous chat. */
export function beginTranscriptLoad(id: string): (messages: ChatMessage[] | null) => void {
  let settle: (messages: ChatMessage[] | null) => void = () => {};
  const promise = new Promise<ChatMessage[] | null>((resolve) => {
    settle = resolve;
  });
  loads.set(id, promise);
  let settled = false;
  return (messages) => {
    if (settled) return;
    settled = true;
    settle(messages);
    if (loads.get(id) === promise) loads.delete(id);
  };
}

export function transcriptLoad(id: string): Promise<ChatMessage[] | null> | undefined {
  if (!id) return undefined;
  return loads.get(id);
}
