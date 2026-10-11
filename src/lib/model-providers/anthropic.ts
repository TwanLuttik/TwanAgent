import type { ProviderProfile } from "./types.ts";

/** Any Anthropic chat id, including a dated snapshot. Grok tutor ids stay on xAI. */
export function isClaudeModel(modelId: string): boolean {
  const id = modelId.trim();
  if (id.startsWith("sxs-")) return false;
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
