import { projectKey } from "./core.ts";

export type ConversationKind = "chat" | "terminal";

export function parseConversationKind(value: unknown): ConversationKind {
  return value === "terminal" ? "terminal" : "chat";
}

export function conversationDraft(
  kind: ConversationKind,
  id: string,
  now: string,
  journeyId?: string | null,
  effort?: string | null,
  settings?: { model?: string | null; contextWindow?: number | null; permission?: string | null },
) {
  const thinking = (effort ?? "").trim();
  const model = (settings?.model ?? "").trim();
  const permission = (settings?.permission ?? "").trim();
  const contextWindow = settings?.contextWindow && settings.contextWindow > 0 ? Math.floor(settings.contextWindow) : 0;
  return {
    id,
    title: kind === "terminal" ? "Terminal" : "New chat",
    created_at: now,
    updated_at: now,
    messages: [] as unknown[],
    kind,
    ...(journeyId ? { journey_id: journeyId } : {}),
    ...(thinking ? { effort: thinking } : {}),
    ...(model ? { model } : {}),
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(permission ? { permission } : {}),
  };
}

export type TerminalPhase = "starting" | "running" | "exited" | "error";

export type TerminalSession = {
  conversationId: string;
  workspace: string;
  ptyId: string | null;
  phase: TerminalPhase;
  error: string | null;
  buffer: string;
  viewing: boolean;
  /** Output that arrived while the terminal was hidden. Painted on the next attach. */
  pending: string;
};

export type TerminalPtyEvent = {
  id: string;
  kind: string;
  data?: string | null;
};

export type TerminalSessionIo = {
  openGrok: (workspace: string, cols: number, rows: number, sessionId: string) => Promise<string>;
  kill: (id: string) => Promise<void>;
  listen: (fn: (ev: TerminalPtyEvent) => void) => Promise<() => void>;
};

export type TerminalStoreEvent =
  | { type: "data"; id: string; chunk: string }
  | { type: "state"; session: TerminalSession };

const BUFFER_CAP = 200_000;

export function attachAction(session: TerminalSession | undefined): "start" | "reuse" | "show-stopped" {
  if (!session) return "start";
  if (session.phase === "running" || session.phase === "starting") return "reuse";
  if ((session.phase === "exited" || session.phase === "error") && session.viewing) return "show-stopped";
  return "start";
}

export function appendOutput(buffer: string, chunk: string, max = BUFFER_CAP): string {
  const next = buffer + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

export function createTerminalSessionStore(io: TerminalSessionIo) {
  const sessions = new Map<string, TerminalSession>();
  const listeners = new Set<(ev: TerminalStoreEvent) => void>();
  let listening: Promise<void> | null = null;
  let unlisten: (() => void) | undefined;

  function get(id: string): TerminalSession | undefined {
    const session = sessions.get(id);
    return session ? { ...session } : undefined;
  }

  function emitState(session: TerminalSession) {
    const snap = { ...session };
    for (const fn of listeners) fn({ type: "state", session: snap });
  }

  function emitData(id: string, chunk: string) {
    for (const fn of listeners) fn({ type: "data", id, chunk });
  }

  function findByPty(ptyId: string): TerminalSession | undefined {
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
          if (session.viewing) emitData(session.conversationId, ev.data);
          else session.pending = appendOutput(session.pending, ev.data);
          return;
        }
        if (ev.kind === "exit") {
          session.phase = "exited";
          session.ptyId = null;
          emitState(session);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    await listening;
  }

  async function start(id: string, workspace: string, cols: number, rows: number): Promise<TerminalSession> {
    const prev = sessions.get(id);
    if (prev?.ptyId) {
      const old = prev.ptyId;
      prev.ptyId = null;
      await io.kill(old);
    }
    const session: TerminalSession = {
      conversationId: id,
      workspace,
      ptyId: null,
      phase: "starting",
      error: null,
      buffer: "",
      viewing: true,
      pending: "",
    };
    sessions.set(id, session);
    emitState(session);
    try {
      const ptyId = await io.openGrok(workspace, cols, rows, id);
      const current = sessions.get(id);
      if (!current) {
        await io.kill(ptyId);
        return session;
      }
      current.ptyId = ptyId;
      current.phase = "running";
      current.error = null;
      emitState(current);
      return { ...current };
    } catch (e) {
      const current = sessions.get(id);
      if (!current) return session;
      current.phase = "error";
      current.error = String(e);
      current.ptyId = null;
      emitState(current);
      return { ...current };
    }
  }

  async function attach(id: string, workspace: string, cols: number, rows: number): Promise<TerminalSession> {
    await ensureListen();
    const existing = sessions.get(id);
    if (existing && existing.workspace !== workspace) {
      return start(id, workspace, cols, rows);
    }
    const action = attachAction(existing);
    if (existing) existing.viewing = true;
    if (action === "reuse" || action === "show-stopped") {
      const session = sessions.get(id)!;
      if (session.pending) {
        const missed = session.pending;
        session.pending = "";
        emitData(id, missed);
      }
      emitState(session);
      return { ...session };
    }
    return start(id, workspace, cols, rows);
  }

  function detach(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    session.viewing = false;
    emitState(session);
  }

  async function restart(id: string, workspace: string, cols: number, rows: number): Promise<TerminalSession> {
    await ensureListen();
    return start(id, workspace, cols, rows);
  }

  async function dispose(id: string) {
    const session = sessions.get(id);
    sessions.delete(id);
    if (session?.ptyId) await io.kill(session.ptyId);
  }

  async function disposeWorkspace(workspace: string) {
    const key = projectKey(workspace);
    if (!key) return;
    const ids = [...sessions.values()]
      .filter((session) => projectKey(session.workspace) === key)
      .map((session) => session.conversationId);
    for (const id of ids) await dispose(id);
  }

  async function disposeAll() {
    const ids = [...sessions.keys()];
    for (const id of ids) await dispose(id);
  }

  function subscribe(fn: (ev: TerminalStoreEvent) => void) {
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

  return { get, attach, detach, restart, dispose, disposeWorkspace, disposeAll, subscribe, stop };
}
