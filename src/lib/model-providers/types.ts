export type ProviderId = "xai" | "anthropic" | "minimax";

/** What the UI branches on. The chat request does not. */
export type ProviderProfile = {
  id: ProviderId;
  /** Claims this model id. The first profile that returns true wins. xAI is the fallback and claims nothing. */
  owns: (modelId: string) => boolean;
  planMode: boolean;
  agentName: string;
  symbol: string;
  /** Used when the catalog row has no context window. */
  contextFallback: number | null;
};
