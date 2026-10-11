import { useSyncExternalStore } from "react";
import { accountUsageIsFresh, parseAccountUsage, type AccountUsage } from "./account-usage";
import * as api from "./tauri";

export type AccountUsageSnapshot = {
  usage: AccountUsage | null;
  /** True only until the first snapshot. Later polls keep the last bars. */
  loading: boolean;
};

type ProviderId = "anthropic" | "minimax";

const PROVIDERS: {
  id: ProviderId;
  loadCached: () => Promise<api.ApiAccountUsage | null>;
  load: () => Promise<api.ApiAccountUsage>;
}[] = [
  { id: "anthropic", loadCached: api.accountUsageCached, load: api.accountUsage },
  { id: "minimax", loadCached: api.minimaxAccountUsageCached, load: api.minimaxAccountUsage },
];

const EMPTY: AccountUsageSnapshot = { usage: null, loading: true };
const POLL_MS = 60_000;

const snapshots = new Map<ProviderId, AccountUsageSnapshot>(
  PROVIDERS.map((provider) => [provider.id, EMPTY]),
);
const listeners = new Set<() => void>();
let pollTimer = 0;
let watchingVisibility = false;
let refreshSeen = 0;

function emit() {
  for (const listener of listeners) listener();
}

function current(id: ProviderId): AccountUsageSnapshot {
  return snapshots.get(id) ?? EMPTY;
}

function publish(id: ProviderId, next: AccountUsageSnapshot) {
  const previous = current(id);
  if (previous.usage === next.usage && previous.loading === next.loading) return;
  snapshots.set(id, next);
  emit();
}

function reload(id: ProviderId, load: () => Promise<api.ApiAccountUsage>) {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const previous = current(id);
  if (!previous.usage) publish(id, { usage: null, loading: true });
  void load()
    .then((row) => {
      const next = parseAccountUsage(row);
      const shown = current(id).usage;
      // One failed poll must not hide an account we already showed.
      if (next && !next.connected && shown?.connected) {
        publish(id, { usage: shown, loading: false });
        return;
      }
      publish(id, { usage: next, loading: false });
    })
    .catch(() => {
      publish(id, { usage: current(id).usage, loading: false });
    });
}

/**
 * Start the Claude and MiniMax allowance checks. Safe to call more than once.
 * The poll is not tied to a component, so opening or closing settings cannot stop it.
 */
export function startAccountUsage() {
  if (typeof window === "undefined") return;
  // Replacing the timer keeps a double call (React strict mode) to one poll.
  if (pollTimer) window.clearInterval(pollTimer);
  for (const provider of PROVIDERS) {
    void provider
      .loadCached()
      .then((row) => {
        const cached = row ? parseAccountUsage(row) : null;
        const shown = current(provider.id).usage;
        // A stale cache is not painted. The live fetch below replaces it.
        if (!shown?.connected && cached?.connected && accountUsageIsFresh(cached)) {
          publish(provider.id, { usage: cached, loading: false });
        }
      })
      .catch(() => undefined);
    reload(provider.id, provider.load);
  }
  pollTimer = window.setInterval(() => {
    for (const provider of PROVIDERS) reload(provider.id, provider.load);
  }, POLL_MS);
  if (watchingVisibility) return;
  watchingVisibility = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const provider of PROVIDERS) reload(provider.id, provider.load);
  });
}

/** Ask for a fresh allowance without resetting the poll. A repeat tick is ignored. */
export function refreshAccountUsage(tick: number) {
  if (!pollTimer) startAccountUsage();
  if (tick === refreshSeen) return;
  refreshSeen = tick;
  for (const provider of PROVIDERS) reload(provider.id, provider.load);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccountUsage(id: ProviderId): AccountUsageSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => current(id),
    () => EMPTY,
  );
}
