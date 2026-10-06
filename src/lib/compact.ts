import type { ChatMessage, ChatToolCall } from "./core.ts";

/** Grok CLI `auto_compact_threshold_percent`. */
export const AUTO_COMPACT_THRESHOLD_PERCENT = 80;

/** Grok CLI `compactions_remaining`: one summary, then the recent tail stays verbatim. */
export const COMPACTION_VERBATIM_TURNS = 2;

export const COMPACTION_SUMMARY_TAG = "compaction_summary";

export const COMPACT_NOTICE =
  "Your conversation was summarized due to context constraints. Here is the summary of the conversation so far:";

/** Shown in the transcript when earlier messages were folded. Not sent to the model. */
export const COMPACTION_EVENT_TEXT = "Conversation compacted";

export function compactionEventMessage(): ChatMessage {
  return { role: "system", content: COMPACTION_EVENT_TEXT };
}

export function isCompactionEvent(msg: ChatMessage | undefined): boolean {
  return msg?.role === "system" && String(msg.content ?? "").trim() === COMPACTION_EVENT_TEXT;
}

const SUMMARY_INSTRUCTIONS = `Summarize this coding conversation so work can continue in a fresh context window.
Write a compact brief the assistant will read instead of the earlier messages. Include:
- What the user asked for and the decisions already made
- Files created or changed, and what changed in each
- Commands run and whether they passed or failed
- Errors still open, and the exact next step
Keep file paths, function names, and error text that the next turn needs. Drop greetings, repeated tool output, and anything already superseded.
Reply with the summary only. Do not mention that you are summarizing.`;

export type CompactionState = {
  summary: string;
  /** Index into the full transcript of the first message that stays verbatim. */
  through: number;
};

/**
 * Drop a visible compaction notice at `through` without moving later messages.
 * The notice is a system message, so it is not sent to the model, and it does
 * not change the stored boundary. Another compaction keeps the earlier notice.
 */
export function insertCompactionEvent(messages: ChatMessage[], through: number): ChatMessage[] {
  const at = Math.floor(through);
  if (!Number.isFinite(at) || at <= 0 || at > messages.length) return messages;
  if (isCompactionEvent(messages[at]) || isCompactionEvent(messages[at - 1])) return messages;
  return [...messages.slice(0, at), compactionEventMessage(), ...messages.slice(at)];
}

export type ContextMessages = {
  messages: ChatMessage[];
  compacted: boolean;
};

export function isCompactionSummary(msg: ChatMessage | undefined): boolean {
  return msg?.role === "system" && String(msg.content ?? "").includes(`<${COMPACTION_SUMMARY_TAG}>`);
}

