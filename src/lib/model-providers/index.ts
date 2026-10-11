import { anthropicProfile } from "./anthropic.ts";
import { minimaxProfile } from "./minimax.ts";
import type { ProviderId, ProviderProfile } from "./types.ts";
import { xaiProfile } from "./xai.ts";

export type { ProviderId, ProviderProfile } from "./types.ts";
export { isClaudeModel } from "./anthropic.ts";
export { isMinimaxModel } from "./minimax.ts";

/** Specific providers first. xAI is the fallback and must stay last. */
const PROFILES: ProviderProfile[] = [minimaxProfile, anthropicProfile, xaiProfile];

export function providerProfile(modelId: string): ProviderProfile {
  const id = modelId.trim();
  return PROFILES.find((profile) => profile.owns(id)) ?? xaiProfile;
}

export function providerFor(modelId: string): ProviderId {
  return providerProfile(modelId).id;
}

export function contextWindowForProvider(modelId: string, windowFromCatalog?: number | null): number | null {
  if (windowFromCatalog && windowFromCatalog > 0) return windowFromCatalog;
  return providerProfile(modelId).contextFallback;
}

/** Name used in the system prompt. Empty when the id is not a known provider family. */
export function agentNameFor(modelId: string): string {
  const id = modelId.trim();
  if (!id) return "";
  const profile = providerProfile(id);
  if (profile.id === "xai" && !id.toLowerCase().startsWith("grok")) return "";
  return profile.agentName;
}

/** One sentence that tells the model who it is for this chat. */
export function agentIdentityLine(modelId?: string | null): string {
  const id = (modelId ?? "").trim();
  const name = agentNameFor(id);
  if (name && id) return `You are ${name} (${id}), a coding agent in TwanAgent.`;
  if (name) return `You are ${name}, a coding agent in TwanAgent.`;
  return "You are a coding agent in TwanAgent.";
}
