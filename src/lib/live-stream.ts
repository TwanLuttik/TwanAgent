import { useSyncExternalStore } from "react";
import type { ConversationActivity, LiveToolRow } from "./core.ts";

/**
 * The visible chat's live tail. Tokens update this store instead of React
 * state on MainView, so the composer, sidebar, and file tree do not render
 * per token. Background chats stay in `liveByChatRef`.
 */
export type LiveStream = {
  streamText: string;
  streamReasoning: string;
  liveTools: LiveToolRow[];
  runningActivity: ConversationActivity | null;
};

export const EMPTY_LIVE_STREAM: LiveStream = {
  streamText: "",
  streamReasoning: "",
  liveTools: [],
  runningActivity: null,
};

let snapshot: LiveStream = EMPTY_LIVE_STREAM;
let empty = true;
const listeners = new Set<() => void>();

/** A second conversation shown beside the focused one. It has its own listeners. */
let secondarySnapshot: LiveStream = EMPTY_LIVE_STREAM;
let secondaryEmpty = true;
const secondaryListeners = new Set<() => void>();

export function getLiveStream(): LiveStream {
  return snapshot;
}

export function liveStreamEmpty(stream: LiveStream = snapshot): boolean {
  return stream.streamText.length === 0 && stream.streamReasoning.length === 0;
}

/** Cached boolean. Same reference across tokens, so a selector subscription does not re-render. */
export function getLiveStreamEmpty(): boolean {
  return empty;
}

export function subscribeLiveStream(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function sameLiveTools(a: LiveToolRow[], b: LiveToolRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (
      left.label !== right.label ||
      left.change !== right.change ||
      left.detail !== right.detail ||
      left.callId !== right.callId
    ) {
      return false;
    }
  }
  return true;
}

function sameActivity(
  a: ConversationActivity | null,
  b: ConversationActivity | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "editing" && b.kind === "editing") return a.path === b.path;
  if (a.kind === "tool" && b.kind === "tool") return a.label === b.label;
  return a.kind === "thinking";
}

/** Replace the foreground stream. Same values keep the snapshot reference and skip listeners. */
export function setLiveStream(
  patch: Partial<LiveStream> | ((prev: LiveStream) => Partial<LiveStream> | LiveStream),
): void {
  const prev = snapshot;
  const nextPatch = typeof patch === "function" ? patch(prev) : patch;
  const next: LiveStream = {
    streamText: nextPatch.streamText ?? prev.streamText,
    streamReasoning: nextPatch.streamReasoning ?? prev.streamReasoning,
    liveTools: nextPatch.liveTools ?? prev.liveTools,
    runningActivity:
      nextPatch.runningActivity === undefined ? prev.runningActivity : nextPatch.runningActivity,
  };
  if (
    next.streamText === prev.streamText &&
    next.streamReasoning === prev.streamReasoning &&
    sameLiveTools(next.liveTools, prev.liveTools) &&
    sameActivity(next.runningActivity, prev.runningActivity)
  ) {
    return;
  }
  snapshot = next;
  empty = next.streamText.length === 0 && next.streamReasoning.length === 0;
  listeners.forEach((cb) => cb());
}

export function clearLiveStream(): void {
  setLiveStream(EMPTY_LIVE_STREAM);
}

export function getSecondaryLiveStream(): LiveStream {
  return secondarySnapshot;
}

export function getSecondaryLiveStreamEmpty(): boolean {
  return secondaryEmpty;
}

export function subscribeSecondaryLiveStream(cb: () => void): () => void {
  secondaryListeners.add(cb);
  return () => secondaryListeners.delete(cb);
}

/** Replace the split pane's stream. Same values keep the snapshot and skip listeners. */
export function setSecondaryLiveStream(
  patch: Partial<LiveStream> | ((prev: LiveStream) => Partial<LiveStream> | LiveStream),
): void {
  const prev = secondarySnapshot;
  const nextPatch = typeof patch === "function" ? patch(prev) : patch;
  const next: LiveStream = {
    streamText: nextPatch.streamText ?? prev.streamText,
    streamReasoning: nextPatch.streamReasoning ?? prev.streamReasoning,
    liveTools: nextPatch.liveTools ?? prev.liveTools,
    runningActivity:
      nextPatch.runningActivity === undefined ? prev.runningActivity : nextPatch.runningActivity,
  };
  if (
    next.streamText === prev.streamText &&
    next.streamReasoning === prev.streamReasoning &&
    sameLiveTools(next.liveTools, prev.liveTools) &&
    sameActivity(next.runningActivity, prev.runningActivity)
  ) {
    return;
  }
  secondarySnapshot = next;
  secondaryEmpty = next.streamText.length === 0 && next.streamReasoning.length === 0;
  secondaryListeners.forEach((cb) => cb());
}

export function clearSecondaryLiveStream(): void {
  setSecondaryLiveStream(EMPTY_LIVE_STREAM);
}

export function resetLiveStreamForTests(): void {
  snapshot = EMPTY_LIVE_STREAM;
  empty = true;
  listeners.clear();
  secondarySnapshot = EMPTY_LIVE_STREAM;
  secondaryEmpty = true;
  secondaryListeners.clear();
}

export function useLiveStream(): LiveStream {
  return useSyncExternalStore(subscribeLiveStream, getLiveStream, getLiveStream);
}

/**
 * True only when both live strings are empty. `useSyncExternalStore` compares
 * with Object.is, so this flips on the first token and again when the stream
 * clears, not on every token.
 */
export function useLiveStreamEmpty(): boolean {
  return useSyncExternalStore(subscribeLiveStream, getLiveStreamEmpty, getLiveStreamEmpty);
}

export function useSecondaryLiveStream(): LiveStream {
  return useSyncExternalStore(subscribeSecondaryLiveStream, getSecondaryLiveStream, getSecondaryLiveStream);
}

export function useSecondaryLiveStreamEmpty(): boolean {
  return useSyncExternalStore(
    subscribeSecondaryLiveStream,
    getSecondaryLiveStreamEmpty,
    getSecondaryLiveStreamEmpty,
  );
}
