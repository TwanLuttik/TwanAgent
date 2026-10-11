import { useSyncExternalStore } from "react";

/** One shell command the agent is running in a chat. Output grows while it runs. */
export type CommandRun = {
  id: string;
  chatId: string;
  command: string;
  label: string;
  output: string;
  running: boolean;
  /** The shell returned, but the command was left running (a trailing `&`). */
  background: boolean;
  exitCode: number | null;
  startedAt: number;
};

const BACKGROUND_NOTE = "still running in the background";
/** The runner prints this with the detached pid. It is not command output. */
const DETACH_PID = /\u001ebg:\d+\n?/g;

function visibleOutput(text: string): string {
  return text.replace(DETACH_PID, "");
}

/** A trailing `&` outside quotes means the shell was asked to leave the command running. */
export function commandDetaches(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of command) {
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = !escaped;
      continue;
    }
    escaped = false;
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "&") return true;
  }
  return false;
}

const OUTPUT_CAP = 80_000;
/** A build or server is still going. A quick command finishes before this and never opens. */
export const COMMAND_VISIBLE_AFTER_MS = 2_000;
const runs = new Map<string, CommandRun>();
const listeners = new Set<() => void>();
let snapshot: CommandRun[] = [];

function publish() {
  snapshot = [...runs.values()];
  listeners.forEach((cb) => cb());
}

export function getCommandRuns(): CommandRun[] {
  return snapshot;
}

/** Shown once a command has been running for two seconds, or once it is known to stay up. */
export function commandRunVisible(run: CommandRun | null, now = Date.now()): boolean {
  if (!run) return false;
  if (run.background) return true;
  return run.running && now - run.startedAt >= COMMAND_VISIBLE_AFTER_MS;
}

/**
 * The command the terminal should stay on. A server that is already up wins
 * over a later check, so the panel does not close and open again for the
 * same process. A command that is still in its first moments can take over.
 */
export function commandRunForChat(
  chatId: string,
  rows: CommandRun[] = snapshot,
  now = Date.now(),
): CommandRun | null {
  if (!chatId) return null;
  let shown: CommandRun | null = null;
  let running: CommandRun | null = null;
  let latest: CommandRun | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.chatId !== chatId) continue;
    latest ??= row;
    if (commandRunVisible(row, now)) shown ??= row;
    if (row.running) running ??= row;
  }
  return shown ?? running ?? latest;
}

export function startCommandRun(
  run: Omit<CommandRun, "output" | "running" | "background" | "exitCode" | "startedAt">,
): void {
  runs.set(run.id, {
    ...run,
    output: "",
    running: true,
    background: commandDetaches(run.command),
    exitCode: null,
    startedAt: Date.now(),
  });
  publish();
}

export function appendCommandOutput(id: string, chunk: string): void {
  const row = runs.get(id);
  if (!row || !chunk) return;
  let output = visibleOutput(row.output + chunk);
  if (output.length > OUTPUT_CAP) output = output.slice(output.length - OUTPUT_CAP);
  if (output === row.output) return;
  runs.set(id, { ...row, output });
  publish();
}

export function finishCommandRun(id: string, exitCode: number | null = null): void {
  const row = runs.get(id);
  if (!row || !row.running) return;
  runs.set(id, { ...row, running: false, exitCode });
  publish();
}

/**
 * The tool call returned. A backgrounded command stays pinned above the input.
 * A foreground command is already done, so it leaves. A command that looked
 * foreground and then reports it is still running stays, instead of closing
 * and opening again.
 */
export function settleCommandRun(id: string, result: string): void {
  const row = runs.get(id);
  if (!row) return;
  const background = row.background || result.includes(BACKGROUND_NOTE);
  if (!background) {
    runs.delete(id);
    publish();
    return;
  }
  const output = row.output.trim() ? row.output : result.trim();
  const next = { ...row, background: true, running: true, output };
  if (
    row.background === next.background &&
    row.running === next.running &&
    row.output === next.output
  ) {
    return;
  }
  runs.set(id, next);
  publish();
}

export function clearCommandRun(id: string): void {
  if (!runs.delete(id)) return;
  publish();
}

export function clearCommandRunsForChat(chatId: string): void {
  let changed = false;
  for (const [id, row] of runs) {
    if (row.chatId !== chatId) continue;
    runs.delete(id);
    changed = true;
  }
  if (changed) publish();
}

export function subscribeCommandRuns(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function resetCommandRunsForTests(): void {
  runs.clear();
  snapshot = [];
  listeners.clear();
}

export function useCommandRuns(): CommandRun[] {
  return useSyncExternalStore(subscribeCommandRuns, getCommandRuns, getCommandRuns);
}

export function useCommandRun(chatId: string): CommandRun | null {
  const pick = () => commandRunForChat(chatId, getCommandRuns(), Date.now());
  return useSyncExternalStore(subscribeCommandRuns, pick, pick);
}
