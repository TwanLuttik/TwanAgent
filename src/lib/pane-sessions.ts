import { projectKey } from "./core.ts";
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

export function closedTerminalTabs(prev: PaneState, next: PaneState): PaneTab[] {
  const kept = new Set(next.tabs.map((tab) => tab.id));
  return prev.tabs.filter((tab) => tab.kind === "terminal" && !kept.has(tab.id));
}
