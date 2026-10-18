import { providerFor, type ProviderId } from "./provider.ts";
import type { UsageEvent } from "./usage.ts";
import { usageDelta } from "./usage.ts";
import type { AccountUsage } from "./account-usage.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** How far the timeline looks past now. A week of days, plus a little slack. */
export const FORECAST_HORIZON_MS = 8 * DAY;

/** A window shorter than this is a session limit (5h). Longer ones are the weekly allowance. */
const SESSION_WINDOW_MS = 36 * HOUR;

/** A window that just opened still gets a pace, so a burst cannot divide by nothing. */
const MIN_ELAPSED_MS = 15 * 60 * 1000;

export type ForecastAccountId = ProviderId;

export type ForecastWindow = {
  id: string;
  label: string;
  /** 0–100 of this allowance already spent. */
  usedPercent: number;
  /** How long the allowance lasts. Null when the reset time is missing. */
  windowMs: number | null;
  resetsAt: number | null;
  /** True when the provider reports percent remaining, not percent used. */
  remaining: boolean;
};

export type ForecastAccount = {
  id: ForecastAccountId;
  /** Short name on the row, such as "Claude Pro". */
  name: string;
  /** Secondary line, such as an email or "Side project". */
  detail: string;
  logo: string;
  /** True when the login cannot be read. The row stays, with no forecast. */
  reconnect: boolean;
  windows: ForecastWindow[];
};

export type RunOut = {
  atMs: number;
  /** Hours from now until the allowance hits 100%. Negative when it already has. */
  hours: number;
};

export type AccountForecast = {
  account: ForecastAccount;
  /** The window the forecast is drawn from. Session limits win over weekly ones. */
  window: ForecastWindow | null;
  /** Percent of that window already spent, 0–100. */
  usedPercent: number;
  /** When this pace would empty the allowance. Null when usage is flat or there is no window. */
  runsOut: RunOut | null;
  /** Hours between running out and the reset. 0 when it lasts to the reset. */
  lockedHours: number;
  /** Percent points of the allowance spent per day at the recent pace. */
  pacePerDay: number;
  /** Percent points a day that would land exactly on the reset. */
  allowedPerDay: number;
  /** Recent days, oldest first, ending on today. */
  days: ForecastDay[];
};

export type ForecastDay = {
  atMs: number;
  label: string;
  /** Percent points of the allowance spent that day. */
  used: number;
  /** True when this day is still in progress. */
  today: boolean;
  /** True when the day sits past the reset, so it belongs to the next window. */
  nextWindow: boolean;
};

export type ForecastHeadline = {
  /** How many connected accounts run out before their reset. */
  count: number;
  /** The one that runs out first. */
  first: AccountForecast | null;
  /** Hours that first account stays locked. */
  lockedHours: number;
};

const ACCOUNT_META: Record<
  ForecastAccountId,
  { name: string; logo: string; remaining: boolean }
> = {
  anthropic: { name: "Claude", logo: "logo.claude", remaining: false },
  minimax: { name: "MiniMax", logo: "logo.minimax", remaining: true },
  xai: { name: "Grok", logo: "logo.grok", remaining: false },
};

/** Claude reports percent used. MiniMax reports percent left. Both become percent used. */
export function usedPercentOf(percent: number, remaining: boolean): number {
  const value = Number.isFinite(percent) ? percent : 0;
  const clamped = Math.max(0, Math.min(100, value));
  return remaining ? 100 - clamped : clamped;
}

export function parseResetMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const trimmed = iso.trim();
  if (!trimmed) return null;
  const numeric = /^[0-9]{10,13}$/.test(trimmed) ? Number(trimmed) : NaN;
  const at = Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : Date.parse(trimmed);
  return Number.isFinite(at) ? at : null;
}

/**
 * How long the allowance lasts.
 * A known label wins ("5h", "Week"). Otherwise the reset is one window away,
 * which is only a guess for a window that is already partway through.
 */
export function windowDurationMs(label: string, resetsAt: number | null, nowMs: number): number | null {
  const text = label.trim().toLowerCase();
  const hours = text.match(/^(\d+(?:\.\d+)?)\s*h$/);
  if (hours) return Math.round(Number(hours[1]) * HOUR);
  if (text === "week" || text === "7d" || text.endsWith(" week")) return 7 * DAY;
  if (text === "day" || text === "24h" || text.endsWith(" day")) return DAY;
  if (resetsAt == null || resetsAt <= nowMs) return null;
  return resetsAt - nowMs;
}

