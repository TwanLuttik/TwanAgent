import type { ProviderProfile } from "./types.ts";

/** MiniMax text ids. The prefix matches the API, so `minimax-m3` stays on xAI. */
export function isMinimaxModel(modelId: string): boolean {
  const id = modelId.trim();
  const rest = id.startsWith("MiniMax-") ? id.slice("MiniMax-".length) : "";
  return rest.length > 0 && /^[A-Za-z0-9.-]+$/.test(rest);
}

export const minimaxProfile: ProviderProfile = {
  id: "minimax",
  owns: isMinimaxModel,
  planMode: false,
  agentName: "MiniMax",
  symbol: "logo.minimax",
  contextFallback: 512_000,
};
