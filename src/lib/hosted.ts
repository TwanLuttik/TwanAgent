import type { ChatMessage } from "./core.ts";

/** What the GUI is allowed to send for a hosted turn. Tools are not included. */
export type HostedPrompt = {
  conversationId: string;
  prompt: string;
  model: string;
  effort: string;
  permission: string;
};

export type HostedEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; messages: ChatMessage[] }
  | { type: "error"; message: string };

/** A paired cloud project never runs the model or tools in the GUI. */
export function hostedTurnStaysOnServer(remote: { paired?: boolean; online?: boolean } | null | undefined): boolean {
  return Boolean(remote && remote.paired !== false && remote.online !== false);
}

/**
 * The composer waits while a cloud project is still opening its server.
 * `known` is false until the lookup for this folder has returned.
 * A local project, or a server that is already up, does not wait.
 */
export function cloudSendWaiting(
  hasWorkspace: boolean,
  known: boolean,
  remote: { paired?: boolean; online?: boolean } | null | undefined,
  linkReady: boolean,
): boolean {
  if (!hasWorkspace) return false;
  if (!known) return true;
  if (!remote?.paired || remote.online === false) return false;
  return !linkReady;
}

export type HostedServer = {
  submit(prompt: HostedPrompt): Promise<HostedEvent[]>;
  getConversation(id: string): Promise<ChatMessage[]>;
};

export function hostedPromptFrame(input: HostedPrompt): { type: "submit_prompt" } & HostedPrompt {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt is empty");
  if (!input.conversationId.trim()) throw new Error("conversation id is empty");
  return {
    type: "submit_prompt",
    conversationId: input.conversationId.trim(),
    prompt,
    model: input.model.trim(),
    effort: input.effort.trim(),
    permission: input.permission.trim() || "ask",
  };
}

/** A hosted frame is a prompt. The GUI does not execute tools from it. */
export function frameRunsToolsOnClient(frame: { type: string }): boolean {
  return frame.type !== "submit_prompt";
}

/**
 * Run `worker` for each item, at most `limit` at a time.
 * A worker that throws is skipped. The rest still run.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<unknown>,
): Promise<void> {
  if (items.length === 0) return;
  const size = Math.max(1, Math.min(items.length, Math.floor(limit) || 1));
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        await worker(items[index] as T);
      } catch {
        // one chat failing to cache must not stop the others
      }
    }
  }
  await Promise.all(Array.from({ length: size }, () => lane()));
}

export async function runHostedTurn(
  server: HostedServer,
  input: HostedPrompt,
): Promise<{ events: HostedEvent[]; messages: ChatMessage[] }> {
  const frame = hostedPromptFrame(input);
  const events = await server.submit({
    conversationId: frame.conversationId,
    prompt: frame.prompt,
    model: frame.model,
    effort: frame.effort,
    permission: frame.permission,
  });
  const failed = events.find((event) => event.type === "error");
  if (failed && failed.type === "error") {
    throw new Error(failed.message);
  }
  const messages = await server.getConversation(frame.conversationId);
  return { events, messages };
}
