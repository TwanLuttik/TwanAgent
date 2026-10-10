import { contextWindowForProvider } from "./provider.ts";

export type ChatUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type UsageTone = "ok" | "warn" | "high";

export type ContextUsageSnapshot = {
  used: number;
  window: number;
  percent: number;
  tone: UsageTone;
};

function asCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function detailsCount(raw: unknown, key: string): number {
  if (!raw || typeof raw !== "object") return 0;
  return asCount((raw as Record<string, unknown>)[key]) ?? 0;
}

export function normalizeChatUsage(promptTokens: number, completionTokens: number, totalTokens: number): ChatUsage {
  let completion = completionTokens;
  let total = totalTokens;
  const sum = promptTokens + completion;
  if (total < sum) total = sum;
  if (total > promptTokens + completion) completion = total - promptTokens;
  return { promptTokens, completionTokens: completion, totalTokens: total };
}

export function parseChatUsage(raw: unknown): ChatUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const promptTokens = asCount(rec.prompt_tokens ?? rec.promptTokens ?? rec.input_tokens);
  if (promptTokens == null) return null;
  let completionTokens = asCount(rec.completion_tokens ?? rec.completionTokens ?? rec.output_tokens) ?? 0;
  const reasoning = detailsCount(rec.completion_tokens_details ?? rec.completionTokensDetails, "reasoning_tokens");
  if (reasoning > 0 && completionTokens < reasoning) completionTokens += reasoning;
  const totalTokens = asCount(rec.total_tokens ?? rec.totalTokens) ?? promptTokens + completionTokens;
  return normalizeChatUsage(promptTokens, completionTokens, totalTokens);
}

export function contextWindowForModel(modelId: string, windowFromCatalog?: number | null): number {
  if (windowFromCatalog && windowFromCatalog > 0) return windowFromCatalog;
  const claude = contextWindowForProvider(modelId, null);
  if (claude) return claude;
  const id = modelId.trim().toLowerCase();
  if (id.startsWith("grok-3")) return 131_072;
  return 500_000;
}

/** Catalog sizes worth a picker. A single window is omitted so the chip stays hidden. */
export function contextWindowChoices(
  windows?: number[] | null,
  catalogDefault?: number | null,
): number[] {
  const rows: number[] = [];
  for (const value of windows ?? []) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const tokens = Math.floor(value);
    if (!rows.includes(tokens)) rows.push(tokens);
  }
  if (catalogDefault && catalogDefault > 0) {
    const tokens = Math.floor(catalogDefault);
    if (!rows.includes(tokens)) rows.unshift(tokens);
  }
  return rows.length > 1 ? rows : [];
}

export function contextWindowLabel(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  const n = Math.floor(tokens);
  if (n % 1000 === 0) {
    const k = n / 1000;
    if (k % 1000 === 0) return `${k / 1000}M`;
    return `${k}k`;
  }
  return n.toLocaleString("en-US");
}

/**
 * Keep a saved size when this model offers it. Otherwise use the catalog default,
 * then the first listed size. Matches Grok CLI: the choice carries to a model that
 * supports the same size.
 */
export function resolveContextWindow(
  choices: number[],
  preferred: number | null | undefined,
  catalogDefault?: number | null,
  modelId = "",
): number {
  if (preferred && preferred > 0 && choices.includes(preferred)) return preferred;
  if (catalogDefault && catalogDefault > 0 && (choices.length === 0 || choices.includes(catalogDefault))) {
    return catalogDefault;
  }
  if (choices.length > 0) return choices[0];
  return contextWindowForModel(modelId, catalogDefault);
}

export function contextUsedPercent(used: number, windowSize: number): number {
  if (windowSize <= 0 || used <= 0) return 0;
  return Math.min(100, Math.round((used / windowSize) * 100));
}

export function contextUsageTone(percent: number): UsageTone {
  if (percent >= 95) return "high";
  if (percent >= 80) return "warn";
  return "ok";
}

export function formatTokenCount(n: number): string {
  const value = Math.max(0, Math.floor(n));
  if (value < 1000) return String(value);
  if (value < 10_000) {
    const compact = (value / 1000).toFixed(1);
    return `${compact.endsWith(".0") ? compact.slice(0, -2) : compact}k`;
  }
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  const compact = (value / 1_000_000).toFixed(1);
  return `${compact.endsWith(".0") ? compact.slice(0, -2) : compact}M`;
}

export function contextUsageSnapshot(usage: ChatUsage, windowSize: number): ContextUsageSnapshot {
  const window = windowSize > 0 ? windowSize : 500_000;
  const used = usage.totalTokens > 0 ? usage.totalTokens : usage.promptTokens + usage.completionTokens;
  const percent = contextUsedPercent(used, window);
  return { used, window, percent, tone: contextUsageTone(percent) };
}

export function formatContextUsage(usage: ChatUsage, windowSize: number): string {
  const snap = contextUsageSnapshot(usage, windowSize);
  return `${snap.percent}% · ${formatTokenCount(snap.used)} / ${formatTokenCount(snap.window)}`;
}

export function usageToWire(usage: ChatUsage): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

export function putChatUsage(
  prev: Record<string, ChatUsage>,
  id: string,
  raw: unknown,
): Record<string, ChatUsage> {
  const stored = parseChatUsage(raw);
  if (!id || !stored) return prev;
  if (sameChatUsage(prev[id], stored)) return prev;
  return { ...prev, [id]: stored };
}

export function usageToPersist(
  latest?: ChatUsage,
  stored?: ChatUsage,
): ReturnType<typeof usageToWire> | undefined {
  const usage = latest ?? stored;
  return usage ? usageToWire(usage) : undefined;
}

export function sameChatUsage(a: ChatUsage | undefined, b: ChatUsage): boolean {
  return (
    a?.promptTokens === b.promptTokens &&
    a?.completionTokens === b.completionTokens &&
    a?.totalTokens === b.totalTokens
  );
}
