import { isCompactionEvent, isCompactionSummary } from "./compact.ts";
import { isFileAttachment, stripImageTokens } from "./image.ts";
import { permissionSystemLine, remoteWorkspaceLine, type PermissionMode, type RemoteWorkspace } from "./permission.ts";
import { mcpSystemLine, type DetectedMcpServer } from "./mcp.ts";
import { agentIdentityLine } from "./provider.ts";
import { skillSystemLine, type DetectedSkill } from "./skill.ts";
import { folderName, projectKey } from "./project-rows.ts";
import { TURN_FAILURE_PREFIX, type ChatImage, type ChatMessage, type ChatRole, type ChatToolCall, type ThinkingBlock } from "./chat-types.ts";

export type WorktreeCheckout = {
  name: string;
  branch: string;
  mainName: string;
};

export type WorktreeListRow = {
  path: string;
  branch?: string | null;
  detached?: boolean;
  main?: boolean;
};

/** The open folder when it is a linked checkout. The main checkout returns null. */
export function worktreeCheckoutFor(
  workspace: string,
  worktrees: WorktreeListRow[] | null | undefined,
): WorktreeCheckout | null {
  if (!workspace || !worktrees?.length) return null;
  const key = projectKey(workspace);
  const here = worktrees.find((row) => projectKey(row.path) === key);
  if (!here || here.main) return null;
  const main = worktrees.find((row) => row.main);
  const branch = here.detached ? "detached" : here.branch?.trim() || "";
  const mainName = main?.path ? folderName(main.path) : "";
  if (!branch || !mainName) return null;
  return { name: folderName(here.path), branch, mainName };
}

/** One line when this folder is a linked worktree, not the main checkout. */
export function worktreeSystemLine(checkout?: WorktreeCheckout | null): string {
  if (!checkout?.name || !checkout.branch || !checkout.mainName) return "";
  return `This checkout is worktree ${checkout.name} on branch ${checkout.branch}. The main checkout is ${checkout.mainName}. Edits here do not change the other checkout.`;
}

export function systemPrompt(
  workspace: string,
  permission: PermissionMode = "ask",
  _knowledge?: string,
  mcpServers?: DetectedMcpServer[],
  skills?: DetectedSkill[],
  remote?: RemoteWorkspace | null,
  modelId?: string,
  planLine?: string,
  worktree?: WorktreeCheckout | null,
): ChatMessage {
  const extra = extraSystemLines(mcpServers, skills);
  const remoteLine = remoteWorkspaceLine(remote);
  const worktreeLine = worktreeSystemLine(worktree);
  const place = [remoteLine, worktreeLine].filter(Boolean).join("\n");
  const placeBlock = place ? `\n${place}` : "";
  const who = agentIdentityLine(modelId);
  const planning = (planLine ?? "").trim();
  return {
    role: "system",
    content: `${who}
Workspace: ${workspace}${placeBlock}
${permissionSystemLine(permission)}${planning ? `\n${planning}` : ""}
For independent research, planning, or parallel work, call spawn_subagent. Each child has its own context and reports a summary when it finishes. Use explore to investigate, plan for implementation plans, and general-purpose when the child may edit files.
For multi-step work, call todo_write to keep a short step list above the input. Update it as you go, including mid-turn. Keep at most one item in_progress.
For current facts, news, docs, or anything that may have changed, call web_search instead of guessing. Cite the source URLs it returns.
To find code, call grep for contents and glob for paths. Do not use the shell to search.
Prefer edit_file for small changes. Don't commit unless asked. Be concise.${extra}`,
  };
}

export function withSystem(
  workspace: string,
  messages: ChatMessage[],
  system?: ChatMessage,
  permission: PermissionMode = "ask",
  knowledge?: string,
  mcpServers?: DetectedMcpServer[],
  skills?: DetectedSkill[],
  remote?: RemoteWorkspace | null,
  modelId?: string,
  planLine?: string,
  worktree?: WorktreeCheckout | null,
): ChatMessage[] {
  const base = system ?? systemPrompt(workspace, permission, knowledge, mcpServers, skills, remote, modelId, planLine, worktree);
  const extra = system ? extraSystemLines(mcpServers, skills) : "";
  const content =
    extra && !String(base.content ?? "").includes(extra.trim())
      ? `${base.content ?? ""}${extra}`
      : base.content;
  return [{ ...base, content }, ...messages.filter((m) => m.role !== "system" || isCompactionSummary(m))];
}

function extraSystemLines(mcpServers?: DetectedMcpServer[], skills?: DetectedSkill[]): string {
  const blocks = [mcpSystemLine(mcpServers ?? []), skillSystemLine(skills ?? [])].filter(Boolean);
  return blocks.length ? `\n${blocks.join("\n")}` : "";
}

export type ApiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ApiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ApiChatMessage = {
  role: ChatRole;
  content?: string | null | ApiContentPart[];
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
  /** Signed Claude thinking blocks. Absent for Grok. */
  thinking?: ThinkingBlock[];
  /**
   * Kept so the app can inline non-image files before the provider call.
   * Picture bytes are already content parts. The provider drops this field.
   */
  images?: ChatImage[];
};

