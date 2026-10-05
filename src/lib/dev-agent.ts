import type { DevToolCall } from "./tauri";
import * as api from "./tauri";
import { parseChatUsage, type ChatUsage } from "./dev-context.ts";
import { parseToolArgs, toApiMessages, toolActivityLabel, withSystem, type ChatMessage } from "./dev.ts";
import type { DetectedMcpServer } from "./dev-mcp.ts";
import type { DetectedSkill } from "./dev-skill.ts";
import { withImageDataUrls } from "./dev-image.ts";
import { parsePermissionMode, toolDeniedByPermission, type PermissionMode } from "./dev-permission.ts";
import { formatTodoWriteResult, parseTodoWriteArgs } from "./dev-todo.ts";
import {
  compactionPrompt,
  isContextLengthError,
  messagesForContext,
  readCompactionState,
  shouldAutoCompact,
  splitForCompaction,
  type CompactionState,
} from "./dev-compact.ts";
import {
  EMPTY_COMPLETION_MESSAGE,
  UNFINISHED_TOOL,
  closeDanglingToolCalls,
  isEmptyCompletion,
  isRetryableChatError,
  skipToolIfAborted,
  turnFailureMessage,
} from "./dev-turn.ts";
import {
  childCanUseTool,
  emptySubagent,
  parseSpawnArgs,
  summarizeSubagent,
  subagentSystemPrompt,
  type SubagentEvent,
  type SubagentType,
} from "./dev-subagent.ts";

export type ConfirmShell = (command: string) => Promise<boolean>;

