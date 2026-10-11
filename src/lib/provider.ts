export type ProviderId = "xai" | "anthropic";

const CLAUDE_CONTEXT = 200_000;

/** Any Anthropic chat id, including a dated snapshot. Grok tutor ids stay on xAI. */
export function isClaudeModel(modelId: string): boolean {
  const id = modelId.trim();
  const rest = id.startsWith("claude-") ? id.slice("claude-".length) : "";
  return rest.length > 0 && /^[a-z0-9.-]+$/i.test(rest);
}

/** Catalog Claude ids are Anthropic. Everything else, including empty and Grok CLI side-by-side ids, is xAI. */
export function providerFor(modelId: string): ProviderId {
  return isClaudeModel(modelId) ? "anthropic" : "xai";
}

export function contextWindowForProvider(modelId: string, windowFromCatalog?: number | null): number | null {
  if (windowFromCatalog && windowFromCatalog > 0) return windowFromCatalog;
  if (isClaudeModel(modelId)) return CLAUDE_CONTEXT;
  return null;
}

/** Name used in the system prompt. Empty when the id is not a known provider. */
export function agentNameFor(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  if (!id) return "";
  if (id.startsWith("claude")) return "Claude";
  if (id.startsWith("grok-") || id.startsWith("grok ") || id.startsWith("grok")) return "Grok";
  return "";
}

/** One sentence that tells the model who it is for this chat. */
export function agentIdentityLine(modelId?: string | null): string {
  const id = (modelId ?? "").trim();
  const name = agentNameFor(id);
  if (name && id) return `You are ${name} (${id}), a coding agent in TwanAgent.`;
  if (name) return `You are ${name}, a coding agent in TwanAgent.`;
  return "You are a coding agent in TwanAgent.";
}
