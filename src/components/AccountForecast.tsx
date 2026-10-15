import {
  formatForecastWhen,
  formatResetWhen,
  type AccountForecast,
  type ForecastHeadline,
} from "../lib/account-forecast";
import { Symbol } from "./Symbol";

const DAY = 24 * 60 * 60 * 1000;

export function AccountForecastView({
  rows,
  headline,
  nowMs,
}: {
  rows: AccountForecast[];
  headline: ForecastHeadline;
  nowMs: number;
}) {
  return (
    <section className="min-w-0">
      <header className="mb-3">
        <h2 className="m-0 text-[18px] font-semibold tracking-tight text-ink">{headlineTitle(headline)}</h2>
        <p className="mt-1 mb-0 text-[12px] text-muted">{headlineDetail(headline, nowMs)}</p>
      </header>
      <div className="grid gap-2">
        {rows.map((row) => (
          <ForecastRow key={`${row.account.id}:${row.window?.id ?? "none"}`} row={row} nowMs={nowMs} />
        ))}
      </div>
    </section>
  );
}

function headlineTitle(headline: ForecastHeadline): string {
  if (headline.count <= 0) return "No account runs out before reset";
  if (headline.count === 1) return "1 account runs out before reset";
  return `${headline.count} accounts run out before reset`;
}

function headlineDetail(headline: ForecastHeadline, nowMs: number): string {
  const first = headline.first;
  if (!first?.runsOut) return "Assumes the current pace holds.";
  return `${first.account.name} first, ${formatForecastWhen(first.runsOut.atMs, nowMs)}`;
}

function ForecastRow({ row, nowMs }: { row: AccountForecast; nowMs: number }) {
  const summary = rowSummary(row, nowMs);
  const used = Math.max(0, Math.min(100, row.usedPercent));
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)_8.5rem] items-center gap-3 px-1 py-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <Symbol name={row.account.logo} colored className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-ink">{row.account.name}</span>
          {row.account.detail ? <span className="block truncate text-[10px] text-muted">{row.account.detail}</span> : null}
        </span>
      </span>
      <span className="block h-1.5 overflow-hidden rounded-full bg-wash-strong" title={summary.title}>
        {row.window ? (
          <span className="block h-full rounded-full bg-ink/70" style={{ width: `${Math.max(used, 2)}%` }} />
        ) : null}
      </span>
      <span className="min-w-0 text-right">
        <span className="block truncate text-[12px] font-medium text-ink">{summary.title}</span>
        <span className="block truncate text-[10px] text-muted">{summary.detail}</span>
      </span>
    </div>
  );
}

function rowSummary(row: AccountForecast, nowMs: number): { title: string; detail: string } {
  if (row.account.reconnect) return { title: "Reconnect", detail: "No forecast yet" };
  const reset = row.window?.resetsAt;
  if (!row.window) return { title: "No window", detail: "Allowance not reported" };
  if (row.runsOut && reset != null && row.runsOut.atMs < reset) {
    return {
      title: `Runs out ${formatForecastWhen(row.runsOut.atMs, nowMs)}`,
      detail: formatResetWhen(reset, nowMs),
    };
  }
  if (reset != null) {
    const atReset = Math.min(100, row.usedPercent + row.pacePerDay * ((reset - nowMs) / DAY));
    return {
      title: `~${Math.round(atReset)}% at reset`,
      detail: formatResetWhen(reset, nowMs),
    };
  }
  return { title: `${Math.round(row.usedPercent)}% used`, detail: "No reset time" };
}
