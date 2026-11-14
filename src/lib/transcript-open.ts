import { useSyncExternalStore } from "react";
import { afterInput } from "./after-input.ts";
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
    // Keep the settled promise. Send may start after the read and before the
    // rows commit. The next open of this chat replaces it.
  };
}

/** Which chat the messages on screen belong to. A switch updates the id first. */
let screenTranscriptId = "";

export function noteScreenTranscript(id: string): void {
  screenTranscriptId = id;
}

export function screenHasTranscript(id: string): boolean {
  return id !== "" && screenTranscriptId === id;
}

/** The tail preview or the committed transcript. The loading shell is neither. */
export function transcriptOnScreen(id: string): boolean {
  if (!id) return false;
  return screenHasTranscript(id) || preview?.id === id;
}

export function transcriptLoad(id: string): Promise<ChatMessage[] | null> | undefined {
  if (!id) return undefined;
  return loads.get(id);
}

type DeferredTranscript = {
  id: string;
  cancelIdle: () => void;
  commit: () => boolean;
};

let deferred: DeferredTranscript | null = null;

/**
 * Paint a full transcript after this click. Send already has the list via
 * `finishLoad`. The idle callback is cancelled when the open is superseded.
 */
export function deferTranscriptCommit(id: string, commit: () => boolean): void {
  cancelDeferredTranscript();
  let ran = false;
  let running = false;
  const run = () => {
    if (ran || running) return false;
    running = true;
    // A false commit has not painted. Leave it pending so the full read is not dropped.
    const ok = commit();
    running = false;
    if (!ok || ran) return false;
    ran = true;
    const pending = deferred;
    if (pending?.id === id) {
      deferred = null;
      pending.cancelIdle();
    }
    return true;
  };
  const cancelIdle = afterInput(() => {
    run();
  });
  deferred = { id, cancelIdle, commit: run };
}

export function cancelDeferredTranscript(id?: string): void {
  if (!deferred) return;
  if (id && deferred.id !== id) return;
  const cancel = deferred.cancelIdle;
  deferred = null;
  cancel();
}

export function hasDeferredTranscript(id: string): boolean {
  return deferred?.id === id;
}

/** The full list is already stored. Commit it before revealing older rows. */
export function commitDeferredTranscript(id: string): boolean {
  if (!deferred || deferred.id !== id) return false;
  return deferred.commit();
}
