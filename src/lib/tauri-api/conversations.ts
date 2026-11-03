import { invoke } from "@tauri-apps/api/core";
import { runPool } from "../hosted.ts";

export type ConversationSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  kind?: string;
  journey_id?: string | null;
  sort_order?: number;
  effort?: string | null;
  model?: string | null;
  context_window?: number | null;
  permission?: string | null;
  archived?: boolean;
  /** Latest user or assistant line, flattened. Empty when the chat has none. */
  preview?: string;
};
export type Compaction = {
  summary: string;
  through: number;
};
export type Conversation = ConversationSummary & {
  messages: unknown[];
  context_usage?: ApiChatUsage | null;
  compaction?: Compaction | null;
};
export type Journey = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sort_order: number;
  collapsed: boolean;
  color?: string;
};
export type SidebarItem = { kind: "journey" | "conversation" | string; id: string };
export type ToolCall = { id: string; name: string; arguments: string };
export type ApiThinkingBlock = {
  type: "thinking" | "redacted_thinking" | string;
  thinking?: string;
  signature?: string;
  data?: string;
};
export type ApiChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

async function hostedFrame(workspace: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await hostedCall(workspace, frame);
  return JSON.parse(raw) as Record<string, unknown>;
}

function summaryFromHosted(row: Record<string, unknown>): ConversationSummary {
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? "Chat"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    kind: String(row.kind ?? "chat"),
    journey_id: (row.journey_id as string | null | undefined) ?? null,
    sort_order: Number(row.sort_order ?? 0),
    effort: (row.effort as string | null | undefined) ?? null,
    model: (row.model as string | null | undefined) ?? null,
    context_window: (row.context_window as number | null | undefined) ?? null,
    permission: (row.permission as string | null | undefined) ?? null,
    archived: Boolean(row.archived),
  };
}

/** The last server chat list and the saved messages. Empty until one sync has landed. */
export async function hostedSidebarCached(
  workspace: string,
): Promise<{ conversations: ConversationSummary[]; journeys: Journey[]; transcripts: Conversation[] }> {
  const [conversations, journeys, transcripts] = await invoke<
    [ConversationSummary[], Journey[], Conversation[]]
  >("dev_hosted_sidebar_cached", { workspace });
  return {
    conversations: conversations ?? [],
    journeys: journeys ?? [],
    transcripts: transcripts ?? [],
  };
}

/** The last transcript saved for one cloud chat. Null until that chat has been opened here. */
export function hostedConversationCached(workspace: string, id: string): Promise<Conversation | null> {
  return invoke("dev_hosted_conversation_cached", { workspace, id });
}

/** Cloud chats live on the paired server. The local mount database is not used. Messages are cached with the list. */
export async function listHostedConversations(workspace: string): Promise<ConversationSummary[]> {
  // `list_conversations` is the frame every paired server already accepts.
  // A newer frame name fails on a server that has not been updated.
  const frame = await hostedFrame(workspace, { type: "list_conversations" });
  const rows = Array.isArray(frame.rows) ? frame.rows : [];
  const summaries = rows.map((row) => summaryFromHosted(row as Record<string, unknown>));
  // The list has no messages. Warm each transcript in the background, two SSH
  // calls at a time, so the sidebar can paint before every chat has downloaded.
  const ids = summaries.map((row) => row.id).filter((id) => id.length > 0);
  void runPool(ids, 2, (id) => getHostedConversation(workspace, id).catch(() => undefined));
  return summaries;
}

export async function getHostedConversation(workspace: string, id: string): Promise<Conversation> {
  const frame = await hostedFrame(workspace, { type: "get_conversation", id });
  const row = frame;
  return {
    ...summaryFromHosted(row),
    messages: Array.isArray(row.messages) ? row.messages : [],
  };
}

export type SidebarProject = {
  path: string;
  name: string;
  remote?: boolean;
  conversations: ConversationSummary[];
  journeys: Journey[];
};

/** Every indexed project, in sidebar order, with the chats already copied into the app database. */
export function sidebarSnapshot(): Promise<SidebarProject[]> {
  return invoke("dev_sidebar_snapshot");
}

export function listConversations(workspace: string): Promise<ConversationSummary[]> {
  return invoke("dev_list_conversations", { workspace });
}

/** A cloud chat is found by id. The mount path is not the store. */
export function getConversationById(id: string): Promise<Conversation> {
  return invoke("dev_get_conversation", { id });
}

export function getConversation(workspace: string, id: string): Promise<Conversation> {
  return invoke("dev_get_conversation", { id, workspace: workspace || null });
}

export function saveConversation(workspace: string, conversation: Conversation): Promise<Conversation> {
  return invoke("dev_save_conversation", { workspace, conversation });
}

