import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type CommandEvent = {
  stream_id: string;
  kind: "start" | "data" | "exit" | string;
  text?: string | null;
  exit_code?: number | null;
};

export function stopCommand(id: string): Promise<void> {
  return invoke("dev_stop_command", { id });
}

export function runCommand(workspace: string, command: string, streamId?: string): Promise<string> {
  return invoke("dev_run_command", {
    workspace,
    command,
    streamId: streamId ?? null,
    stream_id: streamId ?? null,
  });
}

export function onCommand(fn: (ev: CommandEvent) => void): Promise<UnlistenFn> {
  return listen<CommandEvent>("dev-command", (ev) => fn(ev.payload));
}

export function openUrl(url: string): Promise<void> {
  return invoke("dev_open_url", { url });
}

export function revealFolder(path: string): Promise<void> {
  return invoke("dev_reveal_folder", { path });
}
