import { useEffect, useState } from "react";
import {
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

/** Claude account allowance, shown under the sidebar Usage button. */
export function AccountUsageRow({ refresh = 0 }: { refresh?: number }) {
  const [usage, setUsage] = useState<AccountUsage | null>(null);

  useEffect(() => {
    let gone = false;
    function load() {
      void api
        .accountUsage()
        .then((row) => {
          if (!gone) setUsage(parseAccountUsage(row));
        })
        .catch(() => {
          if (!gone) setUsage(null);
        });
    }
    load();
    const poll = window.setInterval(load, 60_000);
    return () => {
      gone = true;
      window.clearInterval(poll);
    };
  }, [refresh]);

  if (!usage?.connected) return null;
  const title = usage.label && usage.label !== "Claude" ? `Claude · ${usage.label}` : "Claude account";

  return (
    <div className="px-2 pt-0.5 pb-1" title={title} aria-label={title}>
      <div className="flex items-center gap-1.5 px-0.5 pb-1 text-[11px] text-muted">
        <Symbol name="logo.claude" className="size-3 shrink-0 text-[#d97757]" />
        <span className="min-w-0 flex-1 truncate">{usage.label === "Claude" ? "Claude" : usage.label}</span>
      </div>
      {usage.windows.length === 0 ? (
        <AccountBalance usage={usage} />
      ) : (
      <div className="grid gap-1">
        {usage.windows.map((window) => {
          const reset = formatAccountReset(window.resetsAt);
          return (
            <div key={window.id} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-1.5">
              <span className="text-[10px] tabular-nums text-muted">{window.label}</span>
              <span className="h-1 overflow-hidden rounded-full bg-wash-strong">
                <span
                  className="block h-full rounded-full bg-[#d97757]"
                  style={{ width: `${Math.max(2, Math.min(100, window.usedPercent))}%` }}
                />
              </span>
              <span className="text-right text-[10px] tabular-nums text-muted">
                {formatAccountUsed(window.usedPercent)}
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
