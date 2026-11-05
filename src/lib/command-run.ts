import { useSyncExternalStore } from "react";

/** One shell command the agent is running in a chat. Output grows while it runs. */
export type CommandRun = {
  id: string;
  chatId: string;
  command: string;
  label: string;
  output: string;
  running: boolean;
  /** The output is open. A finished command stays only while this is set. */
  watching: boolean;
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

/**
 * A background `&` outside quotes means the shell was asked to leave the command
 * running. `&&`, `|&`, and redirects such as `2>&1` or `&>` are not that.
 */
export function commandDetaches(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const chars = [...command];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
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
    if (ch === "&" && isBackgroundAmp(chars, i)) return true;
  }
  return false;
}

/** True when this `&` backgrounds a command rather than joining or redirecting one. */
function isBackgroundAmp(chars: string[], index: number): boolean {
  const prev = neighborChar(chars, index, -1);
  const next = neighborChar(chars, index, 1);
  if (prev === "&" || prev === ">" || prev === "<" || prev === "|") return false;
  if (next === "&" || next === ">") return false;
  return true;
}

function neighborChar(chars: string[], index: number, dir: -1 | 1): string {
  let i = index + dir;
  while (i >= 0 && i < chars.length && /\s/.test(chars[i] ?? "")) i += dir;
  return chars[i] ?? "";
}

const OUTPUT_CAP = 80_000;
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

/**
 * A command stays above the input while it runs. Once it finishes, it stays
 * only when its output is open. A background command is still running.
 */
export function commandRunVisible(run: CommandRun | null, _now = Date.now()): boolean {
  if (!run) return false;
  return run.running || run.watching;
}

/**
 * The command the terminal should show. The newest running command wins, so a
 * check covers a server until the check finishes. A finished command is shown
 * only while its output is open.
 */
export function commandRunForChat(
  chatId: string,
  rows: CommandRun[] = snapshot,
  now = Date.now(),
): CommandRun | null {
  if (!chatId) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.chatId !== chatId) continue;
    if (commandRunVisible(row, now)) return row;
  }
  return null;
}

export function startCommandRun(
  run: Omit<CommandRun, "output" | "running" | "watching" | "background" | "exitCode" | "startedAt">,
): void {
  runs.set(run.id, {
    ...run,
    output: "",
    running: true,
    watching: false,
    // A guess only. The runner's result is what keeps the terminal open.
    background: false,
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
 * A finished command leaves, unless its output is open. A command that looked
 * foreground and then reports it is still running stays, instead of closing
 * and opening again.
 */
export function settleCommandRun(id: string, result: string): void {
  const row = runs.get(id);
  if (!row) return;
  // The runner's own note is the truth. `&&` used to look like a background
  // job, and that guess must not keep the terminal up after a normal command.
  const background = result.includes(BACKGROUND_NOTE);
  if (!background) {
    if (!row.watching) {
      runs.delete(id);
      publish();
      return;
    }
    if (!row.running && !row.background) return;
    runs.set(id, { ...row, background: false, running: false });
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

/** The output was opened or closed. Closing a finished command drops it. */
export function watchCommandRun(id: string, watching: boolean): void {
  const row = runs.get(id);
  if (!row || row.watching === watching) return;
  if (!watching && !row.running) {
    runs.delete(id);
    publish();
    return;
  }
  runs.set(id, { ...row, watching });
  publish();
}

export type CommandStreamEvent = {
  kind: string;
  text?: string | null;
  tool?: { id: string; name: string; arguments: string } | null;
};

/**
 * A local turn reports each shell command on the chat stream.
 * Start shows it, chunks grow the output, and exit drops it unless it is
 * still running in the background or the output is open.
 */
export function noteCommandStream(chatId: string, event: CommandStreamEvent): void {
  if (!chatId) return;
  const id = event.tool?.id?.trim() ?? "";
  if (!id) return;
  if (event.kind === "command-start") {
    const command = String(event.text ?? "");
    const description = String(event.tool?.arguments ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/^run\s+/i, "");
    const trimmed = command.trim();
    startCommandRun({
      id,
      chatId,
      command,
      label: description ? `Run ${description}` : trimmed ? `Run ${trimmed}` : "Run command",
    });
    return;
  }
  if (event.kind === "command") {
    if (event.text) appendCommandOutput(id, event.text);
    return;
  }
  if (event.kind === "command-exit") settleCommandRun(id, event.text ?? "");
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
