import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

export function appVersion(): Promise<string> {
  return invoke("app_version");
}

/** True while this window is `tauri dev` or a debug bundle. */
export function appDevBuild(): Promise<boolean> {
  return invoke("app_dev_build");
}

export type AppUpdate = {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  bytes: number;
  sha256: string;
};

export type AppUpdateEvent = {
  received: number;
  total: number;
  phase: "download" | "install" | "ready" | string;
};

/** The newest GitHub release ahead of this build. Null when this one is current. */
export function appUpdateCheck(): Promise<AppUpdate | null> {
  return invoke("app_update_check");
}

/** Download the release and replace this app. Relaunch afterwards. */
export function appUpdateInstall(update: AppUpdate): Promise<void> {
  return invoke("app_update_install", { update });
}

/** Open the updated app and quit this one. */
export function appUpdateRelaunch(): Promise<void> {
  return invoke("app_update_relaunch");
}

export function onAppUpdate(fn: (event: AppUpdateEvent) => void): Promise<UnlistenFn> {
  return listen<AppUpdateEvent>("app-update", (ev) => fn(ev.payload));
}

export type AppPerfSnapshot = {
  cpu_percent: number;
  memory_bytes: number;
};

export function appPerfSnapshot(): Promise<AppPerfSnapshot> {
  return invoke("app_perf_snapshot");
}

export async function pickDir(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

const IMAGE_FILTERS = [
  { name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "jfif", "heic", "heif"] },
];

export async function pickImage(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: IMAGE_FILTERS,
  });
  return typeof selected === "string" ? selected : null;
}
