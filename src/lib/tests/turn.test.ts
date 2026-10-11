import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canPersistTurn,
  closeDanglingToolCalls,
  liveTurnMessages,
  clearPendingForChat,
  clearUnseenFinished,
  dequeuePending,
  draftForChat,
  enqueuePending,
  isEmptyCompletion,
  isRetryableChatError,
  markUnseenFinished,
  pendingEditBlocksSend,
  pendingForChat,
  pendingIndexAfterRemove,
  removePending,
  setDraftForChat,
  skipToolIfAborted,
  chatHasRunningTurn,
  patchRunningTurn,
  composerSettingsForChat,
  effortForModel,
  modelForTurn,
  foregroundRunningId,
  runningTurnStartedAt,
  shouldQueueForChat,
  commitPartialReply,
  takeNextPending,
  updatePending,
  turnAppliesToChat,
  turnFailureMessage,
} from "../turn.ts";

describe("turnAppliesToChat", () => {
  it("only applies updates to the conversation that owns the turn", () => {
    assert.equal(turnAppliesToChat("chat-a", "chat-a"), true);
    assert.equal(turnAppliesToChat("chat-a", "chat-b"), false);
    assert.equal(turnAppliesToChat("chat-a", ""), false);
    assert.equal(turnAppliesToChat("", "chat-a"), false);
  });
});

describe("liveTurnMessages", () => {
  const live = [{ role: "assistant" as const, content: "still working" }];

  it("keeps the in-memory transcript for the project that owns the turn", () => {
    assert.deepEqual(
      liveTurnMessages({
        workspace: "/app/beta/",
        conversationId: "chat-b",
        runningWorkspace: "/app/Beta",
        runningId: "chat-b",
        live,
      }),
      live,
    );
  });

  it("uses the per-conversation live transcript when another chat is the foreground turn", () => {
    const other = [{ role: "user" as const, content: "from chat a" }];
    assert.deepEqual(
      liveTurnMessages({
        workspace: "/app/beta",
        conversationId: "chat-a",
        runningWorkspace: "/app/beta",
        runningId: "chat-b",
        live,
        liveByChat: new Map([["chat-a", { messages: other }]]),
      }),
      other,
    );
  });

  it("keeps a chat's live transcript while another project is in front", () => {
    const alpha = [{ role: "assistant" as const, content: "alpha live" }];
    assert.deepEqual(
      liveTurnMessages({
        workspace: "/app/alpha",
        conversationId: "chat-a",
        runningWorkspace: "/app/beta",
        runningId: "chat-b",
        live,
        liveByChat: new Map([["chat-a", { messages: alpha }]]),
      }),
      alpha,
    );
  });

  it("ignores a saved transcript from another project or another chat", () => {
    const other = {
      workspace: "/app/alpha",
      conversationId: "chat-b",
      runningWorkspace: "/app/beta",
      runningId: "chat-b",
      live,
    };
    assert.equal(liveTurnMessages(other), null);
    assert.equal(liveTurnMessages({ ...other, workspace: "/app/beta", conversationId: "chat-a" }), null);
    assert.equal(liveTurnMessages({ ...other, workspace: "/app/beta", live: null }), null);
  });
});

describe("closeDanglingToolCalls", () => {
  it("adds a result for a tool call that never finished", () => {
    const closed = closeDanglingToolCalls([
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", name: "run_command", arguments: "{}" }] },
    ]);
    assert.equal(closed.length, 2);
    assert.equal(closed[1]?.role, "tool");
    assert.equal(closed[1]?.tool_call_id, "call-1");
    assert.match(closed[1]?.content ?? "", /did not finish/);
  });

  it("leaves a transcript alone when every tool call has a result", () => {
    const messages = [
      { role: "assistant" as const, content: "", tool_calls: [{ id: "call-1", name: "run_command", arguments: "{}" }] },
      { role: "tool" as const, tool_call_id: "call-1", content: "ok" },
    ];
    assert.equal(closeDanglingToolCalls(messages), messages);
  });
});

describe("canPersistTurn", () => {
  it("persists the owning conversation unless it was deleted", () => {
    assert.equal(canPersistTurn("chat-a", new Set()), true);
    assert.equal(canPersistTurn("chat-a", new Set(["chat-b"])), true);
    assert.equal(canPersistTurn("chat-a", new Set(["chat-a"])), false);
    assert.equal(canPersistTurn("", new Set()), false);
  });
});

