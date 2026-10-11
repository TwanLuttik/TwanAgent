import type { ToolCall } from "./tauri";
import * as api from "./tauri";
import { parseChatUsage, type ChatUsage } from "./context.ts";
import { parseToolArgs, toApiMessages, toolActivityLabel, withSystem, type ChatMessage, type ThinkingBlock } from "./core.ts";
import type { DetectedMcpServer } from "./mcp.ts";
import type { DetectedSkill } from "./skill.ts";
import { withImageDataUrls } from "./image.ts";
import { parsePermissionMode, toolDeniedByPermission, type PermissionMode, type RemoteWorkspace } from "./permission.ts";
import {
  isPlanTool,
  isSessionPlanPath,
  planModeBlockMessage,
  planModeBlocksTool,
  planModeEngaged,
  planModeSystemLine,
  planStateAfterDecision,
  planTextFromMessages,
  planToolResult,
  type PlanDecision,
  type PlanModeState,
  type PlanPrompt,
} from "./plan.ts";
import { formatTodoWriteResult, parseTodoWriteArgs } from "./todo.ts";
import {
  compactionPrompt,
  insertCompactionEvent,
  isContextLengthError,
  messagesForContext,
  readCompactionState,
  shouldAutoCompact,
  splitForCompaction,
  type CompactionState,
} from "./compact.ts";
import {
  EMPTY_COMPLETION_MESSAGE,
  UNFINISHED_TOOL,
  closeDanglingToolCalls,
  isEmptyCompletion,
  isRetryableChatError,
  skipToolIfAborted,
  turnFailureMessage,
} from "./turn.ts";
import {
  childCanUseTool,
  emptySubagent,
  parseSpawnArgs,
  summarizeSubagent,
  subagentSystemPrompt,
  type SubagentEvent,
  type SubagentType,
} from "./subagent.ts";

export type ConfirmShell = (command: string) => Promise<boolean>;

export type ConfirmPlan = (prompt: PlanPrompt) => Promise<{ decision: PlanDecision; note: string }>;

export type ToolProgress = (detail: string) => void;

export type PlanToolIO = {
  sessionId: string;
  enabled: boolean;
  getState: () => PlanModeState;
  setState: (state: PlanModeState, awaitingApproval: boolean) => Promise<void>;
  readContent: () => Promise<string>;
  writePlan: (contents: string) => Promise<void>;
  editPlan: (oldString: string, newString: string) => Promise<void>;
  /** Transcript so far, used when the model wrote plan.md through write_file. */
  messages: () => { role: string; tool_calls?: { name: string; arguments: string }[] }[];
  confirm: ConfirmPlan;
};

