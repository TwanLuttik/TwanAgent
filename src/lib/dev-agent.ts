import type { DevToolCall } from "./tauri";
import * as api from "./tauri";
import { parseToolArgs, toApiMessages, toolActivityLabel, withSystem, type ChatMessage } from "./dev.ts";
import { parsePermissionMode, toolDeniedByPermission, type PermissionMode } from "./dev-permission.ts";
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
): Promise<string> {
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

const MAX_TURNS = 20;

export type TurnOpts = {
  workspace: string;
  messages: ChatMessage[];
  model?: string;
  effort?: string;
  system?: ChatMessage;
  allowSpawn?: boolean;
  childType?: SubagentType;
  onDelta: (text: string) => void;
  onError: (text: string) => void;
  confirmShell: ConfirmShell;
  getPermission?: () => PermissionMode;
  onTool?: (call: DevToolCall) => void;
  onUpdate?: (messages: ChatMessage[]) => void;
  onRefresh?: () => void;
  onSubagent?: (event: SubagentEvent) => void;
  signal: AbortSignal;
};

export async function completeTurn(opts: TurnOpts): Promise<ChatMessage[]> {
  let messages = opts.messages;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (opts.signal.aborted) return messages;
    const permission = parsePermissionMode(opts.getPermission?.());
    const result = await streamCompletion(
      withSystem(opts.workspace, messages, opts.system, permission),
      opts,
    );
    if (opts.signal.aborted) return messages;
    if (result.error) {
      opts.onError(result.error);
      return messages;
    }
    const assistant: ChatMessage = {
      role: "assistant",
      content: result.text || (result.toolCalls.length ? "" : result.text),
      tool_calls: result.toolCalls.length ? result.toolCalls : undefined,
    };
    messages = [...messages, assistant];
    opts.onUpdate?.(messages);
    if (!result.toolCalls.length) return messages;
    const contents: string[] = new Array(result.toolCalls.length);
    const spawnWaits: Promise<void>[] = [];
    for (let i = 0; i < result.toolCalls.length; i++) {
      const call = result.toolCalls[i];
      opts.onTool?.(call);
      if (call.name === "spawn_subagent") {
        spawnWaits.push(
          runSubagent(call, opts).then((content) => {
            contents[i] = content;
          }),
        );
        continue;
      }
      contents[i] = await executeTool(
        opts.workspace,
        call,
        opts.confirmShell,
        opts.childType,
        parsePermissionMode(opts.getPermission?.()),
      );
      if (call.name === "write_file" || call.name === "edit_file" || call.name === "run_command") {
        opts.onRefresh?.();
      }
    }
    await Promise.all(spawnWaits);
    const toolMsgs: ChatMessage[] = result.toolCalls.map((call, i) => ({
      role: "tool",
      tool_call_id: call.id,
      content: contents[i] ?? "",
    }));
    messages = [...messages, ...toolMsgs];
    opts.onUpdate?.(messages);
  }
  opts.onError("Stopped after too many tool turns.");
  return messages;
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
      system: subagentSystemPrompt(
        opts.workspace,
        parsed.subagentType,
        parsed.description,
        parsePermissionMode(opts.getPermission?.()),
      ),
      allowSpawn: false,
      childType: parsed.subagentType,
      getPermission: opts.getPermission,
      onDelta: (text) => opts.onSubagent?.({ type: "delta", id, text }),
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
    onDelta: (text: string) => void;
    onError: (text: string) => void;
    signal: AbortSignal;
  },
): Promise<{ text: string; toolCalls: DevToolCall[]; error?: string }> {
  const streamId = crypto.randomUUID();
  let text = "";
  let toolCalls: DevToolCall[] = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (value: { text: string; toolCalls: DevToolCall[]; error?: string }) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener("abort", onAbort);
      unlisten?.();
      resolve(value);
    };
    const onAbort = () => {
      void api.devChatCancel(streamId);
      finish({ text, toolCalls, error: "Stopped." });
    };
    void (async () => {
      try {
        unlisten = await api.onDevChat((ev) => {
          if (ev.stream_id !== streamId) return;
          if (ev.kind === "delta" && ev.text) {
            text += ev.text;
            opts.onDelta(ev.text);
          } else if (ev.kind === "done") {
            if (ev.tool_calls?.length) toolCalls = ev.tool_calls;
            finish({ text, toolCalls });
          } else if (ev.kind === "error") {
            finish({ text, toolCalls, error: ev.text || "xAI request failed." });
          }
        });
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort);
        await api.devChatStart(streamId, toApiMessages(messages), opts.model, opts.effort);
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
