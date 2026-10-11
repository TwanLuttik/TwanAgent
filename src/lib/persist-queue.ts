export const PERSIST_TRAIL_MS = 400;

export type PersistSchedule = (fn: () => void, ms: number) => void;
export type PersistCancel = (handle: unknown) => void;

type Waiter = {
  epoch: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type Slot<T> = {
  payload: T;
  epoch: number;
  timer: unknown | null;
  writing: Promise<void> | null;
  /** Epoch captured when the in-flight write started. A newer enqueue must write again. */
  writingEpoch: number;
  waiters: Waiter[];
};

/**
 * Trailing save scheduler. Rapid enqueues for one id keep only the latest
 * payload and call the writer once. A flush cancels the wait and writes now.
 * A write already in flight still runs, then a newer payload writes again.
 */
export function createPersistQueue<T>(options: {
  write: (id: string, payload: T) => Promise<void>;
  delay?: number;
  schedule?: PersistSchedule;
  cancel?: PersistCancel;
}) {
  const delay = options.delay ?? PERSIST_TRAIL_MS;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const slots = new Map<string, Slot<T>>();

  function settle(current: Slot<T>, epoch: number) {
    const ready = current.waiters.filter((waiter) => waiter.epoch <= epoch);
    if (!ready.length) return;
    current.waiters = current.waiters.filter((waiter) => waiter.epoch > epoch);
    for (const waiter of ready) waiter.resolve();
  }

  function arm(current: Slot<T>, id: string) {
    if (current.timer != null) cancel(current.timer);
    current.timer = schedule(() => {
      const latest = slots.get(id);
      if (!latest || latest.timer == null) return;
      // Clear before starting. start awaits the writer, and a newer enqueue
      // during that wait must be able to arm its own timer.
      latest.timer = null;
      void start(id);
    }, delay);
  }

  /** Start the write for the payload currently stored. Never starts a second one. */
  function start(id: string): Promise<void> {
    const current = slots.get(id);
    if (!current) return Promise.resolve();
    if (current.writing) return current.writing;
    if (current.timer != null) {
      cancel(current.timer);
      current.timer = null;
    }
    const epoch = current.epoch;
    const payload = current.payload;
    // The follow-up write must not be chained onto this promise. A flush that
    // arrives while this write is running returns `writing`, and a newer write
    // chained inside it would wait on itself. Queue the follow-up only after
    // this promise has settled, so its waiters are not waiting on the next disk write.
    const writing = Promise.resolve().then(() => options.write(id, payload));
    current.writing = writing;
    current.writingEpoch = epoch;
    writing.then(
      () => {
        queueMicrotask(() => follow(id, writing, epoch, null));
      },
      (error: unknown) => {
        queueMicrotask(() => follow(id, writing, epoch, error));
      },
    );
    // Callers that only scheduled this write still get the rejection from their
    // own promise. This catch keeps the internal follow-up from surfacing twice.
    void writing.catch(() => undefined);
    return writing;
  }

  function follow(id: string, writing: Promise<void>, epoch: number, error: unknown) {
    const latest = slots.get(id);
    if (!latest || latest.writing !== writing) return;
    latest.writing = null;
    const again = latest.epoch !== epoch;
    if (error !== null) {
      const waiting = latest.waiters;
      if (!again && latest.timer == null) slots.delete(id);
      else latest.waiters = waiting.filter((waiter) => waiter.epoch > epoch);
      for (const waiter of waiting) {
        if (waiter.epoch <= epoch) waiter.reject(error);
      }
    } else {
      settle(latest, epoch);
    }
    if (!again) {
      if (latest.timer == null && latest.waiters.length === 0 && slots.get(id) === latest) slots.delete(id);
      return;
    }
    if (latest.timer != null) return;
    void start(id);
  }

  return {
    /** Keep the latest payload and write it after the trailing delay. */
    enqueue(id: string, payload: T): Promise<void> {
      return new Promise((resolve, reject) => {
        let current = slots.get(id);
        if (!current) {
          current = {
            payload,
            epoch: 0,
            timer: null,
            writing: null,
            writingEpoch: 0,
            waiters: [],
          };
          slots.set(id, current);
        }
        current.payload = payload;
        current.epoch += 1;
        current.waiters.push({ epoch: current.epoch, resolve, reject });
        if (current.writing) return;
        arm(current, id);
      });
    },

    /** Cancel the delay and write the latest payload now. */
    flush(id: string): Promise<void> {
      const current = slots.get(id);
      if (!current) return Promise.resolve();
      if (current.timer != null) {
        cancel(current.timer);
        current.timer = null;
      }
      if (current.writing && current.writingEpoch === current.epoch) return current.writing;
      // A newer payload arrived while a write was running. Its promise must not be
      // the in-flight one: that write can fail, and the flush still has to wait
      // for the retry that carries the latest messages.
      if (current.writing) {
        return new Promise((resolve, reject) => {
          current.waiters.push({ epoch: current.epoch, resolve, reject });
        });
      }
      return start(id);
    },
  };
}
