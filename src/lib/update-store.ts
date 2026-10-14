import { useSyncExternalStore } from "react";
import * as api from "./tauri.ts";
import type { AppUpdate } from "./tauri.ts";
import { versionIsNewer } from "./update.ts";

export type UpdatePhase = "checking" | "idle" | "downloading" | "installing" | "ready";

type UpdateSnapshot = {
  update: AppUpdate | null;
  phase: UpdatePhase;
  received: number;
  total: number;
  dev: boolean;
};

const empty: UpdateSnapshot = {
  update: null,
  phase: "checking",
  received: 0,
  total: 0,
  dev: false,
};

let snapshot: UpdateSnapshot = empty;
const listeners = new Set<() => void>();
let started = false;

function publish(next: Partial<UpdateSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

function start() {
  if (started) return;
  started = true;
  void api.onAppUpdate((event) => {
    if (snapshot.phase === "ready") return;
    publish({
      received: event.received,
      total: event.total > 0 ? event.total : snapshot.total,
      phase: event.phase === "install" ? "installing" : event.phase === "ready" ? "ready" : "downloading",
    });
  });
  void api.appDevBuild().then((dev) => publish({ dev })).catch(() => undefined);
  void api
    .appUpdateCheck()
    .then((found) => {
      if (found && versionIsNewer(found.version, __APP_VERSION_LABEL__)) {
        publish({ update: found, total: found.bytes, phase: "idle" });
        return;
      }
      publish({ update: null, phase: "idle" });
    })
    .catch(() => {
      publish({ phase: "idle" });
    });
}

export function useAppUpdate(): UpdateSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => empty);
}

export async function installAppUpdate(): Promise<string | null> {
  const update = snapshot.update;
  if (!update || snapshot.phase === "downloading" || snapshot.phase === "installing") return null;
  publish({ phase: "downloading", received: 0 });
  try {
    await api.appUpdateInstall(update);
    publish({ phase: "ready" });
    return null;
  } catch (err) {
    publish({ phase: "idle" });
    return String(err);
  }
}

export function relaunchAppUpdate(): Promise<void> {
  return api.appUpdateRelaunch();
}
