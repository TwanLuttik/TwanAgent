import type { ProviderProfile } from "./types.ts";

/** Catalog ids and any other `gpt-` id. `gpt-` alone stays on xAI. */
export function isOpenAiModel(modelId: string): boolean {
  const id = modelId.trim();
  const rest = id.startsWith("gpt-") ? id.slice("gpt-".length) : "";
  return rest.length > 0 && /^[A-Za-z0-9._-]+$/.test(rest);
}

export const openaiProfile: ProviderProfile = {
  id: "openai",
  owns: isOpenAiModel,
  planMode: false,
  agentName: "GPT",
  symbol: "logo.openai",
  contextFallback: 922_000,
};
