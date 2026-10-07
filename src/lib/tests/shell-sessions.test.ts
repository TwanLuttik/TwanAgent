import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createShellSessionStore, shellSessionId } from "../shell-sessions.ts";

describe("shellSessionId", () => {
  it("keys a tab by the project path", () => {
    assert.equal(shellSessionId("/App/Alpha/", "terminal-1"), "/app/alpha::terminal-1");
    assert.equal(shellSessionId("/app/alpha", "terminal-1"), "/app/alpha::terminal-1");
  });
});

describe("shell session store", () => {
  function fakeStore() {
    let next = 0;
    let emit: ((ev: { id: string; kind: string; data?: string | null }) => void) | undefined;
    const killed: string[] = [];
    const opened: string[] = [];
    const store = createShellSessionStore({
      open: async (workspace) => {
        opened.push(workspace);
        next += 1;
        return `pty-${next}`;
      },
      write: async () => undefined,
      writeBytes: async () => undefined,
      resize: async () => undefined,
      kill: async (id) => {
        killed.push(id);
      },
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
      opened,
      emit: (ev: { id: string; kind: string; data?: string | null }) => emit?.(ev),
    };
  }

  it("reuses the same process when opened again", async () => {
    const { store, opened } = fakeStore();
    const id = shellSessionId("/ws", "tab-1");
    const first = await store.open(id, "/ws", 80, 24);
    const again = await store.open(id, "/ws", 100, 30);
    assert.equal(first.ptyId, "pty-1");
    assert.equal(again.ptyId, "pty-1");
    assert.equal(opened.length, 1);
    assert.equal(again.cols, 100);
  });

  it("keeps output after the view is gone", async () => {
    const { store, emit } = fakeStore();
    const id = shellSessionId("/ws", "tab-1");
    await store.open(id, "/ws", 80, 24);
    emit({ id: "pty-1", kind: "data", data: "still here" });
    assert.equal(store.get(id)?.buffer.includes("still here"), true);
  });

  it("dispose kills one shell and disposeWorkspace kills only that project", async () => {
    const { store, killed } = fakeStore();
    const alpha = shellSessionId("/app/alpha", "tab-1");
    const beta = shellSessionId("/app/beta/", "tab-1");
    await store.open(alpha, "/app/alpha", 80, 24);
    await store.open(beta, "/app/beta/", 80, 24);
    await store.dispose(alpha);
    assert.deepEqual(killed, ["pty-1"]);
    assert.equal(store.get(alpha), undefined);
    await store.disposeWorkspace("/app/Beta");
    assert.deepEqual(killed, ["pty-1", "pty-2"]);
    assert.equal(store.get(beta), undefined);
  });

  it("kills a shell that finishes opening after the tab was closed", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let next = 0;
    let started: () => void = () => undefined;
    const startedOpen = new Promise<void>((resolve) => {
      started = resolve;
    });
    const killed: string[] = [];
    const store = createShellSessionStore({
      open: async () => {
        started();
        await gate;
        next += 1;
        return `pty-${next}`;
      },
      write: async () => undefined,
      writeBytes: async () => undefined,
      resize: async () => undefined,
      kill: async (id) => {
        killed.push(id);
      },
      listen: async () => () => undefined,
    });
    const id = shellSessionId("/ws", "tab-1");
    const pending = store.open(id, "/ws", 80, 24);
    await startedOpen;
    const closed = store.dispose(id);
    release();
    await closed;
    await pending;
    assert.deepEqual(killed, ["pty-1"]);
    assert.equal(store.get(id), undefined);
  });

  it("notes when the process exits and starts a new one on the next open", async () => {
    const { store, emit, opened } = fakeStore();
    const id = shellSessionId("/ws", "tab-1");
    await store.open(id, "/ws", 80, 24);
    emit({ id: "pty-1", kind: "exit" });
    const stopped = store.get(id);
    assert.equal(stopped?.phase, "exited");
    assert.equal(stopped?.ptyId, null);
    assert.match(stopped?.buffer ?? "", /process exited/);
    const again = await store.open(id, "/ws", 80, 24);
    assert.equal(again.phase, "running");
    assert.equal(again.ptyId, "pty-2");
    assert.equal(opened.length, 2);
  });
});
