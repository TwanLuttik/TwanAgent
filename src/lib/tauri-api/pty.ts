import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PtyEvent = {
  id: string;
  kind: "data" | "exit" | string;
  data?: string | null;
};

export function ptyOpen(workspace: string, cols: number, rows: number): Promise<string> {
  return invoke("dev_pty_open", { workspace, cols, rows });
}

export type ApiGrokPlan = {
  found: boolean;
  state: string;
  awaiting_approval: boolean;
  content: string;
};

export function grokPlan(workspace: string, sessionId: string): Promise<ApiGrokPlan> {
  return invoke("dev_grok_plan", {
    workspace,
    sessionId,
    session_id: sessionId,
  });
}

export function grokPlanSet(
  workspace: string,
  sessionId: string,
  state: string,
  awaitingApproval: boolean,
): Promise<ApiGrokPlan> {
  return invoke("dev_grok_plan_set", {
    workspace,
    sessionId,
    session_id: sessionId,
    state,
    awaitingApproval,
    awaiting_approval: awaitingApproval,
  });
}

export function grokPlanWrite(workspace: string, sessionId: string, contents: string): Promise<void> {
  return invoke("dev_grok_plan_write", {
    workspace,
    sessionId,
    session_id: sessionId,
    contents,
  });
}

export function grokPlanEdit(
  workspace: string,
  sessionId: string,
  oldString: string,
  newString: string,
): Promise<void> {
  return invoke("dev_grok_plan_edit", {
    workspace,
    sessionId,
    session_id: sessionId,
    oldString,
    newString,
    old_string: oldString,
    new_string: newString,
  });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("dev_pty_write", { id, data });
}

export function ptyWriteBytes(id: string, data: number[]): Promise<void> {
  return invoke("dev_pty_write_bytes", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("dev_pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("dev_pty_kill", { id });
}

export function onPty(fn: (ev: PtyEvent) => void): Promise<UnlistenFn> {
  return listen<PtyEvent>("dev-pty", (ev) => fn(ev.payload));
}
