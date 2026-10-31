/**
 * The moment a turn started, kept outside React.
 * A reload while the turn is still running (a file save, a refresh) used to
 * stamp `Date.now()` again, so the sidebar and the status line jumped back to 0s
 * every time a message landed between tool calls.
 */

const memory = new Map<string, number>();
const STORAGE_KEY = "twanagent.turn-clock.v1";

function browserStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readStored(id: string): number {
  const store = browserStore();
  if (!store) return 0;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = Number(parsed[id] ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeStored(id: string, startedAt: number) {
  const store = browserStore();
  if (!store) return;
  try {
    const raw = store.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    parsed[id] = startedAt;
    store.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    /* private mode has no storage; the memory map still holds this page */
  }
}

function dropStored(id: string) {
  const store = browserStore();
  if (!store) return;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, number>;
    if (!(id in parsed)) return;
    delete parsed[id];
    store.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
}

function readClock(id: string): number {
  const saved = memory.get(id) ?? 0;
  const stored = readStored(id);
  if (stored > 0 && (saved <= 0 || stored < saved)) return stored;
  return saved > 0 ? saved : 0;
}

function writeClock(id: string, startedAt: number) {
  memory.set(id, startedAt);
  writeStored(id, startedAt);
}

/** A new prompt is starting. The previous turn's stamp must not carry over. */
export function beginTurnClock(id: string, startedAt: number): number {
  if (!id) return startedAt > 0 ? startedAt : 0;
  const stamp = startedAt > 0 ? startedAt : Date.now();
  writeClock(id, stamp);
  return stamp;
}

/**
 * The clock already running for this chat, or `fallback` when this is the first time we see it.
 * A later fallback (a rejoin in the middle of the turn) does not move the clock forward.
 */
export function rememberTurnClock(id: string, fallback = 0): number {
  if (!id) return fallback > 0 ? fallback : 0;
  const saved = readClock(id);
  if (saved > 0 && (fallback <= 0 || saved <= fallback)) return saved;
  if (fallback > 0) {
    writeClock(id, fallback);
    return fallback;
  }
  return 0;
}

export function endTurnClock(id: string) {
  if (!id) return;
  memory.delete(id);
  dropStored(id);
}

export function resetTurnClocksForTests() {
  memory.clear();
  try {
    browserStore()?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