export function reorderConversations(
  workspace: string,
  ids: string[],
): Promise<ConversationSummary[]> {
  return invoke("dev_reorder_conversations", { workspace, ids });
}

export function deleteConversation(workspace: string, id: string): Promise<void> {
  return invoke("dev_delete_conversation", { workspace, id });
}

export function archiveConversation(workspace: string, id: string, archived: boolean): Promise<void> {
  return invoke("dev_archive_conversation", { workspace, id, archived });
}

export function listJourneys(workspace: string): Promise<Journey[]> {
  return invoke("dev_list_journeys", { workspace });
}

export function createJourney(workspace: string, conversationId: string): Promise<Journey> {
  return invoke("dev_create_journey", {
    workspace,
    conversationId,
    conversation_id: conversationId,
  });
}

export function renameJourney(workspace: string, id: string, title: string): Promise<Journey> {
  return invoke("dev_rename_journey", { workspace, id, title });
}

export function deleteJourney(workspace: string, id: string, deleteChats: boolean): Promise<void> {
  return invoke("dev_delete_journey", {
    workspace,
    id,
    deleteChats,
    delete_chats: deleteChats,
  });
}

export function setJourneyCollapsed(workspace: string, id: string, collapsed: boolean): Promise<void> {
  return invoke("dev_set_journey_collapsed", { workspace, id, collapsed });
}

export function setJourneyColor(workspace: string, id: string, color: string): Promise<Journey> {
  return invoke("dev_set_journey_color", { workspace, id, color });
}

export function moveConversation(
  workspace: string,
  id: string,
  journeyId: string | null,
): Promise<Conversation> {
  return invoke("dev_move_conversation", {
    workspace,
    id,
    journeyId,
    journey_id: journeyId,
  });
}

export function reorderSidebar(workspace: string, items: SidebarItem[]): Promise<ConversationSummary[]> {
  return invoke("dev_reorder_sidebar", { workspace, items });
}

export function getJourneyKnowledge(workspace: string, journeyId: string): Promise<string> {
  return invoke("dev_get_journey_knowledge", {
    workspace,
    journeyId,
    journey_id: journeyId,
  });
}

export function saveJourneyKnowledge(workspace: string, journeyId: string, contents: string): Promise<void> {
  return invoke("dev_save_journey_knowledge", {
    workspace,
    journeyId,
    journey_id: journeyId,
    contents,
  });
}

export function updateJourneyKnowledge(
  workspace: string,
  journeyId: string,
  args: { mode: string; contents?: string; oldString?: string; newString?: string },
): Promise<string> {
  return invoke("dev_update_journey_knowledge", {
    workspace,
    journeyId,
    journey_id: journeyId,
    mode: args.mode,
    contents: args.contents ?? null,
    oldString: args.oldString ?? null,
    newString: args.newString ?? null,
    old_string: args.oldString ?? null,
    new_string: args.newString ?? null,
  });
}

export function hostedTurn(input: {
  workspace: string;
  streamId: string;
  conversationId: string;
  prompt: string;
  model?: string;
  effort?: string;
  permission?: string;
  contextWindow?: number;
}): Promise<void> {
  return invoke("dev_hosted_turn", {
    workspace: input.workspace,
    streamId: input.streamId,
    stream_id: input.streamId,
    conversationId: input.conversationId,
    conversation_id: input.conversationId,
    prompt: input.prompt,
    model: input.model ?? null,
    effort: input.effort ?? null,
    permission: input.permission ?? null,
    contextWindow: input.contextWindow ?? null,
    context_window: input.contextWindow ?? null,
  });
}

export function hostedCancel(streamId: string): Promise<void> {
  return invoke("dev_hosted_cancel", { streamId, stream_id: streamId });
}

/** Ask mode on a paired server. The command has not run until this returns. */
export function hostedShellAnswer(conversationId: string, allow: boolean): Promise<void> {
  return invoke("dev_hosted_shell_answer", {
    conversationId,
    conversation_id: conversationId,
    allow,
  });
}

/** Follow a turn that is already running on the paired server. Events arrive on `dev-chat`. */
export function hostedFollow(workspace: string, streamId: string, conversationId: string): Promise<void> {
  return invoke("dev_hosted_follow", {
    workspace,
    streamId,
    stream_id: streamId,
    conversationId,
    conversation_id: conversationId,
  });
}

export function hostedUnfollow(streamId: string): Promise<void> {
  return invoke("dev_hosted_unfollow", { streamId, stream_id: streamId });
}

/** One conversation frame on the paired server. The reply is the server frame as JSON. */
export function hostedCall(workspace: string, frame: Record<string, unknown>): Promise<string> {
  return invoke("dev_hosted_call", {
    workspace,
    frameJson: JSON.stringify(frame),
    frame_json: JSON.stringify(frame),
  });
}
