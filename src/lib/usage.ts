import { folderName, projectKey } from "./core.ts";

export type UsageRange = 7 | 30 | 90;

export type UsageEvent = {
  id: number;
  recorded_at: string;
  workspace_path: string;
  workspace_name: string;
  conversation_id: string;
  conversation_title: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms?: number | null;
};

export type UsageTotals = { prompt: number; completion: number; total: number };

export type UsageDay = UsageTotals & { date: string };

export type UsageProject = UsageTotals & { path: string; name: string };

export type UsageSnapshot = {
  totals: UsageTotals;
  days: UsageDay[];
  projects: UsageProject[];
  /** Mean response time for turns that recorded one. Null when none did. */
  avgDurationMs: number | null;
  durationCount: number;
};

export function formatBytes(bytes: number): string {
  const n = Math.max(0, Math.floor(bytes));
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = units[0];
  for (let i = 0; i < units.length; i++) {
    unit = units[i];
    if (value < 1024 || i === units.length - 1) break;
    value /= 1024;
  }
  const rounded = Number(value.toFixed(2));
  const digits = rounded >= 100 || Number.isInteger(rounded) ? 0 : rounded >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function rangeStartMs(range: UsageRange, nowMs = Date.now()): number {
  const end = new Date(nowMs);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (range - 1));
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function emptyTotals(): UsageTotals {
  return { prompt: 0, completion: 0, total: 0 };
}

function addTotals(target: UsageTotals, delta: UsageTotals) {
  target.prompt += delta.prompt;
  target.completion += delta.completion;
  target.total += delta.total;
}

function conversationKey(ev: UsageEvent): string {
  return ev.conversation_id || `event:${ev.id}`;
}

/**
 * Tokens introduced by one model request.
 * A later tool round resends the whole prompt, so only the growth counts.
 * The same prompt with a different completion is another send of that prompt, not new context.
 * An identical row is a double write and counts as nothing.
 */
export function usageDelta(current: UsageEvent, previous?: UsageEvent): UsageTotals {
  if (
    previous &&
    current.prompt_tokens === previous.prompt_tokens &&
    current.completion_tokens === previous.completion_tokens &&
    current.total_tokens === previous.total_tokens
  ) {
    return emptyTotals();
  }
  if (previous && current.prompt_tokens > previous.prompt_tokens) {
    const prompt = Math.max(0, current.prompt_tokens - previous.prompt_tokens - previous.completion_tokens);
    const completion = Math.max(0, current.completion_tokens);
    return { prompt, completion, total: prompt + completion };
  }
  if (previous && current.prompt_tokens === previous.prompt_tokens) {
    const completion = Math.max(0, current.completion_tokens);
    return { prompt: 0, completion, total: completion };
  }
  return {
    prompt: Math.max(0, current.prompt_tokens),
    completion: Math.max(0, current.completion_tokens),
    total: Math.max(0, current.total_tokens),
  };
}

/** USD per 1,000,000 tokens. Long context applies when the request prompt reaches the threshold. */
export type ModelRate = {
  input: number;
  output: number;
  cachedInput?: number;
  longContextFrom?: number;
  longInput?: number;
  longOutput?: number;
  longCachedInput?: number;
};

/**
 * xAI list prices, per million tokens.
 * A request whose prompt reaches 200k is billed at the long-context rate for every token in it.
 * https://docs.x.ai/docs/models
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  "grok-4.7": { input: 2, cachedInput: 0.5, output: 6, longContextFrom: 200_000, longInput: 4, longCachedInput: 1, longOutput: 12 },
  "grok-4.6": { input: 2, cachedInput: 0.5, output: 6, longContextFrom: 200_000, longInput: 4, longCachedInput: 1, longOutput: 12 },
  "grok-4.5": { input: 2, cachedInput: 0.3, output: 6, longContextFrom: 200_000, longInput: 4, longCachedInput: 0.6, longOutput: 12 },
  "grok-4.3": { input: 1.25, cachedInput: 0.2, output: 2.5, longContextFrom: 200_000, longInput: 2.5, longCachedInput: 0.4, longOutput: 5 },
  "grok-4.20-0309-reasoning": { input: 1.25, cachedInput: 0.2, output: 2.5, longContextFrom: 200_000, longInput: 2.5, longCachedInput: 0.4, longOutput: 5 },
  "grok-4.20-0309-non-reasoning": { input: 1.25, cachedInput: 0.2, output: 2.5, longContextFrom: 200_000, longInput: 2.5, longCachedInput: 0.4, longOutput: 5 },
  "grok-4.20-multi-agent-0309": { input: 1.25, cachedInput: 0.2, output: 2.5, longContextFrom: 200_000, longInput: 2.5, longCachedInput: 0.4, longOutput: 5 },
  "grok-build-0.1": { input: 1, cachedInput: 0.2, output: 2, longContextFrom: 200_000, longInput: 2, longCachedInput: 0.4, longOutput: 4 },
  // Anthropic standard context, per million tokens. No cached or long-context tier in this slice.
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const PER_MILLION = 1_000_000;

export function modelRate(model: string): ModelRate | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  if (MODEL_RATES[id]) return MODEL_RATES[id];
  const family = id.replace(/-latest$/, "").replace(/-\d{4,8}$/, "");
  if (family !== id && MODEL_RATES[family]) return MODEL_RATES[family];
  const prefix = family !== id ? family : id;
  const dated = Object.keys(MODEL_RATES)
    .filter((key) => prefix === key || prefix.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return dated ? MODEL_RATES[dated] : null;
}

function rateForPrompt(rate: ModelRate, promptTokens: number): { input: number; output: number } {
  const long = rate.longContextFrom != null && promptTokens >= rate.longContextFrom;
  return {
    input: long ? (rate.longInput ?? rate.input) : rate.input,
    output: long ? (rate.longOutput ?? rate.output) : rate.output,
  };
}

/** USD for one billable delta. Uses the prompt size of the request that introduced the tokens. */
export function usageCostUsd(delta: UsageTotals, model: string, promptTokens: number): number | null {
  const rate = modelRate(model);
  if (!rate) return null;
  const priced = rateForPrompt(rate, Math.max(0, promptTokens));
  return (delta.prompt * priced.input + delta.completion * priced.output) / PER_MILLION;
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

export type UsageCost = {
  usd: number;
  /** Tokens whose model has no list price, so they are left out of the estimate. */
  unpricedTokens: number;
};

/**
 * Estimated API cost for the same window and project filter as a usage snapshot.
 * Cached prompt tokens are not stored, so resent context is priced as fresh input.
 */
export function estimateUsageCost(
  events: UsageEvent[],
  opts: { range: UsageRange; nowMs?: number; workspacePath?: string | null },
): UsageCost {
  const nowMs = opts.nowMs ?? Date.now();
  const startMs = rangeStartMs(opts.range, nowMs);
  const want = opts.workspacePath ? projectKey(opts.workspacePath) : "";
  let usd = 0;
  let unpricedTokens = 0;
  for (const { ev, atMs, delta } of eachUsageDelta(events, (row, t) => {
    if (t < startMs || t > nowMs) return false;
    if (want && projectKey(row.workspace_path) !== want) return false;
    return true;
  })) {
    void atMs;
    const cost = usageCostUsd(delta, ev.model, ev.prompt_tokens);
    if (cost == null) unpricedTokens += delta.total;
    else usd += cost;
  }
  return { usd, unpricedTokens };
}

function eachUsageDelta(
  events: UsageEvent[],
  inside: (ev: UsageEvent, atMs: number) => boolean,
): { ev: UsageEvent; atMs: number; delta: UsageTotals }[] {
  const ordered = events
    .map((ev) => ({ ev, atMs: Date.parse(ev.recorded_at) }))
    .filter((row) => Number.isFinite(row.atMs))
    .sort((a, b) => a.atMs - b.atMs || a.ev.id - b.ev.id);
  const previous = new Map<string, UsageEvent>();
  const out: { ev: UsageEvent; atMs: number; delta: UsageTotals }[] = [];
  for (const row of ordered) {
    const key = conversationKey(row.ev);
    const delta = usageDelta(row.ev, previous.get(key));
    previous.set(key, row.ev);
    if (inside(row.ev, row.atMs)) out.push({ ev: row.ev, atMs: row.atMs, delta });
  }
  return out;
}

export function buildUsageSnapshot(
  events: UsageEvent[],
  opts: { range: UsageRange; nowMs?: number; workspacePath?: string | null },
): UsageSnapshot {
  const nowMs = opts.nowMs ?? Date.now();
  const startMs = rangeStartMs(opts.range, nowMs);
  const want = opts.workspacePath ? projectKey(opts.workspacePath) : "";
  const rows = events.filter((ev) => {
    const t = Date.parse(ev.recorded_at);
    if (!Number.isFinite(t) || t < startMs || t > nowMs) return false;
    if (want && projectKey(ev.workspace_path) !== want) return false;
    return true;
  });

  const start = new Date(startMs);
  const days: UsageDay[] = [];
  const byDay = new Map<string, UsageDay>();
  for (let i = 0; i < opts.range; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const date = dayKey(d.toISOString());
    const row: UsageDay = { date, ...emptyTotals() };
    days.push(row);
    byDay.set(date, row);
  }

  const totals = emptyTotals();
  const byProject = new Map<string, UsageProject>();
  let durationSum = 0;
  let durationCount = 0;
  for (const { ev, delta } of eachUsageDelta(rows, () => true)) {
    const ms = ev.duration_ms;
    if (typeof ms === "number" && ms >= 0) {
      durationSum += ms;
      durationCount += 1;
    }
    addTotals(totals, delta);
    const day = byDay.get(dayKey(ev.recorded_at));
    if (day) addTotals(day, delta);
    const key = projectKey(ev.workspace_path);
    const prev = byProject.get(key);
    if (prev) {
      addTotals(prev, delta);
    } else {
      byProject.set(key, {
        path: ev.workspace_path,
        name: ev.workspace_name || folderName(ev.workspace_path),
        prompt: delta.prompt,
        completion: delta.completion,
        total: delta.total,
      });
    }
  }

  const projects = [...byProject.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return {
    totals,
    days,
    projects,
    avgDurationMs: durationCount > 0 ? durationSum / durationCount : null,
    durationCount,
  };
}

export function formatDuration(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n} ms`;
  const seconds = n / 1000;
  if (seconds < 60) {
    const digits = seconds >= 10 ? 0 : 1;
    return `${seconds.toFixed(digits)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export type UsageLevel = 0 | 1 | 2 | 3 | 4;

export type UsageGridCell = UsageTotals & {
  date: string;
  inRange: boolean;
  level: UsageLevel;
};

export type UsageGridWeek = {
  cells: UsageGridCell[];
  monthLabel: string | null;
};

export function usageLevel(value: number, max: number): UsageLevel {
  if (value <= 0 || max <= 0) return 0;
  const t = value / max;
  if (t <= 0.25) return 1;
  if (t <= 0.5) return 2;
  if (t <= 0.75) return 3;
  return 4;
}

function parseDay(date: string): Date | null {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthShort(date: string): string {
  const d = parseDay(date);
  if (!d) return "";
  return MONTHS[d.getMonth()] ?? "";
}

export function buildUsageGrid(days: UsageDay[]): UsageGridWeek[] {
  if (days.length === 0) return [];
  const first = parseDay(days[0].date);
  const last = parseDay(days[days.length - 1].date);
  if (!first || !last) return [];

  const byDate = new Map(days.map((row) => [row.date, row]));
  const max = Math.max(0, ...days.map((row) => row.total));

  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + (6 - last.getDay()));

  const weeks: UsageGridWeek[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const cells: UsageGridCell[] = [];
    for (let i = 0; i < 7; i++) {
      const date = formatDayKey(cursor);
      const row = byDate.get(date);
      const inRange = Boolean(row);
      const prompt = row?.prompt ?? 0;
      const completion = row?.completion ?? 0;
      const total = row?.total ?? 0;
      cells.push({
        date,
        inRange,
        prompt,
        completion,
        total,
        level: inRange ? usageLevel(total, max) : 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    const firstOfMonth = cells.find((cell) => cell.inRange && parseDay(cell.date)?.getDate() === 1);
    const firstInRange = cells.find((cell) => cell.inRange);
    const isFirstWeek = weeks.length === 0;
    const monthLabel = firstOfMonth
      ? monthShort(firstOfMonth.date)
      : isFirstWeek && firstInRange
        ? monthShort(firstInRange.date)
        : null;
    weeks.push({ cells, monthLabel });
  }
  return weeks;
}

export const USAGE_TEASER_WINDOWS = [
  { id: "30m", label: "30m", ms: 30 * 60 * 1000 },
  { id: "2h", label: "2h", ms: 2 * 60 * 60 * 1000 },
  { id: "6h", label: "6h", ms: 6 * 60 * 60 * 1000 },
  { id: "12h", label: "12h", ms: 12 * 60 * 60 * 1000 },
] as const;

export function usageTotalSince(events: UsageEvent[], sinceMs: number, nowMs = Date.now()): number {
  let total = 0;
  for (const { delta } of eachUsageDelta(events, (_ev, atMs) => atMs >= sinceMs && atMs <= nowMs)) {
    total += delta.total;
  }
  return total;
}

export function usageSeries(
  events: UsageEvent[],
  sinceMs: number,
  nowMs: number,
  buckets: number,
): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const values = Array.from({ length: n }, () => 0);
  const span = nowMs - sinceMs;
  if (span <= 0) return values;
  for (const { atMs, delta } of eachUsageDelta(events, (_ev, t) => t >= sinceMs && t <= nowMs)) {
    let i = Math.floor(((atMs - sinceMs) / span) * n);
    if (i >= n) i = n - 1;
    if (i < 0) i = 0;
    values[i] += delta.total;
  }
  return values;
}

export function teaserIndex(nowMs: number, startedMs = 0, intervalMs = 5000): number {
  const step = Math.floor((nowMs - startedMs) / intervalMs);
  const len = USAGE_TEASER_WINDOWS.length;
  return ((step % len) + len) % len;
}

export type UsageTrendRange = "24h" | "7d" | "30d";

export type UsageTrendPoint = UsageTotals & {
  atMs: number;
  label: string;
};

export type UsageTrend = {
  points: UsageTrendPoint[];
  totals: UsageTotals;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function usageTrendRangeMs(range: UsageTrendRange): number {
  if (range === "24h") return DAY;
  if (range === "7d") return 7 * DAY;
  return 30 * DAY;
}

function trendBucketCount(range: UsageTrendRange): number {
  if (range === "24h") return 24;
  if (range === "7d") return 7 * 24;
  return 30;
}

function trendBucketStart(range: UsageTrendRange, nowMs: number): number {
  if (range === "30d") {
    const end = new Date(nowMs);
    return new Date(end.getFullYear(), end.getMonth(), end.getDate() - 29).setHours(0, 0, 0, 0);
  }
  return nowMs - usageTrendRangeMs(range);
}

function trendBucketAt(range: UsageTrendRange, startMs: number, index: number, size: number): number {
  if (range !== "30d") return startMs + index * size;
  const start = new Date(startMs);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + index).setHours(0, 0, 0, 0);
}

function dayIndex(startMs: number, atMs: number): number {
  const start = new Date(startMs);
  const at = new Date(atMs);
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const atDay = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.round((atDay - startDay) / DAY);
}

function trendLabel(range: UsageTrendRange, atMs: number): string {
  const d = new Date(atMs);
  if (range === "30d") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  if (range === "7d") {
    return d.toLocaleString(undefined, { weekday: "short", hour: "numeric" });
  }
  return d.toLocaleTimeString(undefined, { hour: "numeric" });
}

/**
 * Tokens added inside a rolling window.
 * 24h and 7d are hourly. 30d is one local calendar day per point.
 */
export function buildUsageTrend(
  events: UsageEvent[],
  opts: { range: UsageTrendRange; nowMs?: number; workspacePath?: string | null },
): UsageTrend {
  const nowMs = opts.nowMs ?? Date.now();
  const count = trendBucketCount(opts.range);
  const startMs = trendBucketStart(opts.range, nowMs);
  const span = Math.max(1, nowMs - startMs);
  const size = span / count;
  const want = opts.workspacePath ? projectKey(opts.workspacePath) : "";
  const points: UsageTrendPoint[] = Array.from({ length: count }, (_, i) => {
    const atMs = trendBucketAt(opts.range, startMs, i, size);
    return { atMs, label: trendLabel(opts.range, atMs), ...emptyTotals() };
  });
  const totals = emptyTotals();
  for (const { ev, atMs, delta } of eachUsageDelta(
    events,
    (row, t) => t >= startMs && t <= nowMs && (!want || projectKey(row.workspace_path) === want),
  )) {
    void ev;
    addTotals(totals, delta);
    let i = opts.range === "30d" ? dayIndex(startMs, atMs) : Math.floor((atMs - startMs) / size);
    if (i >= count) i = count - 1;
    if (i < 0) continue;
    addTotals(points[i], delta);
  }
  return { points, totals };
}

export function linePath(values: number[], width: number, height: number, pad = 0): string {
  if (values.length < 2) return "";
  const max = Math.max(0, ...values);
  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);
  const emptyY = pad + innerH / 2;
  return values
    .map((value, i) => {
      const x = pad + (i / (values.length - 1)) * innerW;
      const y = max <= 0 ? emptyY : pad + innerH - (value / max) * innerH;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
