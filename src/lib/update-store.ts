import { useSyncExternalStore } from "react";
import * as api from "./tauri.ts";
import {
  closeDemo,
  failDemo,
  openDemo,
  tickDemo,
  versionIsNewer,
  type UpdateModel,
  type UpdatePhase,
} from "./update.ts";

export type { UpdatePhase };

type UpdateSnapshot = {
  update: UpdateModel["update"];
  phase: UpdatePhase;
  received: number;
  total: number;
  dev: boolean;
  error: string | null;
  demo: boolean;
};

const emptyModel: UpdateModel = {
  update: null,
  phase: "checking",
  received: 0,
  total: 0,
  error: null,
  demo: false,
  held: null,
};

const serverSnapshot: UpdateSnapshot = {
  update: null,
  phase: "checking",
  received: 0,
  total: 0,
  dev: false,
  error: null,
  demo: false,
};

let model: UpdateModel = emptyModel;
let dev = false;
let snapshot: UpdateSnapshot = serverSnapshot;
const listeners = new Set<() => void>();
let started = false;
let demoTimer: ReturnType<typeof setInterval> | null = null;
let demoStartedAt = 0;

function viewOf(next: UpdateModel, isDev: boolean): UpdateSnapshot {
  return {
    update: next.update,
    phase: next.phase,
    received: next.received,
    total: next.total,
    dev: isDev,
    error: next.error,
    demo: next.demo,
  };
}

function publish(next: UpdateModel, isDev = dev) {
  model = next;
  dev = isDev;
  snapshot = viewOf(next, isDev);
  for (const listener of listeners) listener();
}

function clearDemoTimer() {
  if (demoTimer == null) return;
  clearInterval(demoTimer);
  demoTimer = null;
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
    if (model.demo || model.phase === "ready") return;
    publish({
      ...model,
      received: event.received,
      total: event.total > 0 ? event.total : model.total,
      phase: event.phase === "install" ? "installing" : event.phase === "ready" ? "ready" : "downloading",
      error: null,
    });
  });
  void api.appDevBuild().then((isDev) => publish(model, isDev)).catch(() => undefined);
  void api
    .appUpdateCheck()
    .then((found) => {
      const update = found && versionIsNewer(found.version, __APP_VERSION_LABEL__) ? found : null;
      if (model.demo) {
        if (!model.held && update) publish({ ...model, held: update });
        return;
      }
      if (model.phase !== "checking" && model.phase !== "idle") return;
      publish({
        ...model,
        update,
        total: update?.bytes ?? 0,
        phase: "idle",
        received: 0,
        error: null,
      });
    })
    .catch(() => {
      if (model.demo || model.phase !== "checking") return;
      publish({ ...model, phase: "idle" });
    });
}

export function useAppUpdate(): UpdateSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => serverSnapshot);
}

function playDemo() {
  clearDemoTimer();
  demoStartedAt = Date.now();
  publish({
    ...model,
    phase: "downloading",
    received: 0,
    total: model.update?.bytes ?? 0,
    error: null,
  });
  demoTimer = setInterval(() => {
    const next = tickDemo(model, Date.now() - demoStartedAt);
    publish(next);
    if (next.phase === "ready" || next.phase === "error") clearDemoTimer();
  }, 100);
}

export async function installAppUpdate(): Promise<void> {
  const update = model.update;
  if (!update || model.phase === "downloading" || model.phase === "installing") return;
  if (model.demo) {
    playDemo();
    return;
  }
  publish({ ...model, phase: "downloading", received: 0, total: update.bytes, error: null });
  try {
    await api.appUpdateInstall(update);
    if (!model.demo && model.phase !== "error") publish({ ...model, phase: "ready", error: null });
  } catch (err) {
    if (!model.demo && model.phase !== "ready") publish({ ...model, phase: "error", error: String(err) });
  }
}

export function relaunchAppUpdate(): Promise<void> {
  if (model.demo) {
    stopUpdateDemo();
    return Promise.resolve();
  }
  return api.appUpdateRelaunch();
}

export function toggleUpdateDemo(): void {
  if (!dev) return;
  if (model.demo) {
    stopUpdateDemo();
    return;
  }
  const next = openDemo(model);
  if (next === model) return;
  clearDemoTimer();
  publish(next);
}

function stopUpdateDemo() {
  clearDemoTimer();
  publish(closeDemo(model));
}

export function failUpdateDemo(): void {
  const next = failDemo(model);
  if (next === model) return;
  clearDemoTimer();
  publish(next);
}