/** The allowance the forecast should follow. A session window beats a weekly one. */
export function primaryWindow(windows: ForecastWindow[], nowMs: number): ForecastWindow | null {
  const live = windows.filter((row) => row.resetsAt == null || row.resetsAt > nowMs);
  const pool = live.length > 0 ? live : windows;
  if (pool.length === 0) return null;
  const session = pool.find((row) => row.windowMs != null && row.windowMs <= SESSION_WINDOW_MS);
  if (session) return session;
  return [...pool].sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))[0];
}

export function accountFromUsage(id: ForecastAccountId, usage: AccountUsage | null, nowMs = Date.now()): ForecastAccount {
  const meta = ACCOUNT_META[id];
  const reconnect = !usage?.connected;
  const label = usage?.label?.trim() ?? "";
  const detail = label && label !== meta.name ? label : "";
  const windows: ForecastWindow[] = (usage?.windows ?? []).map((row) => {
    const resetsAt = parseResetMs(row.resetsAt);
    return {
      id: row.id,
      label: row.label,
      usedPercent: usedPercentOf(row.usedPercent, meta.remaining),
      windowMs: windowDurationMs(row.label, resetsAt, nowMs),
      resetsAt,
      remaining: meta.remaining,
    };
  });
  return {
    id,
    name: meta.name,
    detail,
    logo: meta.logo,
    reconnect,
    windows,
  };
}

function accountOf(model: string): ForecastAccountId {
  return providerFor(model);
}

type Sample = { atMs: number; tokens: number };

function samplesFor(events: UsageEvent[], accountId: ForecastAccountId, sinceMs: number, nowMs: number): Sample[] {
  const ordered = events
    .map((ev) => ({ ev, atMs: Date.parse(ev.recorded_at) }))
    .filter((row) => Number.isFinite(row.atMs))
    .sort((a, b) => a.atMs - b.atMs || a.ev.id - b.ev.id);
  const previous = new Map<string, UsageEvent>();
  const out: Sample[] = [];
  for (const row of ordered) {
    const key = `${row.ev.conversation_id || `event:${row.ev.id}`}\0${row.ev.model.trim()}`;
    const delta = usageDelta(row.ev, previous.get(key));
    previous.set(key, row.ev);
    if (row.atMs < sinceMs || row.atMs > nowMs) continue;
    if (accountOf(row.ev.model) !== accountId) continue;
    if (delta.total <= 0) continue;
    out.push({ atMs: row.atMs, tokens: delta.total });
  }
  return out;
}

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Percent of the allowance spent per day.
 * The provider already says how full the window is. That total, spread across the
 * time since the window opened, is the pace. Local history only fills the day bars.
 */
export function pacePerDay(window: ForecastWindow, nowMs: number): { perDay: number; perMs: number } {
  if (window.usedPercent <= 0) return { perDay: 0, perMs: 0 };
  const openedAt =
    window.resetsAt != null && window.windowMs != null
      ? window.resetsAt - window.windowMs
      : nowMs - (window.windowMs ?? DAY);
  const elapsed = Math.max(MIN_ELAPSED_MS, nowMs - openedAt);
  const perMs = window.usedPercent / elapsed;
  return { perDay: perMs * DAY, perMs };
}

/** When the current pace reaches 100%. Null when usage is flat or the window is already full. */
export function runOutAt(usedPercent: number, perMs: number, nowMs: number): RunOut | null {
  if (usedPercent >= 100) return { atMs: nowMs, hours: 0 };
  if (perMs <= 0) return null;
  const ms = ((100 - usedPercent) / perMs);
  return { atMs: nowMs + ms, hours: ms / HOUR };
}

/** Hours spent locked if the pace holds. Zero when the allowance lasts until reset. */
export function lockedHours(runsOut: RunOut | null, resetsAt: number | null): number {
  if (!runsOut || resetsAt == null) return 0;
  const gap = resetsAt - runsOut.atMs;
  if (gap <= 0) return 0;
  return gap / HOUR;
}

