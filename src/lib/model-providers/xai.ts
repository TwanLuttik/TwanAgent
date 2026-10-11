import type { ProviderProfile } from "./types.ts";

export const xaiProfile: ProviderProfile = {
  id: "xai",
  owns: () => false,
  planMode: true,
  agentName: "Grok",
  symbol: "logo.grok",
  contextFallback: null,
};
