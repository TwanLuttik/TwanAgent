import { useEffect, useRef, useState } from "react";
import {
  accountUsageIsFresh,
  formatAccountBalance,
  formatAccountReset,
  formatAccountUsed,
  parseAccountUsage,
  type AccountUsage,
} from "../lib/account-usage";
import * as api from "../lib/tauri";
import { Symbol } from "./Symbol";

function AccountBalance({ usage }: { usage: AccountUsage }) {
  const amount = formatAccountBalance(usage.balanceCents, usage.balanceCurrency ?? "USD");
  if (amount) {
    return (
      <p className="m-0 px-0.5 text-[11px] tabular-nums text-ink/80">
        {amount} <span className="text-muted">left</span>
      </p>
    );
  }
  const text =
    usage.creditStatus === "available"
      ? "Credits available"
      : usage.creditStatus === "exhausted"
        ? "Credits used up"
        : "No balance on this login";
  return <p className="m-0 px-0.5 text-[10px] leading-snug text-muted/80">{text}</p>;
}

const ACCOUNT_ROWS: {
  id: string;
  loadCached: () => Promise<api.ApiAccountUsage | null>;
  load: () => Promise<api.ApiAccountUsage>;
  logo: string;
  logoClass: string;
  barClass: string;
  fallback: string;
  /** MiniMax reports percent left. Claude reports percent used. */
  remaining?: boolean;
}[] = [
  {
    id: "anthropic",
    loadCached: api.accountUsageCached,
    load: api.accountUsage,
    logo: "logo.claude",
    logoClass: "text-[#d97757]",
    barClass: "bg-[#d97757]",
    fallback: "Claude",
  },
  {
    id: "minimax",
    loadCached: api.minimaxAccountUsageCached,
    load: api.minimaxAccountUsage,
    logo: "logo.minimax",
    logoClass: "text-[#e21680]",
    barClass: "bg-[#e21680]",
    fallback: "MiniMax",
    remaining: true,
  },
];

/** Claude and MiniMax account allowance, shown under the sidebar Usage button. */
export function AccountUsageRow({ refresh = 0 }: { refresh?: number }) {
  return (
    <>
      {ACCOUNT_ROWS.map((row) => (
        <ProviderAccountUsage key={row.id} refresh={refresh} remaining={false} {...row} />
      ))}
    </>
  );
}

function ProviderAccountUsage({
  refresh,
  loadCached,
  load,
  logo,
  logoClass,
  barClass,
  fallback,
  remaining,
}: {
  refresh: number;
  loadCached: () => Promise<api.ApiAccountUsage | null>;
  load: () => Promise<api.ApiAccountUsage>;
  logo: string;
  logoClass: string;
  barClass: string;
  fallback: string;
  remaining: boolean;
}) {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const usageRef = useRef<AccountUsage | null>(null);
  usageRef.current = usage;
  const loadRef = useRef(load);
  const loadCachedRef = useRef(loadCached);
  loadRef.current = load;
  loadCachedRef.current = loadCached;

  useEffect(() => {
    let gone = false;
    setLoading(true);
    void loadCachedRef.current()
      .then((row) => {
        if (gone || !row || usageRef.current?.connected) return;
        const cached = parseAccountUsage(row);
        // A stale cache is not painted. The live fetch below replaces it.
        if (cached?.connected && accountUsageIsFresh(cached)) setUsage(cached);
      })
      .catch(() => undefined);
    function reload() {
      if (document.visibilityState === "hidden") return;
      if (!gone) setLoading(true);
      void loadRef.current()
        .then((row) => {
          if (gone) return;
          const next = parseAccountUsage(row);
          const previous = usageRef.current;
          // One failed poll must not hide an account we already showed.
          if (next && !next.connected && previous?.connected) {
            setLoading(false);
            return;
          }
          setUsage(next);
          setLoading(false);
        })
        .catch(() => {
          if (!gone) setLoading(false);
        });
    }
    reload();
    const poll = window.setInterval(reload, 60_000);
    function onVisible() {
      if (document.visibilityState === "visible") reload();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true;
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `refresh` is the only trigger. The loaders are read through refs so a new
    // function identity does not restart the poll.
  }, [refresh]);

  if (!usage?.connected) {
    if (!loading) return null;
    return (
      <div className="px-2 pt-0.5 pb-1" aria-busy="true" aria-label={`Loading ${fallback} account`}>
        <div className="flex items-center gap-1.5 px-0.5 pb-1 text-[11px] text-muted">
          <Symbol name={logo} className={`size-3 shrink-0 ${logoClass}`} />
          <span className="min-w-0 flex-1 truncate">{fallback}</span>
          <span className="size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
        </div>
      </div>
    );
  }
  const title = usage.label && usage.label !== fallback ? `${fallback} · ${usage.label}` : `${fallback} account`;
  const wide = usage.windows.some((window) => window.label.length > 4);

  return (
    <div className="px-2 pt-0.5 pb-1" title={title} aria-label={title} aria-busy={loading}>
      <div className="flex items-center gap-1.5 px-0.5 pb-1 text-[11px] text-muted">
        <Symbol name={logo} className={`size-3 shrink-0 ${logoClass}`} />
        <span className="min-w-0 flex-1 truncate">{usage.label === fallback ? fallback : usage.label}</span>
        {loading ? (
          <span className="size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent" aria-label="Updating" />
        ) : null}
      </div>
      {usage.windows.length === 0 ? (
        <AccountBalance usage={usage} />
      ) : (
      <div className="grid gap-1">
        {usage.windows.map((window) => {
          const reset = formatAccountReset(window.resetsAt);
          return (
            <div
              key={window.id}
              className={`grid items-center gap-1.5 ${wide ? "grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_auto]" : "grid-cols-[1.75rem_minmax(0,1fr)_auto]"}`}
            >
              <span className="truncate text-[10px] tabular-nums text-muted" title={window.label}>
                {window.label}
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-wash-strong">
                <span
                  className={`block h-full rounded-full ${barClass}`}
                  style={{ width: `${Math.max(2, Math.min(100, window.usedPercent))}%` }}
                />
              </span>
              <span className="text-right text-[10px] tabular-nums text-muted">
                {formatAccountUsed(window.usedPercent)}
                {remaining ? " left" : ""}
                {reset ? ` · ${reset}` : ""}
              </span>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