export function allowedPerDay(usedPercent: number, resetsAt: number | null, nowMs: number): number {
  if (resetsAt == null || resetsAt <= nowMs) return 0;
  const days = (resetsAt - nowMs) / DAY;
  if (days <= 0) return 0;
  return Math.max(0, 100 - usedPercent) / days;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(atMs: number, today: boolean): string {
  if (today) return "Today";
  return WEEKDAYS[new Date(atMs).getDay()] ?? "";
}

/**
 * One bar per day from when this window opened through the reset, at least a week.
 * Days after the reset are the next window and draw empty.
 */
export function forecastDays(
  events: UsageEvent[],
  account: ForecastAccount,
  window: ForecastWindow,
  nowMs: number,
): ForecastDay[] {
  const openedAt = window.resetsAt != null && window.windowMs != null ? window.resetsAt - window.windowMs : nowMs - 6 * DAY;
  const start = dayStart(Math.min(openedAt, nowMs - 6 * DAY));
  const end = window.resetsAt != null ? dayStart(window.resetsAt) : dayStart(nowMs);
  const last = Math.max(end, dayStart(nowMs));
  const since = start;
  const samples = samplesFor(events, account.id, since, nowMs + DAY);
  const byDay = new Map<number, number>();
  for (const sample of samples) {
    const key = dayStart(sample.atMs);
    byDay.set(key, (byDay.get(key) ?? 0) + sample.tokens);
  }
  const windowTokens = samples
    .filter((row) => row.atMs >= openedAt && row.atMs <= nowMs)
    .reduce((sum, row) => sum + row.tokens, 0);
  const percentPerToken = windowTokens > 0 && window.usedPercent > 0 ? window.usedPercent / windowTokens : 0;
  const today = dayStart(nowMs);
  const days: ForecastDay[] = [];
  for (let at = start; at <= last; at += DAY) {
    const next = window.resetsAt != null && at > dayStart(window.resetsAt);
    const tokens = byDay.get(at) ?? 0;
    days.push({
      atMs: at,
      label: dayLabel(at, at === today),
      used: next ? 0 : Math.round(tokens * percentPerToken * 10) / 10,
      today: at === today,
      nextWindow: next,
    });
  }
  return days;
}

/** One forecast row per live window. MiniMax keeps the 5-hour limit and the week. */
export function forecastWindows(account: ForecastAccount, nowMs = Date.now()): ForecastWindow[] {
  if (account.reconnect || account.windows.length === 0) return [];
  if (account.id !== "minimax") {
    const primary = primaryWindow(account.windows, nowMs);
    return primary ? [primary] : [];
  }
  const live = account.windows.filter((row) => row.resetsAt == null || row.resetsAt > nowMs);
  const pool = live.length > 0 ? live : account.windows;
  const session = pool.filter((row) => row.windowMs != null && row.windowMs <= SESSION_WINDOW_MS);
  const weekly = pool.filter((row) => row.windowMs != null && row.windowMs > SESSION_WINDOW_MS);
  const picked = [...session, ...weekly];
  const rows = picked.length > 0 ? picked : pool;
  return [...rows].sort((a, b) => (a.windowMs ?? Infinity) - (b.windowMs ?? Infinity));
}

export function forecastAccount(
  account: ForecastAccount,
  events: UsageEvent[],
  nowMs = Date.now(),
): AccountForecast {
  const window = forecastWindows(account, nowMs)[0] ?? null;
  if (!window) {
    return {
      account,
      window: null,
      usedPercent: 0,
      runsOut: null,
      lockedHours: 0,
      pacePerDay: 0,
      allowedPerDay: 0,
      days: [],
    };
  }
  const pace = pacePerDay(window, nowMs);
  const runsOut = runOutAt(window.usedPercent, pace.perMs, nowMs);
  return {
    account,
    window,
    usedPercent: window.usedPercent,
    runsOut,
    lockedHours: lockedHours(runsOut, window.resetsAt),
    pacePerDay: pace.perDay,
    allowedPerDay: allowedPerDay(window.usedPercent, window.resetsAt, nowMs),
    days: forecastDays(events, account, window, nowMs),
  };
}

/** Every allowance worth its own row. Claude stays one row. MiniMax gets the 5-hour and the week. */
export function forecastAccounts(
  account: ForecastAccount,
  events: UsageEvent[],
  nowMs = Date.now(),
): AccountForecast[] {
  const windows = forecastWindows(account, nowMs);
  if (windows.length === 0) return [forecastAccount(account, events, nowMs)];
  return windows.map((window) => {
    const name = windows.length > 1 ? `${account.name} ${windowLabel(window)}` : account.name;
    return forecastAccount({ ...account, name, windows: [window] }, events, nowMs);
  });
}

function windowLabel(window: ForecastWindow): string {
  const text = window.label.trim();
  if (/^5h$/i.test(text) || text.toLowerCase().includes("5h")) return "5h";
  if (/week/i.test(text)) return "Week";
  return text || "window";
}

export function forecastHeadline(rows: AccountForecast[], nowMs = Date.now()): ForecastHeadline {
  const soon = rows
    .filter((row) => row.runsOut && row.window?.resetsAt != null && row.runsOut.atMs < (row.window.resetsAt ?? 0))
    .filter((row) => (row.runsOut?.atMs ?? 0) >= nowMs - HOUR)
    .sort((a, b) => (a.runsOut?.atMs ?? 0) - (b.runsOut?.atMs ?? 0));
  const first = soon[0] ?? null;
  return {
    count: soon.length,
    first,
    lockedHours: first ? Math.round(first.lockedHours) : 0,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri 03:24" for a time inside the next week, otherwise "Oct 21 09:21". */
export function formatForecastWhen(atMs: number, nowMs = Date.now()): string {
  const at = new Date(atMs);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const soon = atMs - nowMs < 6 * DAY && atMs >= dayStart(nowMs);
  if (soon) return `${WEEKDAYS[at.getDay()]} ${time}`;
  return `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`;
}

/** "Resets Fri 11:22". A reset more than a week out names the date. */
export function formatResetWhen(atMs: number, nowMs = Date.now()): string {
  const at = new Date(atMs);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (atMs - nowMs > 6 * DAY) return `Resets ${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`;
  return `Resets ${WEEKDAYS[at.getDay()]} ${time}`;
}

export function formatLocked(hours: number): string {
  if (hours <= 0) return "0 h";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} m`;
  const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return `${rounded} h`;
}

export function formatPace(perDay: number): string {
  if (perDay <= 0) return "0";
  if (perDay >= 10) return String(Math.round(perDay));
  return (Math.round(perDay * 10) / 10).toString();
}

/** "1.0x even" when the pace matches the allowance, "1.4x fast" when it does not. */
export function formatPaceRatio(pacePerDay: number, allowedPerDay: number): { text: string; over: boolean } {
  if (allowedPerDay <= 0) {
    return pacePerDay > 0 ? { text: "over", over: true } : { text: "even", over: false };
  }
  const ratio = pacePerDay / allowedPerDay;
  const over = ratio > 1.05;
  const shown = Math.round(ratio * 10) / 10;
  return { text: `${shown.toFixed(1)}x ${over ? "fast" : "even"}`, over };
}

/**
 * Points for the detail chart. Past points are what was used.
 * The line then runs at the current pace to the reset, or to where it runs out.
 */
export function usageSeries(
  forecast: AccountForecast,
  nowMs: number,
): { atMs: number; used: number; projected: boolean }[] {
  const window = forecast.window;
  if (!window || window.windowMs == null) return [];
  const openedAt = window.resetsAt != null ? window.resetsAt - window.windowMs : nowMs - window.windowMs;
  const points: { atMs: number; used: number; projected: boolean }[] = [
    { atMs: openedAt, used: 0, projected: false },
    { atMs: nowMs, used: forecast.usedPercent, projected: false },
  ];
  const end = window.resetsAt ?? nowMs + window.windowMs;
  if (forecast.runsOut && forecast.runsOut.atMs > nowMs && forecast.runsOut.atMs < end) {
    points.push({ atMs: forecast.runsOut.atMs, used: 100, projected: true });
  }
  const atEnd = forecast.runsOut
    ? Math.min(100, forecast.usedPercent + (forecast.pacePerDay * (end - nowMs)) / DAY)
    : forecast.usedPercent;
  if (points[points.length - 1].atMs < end) {
    points.push({ atMs: end, used: Math.max(forecast.usedPercent, atEnd), projected: true });
  }
  return points;
}