function messageTextWithoutImageTokens(msg: ChatMessage): string {
  const text = String(msg.content ?? "");
  return msg.images?.length ? stripImageTokens(text, msg.images) : text;
}

export function toApiToolCall(call: ChatToolCall): ApiToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.arguments || "{}",
    },
  };
}

export function toApiMessages(messages: ChatMessage[]): ApiChatMessage[] {
  return messages
    .filter((msg) => !isCompactionEvent(msg) && !msg.error && !String(msg.content ?? "").startsWith(TURN_FAILURE_PREFIX))
    .map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.tool_call_id ?? "",
        content: msg.content ?? "",
      };
    }
    if (msg.role === "assistant" && (msg.tool_calls?.length || msg.thinking?.length)) {
      return {
        role: "assistant",
        content: msg.content?.trim() ? msg.content : null,
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls.map(toApiToolCall) } : {}),
        ...(msg.thinking?.length ? { thinking: msg.thinking } : {}),
      };
    }
    if (isCompactionSummary(msg)) {
      return { role: "user", content: String(msg.content ?? "") };
    }
    if (msg.role === "user" && msg.images?.length) {
      const parts: ApiContentPart[] = [];
      const text = messageTextWithoutImageTokens(msg).trim();
      if (text) parts.push({ type: "text", text });
      for (const img of msg.images) {
        if (isFileAttachment(img) || !img.dataUrl) continue;
        parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
      }
      const hasFile = msg.images.some(isFileAttachment);
      if (!parts.length) {
        return hasFile
          ? { role: "user", content: "", images: msg.images }
          : { role: "user", content: "" };
      }
      return hasFile ? { role: "user", content: parts, images: msg.images } : { role: "user", content: parts };
    }
    return {
      role: msg.role,
      content: msg.content ?? "",
    };
  });
}

export type FinishStamp = { at: string; durationMs?: number | null };

/**
 * Fill `finishedAt` on replies that were saved before the clock time was stored.
 * `events` are usage records for one conversation, oldest first. Each record is
 * the end of one model step, so a tool round and the final reply both count.
 * A reply that already has a time is left alone.
 */
export function backfillFinishedAt(messages: ChatMessage[], events: FinishStamp[]): ChatMessage[] {
  const stamps = events
    .map((event) => ({ at: event.at.trim(), durationMs: event.durationMs }))
    .filter((event) => Number.isFinite(Date.parse(event.at)));
  if (!stamps.length || !messages.some(needsFinishStamp)) return messages;

  const steps: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isModelStep(messages[i]!)) steps.push(i);
  }
  if (!steps.length) return messages;

  let cursor = 0;
  const assigned = new Map<number, FinishStamp>();
  for (const index of steps) {
    const message = messages[index]!;
    if (String(message.finishedAt ?? "").trim()) {
      const known = Date.parse(message.finishedAt!);
      while (cursor < stamps.length && Date.parse(stamps[cursor]!.at) <= known) cursor += 1;
      continue;
    }
    if (cursor >= stamps.length) break;
    assigned.set(index, stamps[cursor]!);
    cursor += 1;
  }
  if (!assigned.size) return messages;

  let changed = false;
  const next = messages.slice();
  for (const [index, stamp] of assigned) {
    const message = next[index]!;
    if (!showsFinishedLine(message)) continue;
    changed = true;
    const duration =
      typeof message.durationMs === "number" || typeof stamp.durationMs !== "number" || stamp.durationMs < 0
        ? {}
        : { durationMs: stamp.durationMs };
    next[index] = { ...message, finishedAt: stamp.at, ...duration };
  }
  return changed ? next : messages;
}

function needsFinishStamp(message: ChatMessage): boolean {
  return showsFinishedLine(message) && !String(message.finishedAt ?? "").trim();
}

function showsFinishedLine(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.error &&
    !String(message.content ?? "").startsWith(TURN_FAILURE_PREFIX) &&
    Boolean((message.content ?? "").trim()) &&
    !(message.tool_calls ?? []).some(
      (call) => call.name !== "todo_write" && call.name !== "enter_plan_mode" && call.name !== "exit_plan_mode",
    )
  );
}

function isModelStep(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.error) return false;
  if (String(message.content ?? "").startsWith(TURN_FAILURE_PREFIX)) return false;
  return Boolean((message.content ?? "").trim() || message.tool_calls?.length || message.thinking?.length);
}

export function stampTurnDuration(
  messages: ChatMessage[],
  durationMs: number,
  finishedAt = "",
): ChatMessage[] {
  const stampTime = finishedAt.trim();
  const stampDuration = Number.isFinite(durationMs) && durationMs >= 0;
  if (!stampDuration && !stampTime) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role === "user") return messages;
    if (msg.role !== "assistant" || msg.error) continue;
    if (!(msg.content ?? "").trim() || msg.tool_calls?.length) continue;
    const sameDuration = !stampDuration || msg.durationMs === durationMs;
    const sameTime = !stampTime || msg.finishedAt === stampTime;
    if (sameDuration && sameTime) return messages;
    const next = messages.slice();
    next[i] = {
      ...msg,
      ...(stampDuration ? { durationMs } : {}),
      ...(stampTime ? { finishedAt: stampTime } : {}),
    };
    return next;
  }
  return messages;
}

export function newConversationId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