describe("per-conversation drafts", () => {
  it("keeps drafts isolated by chat id", () => {
    let drafts = setDraftForChat({}, "a", "hello a");
    drafts = setDraftForChat(drafts, "b", "hello b");
    assert.equal(draftForChat(drafts, "a"), "hello a");
    assert.equal(draftForChat(drafts, "b"), "hello b");
    assert.equal(draftForChat(drafts, "c"), "");
  });

  it("clears an empty draft for that chat only", () => {
    let drafts = setDraftForChat({}, "a", "keep");
    drafts = setDraftForChat(drafts, "b", "drop");
    drafts = setDraftForChat(drafts, "b", "");
    assert.equal(draftForChat(drafts, "a"), "keep");
    assert.equal(draftForChat(drafts, "b"), "");
    assert.equal(Object.hasOwn(drafts, "b"), false);
  });
});

describe("isRetryableChatError", () => {
  it("retries transport and server failures, not stop or auth", () => {
    assert.equal(isRetryableChatError("xAI request failed: error sending request"), true);
    assert.equal(isRetryableChatError("xAI error 429: rate limited"), true);
    assert.equal(isRetryableChatError("xAI error 503: unavailable"), true);
    assert.equal(isRetryableChatError("error decoding response body"), true);
    assert.equal(isRetryableChatError("Stopped."), false);
    assert.equal(isRetryableChatError("Grok CLI login expired. Run grok login."), false);
    assert.equal(isRetryableChatError("xAI rejected the API key."), false);
  });
});

describe("isEmptyCompletion", () => {
  it("treats whitespace-only text with no tool calls as empty", () => {
    assert.equal(isEmptyCompletion("", []), true);
    assert.equal(isEmptyCompletion("   ", []), true);
    assert.equal(isEmptyCompletion("ok", []), false);
    assert.equal(isEmptyCompletion("", [{ id: "1" }]), false);
  });
});

describe("turnFailureMessage", () => {
  it("keeps the API error in the transcript so the turn is not a silent stop", () => {
    const msg = turnFailureMessage("xAI error 503: unavailable");
    assert.equal(msg.role, "assistant");
    assert.match(String(msg.content), /xAI error 503/);
    assert.equal(msg.error, true);
  });
});

describe("unseen finished chats", () => {
  it("marks a reply that finished while the user was looking elsewhere", () => {
    const marked = markUnseenFinished(new Set(), "chat-a", {
      aborted: false,
      failed: false,
      looking: false,
      queued: false,
    });
    assert.equal(marked.has("chat-a"), true);
    assert.equal(markUnseenFinished(marked, "chat-a", { aborted: false, failed: false, looking: false, queued: false }), marked);
  });

  it("does not mark the chat the user is already reading, a stop, a failure, or a queued follow-up", () => {
    const none = new Set<string>();
    const opts = { aborted: false, failed: false, looking: false, queued: false };
    assert.equal(markUnseenFinished(none, "chat-a", { ...opts, looking: true }), none);
    assert.equal(markUnseenFinished(none, "chat-a", { ...opts, aborted: true }), none);
    assert.equal(markUnseenFinished(none, "chat-a", { ...opts, failed: true }), none);
    assert.equal(markUnseenFinished(none, "chat-a", { ...opts, queued: true }), none);
    assert.equal(markUnseenFinished(none, "", opts), none);
  });

  it("clears the mark when that conversation is opened", () => {
    const marked = new Set(["chat-a", "chat-b"]);
    const next = clearUnseenFinished(marked, "chat-a");
    assert.equal(next.has("chat-a"), false);
    assert.equal(next.has("chat-b"), true);
    assert.equal(clearUnseenFinished(next, "chat-a"), next);
  });
});

