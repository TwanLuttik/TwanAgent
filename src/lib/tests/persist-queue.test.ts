import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERSIST_TRAIL_MS, createPersistQueue } from "../persist-queue.ts";

type Clock = {
  schedule: (fn: () => void, ms: number) => number;
  cancel: (handle: unknown) => void;
  fire: (ms?: number) => void;
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clock(): Clock {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule(fn, ms) {
      const handle = next++;
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    cancel(handle) {
      timers.delete(handle as number);
    },
    fire(ms = PERSIST_TRAIL_MS) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      for (const [handle, timer] of due) {
        if (!timers.delete(handle)) continue;
        timer.fn();
      }
    },
  };
}

describe("persist queue", () => {
  it("writes a burst once, with the last payload", async () => {
    const time = clock();
    const writes: string[] = [];
    const queue = createPersistQueue<string>({
      write: async (_id, payload) => {
        writes.push(payload);
      },
      schedule: time.schedule,
      cancel: time.cancel,
    });
    const first = queue.enqueue("chat", "one");
    const second = queue.enqueue("chat", "two");
    const third = queue.enqueue("chat", "three");
    assert.deepEqual(writes, []);
    time.fire();
    await Promise.all([first, second, third]);
    assert.deepEqual(writes, ["three"]);
  });

  it("keeps conversations apart", async () => {
    const time = clock();
    const writes: string[] = [];
    const queue = createPersistQueue<string>({
      write: async (id, payload) => {
        writes.push(`${id}:${payload}`);
      },
      schedule: time.schedule,
      cancel: time.cancel,
    });
    const a = queue.enqueue("a", "one");
    const b = queue.enqueue("b", "two");
    time.fire();
    await Promise.all([a, b]);
    assert.deepEqual(writes.sort(), ["a:one", "b:two"]);
  });

  it("flushes immediately and cancels the trailing timer", async () => {
    const time = clock();
    const writes: string[] = [];
    const queue = createPersistQueue<string>({
      write: async (_id, payload) => {
        writes.push(payload);
      },
      schedule: time.schedule,
      cancel: time.cancel,
    });
    const pending = queue.enqueue("chat", "draft");
    const flushed = queue.flush("chat");
    await Promise.all([pending, flushed]);
    assert.deepEqual(writes, ["draft"]);
    time.fire();
    assert.deepEqual(writes, ["draft"]);
  });

  it("flush with nothing queued resolves without writing", async () => {
    const time = clock();
    let writes = 0;
    const queue = createPersistQueue<string>({
      write: async () => {
        writes += 1;
      },
      schedule: time.schedule,
      cancel: time.cancel,
    });
    await queue.flush("missing");
    assert.equal(writes, 0);
  });

  it("writes again after an in-flight save when a newer payload arrives", async () => {
    const time = clock();
    const writes: string[] = [];
    let release: (() => void) | null = null;
    const queue = createPersistQueue<string>({
      write: (id, payload) => {
        writes.push(`${id}:${payload}`);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      schedule: time.schedule,
      cancel: time.cancel,
    });
    const first = queue.enqueue("chat", "one");
    time.fire();
    await flushMicrotasks();
    assert.deepEqual(writes, ["chat:one"]);
    const second = queue.enqueue("chat", "two");
    const flushed = queue.flush("chat");
    assert.deepEqual(writes, ["chat:one"]);
    release!();
    await first;
    await flushMicrotasks();
    release!();
    await Promise.all([second, flushed]);
    assert.deepEqual(writes, ["chat:one", "chat:two"]);
  });

  it("does not let an older scheduled write replace a newer one", async () => {
    const time = clock();
    const writes: string[] = [];
    const queue = createPersistQueue<string>({
      write: async (_id, payload) => {
        writes.push(payload);
      },
      schedule: time.schedule,
      cancel: time.cancel,
    });
    const early = queue.enqueue("chat", "stale");
    time.fire(200);
    const latest = queue.enqueue("chat", "fresh");
    time.fire(200);
    assert.deepEqual(writes, []);
    time.fire(200);
    await Promise.all([early, latest]);
    assert.deepEqual(writes, ["fresh"]);
  });

  it("rejects the waiters when the writer fails and still accepts the next save", async () => {
    const time = clock();
    const writes: string[] = [];
    let fail = true;
    const queue = createPersistQueue<string>({
      write: async (_id, payload) => {
        writes.push(payload);
        if (fail) throw new Error("disk");
      },
      schedule: time.schedule,
      cancel: time.cancel,
    });
    const broken = queue.enqueue("chat", "one");
    time.fire();
    await assert.rejects(broken, /disk/);
    fail = false;
    const next = queue.enqueue("chat", "two");
    time.fire();
    await next;
    assert.deepEqual(writes, ["one", "two"]);
  });

  it("flush during a failed write still saves the newer payload", async () => {
    const time = clock();
    const writes: string[] = [];
    let fail = true;
    let release: ((error?: Error) => void) | null = null;
    const queue = createPersistQueue<string>({
      write: (_id, payload) => {
        writes.push(payload);
        return new Promise((resolve, reject) => {
          release = (error) => (error ? reject(error) : resolve());
        });
      },
      schedule: time.schedule,
      cancel: time.cancel,
    });
    const first = queue.enqueue("chat", "one");
    time.fire();
    await flushMicrotasks();
    const second = queue.enqueue("chat", "two");
    const flushed = queue.flush("chat");
    fail = false;
    release!(new Error("disk"));
    await assert.rejects(first, /disk/);
    await flushMicrotasks();
    const unlock = release;
    unlock?.();
    await Promise.all([second, flushed]);
    assert.deepEqual(writes, ["one", "two"]);
    assert.equal(fail, false);
  });
});
