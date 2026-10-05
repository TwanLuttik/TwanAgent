import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendOutput,
  attachAction,
  conversationDraft,
  createTerminalSessionStore,
  parseConversationKind,
  type TerminalSession,
} from "./terminal-chat.ts";

function session(partial: Partial<TerminalSession> = {}): TerminalSession {
  return {
    conversationId: "c1",
    workspace: "/ws",
    ptyId: "pty-1",
    phase: "running",
    error: null,
    buffer: "",
    viewing: false,
    ...partial,
  };
}

describe("parseConversationKind", () => {
  it("accepts terminal and treats everything else as chat", () => {
    assert.equal(parseConversationKind("terminal"), "terminal");
    assert.equal(parseConversationKind("chat"), "chat");
    assert.equal(parseConversationKind(undefined), "chat");
    assert.equal(parseConversationKind(null), "chat");
    assert.equal(parseConversationKind("shell"), "chat");
  });
});

describe("conversationDraft", () => {
  it("titles chat and terminal drafts", () => {
    assert.deepEqual(conversationDraft("chat", "id-1", "t0"), {
      id: "id-1",
      title: "New chat",
      created_at: "t0",
      updated_at: "t0",
      messages: [],
      kind: "chat",
    });
    assert.deepEqual(conversationDraft("chat", "id-3", "t2", "j1"), {
      id: "id-3",
      title: "New chat",
      created_at: "t2",
      updated_at: "t2",
      messages: [],
      kind: "chat",
      journey_id: "j1",
    });
    assert.deepEqual(conversationDraft("terminal", "id-2", "t1"), {
      id: "id-2",
      title: "Terminal",
      created_at: "t1",
      updated_at: "t1",
      messages: [],
      kind: "terminal",
    });
  });
});

describe("attachAction", () => {
  it("starts when there is no session", () => {
    assert.equal(attachAction(undefined), "start");
  });

  it("reuses a live or starting session", () => {
    assert.equal(attachAction(session({ phase: "running" })), "reuse");
    assert.equal(attachAction(session({ phase: "starting", ptyId: null })), "reuse");
  });

  it("keeps a stopped session on screen and restarts after you leave", () => {
    assert.equal(attachAction(session({ phase: "exited", viewing: true })), "show-stopped");
    assert.equal(attachAction(session({ phase: "exited", viewing: false })), "start");
    assert.equal(attachAction(session({ phase: "error", viewing: true, error: "nope" })), "show-stopped");
    assert.equal(attachAction(session({ phase: "error", viewing: false, error: "nope" })), "start");
  });
});

describe("appendOutput", () => {
  it("keeps the tail when the buffer exceeds the cap", () => {
    assert.equal(appendOutput("hello ", "world"), "hello world");
    assert.equal(appendOutput("abcdef", "ghij", 8), "cdefghij");
  });
});

describe("terminal session store", () => {
  function fakeStore(opts?: {
    open?: (workspace: string, cols: number, rows: number, sessionId: string) => Promise<string>;
    kill?: (id: string) => Promise<void>;
  }) {
    let next = 0;
    let emit: ((ev: { id: string; kind: string; data?: string | null }) => void) | undefined;
    const killed: string[] = [];
    const store = createTerminalSessionStore({
      openGrok: opts?.open ?? (async () => {
        next += 1;
        return `pty-${next}`;
      }),
      kill: opts?.kill ?? (async (id) => {
        killed.push(id);
      }),
      listen: async (fn) => {
        emit = fn;
        return () => {
          emit = undefined;
        };
      },
    });
    return {
      store,
      killed,
      emit: (ev: { id: string; kind: string; data?: string | null }) => emit?.(ev),
    };
  }

  it("starts grok on first attach and reuses the same process after detach", async () => {
    const { store } = fakeStore();
    const first = await store.attach("c1", "/ws", 80, 24);
    assert.equal(first.phase, "running");
    assert.equal(first.ptyId, "pty-1");
    store.detach("c1");
    const again = await store.attach("c1", "/ws", 80, 24);
    assert.equal(again.ptyId, "pty-1");
    assert.equal(again.phase, "running");
  });

  it("passes the conversation id so grok can resume that session", async () => {
    const seen: string[] = [];
    const { store } = fakeStore({
      open: async (_workspace, _cols, _rows, sessionId) => {
        seen.push(sessionId);
        return "pty-1";
      },
    });
    await store.attach("conv-uuid", "/ws", 80, 24);
    assert.deepEqual(seen, ["conv-uuid"]);
  });

  it("does not auto-restart while the exited terminal is still on screen", async () => {
    const { store, emit } = fakeStore();
    await store.attach("c1", "/ws", 80, 24);
    emit({ id: "pty-1", kind: "exit" });
    assert.equal(store.get("c1")?.phase, "exited");
    const still = await store.attach("c1", "/ws", 80, 24);
    assert.equal(still.phase, "exited");
    assert.equal(still.ptyId, null);
  });

  it("restarts grok the next time you open an exited conversation", async () => {
    const { store, emit } = fakeStore();
    await store.attach("c1", "/ws", 80, 24);
    emit({ id: "pty-1", kind: "exit" });
    store.detach("c1");
    const again = await store.attach("c1", "/ws", 80, 24);
    assert.equal(again.phase, "running");
    assert.equal(again.ptyId, "pty-2");
  });

  it("keeps output while detached and surfaces a start error", async () => {
    const { store, emit } = fakeStore();
    await store.attach("c1", "/ws", 80, 24);
    store.detach("c1");
    emit({ id: "pty-1", kind: "data", data: "hello from grok" });
    assert.equal(store.get("c1")?.buffer.includes("hello from grok"), true);

    let opens = 0;
    const failing = fakeStore({
      open: async () => {
        opens += 1;
        throw new Error("Grok CLI isn’t installed.");
      },
    });
    const err = await failing.store.attach("c2", "/ws", 80, 24);
    assert.equal(err?.phase, "error");
    assert.match(err?.error ?? "", /isn’t installed/);
    assert.equal(opens, 1);
  });

  it("starts a new process when the workspace changes", async () => {
    const { store } = fakeStore();
    await store.attach("c1", "/ws", 80, 24);
    const next = await store.attach("c1", "/other", 80, 24);
    assert.equal(next.workspace, "/other");
    assert.equal(next.ptyId, "pty-2");
  });

  it("disposeWorkspace kills only that project's terminals", async () => {
    const { store, killed } = fakeStore();
    await store.attach("c1", "/app/alpha", 80, 24);
    await store.attach("c2", "/app/beta/", 80, 24);
    await store.disposeWorkspace("/app/Alpha");
    assert.deepEqual(killed, ["pty-1"]);
    assert.equal(store.get("c1"), undefined);
    assert.equal(store.get("c2")?.phase, "running");
  });

  it("restart starts a new process even while viewing, and dispose kills the pty", async () => {
    const { store, killed, emit } = fakeStore();
    await store.attach("c1", "/ws", 80, 24);
    emit({ id: "pty-1", kind: "exit" });
    const restarted = await store.restart("c1", "/ws", 80, 24);
    assert.equal(restarted.phase, "running");
    assert.equal(restarted.ptyId, "pty-2");

    await store.attach("c3", "/other", 80, 24);
    await store.dispose("c3");
    assert.deepEqual(killed, ["pty-3"]);
    assert.equal(store.get("c3"), undefined);
  });
});