describe("commitPartialReply", () => {
  const history = [
    { role: "user" as const, content: "fix the login" },
    { role: "assistant" as const, content: "Done earlier." },
    { role: "user" as const, content: "now the header" },
  ];

  it("keeps the sent message and saves the reply that was still streaming", () => {
    const next = commitPartialReply(history, { text: "Looking at the header", reasoning: "Check the nav" });
    assert.equal(next[2]?.content, "now the header");
    assert.equal(next[3]?.role, "assistant");
    assert.equal(next[3]?.content, "Looking at the header");
    assert.equal(next[3]?.reasoning, "Check the nav");
    assert.equal(next.length, 4);
  });

  it("saves reasoning when the answer text has not started", () => {
    const next = commitPartialReply(history, { text: "", reasoning: "Still thinking" });
    assert.equal(next[3]?.content, "");
    assert.equal(next[3]?.reasoning, "Still thinking");
  });

  it("leaves the transcript alone when nothing was received yet", () => {
    assert.equal(commitPartialReply(history, { text: "", reasoning: "" }), history);
    assert.equal(commitPartialReply(history, { text: "   ", reasoning: "  " }), history);
  });
});

describe("skipToolIfAborted", () => {
  it("lets tools run while the turn is live", () => {
    const ac = new AbortController();
    assert.equal(skipToolIfAborted(ac.signal), null);
  });

  it("skips remaining tools after stop", () => {
    const ac = new AbortController();
    ac.abort();
    assert.equal(skipToolIfAborted(ac.signal), "Skipped: stopped.");
  });
});

