import { parseToolArgs, type ChatMessage } from "./dev.ts";
import { permissionSystemLine, type PermissionMode } from "./dev-permission.ts";

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
  tools: string[];
  messages: ChatMessage[];
  summary: string;
  error?: string;
};

export type SubagentEvent =
  | { type: "start"; record: SubagentRecord }
  | { type: "delta"; id: string; text: string }
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
  if (name === "spawn_subagent" || name === "update_journey_knowledge") return false;
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

export function subagentSystemPrompt(
  workspace: string,
  type: SubagentType,
  description: string,
  permission: PermissionMode = "ask",
  knowledge?: string,
): ChatMessage {
  const limits =
    type === "explore"
      ? "You are an explore agent. Search and read, but do not edit files or run shell commands."
      : type === "plan"
        ? "You are a plan agent. Explore the codebase and produce a structured plan. Do not edit files or run shell commands."
        : "You are a general-purpose subagent. Inspect and edit this folder as needed.";
  const knowledgeBlock = (knowledge ?? "").trim() ? `\nJourney knowledge:\n${knowledge!.trim()}` : "";
  return {
    role: "system",
    content: `You are Grok, a ${type} subagent in TwanAgent.
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
    if (event.type === "tool") return { ...row, tools: [...row.tools, event.label] };
    if (event.type === "update") return { ...row, messages: event.messages, streamText: "" };
    if (event.type === "done") {
      return {
        ...row,
        status: event.status,
        summary: event.summary,
        messages: event.messages,
        streamText: "",
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