export async function executeTool(
  workspace: string,
  call: ToolCall,
  confirmShell: ConfirmShell,
  childType?: SubagentType,
  permission: PermissionMode = "ask",
  signal?: AbortSignal,
  journeyId?: string,
  onProgress?: ToolProgress,
  plan?: PlanToolIO,
): Promise<string> {
  const skipped = signal ? skipToolIfAborted(signal) : null;
  if (skipped) return skipped;
  if (childType && !childCanUseTool(childType, call.name)) {
    return `Error: ${call.name} is not available to this ${childType} subagent.`;
  }
  const denied = toolDeniedByPermission(permission, call.name);
  if (denied) return denied;
  if (isPlanTool(call.name)) {
    if (!plan?.enabled) return `Error: ${call.name} is only available in a Grok chat.`;
    return runPlanTool(call.name, plan, signal);
  }
  if (plan?.enabled && planModeEngaged(plan.getState()) && planModeBlocksTool(call.name)) {
    return planModeBlockMessage(String(parseToolArgs(call.arguments).path ?? ""));
  }
  if (call.name === "spawn_subagent") {
    return "Error: spawn_subagent must be started by the parent turn.";
  }
  const args = parseToolArgs(call.arguments);
  try {
    switch (call.name) {
      case "list_dir":
        return JSON.stringify(await api.listDir(workspace, String(args.path ?? "")), null, 2);
      case "read_file":
        return await api.readFile(workspace, String(args.path ?? ""));
      case "write_file":
        if (plan?.enabled && isSessionPlanPath(String(args.path ?? ""))) {
          if (!planModeEngaged(plan.getState())) {
            return "Error: plan.md is only writable while plan mode is active.";
          }
          await plan.writePlan(String(args.contents ?? ""));
          return "Wrote plan.md";
        }
        await api.writeFile(workspace, String(args.path ?? ""), String(args.contents ?? ""));
        return `Wrote ${args.path ?? ""}`;
      case "edit_file":
        if (plan?.enabled && isSessionPlanPath(String(args.path ?? ""))) {
          if (!planModeEngaged(plan.getState())) {
            return "Error: plan.md is only writable while plan mode is active.";
          }
          await plan.editPlan(String(args.old_string ?? ""), String(args.new_string ?? ""));
          return "Edited plan.md";
        }
        await api.editFile(
          workspace,
          String(args.path ?? ""),
          String(args.old_string ?? ""),
          String(args.new_string ?? ""),
        );
        return `Edited ${args.path ?? ""}`;
      case "git_status":
        return JSON.stringify(await api.gitStatus(workspace), null, 2);
      case "git_diff": {
        const commit = String(args.commit ?? args.hash ?? "").trim();
        if (commit) return await api.gitShow(workspace, commit);
        return await api.gitDiff(workspace, String(args.path ?? ""));
      }
      case "git_log":
        return JSON.stringify(await api.gitLog(workspace, Number(args.limit ?? 20) || 20), null, 2);
      case "git_commit": {
        const paths = Array.isArray(args.paths) ? args.paths.map((path) => String(path)) : [];
        if (paths.length) await api.gitStage(workspace, paths);
        else {
          const rows = await api.gitStatus(workspace);
          const pending = rows.filter((row) => !row.staged).map((row) => row.path);
          if (pending.length) await api.gitStage(workspace, pending);
        }
        const hash = await api.gitCommit(workspace, String(args.message ?? ""));
        return `Committed ${hash}`;
      }
      case "run_command":
        return runOrSkip(workspace, String(args.command ?? ""), confirmShell);
      case "web_search":
        return runWebSearch(call.arguments || "{}", signal, onProgress);
      case "todo_write": {
        const parsed = parseTodoWriteArgs(call.arguments);
        if (parsed.error) return `Error: ${parsed.error}`;
        return formatTodoWriteResult(parsed.todos);
      }
      case "update_journey_knowledge":
        if (!journeyId) return "Error: update_journey_knowledge is only available in a Journey chat.";
        return api.updateJourneyKnowledge(workspace, journeyId, {
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

async function runPlanTool(
  name: "enter_plan_mode" | "exit_plan_mode",
  plan: PlanToolIO,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return "Skipped: stopped.";
  const state = plan.getState();
  if (name === "enter_plan_mode") {
    if (planModeEngaged(state)) return "Plan mode is already active.";
    const answer = await plan.confirm({ kind: "enter" });
    if (signal?.aborted) return "Skipped: stopped.";
    const next = planStateAfterDecision("enter", answer.decision);
    await plan.setState(next, false);
    return planToolResult("enter", answer.decision, answer.note);
  }
  if (state === "Inactive") return "Plan mode is not active.";
  const saved = await plan.readContent();
  const written = planTextFromMessages(plan.messages());
  const content = written.trim() ? written : saved;
  await plan.setState(state, true);
  const answer = await plan.confirm({ kind: "exit", content });
  if (signal?.aborted) {
    await plan.setState(planModeEngaged(state) ? "Active" : state, false);
    return "Skipped: stopped.";
  }
  const next = planStateAfterDecision("exit", answer.decision);
  await plan.setState(next, false);
  return planToolResult("exit", answer.decision, answer.note);
}

async function runWebSearch(
  argumentsJson: string,
  signal?: AbortSignal,
  onProgress?: ToolProgress,
): Promise<string> {
  const streamId = crypto.randomUUID();
  const seen = new Set<string>();
  const sites: string[] = [];
  let unlisten: (() => void) | undefined;
  const note = (host: string) => {
    const clean = host.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    sites.push(clean);
    onProgress?.(sites.join("\n"));
  };
  try {
    unlisten = await api.onWebSearch((ev) => {
      if (ev.stream_id !== streamId) return;
      if (ev.kind === "site" && ev.host) note(ev.host);
      if (ev.kind === "scope" && ev.text) onProgress?.(ev.text);
    });
    if (signal?.aborted) return "Skipped: stopped.";
    return await api.webSearch(streamId, argumentsJson);
  } finally {
    unlisten?.();
  }
}

async function runOrSkip(
  workspace: string,
  command: string,
  confirmShell: (command: string) => Promise<boolean>,
): Promise<string> {
  const ok = await confirmShell(command);
  if (!ok) return "User skipped this command.";
  return api.runCommand(workspace, command);
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
  /** Grok chats only. Claude never receives plan-mode tools. */
  plan?: PlanToolIO;
  onTool?: (call: ToolCall) => void;
  /** Live detail for the tool call that is running now, such as websites found mid-search. */
  onToolProgress?: (callId: string, detail: string) => void;
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
  remote?: RemoteWorkspace | null;
};

function planModeLine(plan: PlanToolIO): string {
  return planModeSystemLine(plan.getState(), `~/.grok/sessions/<workspace>/${plan.sessionId}/plan.md`);
}

function assistantMessage(
  text: string,
  reasoning: string,
  toolCalls: ToolCall[],
  thinking: ThinkingBlock[] = [],
): ChatMessage {
  const thought = reasoning.trim();
  return {
    role: "assistant",
    content: text,
    ...(thought ? { reasoning: thought } : {}),
    ...(thinking.length ? { thinking } : {}),
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

function signedThinking(blocks: api.ApiThinkingBlock[] | null | undefined): ThinkingBlock[] {
  const out: ThinkingBlock[] = [];
  for (const block of blocks ?? []) {
    if (block.type === "redacted_thinking" && block.data) {
      out.push({ type: "redacted_thinking", data: block.data });
      continue;
    }
    if (block.type === "thinking" && block.signature) {
      out.push({ type: "thinking", thinking: block.thinking ?? "", signature: block.signature });
    }
  }
  return out;
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
  const imageCache = new Map<string, string>();
  for (;;) {
    const repaired = closeDanglingToolCalls(transcript);
    if (repaired !== transcript) {
      transcript = repaired;
      opts.onUpdate?.(transcript);
    }
    if (opts.signal.aborted) return transcript;
    const permission = parsePermissionMode(opts.getPermission?.());
    const context = messagesForContext(transcript, compaction).messages;
    const planLine = opts.plan?.enabled ? planModeLine(opts.plan) : "";
    let result = await streamCompletion(
      withSystem(opts.workspace, context, opts.system, permission, opts.journeyKnowledge, opts.mcpServers, opts.skills, opts.remote, opts.model, planLine),
      opts,
      imageCache,
    );
    if (opts.signal.aborted) return transcript;
    if (result.error && isRetryableChatError(result.error)) {
      result = await streamCompletion(
        withSystem(opts.workspace, context, opts.system, permission, opts.journeyKnowledge, opts.mcpServers, opts.skills, opts.remote, opts.model, planLine),
        opts,
        imageCache,
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
        if (thought || result.thinking.length) transcript = [...transcript, assistantMessage("", thought, [], result.thinking)];
        transcript = [...transcript, turnFailureMessage(result.error)];
        opts.onUpdate?.(transcript);
        return transcript;
      }
      return transcript;
    }
    const empty = isEmptyCompletion(result.text, result.toolCalls) && !result.reasoning.trim();
    if (empty) {
      result = await streamCompletion(
        withSystem(opts.workspace, context, opts.system, permission, opts.journeyKnowledge, opts.mcpServers, opts.skills, opts.remote, opts.model, planLine),
        opts,
        imageCache,
      );
      if (opts.signal.aborted) return transcript;
      if (result.error) {
        opts.onError(result.error);
        if (result.error !== "Stopped.") {
          const thought = result.reasoning.trim();
          if (thought || result.thinking.length) transcript = [...transcript, assistantMessage("", thought, [], result.thinking)];
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
    transcript = [...transcript, assistantMessage(result.text || "", result.reasoning, result.toolCalls, result.thinking)];
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
            (detail) => opts.onToolProgress?.(call.id, detail),
            opts.plan,
          )) || UNFINISHED_TOOL;
      } catch (err) {
        contents[i] = `Error: ${String(err)}`;
      }
      if (
        call.name === "write_file" ||
        call.name === "edit_file" ||
        call.name === "run_command" ||
        call.name === "git_commit" ||
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
  const result = await streamCompletion(
    compactionPrompt(older, previous),
    {
      ...opts,
      onDelta: () => undefined,
      onReasoning: () => undefined,
    },
    new Map(),
  );
  if (opts.signal.aborted || result.error) return null;
  const summary = result.text.trim();
  if (!summary) return null;
  const recent = source.slice(cut);
  const through = stored.length - recent.length;
  if (through <= 0 || through >= stored.length) return null;
  if (current && current.through === through && current.summary === summary) return null;
  const marked = insertCompactionEvent(stored, through);
  if (marked !== stored) {
    stored.splice(0, stored.length, ...marked);
    opts.onUpdate?.(stored);
  }
  return { summary, through };
}

async function runSubagent(call: ToolCall, opts: TurnOpts): Promise<string> {
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
        opts.model,
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
  imageCache: Map<string, string> = new Map(),
): Promise<{ text: string; reasoning: string; toolCalls: ToolCall[]; thinking: ThinkingBlock[]; error?: string; usage?: ChatUsage }> {
  const streamId = crypto.randomUUID();
  let text = "";
  let reasoning = "";
  let toolCalls: ToolCall[] = [];
  let thinking: ThinkingBlock[] = [];
  let usage: ChatUsage | undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (value: {
      text: string;
      reasoning: string;
      toolCalls: ToolCall[];
      thinking: ThinkingBlock[];
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
      void api.chatCancel(streamId);
      finish({ text, reasoning, toolCalls, thinking, error: "Stopped." });
    };
    void (async () => {
      try {
        unlisten = await api.onChat((ev) => {
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
            const signed = signedThinking(ev.thinking);
            if (signed.length) thinking = signed;
            usage = parseChatUsage(ev.usage) ?? usage;
            finish({ text: text || ev.text || "", reasoning, toolCalls, thinking, usage });
          } else if (ev.kind === "error") {
            finish({ text, reasoning, toolCalls, thinking, error: ev.text || "xAI request failed.", usage });
          }
        });
        opts.onReasoning?.("");
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort);
        const hydrated = await withImageDataUrls(messages, (path) => api.imageDataUrl(path), imageCache);
        await api.chatStart(
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
