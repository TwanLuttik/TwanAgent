import { useSyncExternalStore } from "react";
import * as api from "./tauri";
import type { ClaudeCliInfo, GrokCliInfo, MinimaxCliInfo, UsageDbInfo } from "./tauri";

export type KeyStatus = { saved: boolean; env: boolean };

type ProviderStatus = {
  xai: KeyStatus | null;
  anthropic: KeyStatus | null;
  minimax: KeyStatus | null;
  grokCli: GrokCliInfo | null;
  claudeCli: ClaudeCliInfo | null;
  minimaxCli: MinimaxCliInfo | null;
  db: UsageDbInfo | null;
  folders: string[];
};

const EMPTY: ProviderStatus = {
  xai: null,
  anthropic: null,
  minimax: null,
  grokCli: null,
  claudeCli: null,
  minimaxCli: null,
  db: null,
  folders: [],
};

let status: ProviderStatus = EMPTY;
const listeners = new Set<() => void>();
let started = false;

function emit() {
  for (const listener of listeners) listener();
}

function patch(next: Partial<ProviderStatus>) {
  status = { ...status, ...next };
  emit();
}

/** Start the provider, storage, and folder checks. Safe to call more than once. */
export function startProviderStatus() {
  if (started) return;
  started = true;
  void refreshProviderStatus();
}

/** Re-read every status the settings page shows. Runs whether or not that page is open. */
export function refreshProviderStatus() {
  started = true;
  void api.keyStatus().then((xai) => patch({ xai })).catch(() => undefined);
  void api.anthropicKeyStatus().then((anthropic) => patch({ anthropic })).catch(() => undefined);
  void api.minimaxKeyStatus().then((minimax) => patch({ minimax })).catch(() => undefined);
  void api.cliInfo().then((grokCli) => patch({ grokCli })).catch(() => undefined);
  void api.claudeCliInfo().then((claudeCli) => patch({ claudeCli })).catch(() => undefined);
  void api.minimaxCliInfo().then((minimaxCli) => patch({ minimaxCli })).catch(() => undefined);
  void api.usageDbInfo().then((db) => patch({ db })).catch(() => undefined);
  void api.openedWorkspaces().then((folders) => patch({ folders })).catch(() => undefined);
}

export function setProviderKeyStatus(provider: "xai" | "anthropic" | "minimax", next: KeyStatus) {
  patch({ [provider]: next });
}

export function setProviderDb(db: UsageDbInfo) {
  patch({ db });
}

export function setProviderFolders(folders: string[]) {
  patch({ folders });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProviderStatus(): ProviderStatus {
  return useSyncExternalStore(subscribe, () => status, () => status);
}
