export type AccountUsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
};

export type AccountUsage = {
  provider: string;
  connected: boolean;
  label: string;
  windows: AccountUsageWindow[];
  /** Remaining prepaid balance in cents. Absent when the login cannot read one. */
  balanceCents: number | null;
  balanceCurrency: string | null;
  /** `available` or `exhausted` when a prepaid org has no dollar balance. */
  creditStatus: string | null;
};

/** 0–100, or null when the payload has no usable number. */
export function accountUsedPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

export function parseAccountUsageWindow(raw: unknown): AccountUsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const used = accountUsedPercent(row.used_percent ?? row.usedPercent);
  if (used == null) return null;
  const id = String(row.id ?? "").trim();
  const label = String(row.label ?? "").trim();
  if (!id || !label) return null;
  const resets = row.resets_at ?? row.resetsAt;
  return {
    id,
    label,
    usedPercent: used,
    resetsAt: typeof resets === "string" && resets.trim() ? resets : null,
  };
}

export function parseAccountUsage(raw: unknown): AccountUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const windows = Array.isArray(row.windows)
    ? row.windows.flatMap((item) => {
        const parsed = parseAccountUsageWindow(item);
        return parsed ? [parsed] : [];
      })
    : [];
  const cents = row.balance_cents ?? row.balanceCents;
  const currency = row.balance_currency ?? row.balanceCurrency;
  const credit = row.credit_status ?? row.creditStatus;
  return {
    provider: String(row.provider ?? "anthropic"),
    connected: row.connected === true,
    label: String(row.label ?? "Claude").trim() || "Claude",
    windows,
    balanceCents: typeof cents === "number" && Number.isFinite(cents) && cents >= 0 ? Math.floor(cents) : null,
    balanceCurrency: typeof currency === "string" && currency.trim() ? currency.trim() : null,
    creditStatus: credit === "available" || credit === "exhausted" ? credit : null,
  };
}

/** "$12.50" from cents. Empty when there is no balance. */
export function formatAccountBalance(cents: number | null, currency = "USD"): string {
  if (cents == null || !Number.isFinite(cents) || cents < 0) return "";
  const amount = Math.floor(cents) / 100;
  const code = currency.trim().toUpperCase() || "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

/** "42%" for a window, without a trailing decimal when the number is whole. */
export function formatAccountUsed(percent: number): string {
  const value = Math.max(0, Math.min(100, percent));
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}%`;
}

/** Short reset hint. Empty when the timestamp is missing or unreadable. */
export function formatAccountReset(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return "";
  const numeric = /^[0-9]{10,13}$/.test(iso) ? Number(iso) : NaN;
  const at = Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const delta = at - nowMs;
  if (delta <= 0) return "reset";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
