import { projectKey } from "./core.ts";
import { appendOutput, type TerminalPtyEvent } from "./terminal-chat.ts";

export type ShellPhase = "starting" | "running" | "exited" | "error";

export type ShellSession = {
  id: string;
  workspace: string;
  ptyId: string | null;
  phase: ShellPhase;
  error: string | null;
  buffer: string;
  cols: number;
  rows: number;
};

export type ShellSessionIo = {
  open: (workspace: string, cols: number, rows: number) => Promise<string>;
  write: (id: string, data: string) => Promise<void>;
  writeBytes: (id: string, data: number[]) => Promise<void>;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  kill: (id: string) => Promise<void>;
  listen: (fn: (ev: TerminalPtyEvent) => void) => Promise<() => void>;
};

export type ShellStoreEvent =
  | { type: "data"; id: string; chunk: string }
  | { type: "state"; session: ShellSession };

export function shellSessionId(workspace: string, tabId: string): string {
  return `${projectKey(workspace)}::${tabId}`;
}

export function createShellSessionStore(io: ShellSessionIo) {
  const sessions = new Map<string, ShellSession>();
  const epochs = new Map<string, number>();
  const listeners = new Set<(ev: ShellStoreEvent) => void>();
  let listening: Promise<void> | null = null;
  let unlisten: (() => void) | undefined;

  function get(id: string): ShellSession | undefined {
    const session = sessions.get(id);
    return session ? { ...session } : undefined;
  }

  function emitState(session: ShellSession) {
    const snap = { ...session };
    for (const fn of listeners) fn({ type: "state", session: snap });
  }

  function emitData(id: string, chunk: string) {
    for (const fn of listeners) fn({ type: "data", id, chunk });
  }

  function findByPty(ptyId: string): ShellSession | undefined {
    for (const session of sessions.values()) {
      if (session.ptyId === ptyId) return session;
    }
    return undefined;
  }

  async function ensureListen() {
    if (listening) {
      await listening;
      return;
    }
    listening = io
      .listen((ev) => {
        const session = findByPty(ev.id);
        if (!session) return;
        if (ev.kind === "data" && ev.data) {
          session.buffer = appendOutput(session.buffer, ev.data);
          emitData(session.id, ev.data);
          return;
        }
        if (ev.kind === "exit") {
          session.phase = "exited";
          session.ptyId = null;
          const note = "\r\n[process exited]\r\n";
          session.buffer = appendOutput(session.buffer, note);
          emitData(session.id, note);
          emitState(session);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    await listening;
  }

  async function open(id: string, workspace: string, cols: number, rows: number): Promise<ShellSession> {
    await ensureListen();
    const existing = sessions.get(id);
    if (existing && (existing.phase === "running" || existing.phase === "starting")) {
      existing.cols = cols;
      existing.rows = rows;
      if (existing.ptyId && existing.phase === "running") {
        void io.resize(existing.ptyId, cols, rows);
      }
      return { ...existing };
    }
    if (existing?.ptyId) {
      const old = existing.ptyId;
      existing.ptyId = null;
      await io.kill(old);
    }
    const session: ShellSession = {
      id,
      workspace,
      ptyId: null,
      phase: "starting",
      error: null,
      buffer: existing?.phase === "exited" ? existing.buffer : "",
      cols,
      rows,
    };
    const epoch = epochs.get(id) ?? 0;
    sessions.set(id, session);
    emitState(session);
    try {
      const ptyId = await io.open(workspace, cols, rows);
      if ((epochs.get(id) ?? 0) !== epoch || sessions.get(id) !== session) {
        await io.kill(ptyId);
        const current = sessions.get(id);
        return current ? { ...current } : session;
      }
      session.ptyId = ptyId;
      session.phase = "running";
      session.error = null;
      session.cols = cols;
      session.rows = rows;
      emitState(session);
      return { ...session };
    } catch (e) {
      if ((epochs.get(id) ?? 0) !== epoch || sessions.get(id) !== session) {
        return sessions.get(id) ? { ...sessions.get(id)! } : session;
      }
      session.phase = "error";
      session.error = String(e);
      session.ptyId = null;
      emitState(session);
      return { ...session };
    }
  }

  function write(id: string, data: string) {
    const session = sessions.get(id);
    if (session?.ptyId) void io.write(session.ptyId, data);
  }

  function writeBytes(id: string, data: number[]) {
    const session = sessions.get(id);
    if (session?.ptyId) void io.writeBytes(session.ptyId, data);
  }

  function resize(id: string, cols: number, rows: number) {
    const session = sessions.get(id);
    if (!session) return;
    session.cols = cols;
    session.rows = rows;
    if (session.ptyId) void io.resize(session.ptyId, cols, rows);
  }

  async function dispose(id: string) {
    const session = sessions.get(id);
    sessions.delete(id);
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    if (session?.ptyId) await io.kill(session.ptyId);
  }

  async function disposeWorkspace(workspace: string) {
    const key = projectKey(workspace);
    if (!key) return;
    const prefix = `${key}::`;
    const ids = [...sessions.keys()].filter((id) => id.startsWith(prefix));
    for (const id of ids) await dispose(id);
  }

  function subscribe(fn: (ev: ShellStoreEvent) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  function stop() {
    unlisten?.();
    unlisten = undefined;
    listening = null;
  }

  return { get, open, write, writeBytes, resize, dispose, disposeWorkspace, subscribe, stop };
}
