import { parseToolArgs, type ChatMessage } from "./core.ts";
import { agentNameFor } from "./provider.ts";
import { permissionSystemLine, type PermissionMode } from "./permission.ts";

export const SUBAGENT_TYPES = ["general-purpose", "explore", "plan"] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];
export type SubagentStatus = "running" | "done" | "error" | "stopped";

export type SubagentRecord = {
  id: string;
  description: string;
  type: SubagentType;
  status: SubagentStatus;
  prompt: string;
  streamText: string;
  streamReasoning: string;
  tools: string[];
  messages: ChatMessage[];
  summary: string;
  error?: string;
};

export type SubagentEvent =
  | { type: "start"; record: SubagentRecord }
  | { type: "delta"; id: string; text: string }
  | { type: "reasoning"; id: string; text: string }
  | { type: "tool"; id: string; label: string }
  | { type: "update"; id: string; messages: ChatMessage[] }
  | { type: "done"; id: string; status: Exclude<SubagentStatus, "running">; summary: string; messages: ChatMessage[] }
  | { type: "error"; id: string; error: string };

export type SpawnArgs = {
  prompt: string;
  description: string;
  subagentType: SubagentType;
};

export function parseSubagentType(raw: unknown): SubagentType {
  if (raw === "explore" || raw === "plan" || raw === "general-purpose") return raw;
  return "general-purpose";
}

export function parseSpawnArgs(raw: string): SpawnArgs {
  const args = parseToolArgs(raw);
  const prompt = String(args.prompt ?? "").trim();
  const description = String(args.description ?? "").trim() || "Subagent";
  return {
    prompt,
    description: description.slice(0, 80),
    subagentType: parseSubagentType(args.subagent_type ?? args.subagentType),
  };
}

export function childCanUseTool(type: SubagentType, name: string): boolean {
  if (name === "spawn_subagent" || name === "update_journey_knowledge" || name === "todo_write") return false;
  if (name === "enter_plan_mode" || name === "exit_plan_mode") return false;
  if (type === "explore" || type === "plan") {
    return name !== "write_file" && name !== "edit_file" && name !== "run_command";
  }
  return true;
}

export function summarizeSubagent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && (msg.content ?? "").trim()) return String(msg.content).trim();
  }
  return "Subagent finished with no summary.";
}

export function subagentTranscript(agent: SubagentRecord): string[] {
  const parts: string[] = [];
  for (const msg of agent.messages) {
    if (msg.role !== "assistant") continue;
    const thought = String(msg.reasoning ?? "").trim();
    if (thought) parts.push(thought);
    const text = String(msg.content ?? "").trim();
    if (text) parts.push(text);
  }
  const liveThought = agent.streamReasoning.trim();
  if (liveThought && parts[parts.length - 1] !== liveThought) parts.push(agent.streamReasoning);
  const live = agent.streamText.trim();
  if (live) parts.push(agent.streamText);
  else if (parts.length === 0 && agent.summary.trim()) parts.push(agent.summary);
  return parts;
}

export function subagentSystemPrompt(
  workspace: string,
  type: SubagentType,
  description: string,
  permission: PermissionMode = "ask",
  knowledge?: string,
  modelId?: string,
): ChatMessage {
  const limits =
    type === "explore"
      ? "You are an explore agent. Search with grep and glob, read files, and use the web, but do not edit files or run shell commands."
      : type === "plan"
        ? "You are a plan agent. Search with grep and glob, explore the codebase and the web, then produce a structured plan. Do not edit files or run shell commands."
        : "You are a general-purpose subagent. Inspect and edit this folder as needed.";
  const knowledgeBlock = (knowledge ?? "").trim() ? `\nJourney knowledge:\n${knowledge!.trim()}` : "";
  const name = agentNameFor(modelId ?? "");
  const id = (modelId ?? "").trim();
  const who = name && id
    ? `You are ${name} (${id}), a ${type} subagent in TwanAgent.`
    : name
      ? `You are ${name}, a ${type} subagent in TwanAgent.`
      : `You are a ${type} subagent in TwanAgent.`;
  return {
    role: "system",
    content: `${who}
Workspace: ${workspace}
Task: ${description}
${limits}
${permissionSystemLine(permission)}
Be concise. End with a clear summary of findings or work done.${knowledgeBlock}`,
  };
}

export function emptySubagent(partial: {
  id: string;
  description: string;
  type: SubagentType;
  prompt: string;
}): SubagentRecord {
  return {
    id: partial.id,
    description: partial.description,
    type: partial.type,
    status: "running",
    prompt: partial.prompt,
    streamText: "",
    streamReasoning: "",
    tools: [],
    messages: [],
    summary: "",
  };
}

export function applySubagentEvent(rows: SubagentRecord[], event: SubagentEvent): SubagentRecord[] {
  if (event.type === "start") {
    if (rows.some((row) => row.id === event.record.id)) return rows;
    return [...rows, event.record];
  }
  return rows.map((row) => {
    if (row.id !== event.id) return row;
    if (event.type === "delta") return { ...row, streamText: row.streamText + event.text };
    if (event.type === "reasoning") return { ...row, streamReasoning: event.text };
    if (event.type === "tool") return { ...row, tools: [...row.tools, event.label] };
    if (event.type === "update") {
      return { ...row, messages: event.messages, streamText: "", streamReasoning: "" };
    }
    if (event.type === "done") {
      return {
        ...row,
        status: event.status,
        summary: event.summary,
        messages: event.messages,
        streamText: "",
        streamReasoning: "",
      };
    }
    return { ...row, status: row.status === "running" ? "error" : row.status, error: event.error };
  });
}

export function subagentTypeLabel(type: SubagentType): string {
  if (type === "explore") return "Explore";
  if (type === "plan") return "Plan";
  return "General";
}

export type SubagentDockState = {
  agents: SubagentRecord[];
  expanded: Record<string, boolean>;
};

export function emptySubagentDock(): SubagentDockState {
  return { agents: [], expanded: {} };
}

/** Open flags follow the conversation that owns the agents. Switching chats must not share one list. */
export function subagentsForChat(
  byChat: ReadonlyMap<string, SubagentDockState> | null | undefined,
  chatId: string,
): SubagentDockState {
  if (!chatId) return emptySubagentDock();
  return byChat?.get(chatId) ?? emptySubagentDock();
}

export function rememberSubagentDock(
  byChat: Map<string, SubagentDockState>,
  chatId: string,
  dock: SubagentDockState,
): void {
  if (!chatId) return;
  if (dock.agents.length === 0) {
    byChat.delete(chatId);
    return;
  }
  byChat.set(chatId, dock);
}

export function applySubagentToChat(
  byChat: Map<string, SubagentDockState>,
  chatId: string,
  event: SubagentEvent,
): SubagentDockState {
  const prev = subagentsForChat(byChat, chatId);
  const agents = applySubagentEvent(prev.agents, event);
  const expanded =
    event.type === "start" ? { ...prev.expanded, [event.record.id]: true } : prev.expanded;
  const next = { agents, expanded };
  rememberSubagentDock(byChat, chatId, next);
  return next;
}

export function toggleSubagentExpanded(
  byChat: Map<string, SubagentDockState>,
  chatId: string,
  agentId: string,
): SubagentDockState {
  const prev = subagentsForChat(byChat, chatId);
  const next = {
    agents: prev.agents,
    expanded: { ...prev.expanded, [agentId]: !prev.expanded[agentId] },
  };
  rememberSubagentDock(byChat, chatId, next);
  return next;
}
