/** A stats pass already ran this recently should not start another numstat immediately. */
export const GIT_STATUS_STATS_COALESCE_MS = 1500;

export type GitStatusRefresh =
  | { run: true; stats: boolean }
  | { run: false; stats: false; delayMs: number };

/** True only on the refresh where the active tab becomes git. */
export function switchedOntoGitTab(
  prevKind: string | null | undefined,
  activeKind: string | null | undefined,
): boolean {
  return activeKind === "git" && prevKind !== "git";
}

/**
 * Line counts (`stats`) are only for the git pane. The file tree needs paths.
 * A burst of edits while git is open coalesces into one trailing stats refresh.
 * A non-stats status still runs so the file list stays current.
 * Switching onto the git tab always loads line counts, even inside the window.
 */
export function planGitStatusRefresh(input: {
  /** Kind of the tab the user is looking at. A closed git tab does not count. */
  activeKind: string | null | undefined;
  /** When the last stats pass started. Null if none has. */
  lastStatsAt: number | null;
  now: number;
  /** The active tab just became git. */
  switchedToGit?: boolean;
  windowMs?: number;
}): GitStatusRefresh {
  const windowMs = input.windowMs ?? GIT_STATUS_STATS_COALESCE_MS;
  if (input.activeKind !== "git") return { run: true, stats: false };
  if (input.switchedToGit || input.lastStatsAt == null) return { run: true, stats: true };
  const elapsed = input.now - input.lastStatsAt;
  if (elapsed >= windowMs) return { run: true, stats: true };
  return { run: false, stats: false, delayMs: Math.max(0, windowMs - elapsed) };
}