export function compactionThreshold(windowSize: number): number {
  if (!Number.isFinite(windowSize) || windowSize <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((windowSize * AUTO_COMPACT_THRESHOLD_PERCENT) / 100);
}

export function shouldAutoCompact(promptTokens: number, windowSize: number): boolean {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return false;
  return promptTokens >= compactionThreshold(windowSize);
}

export function isContextLengthError(error: string): boolean {
  const text = error.toLowerCase();
  if (!text || text.includes("stopped")) return false;
  return (
    text.includes("context length") ||
    text.includes("context window") ||
    text.includes("maximum context") ||
    text.includes("too many tokens") ||
    text.includes("token limit") ||
    (text.includes("context") && (text.includes("exceed") || text.includes("too long") || text.includes("too large")))
  );
}

/** User turns are the CLI's "turns". Tool results stay inside the turn they belong to. */
export function userTurnStarts(messages: ChatMessage[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") starts.push(i);
  }
  return starts;
}

/**
 * First index that stays verbatim. Everything before it is folded into one summary.
 * Returns the length when there is nothing old enough to fold.
 */
export function compactionCut(messages: ChatMessage[], verbatimTurns = COMPACTION_VERBATIM_TURNS): number {
  const starts = userTurnStarts(messages);
  const keep = Math.max(1, Math.floor(verbatimTurns));
  if (starts.length <= keep) return messages.length;
  return starts[starts.length - keep] ?? messages.length;
}

export function splitForCompaction(
  messages: ChatMessage[],
  verbatimTurns = COMPACTION_VERBATIM_TURNS,
): { older: ChatMessage[]; recent: ChatMessage[]; cut: number } {
  const cut = compactionCut(messages, verbatimTurns);
  if (cut <= 0 || cut >= messages.length) {
    return { older: [], recent: messages, cut: messages.length };
  }
  return { older: messages.slice(0, cut), recent: messages.slice(cut), cut };
}

export function formatCompactionSummary(summary: string): string {
  const body = summary.trim();
  return `${COMPACT_NOTICE}\n<summary_content>\n<${COMPACTION_SUMMARY_TAG}>\n${body}\n</${COMPACTION_SUMMARY_TAG}>\n</summary_content>\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary and do not recap what was happening.`;
}

export function compactionSummaryMessage(summary: string): ChatMessage {
  return { role: "system", content: formatCompactionSummary(summary) };
}

export function compactionPrompt(older: ChatMessage[], previousSummary = ""): ChatMessage[] {
  const prior = previousSummary.trim();
  const transcript = renderCompactionTranscript(older);
  const content = prior
    ? `${SUMMARY_INSTRUCTIONS}\n\nPrevious summary:\n${prior}\n\nConversation since that summary:\n${transcript}`
    : `${SUMMARY_INSTRUCTIONS}\n\nConversation:\n${transcript}`;
  return [{ role: "user", content }];
}

export function readCompactionState(messages: ChatMessage[]): CompactionState | null {
  const first = messages[0];
  if (!isCompactionSummary(first)) return null;
  const summary = extractSummaryBody(String(first?.content ?? ""));
  if (!summary) return null;
  return { summary, through: 1 };
}

export function applyCompaction(messages: ChatMessage[], summary: string, cut: number): ChatMessage[] {
  const body = summary.trim();
  if (!body || cut <= 0 || cut >= messages.length) return messages;
  const recent = messages.slice(cut).filter((msg) => !isCompactionSummary(msg));
  return [compactionSummaryMessage(body), ...recent];
}

/**
 * What the model sees. The stored transcript stays intact.
 * `summary` replaces every message before `through`, matching one CLI compaction.
 */
export function messagesForContext(messages: ChatMessage[], state: CompactionState | null): ContextMessages {
  if (!state?.summary.trim()) return { messages, compacted: false };
  const through = Math.max(0, Math.min(messages.length, Math.floor(state.through)));
  if (through <= 0 || through >= messages.length) return { messages, compacted: false };
  return {
    messages: [compactionSummaryMessage(state.summary), ...messages.slice(through)],
    compacted: true,
  };
}

export function renderCompactionTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system" && isCompactionSummary(msg)) {
      const body = extractSummaryBody(String(msg.content ?? ""));
      if (body) lines.push(`Previous summary:\n${body}`);
      continue;
    }
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      const images = msg.images?.map((img) => img.name).filter(Boolean) ?? [];
      const text = String(msg.content ?? "").trim();
      const attached = images.length ? `\n[images: ${images.join(", ")}]` : "";
      lines.push(`User: ${text}${attached}`.trim());
      continue;
    }
    if (msg.role === "assistant") {
      const thought = String(msg.reasoning ?? "").trim();
      if (thought) lines.push(`Thinking: ${clip(thought, 800)}`);
      const text = String(msg.content ?? "").trim();
      if (text) lines.push(`Assistant: ${clip(text, 2000)}`);
      for (const call of msg.tool_calls ?? []) lines.push(`Tool call: ${toolLine(call)}`);
      continue;
    }
    if (msg.role === "tool") {
      lines.push(`Tool result: ${clip(String(msg.content ?? "").trim(), 500)}`);
    }
  }
  return lines.join("\n\n");
}

function toolLine(call: ChatToolCall): string {
  const args = call.arguments.trim();
  return args ? `${call.name} ${clip(args, 300)}` : call.name;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function extractSummaryBody(content: string): string {
  const match = content.match(new RegExp(`<${COMPACTION_SUMMARY_TAG}>([\\s\\S]*?)</${COMPACTION_SUMMARY_TAG}>`));
  return match?.[1]?.trim() ?? "";
}
