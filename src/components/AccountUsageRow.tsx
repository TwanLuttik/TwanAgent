import {
  formatAccountBalance,
  formatAccountReset,
  formatAccountUsed,
  type AccountUsage,
} from "../lib/account-usage";
import { refreshAccountUsage, useAccountUsage } from "../lib/account-usage-store";
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
  id: "anthropic" | "minimax";
  logo: string;
  logoClass: string;
  barClass: string;
  fallback: string;
  /** MiniMax reports percent left. Claude reports percent used. */
  remaining?: boolean;
}[] = [
  {
    id: "anthropic",
    logo: "logo.claude",
    logoClass: "text-[#d97757]",
    barClass: "bg-[#d97757]",
    fallback: "Claude",
  },
  {
    id: "minimax",
    logo: "logo.minimax",
    logoClass: "text-[#e21680]",
    barClass: "bg-[#f472b6]",
    fallback: "MiniMax",
    remaining: true,
  },
];

/** Claude and MiniMax account allowance, shown under the sidebar Usage button. */
export function AccountUsageRow({ refresh = 0 }: { refresh?: number }) {
  refreshAccountUsage(refresh);
  return (
    <>
      {ACCOUNT_ROWS.map((row) => (
        <ProviderAccountUsage key={row.id} {...row} />
      ))}
    </>
  );
}

function ProviderAccountUsage({
  id,
  logo,
  logoClass,
  barClass,
  fallback,
  remaining = false,
}: {
  id: "anthropic" | "minimax";
  logo: string;
  logoClass: string;
  barClass: string;
  fallback: string;
  remaining?: boolean;
}) {
  const { usage, loading } = useAccountUsage(id);

  if (!usage?.connected) {
    if (!loading) return null;
    return (
      <div className="px-2 pt-0.5 pb-1" aria-busy="true" aria-label={`Loading ${fallback} account`}>
        <div className="flex items-center gap-1.5 px-0.5 pb-1 text-[11px] text-muted">
          <Symbol name={logo} colored className={`size-3 shrink-0 ${logoClass}`} />
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
        <Symbol name={logo} colored className={`size-3 shrink-0 ${logoClass}`} />
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