describe("per-conversation pending queue", () => {
  it("keeps queued messages isolated by chat id", () => {
    let pending = enqueuePending({}, "a", "first a");
    pending = enqueuePending(pending, "b", "first b");
    pending = enqueuePending(pending, "a", "second a");
    assert.deepEqual(pendingForChat(pending, "a"), [{ text: "first a" }, { text: "second a" }]);
    assert.deepEqual(pendingForChat(pending, "b"), [{ text: "first b" }]);
    assert.deepEqual(pendingForChat(pending, "c"), []);
  });

  it("ignores blank messages and missing chat ids", () => {
    assert.deepEqual(enqueuePending({}, "a", "   "), {});
    assert.deepEqual(enqueuePending({}, "", "hello"), {});
  });

  it("trims queued text and keeps attached images", () => {
    const image = {
      id: "img-1",
      path: "/tmp/a.jpg",
      name: "a.jpg",
      mime: "image/jpeg",
      width: 10,
      height: 10,
      resized: false,
    };
    const pending = enqueuePending({}, "a", "  hello  ", [image]);
    assert.deepEqual(pendingForChat(pending, "a"), [{ text: "hello", images: [image] }]);
    assert.deepEqual(pendingForChat(enqueuePending({}, "a", "  ", [image]), "a"), [
      { text: "", images: [image] },
    ]);
  });

  it("removes a queued message by index", () => {
    let pending = enqueuePending({}, "a", "one");
    pending = enqueuePending(pending, "a", "two");
    pending = enqueuePending(pending, "a", "three");
    pending = removePending(pending, "a", 1);
    assert.deepEqual(pendingForChat(pending, "a"), [{ text: "one" }, { text: "three" }]);
  });

  it("drops the chat key when the last pending message is removed", () => {
    let pending = enqueuePending({}, "a", "only");
    pending = enqueuePending(pending, "b", "keep");
    pending = removePending(pending, "a", 0);
    assert.equal(Object.hasOwn(pending, "a"), false);
    assert.deepEqual(pendingForChat(pending, "b"), [{ text: "keep" }]);
  });

  it("dequeues the oldest message first", () => {
    let pending = enqueuePending({}, "a", "one");
    pending = enqueuePending(pending, "a", "two");
    const first = dequeuePending(pending, "a");
    assert.equal(first.item?.text, "one");
    assert.deepEqual(pendingForChat(first.pending, "a"), [{ text: "two" }]);
    const second = dequeuePending(first.pending, "a");
    assert.equal(second.item?.text, "two");
    assert.equal(Object.hasOwn(second.pending, "a"), false);
    const empty = dequeuePending(second.pending, "a");
    assert.equal(empty.item, null);
  });

  it("only continues the conversation whose turn just finished", () => {
    let pending = enqueuePending({}, "finished", "next on finished");
    pending = enqueuePending(pending, "other", "stays on other");
    const fromFinished = takeNextPending(pending, "finished");
    assert.equal(fromFinished.chatId, "finished");
    assert.equal(fromFinished.item?.text, "next on finished");
    assert.deepEqual(pendingForChat(fromFinished.pending, "other"), [{ text: "stays on other" }]);
    const none = takeNextPending(fromFinished.pending, "finished");
    assert.equal(none.chatId, null);
    assert.equal(none.item, null);
    assert.deepEqual(pendingForChat(none.pending, "other"), [{ text: "stays on other" }]);
  });

  it("queues a send only while that same conversation is running", () => {
    assert.equal(shouldQueueForChat("chat-a", "chat-a"), true);
    assert.equal(shouldQueueForChat("chat-a", "chat-b"), false);
    assert.equal(shouldQueueForChat("", "chat-b"), false);
  });

  it("keeps the running map when a tool tick repeats the same label", () => {
    const running = {
      "chat-a": { activity: { kind: "tool" as const, label: "Read a.ts" }, startedAt: 10 },
    };
    assert.equal(patchRunningTurn(running, "chat-a", { activity: { kind: "tool", label: "Read a.ts" } }), running);
    const next = patchRunningTurn(running, "chat-a", { activity: { kind: "tool", label: "Edit a.ts" } });
    assert.notEqual(next, running);
    assert.equal(next["chat-a"]?.activity?.kind, "tool");
    assert.equal(patchRunningTurn(running, "chat-a", { todo: { done: 1, total: 2 } })["chat-a"]?.todo?.total, 2);
    const withTodo = patchRunningTurn(running, "chat-a", { todo: { done: 1, total: 2 } });
    assert.equal(patchRunningTurn(withTodo, "chat-a", { todo: { done: 1, total: 2 } }), withTodo);
  });

  it("keeps every live turn running when a second chat becomes foreground", () => {
    const running = {
      "chat-a": { activity: { kind: "tool" as const, label: "Read a.ts" }, startedAt: 10 },
      "chat-b": { activity: null, startedAt: 20 },
    };
    assert.equal(chatHasRunningTurn(running, "chat-a"), true);
    assert.equal(chatHasRunningTurn(running, "chat-b"), true);
    assert.equal(chatHasRunningTurn(running, "chat-c"), false);
    assert.equal(chatHasRunningTurn({}, "chat-a"), false);
    assert.equal(runningTurnStartedAt(running, "chat-a"), 10);
    assert.equal(runningTurnStartedAt(running, "chat-c"), 0);
  });

  it("clears the composer thinking state when the open chat is idle", () => {
    const running = {
      "chat-a": { activity: null, startedAt: 10 },
    };
    assert.equal(foregroundRunningId(running, "chat-a"), "chat-a");
    assert.equal(foregroundRunningId(running, "chat-b"), "");
    assert.equal(foregroundRunningId(running, ""), "");
    assert.equal(foregroundRunningId(null, "chat-a"), "");
  });

  it("restores each chat's model, thinking, context, and permission", () => {
    const models = [
      {
        id: "grok-4.6",
        efforts: [{ id: "high" }, { id: "low" }],
        context_windows: [256000, 500000],
        context_window: 256000,
      },
      {
        id: "grok-4.7",
        efforts: [{ id: "high" }, { id: "medium" }],
        context_windows: [256000, 1000000],
        context_window: 256000,
      },
    ];
    const fallback = { model: "grok-4.7", effort: "high", contextWindow: 256000, permission: "ask" };
    assert.deepEqual(
      composerSettingsForChat(
        { model: "grok-4.6", effort: "low", contextWindow: 500000, permission: "read-only" },
        models,
        fallback,
      ),
      { model: "grok-4.6", effort: "low", contextWindow: 500000, permission: "read-only" },
    );
    assert.deepEqual(composerSettingsForChat({}, models, fallback), fallback);
    assert.deepEqual(
      composerSettingsForChat({ model: "missing", effort: "max", contextWindow: 128000, permission: "nope" }, models, fallback),
      { model: "grok-4.7", effort: "high", contextWindow: 256000, permission: "ask" },
    );
  });

  it("uses the composer chip on a new chat and the saved model after a reply", () => {
    const user = [{ role: "user" }];
    const replied = [...user, { role: "assistant" }];
    assert.equal(modelForTurn(user, "grok-4.6", "claude-haiku-4-5"), "claude-haiku-4-5");
    assert.equal(modelForTurn([], "grok-4.6", "claude-haiku-4-5"), "claude-haiku-4-5");
    assert.equal(modelForTurn(replied, "grok-4.6", "claude-haiku-4-5"), "grok-4.6");
    assert.equal(modelForTurn(replied, "", "claude-haiku-4-5"), "claude-haiku-4-5");
    assert.equal(modelForTurn(user, null, "  "), "");
  });

  it("sends the chip on an unanswered chat even when the row still has the previous model", () => {
    const models = [
      { id: "grok-4.6", efforts: [{ id: "high" }], context_windows: [256000], context_window: 256000 },
      { id: "claude-haiku-4-5", efforts: [{ id: "high" }], context_windows: [200000], context_window: 200000 },
    ];
    const chip = { model: "claude-haiku-4-5", effort: "high", contextWindow: 200000, permission: "ask" };
    const stored = { model: "grok-4.6", effort: "high", contextWindow: 256000, permission: "ask" };
    const unanswered = [{ role: "user" }];
    const chosen = modelForTurn(unanswered, stored.model, chip.model);
    assert.equal(
      composerSettingsForChat({ ...stored, model: null }, models, { ...chip, model: chosen }).model,
      "claude-haiku-4-5",
    );
    assert.equal(
      composerSettingsForChat(
        { ...stored, model: modelForTurn([...unanswered, { role: "assistant" }], stored.model, chip.model) },
        models,
        chip,
      ).model,
      "grok-4.6",
    );
  });

  it("keeps a chat's thinking level only when the model offers it", () => {
    const efforts = [{ id: "high" }, { id: "medium" }, { id: "low" }];
    assert.equal(effortForModel("low", efforts, "high"), "low");
    assert.equal(effortForModel("  ", efforts, "medium"), "medium");
    assert.equal(effortForModel("max", efforts, "nope"), "high");
    assert.equal(effortForModel("", [], "high"), "");
  });

  it("updates one queued message and keeps its place", () => {
    let pending = enqueuePending({}, "a", "one");
    pending = enqueuePending(pending, "a", "two");
    pending = enqueuePending(pending, "a", "three");
    const saved = updatePending(pending, "a", 1, "  two edited  ");
    assert.equal(saved.saved, true);
    assert.deepEqual(pendingForChat(saved.pending, "a"), [
      { text: "one" },
      { text: "two edited" },
      { text: "three" },
    ]);
    const blank = updatePending(pending, "a", 1, "   ");
    assert.equal(blank.saved, false);
    assert.deepEqual(pendingForChat(blank.pending, "a"), pendingForChat(pending, "a"));
  });

  it("holds the queue while the next message or a middle one is being edited", () => {
    assert.equal(pendingEditBlocksSend(1, 0), true);
    assert.equal(pendingEditBlocksSend(3, 0), true);
    assert.equal(pendingEditBlocksSend(3, 1), true);
    assert.equal(pendingEditBlocksSend(3, 2), false);
    assert.equal(pendingEditBlocksSend(2, 1), false);
    assert.equal(pendingEditBlocksSend(3, null), false);
    assert.equal(pendingEditBlocksSend(3, 4), false);
  });

  it("does not send the next message while a middle edit is open", () => {
    let pending = enqueuePending({}, "a", "first");
    pending = enqueuePending(pending, "a", "middle");
    pending = enqueuePending(pending, "a", "last");
    const held = takeNextPending(pending, "a", { chatId: "a", index: 1 });
    assert.equal(held.item, null);
    assert.deepEqual(pendingForChat(held.pending, "a"), [
      { text: "first" },
      { text: "middle" },
      { text: "last" },
    ]);
    const ready = takeNextPending(pending, "a", null);
    assert.equal(ready.item?.text, "first");
  });

  it("shifts the open edit when a queued message above it is removed", () => {
    assert.equal(pendingIndexAfterRemove(1, 1), null);
    assert.equal(pendingIndexAfterRemove(2, 0), 1);
    assert.equal(pendingIndexAfterRemove(1, 2), 1);
    assert.equal(pendingIndexAfterRemove(null, 0), null);
  });

  it("clears every pending message for a deleted chat", () => {
    let pending = enqueuePending({}, "a", "one");
    pending = enqueuePending(pending, "a", "two");
    pending = enqueuePending(pending, "b", "keep");
    pending = clearPendingForChat(pending, "a");
    assert.equal(Object.hasOwn(pending, "a"), false);
    assert.deepEqual(pendingForChat(pending, "b"), [{ text: "keep" }]);
  });
});
