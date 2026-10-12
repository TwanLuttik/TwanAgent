import type { ProviderProfile } from "./types.ts";

/** Any Anthropic chat id, including a dated snapshot. */
export function isClaudeModel(modelId: string): boolean {
  const id = modelId.trim();
  const rest = id.startsWith("claude-") ? id.slice("claude-".length) : "";
  return rest.length > 0 && /^[a-z0-9.-]+$/i.test(rest);
}

export const anthropicProfile: ProviderProfile = {
  id: "anthropic",
  owns: isClaudeModel,
  planMode: false,
  agentName: "Claude",
  symbol: "logo.claude",
  contextFallback: 200_000,
};
