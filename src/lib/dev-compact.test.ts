import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_COMPACT_THRESHOLD_PERCENT,
  COMPACTION_VERBATIM_TURNS,
  applyCompaction,
  compactionCut,
  messagesForContext,
  compactionPrompt,
  compactionThreshold,
  isCompactionSummary,
  isContextLengthError,
  readCompactionState,
  renderCompactionTranscript,
  shouldAutoCompact,
  splitForCompaction,
} from "./dev-compact.ts";
import type { ChatMessage } from "./dev.ts";

function user(content: string): ChatMessage {
  return { role: "user", content };
}
function assistant(content: string, tools?: ChatMessage["tool_calls"]): ChatMessage {
  return { role: "assistant", content, tool_calls: tools };
}
function tool(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

const thread: ChatMessage[] = [
  user("fix the login bug"),
  assistant("", [{ id: "1", name: "read_file", arguments: '{"path":"src/login.ts"}' }]),
  tool("1", "export function login() {}"),
  assistant("Found it in src/login.ts."),
  user("also add a test"),
  assistant("Added the test."),
  user("now compact the list"),
  assistant("Working on the list."),
];

describe("shouldAutoCompact", () => {
  it("matches the CLI 80 percent threshold", () => {
    assert.equal(AUTO_COMPACT_THRESHOLD_PERCENT, 80);
    assert.equal(compactionThreshold(256_000), 204_800);
    assert.equal(shouldAutoCompact(204_800, 256_000), true);
    assert.equal(shouldAutoCompact(204_799, 256_000), false);
    assert.equal(shouldAutoCompact(0, 256_000), false);
    assert.equal(shouldAutoCompact(10, 0), false);
  });
});

describe("isContextLengthError", () => {
  it("catches a window overflow and ignores stop or auth", () => {
    assert.equal(isContextLengthError("maximum context length exceeded"), true);
    assert.equal(isContextLengthError("prompt is too long for the context window"), true);
    assert.equal(isContextLengthError("Stopped."), false);
    assert.equal(isContextLengthError("xAI rejected the API key."), false);
  });
});

describe("compactionCut", () => {
  it("keeps the last two user turns verbatim and folds the rest", () => {
    assert.equal(COMPACTION_VERBATIM_TURNS, 2);
    assert.equal(compactionCut(thread), 4);
    const split = splitForCompaction(thread);
    assert.equal(split.older[0]?.content, "fix the login bug");
    assert.equal(split.recent[0]?.content, "also add a test");
    assert.equal(split.recent.at(-1)?.content, "Working on the list.");
  });

  it("does not compact a short thread", () => {
    const short = thread.slice(0, 4);
    assert.equal(compactionCut(short), short.length);
    assert.deepEqual(splitForCompaction(short).older, []);
  });
});

describe("applyCompaction", () => {
  it("replaces older turns with one summary and keeps the tail", () => {
    const next = applyCompaction(thread, "Fixed login in src/login.ts.", 4);
    assert.equal(isCompactionSummary(next[0]), true);
    assert.match(String(next[0]?.content), /context constraints/);
    assert.match(String(next[0]?.content), /Fixed login in src\/login\.ts/);
    assert.equal(next[1]?.content, "also add a test");
    assert.equal(next.length, 1 + (thread.length - 4));
    const state = readCompactionState(next);
    assert.equal(state?.summary, "Fixed login in src/login.ts.");
    assert.equal(state?.through, 1);
  });

  it("leaves the transcript alone when there is no tail to keep", () => {
    assert.equal(applyCompaction(thread, "summary", thread.length), thread);
    assert.equal(applyCompaction(thread, "  ", 4), thread);
  });

  it("sends the summary plus the tail without dropping the stored transcript", () => {
    const context = messagesForContext(thread, { summary: "Fixed login in src/login.ts.", through: 4 });
    assert.equal(context.compacted, true);
    assert.equal(isCompactionSummary(context.messages[0]), true);
    assert.equal(context.messages[1]?.content, "also add a test");
    assert.equal(thread.length, 8);
    assert.equal(messagesForContext(thread, null).compacted, false);
    assert.equal(messagesForContext(thread, { summary: "x", through: 0 }).compacted, false);
  });
});

describe("compaction prompt", () => {
  it("asks for a brief and includes the previous summary on the next pass", () => {
    const older = splitForCompaction(thread).older;
    const rendered = renderCompactionTranscript(older);
    assert.match(rendered, /User: fix the login bug/);
    assert.match(rendered, /read_file/);
    assert.match(rendered, /Tool result: export function login/);
    const first = compactionPrompt(older);
    assert.match(String(first[0]?.content), /Reply with the summary only/);
    assert.match(String(first[0]?.content), /fix the login bug/);
    const again = compactionPrompt(older, "Earlier: login was broken.");
    assert.match(String(again[0]?.content), /Previous summary:\nEarlier: login was broken/);
  });
});
