import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ApiChatUsage, ApiThinkingBlock, Conversation, ConversationSummary, ToolCall } from "./conversations.ts";

export type ApiUsageEvent = {
  id: number;
  recorded_at: string;
  workspace_path: string;
  workspace_name: string;
  conversation_id: string;
  conversation_title: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Prompt tokens served from cache. Already inside `prompt_tokens`. */
  cache_read_tokens?: number;
  duration_ms?: number | null;
  /** Non-empty when the row was copied from a paired server. Empty for a turn recorded here. */
  source?: string;
};
export type ApiUsageRecord = {
  workspace_path: string;
  workspace_name: string;
  conversation_id?: string;
  conversation_title?: string;
  model?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Prompt tokens served from cache. Already inside `prompt_tokens`. */
  cache_read_tokens?: number;
  duration_ms?: number | null;
};
export type LiveSocketEvent = {
  stream_id: string;
  conversation_id: string;
  port: number;
  direction: "in" | "out" | string;
  text: string;
};

export type ChatEvent = {
  stream_id: string;
  kind: "delta" | "done" | "error" | string;
  text?: string | null;
  tool_calls?: ToolCall[] | null;
  usage?: ApiChatUsage | null;
  thinking?: ApiThinkingBlock[] | null;
  reasoning_items?: Record<string, unknown>[] | null;
  /** Saved by the paired server. The GUI replaces its copy with this. */
  conversation?: Conversation | null;
};

export type WebSearchEvent = {
  stream_id: string;
  kind: "site" | "scope" | string;
  host?: string | null;
  text?: string | null;
};

export function chatStart(
  streamId: string,
  messages: unknown[],
  model?: string,
  effort?: string,
  journeyId?: string,
  contextWindow?: number,
  serviceTier?: string,
): Promise<void> {
  const tokens = contextWindow && contextWindow > 0 ? Math.floor(contextWindow) : null;
  return invoke("dev_chat_start", {
    streamId,
    stream_id: streamId,
    messages,
    model,
    effort,
    journeyId,
    journey_id: journeyId ?? null,
    contextWindow: tokens,
    context_window: tokens,
    serviceTier: serviceTier ?? null,
    service_tier: serviceTier ?? null,
  });
}

export function chatCancel(streamId: string): Promise<void> {
  return invoke("dev_chat_cancel", { streamId, stream_id: streamId });
}

export type LocalTurnInfo = {
  conversation_id: string;
  workspace: string;
  /** Epoch ms when the process started this turn. Missing on an older build. */
  started_at?: number;
};

/** Turns still running in the app process. A reloaded window uses this to rejoin them. */
export function localTurns(): Promise<LocalTurnInfo[]> {
  return invoke("dev_local_turns");
}

export function localTurnStart(input: {
  workspace: string;
  conversationId: string;
  messages: unknown[];
  model?: string;
  effort?: string;
  contextWindow?: number;
  permission?: string;
  serviceTier?: string;
  system?: string;
  journeyId?: string;
  allowSpawn?: boolean;
}): Promise<void> {
  const tokens = input.contextWindow && input.contextWindow > 0 ? Math.floor(input.contextWindow) : null;
  return invoke("dev_local_turn_start", {
    request: {
      workspace: input.workspace,
      conversation_id: input.conversationId,
      messages: input.messages,
      model: input.model ?? "",
      effort: input.effort ?? "",
      context_window: tokens,
      permission: input.permission ?? "ask",
      service_tier: input.serviceTier ?? "",
      system: input.system ?? "",
      journey_id: input.journeyId ?? null,
      allow_spawn: input.allowSpawn !== false,
    },
  });
}

export function localTurnStop(conversationId: string): Promise<void> {
  return invoke("dev_local_turn_stop", { conversationId, conversation_id: conversationId });
}

export function localTurnShell(conversationId: string, command: string, allow: boolean): Promise<void> {
  return invoke("dev_local_turn_shell", {
    conversationId,
    conversation_id: conversationId,
    command,
    allow,
  });
}

export function localTurnPlan(conversationId: string, decision: string, note = ""): Promise<void> {
  return invoke("dev_local_turn_plan", {
    conversationId,
    conversation_id: conversationId,
    decision,
    note,
  });
}

export function onLocalTurn(fn: (ev: ChatEvent) => void): Promise<UnlistenFn> {
  return listen<ChatEvent>("dev-local-turn", (ev) => fn(ev.payload));
}

export type ConversationCreated = {
  workspace: string;
  conversation: ConversationSummary;
};

/** A group chat created a conversation in one of its projects. */
export function onConversationCreated(fn: (ev: ConversationCreated) => void): Promise<UnlistenFn> {
  return listen<ConversationCreated>("dev-conversation-created", (ev) => fn(ev.payload));
}

export function webSearch(streamId: string, argumentsJson: string): Promise<string> {
  return invoke("dev_web_search", {
    streamId,
    stream_id: streamId,
    arguments: argumentsJson,
  });
}

export function onWebSearch(fn: (ev: WebSearchEvent) => void): Promise<UnlistenFn> {
  return listen<WebSearchEvent>("dev-web-search", (ev) => fn(ev.payload));
}

export function usageRecord(event: ApiUsageRecord): Promise<ApiUsageEvent | null> {
  return invoke("dev_usage_record", { event });
}

/** Copy each paired server's usage log into the local one. Returns how many rows were new. */
export function usageSync(): Promise<number> {
  return invoke("dev_usage_sync");
}

export function usageList(since?: string): Promise<ApiUsageEvent[]> {
  return invoke("dev_usage_list", { since: since ?? null });
}

/** One hosted chat the desktop has already copied from its server. */
export type ApiCloudUsageChat = {
  project_path: string;
  project_name: string;
  conversation_id: string;
  title: string;
  model: string;
  updated_at: string;
  prompt_tokens: number;
  completion_tokens: number;
};

/** A hosted project. `chats` is empty when none of its conversations have been opened here. */
export type ApiCloudUsageProject = {
  project_path: string;
  project_name: string;
  chats: ApiCloudUsageChat[];
};

/**
 * Cloud projects and the chats cached on this machine. The server keeps no usage
 * log, so a chat's tokens are the context of its latest turn, not a history.
 */
export function usageCloud(): Promise<ApiCloudUsageProject[]> {
  return invoke("dev_usage_cloud");
}

/** Finish stamps for one chat. Opening a conversation does not read the whole usage history. */
export function usageForConversation(conversationId: string, workspace: string): Promise<ApiUsageEvent[]> {
  return invoke("dev_usage_for_conversation", {
    conversationId,
    conversation_id: conversationId,
    workspace,
  });
}

const chatListeners = new Map<string, (ev: ChatEvent) => void>();
let chatListen: Promise<UnlistenFn> | null = null;

function ensureChatListen(): Promise<UnlistenFn> {
  if (!chatListen) {
    chatListen = listen<ChatEvent>("dev-chat", (ev) => {
      const payload = ev.payload;
      if (!payload) return;
      for (const fn of chatListeners.values()) fn(payload);
    });
  }
  return chatListen;
}

export function onLiveSocket(fn: (ev: LiveSocketEvent) => void): Promise<UnlistenFn> {
  return listen<LiveSocketEvent>("dev-live-socket", (ev) => fn(ev.payload));
}

export async function onChat(fn: (ev: ChatEvent) => void): Promise<UnlistenFn> {
  await ensureChatListen();
  const key = `tmp-${crypto.randomUUID()}`;
  const wrapped = (ev: ChatEvent) => fn(ev);
  chatListeners.set(key, wrapped);
  return () => {
    chatListeners.delete(key);
  };
}
