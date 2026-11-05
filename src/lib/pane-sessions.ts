import { projectKey } from "./core.ts";
import { isSameProject } from "./all-projects.ts";
import { defaultPaneState, type PaneState, type PaneTab } from "./pane.ts";

const panes = new Map<string, PaneState>();

export function paneForWorkspace(workspace: string): PaneState {
  const key = projectKey(workspace);
  const existing = panes.get(key);
  if (existing) return existing;
  const next = defaultPaneState();
  panes.set(key, next);
  return next;
}

export function savePaneForWorkspace(workspace: string, pane: PaneState) {
  const key = projectKey(workspace);
  if (!key) return;
  panes.set(key, pane);
}

export function forgetPaneWorkspace(workspace: string) {
  const key = projectKey(workspace);
  if (!key) return;
  panes.delete(key);
}

/**
 * The file pane reloads only when the project changes.
 * A chat switch, or the same folder coming back under another spelling, does not.
 */
export function filePaneNeedsReload(shown: string, next: string): boolean {
  if (!next) return false;
  if (!shown) return true;
  return !isSameProject(shown, next);
}

/**
 * Cover the file pane only while it is still showing a different project.
 * Opening a folder rewrites `/users/.../twanagent` to `/Users/.../TwanAgent`.
 * That is the same project, so the cover must not stay up. A strict `!==`
 * check did, including on an existing chat whose saved path used the other spelling.
 */
export function filePanePending(shown: string, next: string): boolean {
  if (!shown || !next) return false;
  return !isSameProject(shown, next);
}

export function closedTerminalTabs(prev: PaneState, next: PaneState): PaneTab[] {
  const kept = new Set(next.tabs.map((tab) => tab.id));
  return prev.tabs.filter((tab) => tab.kind === "terminal" && !kept.has(tab.id));
}