export async function executeTool(
  workspace: string,
  call: DevToolCall,
  confirmShell: ConfirmShell,
  childType?: SubagentType,
  permission: PermissionMode = "ask",
  signal?: AbortSignal,
  journeyId?: string,
): Promise<string> {
  const skipped = signal ? skipToolIfAborted(signal) : null;
  if (skipped) return skipped;
  if (childType && !childCanUseTool(childType, call.name)) {
    return `Error: ${call.name} is not available to this ${childType} subagent.`;
  }
  const denied = toolDeniedByPermission(permission, call.name);
  if (denied) return denied;
  if (call.name === "spawn_subagent") {
    return "Error: spawn_subagent must be started by the parent turn.";
  }
  const args = parseToolArgs(call.arguments);
  try {
    switch (call.name) {
      case "list_dir":
        return JSON.stringify(await api.devListDir(workspace, String(args.path ?? "")), null, 2);
      case "read_file":
        return await api.devReadFile(workspace, String(args.path ?? ""));
      case "write_file":
        await api.devWriteFile(workspace, String(args.path ?? ""), String(args.contents ?? ""));
        return `Wrote ${args.path ?? ""}`;
      case "edit_file":
        await api.devEditFile(
          workspace,
          String(args.path ?? ""),
          String(args.old_string ?? ""),
          String(args.new_string ?? ""),
        );
        return `Edited ${args.path ?? ""}`;
      case "git_status":
        return JSON.stringify(await api.devGitStatus(workspace), null, 2);
      case "git_diff":
        return await api.devGitDiff(workspace, String(args.path ?? ""));
      case "run_command":
        return runOrSkip(workspace, String(args.command ?? ""), confirmShell);
      case "todo_write": {
        const parsed = parseTodoWriteArgs(call.arguments);
        if (parsed.error) return `Error: ${parsed.error}`;
        return formatTodoWriteResult(parsed.todos);
      }
      case "update_journey_knowledge":
        if (!journeyId) return "Error: update_journey_knowledge is only available in a Journey chat.";
        return api.devUpdateJourneyKnowledge(workspace, journeyId, {
          mode: String(args.mode ?? ""),
          contents: args.contents == null ? undefined : String(args.contents),
          oldString: args.old_string == null && args.oldString == null
            ? undefined
            : String(args.old_string ?? args.oldString ?? ""),
          newString: args.new_string == null && args.newString == null
            ? undefined
            : String(args.new_string ?? args.newString ?? ""),
        });
      default:
        return `Unknown tool: ${call.name}`;
    }
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

async function runOrSkip(
  workspace: string,
  command: string,
  confirmShell: (command: string) => Promise<boolean>,
): Promise<string> {
  const ok = await confirmShell(command);
  if (!ok) return "User skipped this command.";
  return api.devRunCommand(workspace, command);
}

export type TurnOpts = {
  workspace: string;
  messages: ChatMessage[];
  model?: string;
  effort?: string;
  contextWindow?: number;
  system?: ChatMessage;
  allowSpawn?: boolean;
  childType?: SubagentType;
  onDelta: (text: string) => void;
  /** Full reasoning text for the current model round. Empty clears the live block. */
  onReasoning?: (text: string) => void;
  onError: (text: string) => void;
  confirmShell: ConfirmShell;
  getPermission?: () => PermissionMode;
  onTool?: (call: DevToolCall) => void;
  onUpdate?: (messages: ChatMessage[]) => void;
  onRefresh?: () => void;
  onSubagent?: (event: SubagentEvent) => void;
  onUsage?: (usage: ChatUsage) => void;
  /** Last prompt size for this conversation. Used for the CLI's 80% auto-compact. */
  priorPromptTokens?: number;
  /** Summary already stored for this conversation. The visible transcript is not rewritten. */
  compaction?: CompactionState | null;
  /** Persist a new summary. `through` is the first transcript index that stays verbatim. */
  onCompact?: (state: CompactionState) => void;
  signal: AbortSignal;
  journeyId?: string;
  journeyKnowledge?: string;
  mcpServers?: DetectedMcpServer[];
  skills?: DetectedSkill[];
};

function assistantMessage(text: string, reasoning: string, toolCalls: DevToolCall[]): ChatMessage {
  const thought = reasoning.trim();
  return {
    role: "assistant",
    content: text,
    ...(thought ? { reasoning: thought } : {}),
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

export async function completeTurn(opts: TurnOpts): Promise<ChatMessage[]> {
  let transcript = opts.messages;
  let compaction = opts.compaction ?? null;
  if (
    opts.allowSpawn !== false &&
    shouldAutoCompact(opts.priorPromptTokens ?? 0, opts.contextWindow ?? 0)
  ) {
    const next = await compactContext(transcript, compaction, opts);
    if (next) {
      compaction = next;
      opts.onCompact?.(next);
    }
  }
  let compactedAfterOverflow = false;
  for (;;) {
    const repaired = closeDanglingToolCalls(transcript);
    if (repaired !== transcript) {
      transcript = repaired;
      opts.onUpdate?.(transcript);
    }
    if (opts.signal.aborted) return transcript;
    const permission = parsePermissionMode(opts.getPermission?.());
    const context = messagesForContext(transcript, compaction).messages;
    let result = await streamCompletion(
      withSystem(opts.workspace, context, opts.system, permission, opts.journeyKnowledge, opts.mcpServers, opts.skills),
      opts,
    );
    if (opts.signal.aborted) return transcript;
    if (result.error && isRetryableChatError(result.error)) {
      result = await streamCompletion(
        withSystem(opts.workspace, context, opts.system, permission, opts.journeyKnowledge, opts.mcpServers, opts.skills),
        opts,
      );
    }
    if (opts.signal.aborted) return transcript;
    if (result.error && !compactedAfterOverflow && isContextLengthError(result.error) && opts.allowSpawn !== false) {
      const next = await compactContext(transcript, compaction, opts);
      if (next && next.through !== compaction?.through) {
        compactedAfterOverflow = true;
        compaction = next;
        opts.onCompact?.(next);
        continue;
      }
    }
    if (result.error) {
      opts.onError(result.error);
      if (result.error !== "Stopped.") {
        const thought = result.reasoning.trim();
        if (thought) transcript = [...transcript, assistantMessage("", thought, [])];
        transcript = [...transcript, turnFailureMessage(result.error)];
        opts.onUpdate?.(transcript);
        return transcript;
      }
      return transcript;
    }
    const empty = isEmptyCompletion(result.text, result.toolCalls) && !result.reasoning.trim();
    if (empty) {
      result = await streamCompletion(
        withSystem(opts.workspace, context, opts.system, permission, opts.journeyKnowledge, opts.mcpServers, opts.skills),
        opts,
      );
      if (opts.signal.aborted) return transcript;
      if (result.error) {
        opts.onError(result.error);
        if (result.error !== "Stopped.") {
          const thought = result.reasoning.trim();
          if (thought) transcript = [...transcript, assistantMessage("", thought, [])];
          transcript = [...transcript, turnFailureMessage(result.error)];
          opts.onUpdate?.(transcript);
          return transcript;
        }
        return transcript;
      }
    }
    if (isEmptyCompletion(result.text, result.toolCalls) && !result.reasoning.trim()) {
      transcript = [...transcript, turnFailureMessage(EMPTY_COMPLETION_MESSAGE)];
      opts.onUpdate?.(transcript);
      return transcript;
    }
    if (result.usage) opts.onUsage?.(result.usage);
    transcript = [...transcript, assistantMessage(result.text || "", result.reasoning, result.toolCalls)];
    opts.onUpdate?.(transcript);
    if (!result.toolCalls.length) return transcript;
    const contents: string[] = new Array(result.toolCalls.length);
    const spawnWaits: Promise<void>[] = [];
    for (let i = 0; i < result.toolCalls.length; i++) {
      const skipped = skipToolIfAborted(opts.signal);
      if (skipped) {
        contents[i] = skipped;
        continue;
      }
      const call = result.toolCalls[i];
      if (!call) {
        contents[i] = UNFINISHED_TOOL;
        continue;
      }
      opts.onTool?.(call);
      try {
        if (call.name === "spawn_subagent") {
          spawnWaits.push(
            runSubagent(call, opts)
              .then((content) => {
                contents[i] = content || UNFINISHED_TOOL;
              })
              .catch((err) => {
                contents[i] = `Error: ${String(err)}`;
              }),
          );
          continue;
        }
        contents[i] =
          (await executeTool(
            opts.workspace,
            call,
            opts.confirmShell,
            opts.childType,
            parsePermissionMode(opts.getPermission?.()),
            opts.signal,
            opts.journeyId,
          )) || UNFINISHED_TOOL;
      } catch (err) {
        contents[i] = `Error: ${String(err)}`;
      }
      if (
        call.name === "write_file" ||
        call.name === "edit_file" ||
        call.name === "run_command" ||
        call.name === "update_journey_knowledge"
      ) {
        opts.onRefresh?.();
      }
    }
    await Promise.all(spawnWaits);
    const toolMsgs: ChatMessage[] = result.toolCalls.map((call, i) => ({
      role: "tool",
      tool_call_id: call.id,
      content: contents[i] || UNFINISHED_TOOL,
    }));
    transcript = [...transcript, ...toolMsgs];
    opts.onUpdate?.(transcript);
  }
}

async function compactContext(
  stored: ChatMessage[],
  current: CompactionState | null,
  opts: TurnOpts,
): Promise<CompactionState | null> {
  if (opts.signal.aborted) return null;
  const source = messagesForContext(stored, current).messages;
  const { older, cut } = splitForCompaction(source);
  if (!older.length || cut >= source.length) return null;
  const previous = readCompactionState(source)?.summary ?? current?.summary ?? "";
  const result = await streamCompletion(compactionPrompt(older, previous), {
    ...opts,
    onDelta: () => undefined,
    onReasoning: () => undefined,
  });
  if (opts.signal.aborted || result.error) return null;
  const summary = result.text.trim();
  if (!summary) return null;
  const recent = source.slice(cut);
  const through = stored.length - recent.length;
  if (through <= 0 || through >= stored.length) return null;
  if (current && current.through === through && current.summary === summary) return null;
  return { summary, through };
}

async function runSubagent(call: DevToolCall, opts: TurnOpts): Promise<string> {
  if (opts.allowSpawn === false) {
    return "Error: subagents cannot spawn subagents.";
  }
  const parsed = parseSpawnArgs(call.arguments);
  if (!parsed.prompt) return "Error: spawn_subagent requires a prompt.";
  const id = crypto.randomUUID();
  opts.onSubagent?.({
    type: "start",
    record: emptySubagent({
      id,
      description: parsed.description,
      type: parsed.subagentType,
      prompt: parsed.prompt,
    }),
  });
  let failed = "";
  try {
    const done = await completeTurn({
      workspace: opts.workspace,
      messages: [{ role: "user", content: parsed.prompt }],
      model: opts.model,
      effort: opts.effort,
      contextWindow: opts.contextWindow,
      system: subagentSystemPrompt(
        opts.workspace,
        parsed.subagentType,
        parsed.description,
        parsePermissionMode(opts.getPermission?.()),
        opts.journeyKnowledge,
      ),
      journeyKnowledge: opts.journeyKnowledge,
      allowSpawn: false,
      childType: parsed.subagentType,
      getPermission: opts.getPermission,
      onDelta: (text) => opts.onSubagent?.({ type: "delta", id, text }),
      onReasoning: (text) => opts.onSubagent?.({ type: "reasoning", id, text }),
      onError: (err) => {
        failed = err;
        opts.onSubagent?.({ type: "error", id, error: err });
      },
      confirmShell: opts.confirmShell,
      onTool: (toolCall) => {
        const label = toolActivityLabel(toolCall);
        if (label) opts.onSubagent?.({ type: "tool", id, label });
      },
      onUpdate: (messages) => opts.onSubagent?.({ type: "update", id, messages }),
      onRefresh: opts.onRefresh,
      signal: opts.signal,
      mcpServers: opts.mcpServers,
      skills: opts.skills,
    });
    const summary = summarizeSubagent(done);
    if (opts.signal.aborted) {
      opts.onSubagent?.({ type: "done", id, status: "stopped", summary: failed || "Stopped.", messages: done });
      return `Subagent stopped: ${parsed.description}`;
    }
    if (failed) {
      opts.onSubagent?.({ type: "done", id, status: "error", summary: failed, messages: done });
      return `Subagent failed: ${failed}`;
    }
    opts.onSubagent?.({ type: "done", id, status: "done", summary, messages: done });
    return `Subagent ${parsed.description} finished:\n${summary}`;
  } catch (e) {
    const error = String(e);
    opts.onSubagent?.({ type: "error", id, error });
    opts.onSubagent?.({ type: "done", id, status: "error", summary: error, messages: [] });
    return `Error: ${error}`;
  }
}

async function streamCompletion(
  messages: ChatMessage[],
  opts: {
    model?: string;
    effort?: string;
    contextWindow?: number;
    onDelta: (text: string) => void;
    onReasoning?: (text: string) => void;
    onError: (text: string) => void;
    onUsage?: (usage: ChatUsage) => void;
    signal: AbortSignal;
    journeyId?: string;
  },
): Promise<{ text: string; reasoning: string; toolCalls: DevToolCall[]; error?: string; usage?: ChatUsage }> {
  const streamId = crypto.randomUUID();
  let text = "";
  let reasoning = "";
  let toolCalls: DevToolCall[] = [];
  let usage: ChatUsage | undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (value: {
      text: string;
      reasoning: string;
      toolCalls: DevToolCall[];
      error?: string;
      usage?: ChatUsage;
    }) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener("abort", onAbort);
      unlisten?.();
      resolve(value);
    };
    const onAbort = () => {
      void api.devChatCancel(streamId);
      finish({ text, reasoning, toolCalls, error: "Stopped." });
    };
    void (async () => {
      try {
        unlisten = await api.onDevChat((ev) => {
          if (ev.stream_id !== streamId) return;
          if (ev.kind === "reasoning" && ev.text) {
            reasoning += ev.text;
            opts.onReasoning?.(reasoning);
          } else if (ev.kind === "delta" && ev.text) {
            text += ev.text;
            opts.onDelta(ev.text);
          } else if (ev.kind === "usage") {
            const next = parseChatUsage(ev.usage);
            if (next) usage = next;
          } else if (ev.kind === "done") {
            if (ev.tool_calls?.length) toolCalls = ev.tool_calls;
            usage = parseChatUsage(ev.usage) ?? usage;
            finish({ text: text || ev.text || "", reasoning, toolCalls, usage });
          } else if (ev.kind === "error") {
            finish({ text, reasoning, toolCalls, error: ev.text || "xAI request failed.", usage });
          }
        });
        opts.onReasoning?.("");
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort);
        const hydrated = await withImageDataUrls(messages, (path) => api.devImageDataUrl(path));
        await api.devChatStart(
          streamId,
          toApiMessages(hydrated),
          opts.model,
          opts.effort,
          opts.journeyId,
          opts.contextWindow,
        );
      } catch (e) {
        opts.signal.removeEventListener("abort", onAbort);
        unlisten?.();
        if (settled) return;
        settled = true;
        reject(e);
      }
    })();
  });
}
