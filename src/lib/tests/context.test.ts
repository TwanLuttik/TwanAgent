import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextUsageSnapshot,
  contextUsageTone,
  contextWindowChoices,
  contextWindowForModel,
  contextWindowLabel,
  resolveContextWindow,
  formatContextUsage,
  formatTokenCount,
  parseChatUsage,
  sameChatUsage,
  putChatUsage,
  usageToPersist,
  usageToWire,
} from "../context.ts";

describe("parseChatUsage", () => {
  it("reads OpenAI-style usage from a done event", () => {
    assert.deepEqual(
      parseChatUsage({
        prompt_tokens: 24100,
        completion_tokens: 800,
        total_tokens: 24900,
      }),
      { promptTokens: 24100, completionTokens: 800, totalTokens: 24900 },
    );
  });

  it("returns null when prompt tokens are missing", () => {
    assert.equal(parseChatUsage(undefined), null);
    assert.equal(parseChatUsage({ completion_tokens: 10 }), null);
    assert.equal(parseChatUsage({ prompt_tokens: -1 }), null);
  });

  it("fills missing completion and total from prompt tokens", () => {
    assert.deepEqual(parseChatUsage({ prompt_tokens: 12 }), {
      promptTokens: 12,
      completionTokens: 0,
      totalTokens: 12,
    });
  });

  it("folds reasoning tokens that xAI leaves out of completion_tokens", () => {
    assert.deepEqual(
      parseChatUsage({
        prompt_tokens: 136,
        completion_tokens: 3,
        total_tokens: 736,
        completion_tokens_details: { reasoning_tokens: 597 },
      }),
      { promptTokens: 136, completionTokens: 600, totalTokens: 736 },
    );
  });

  it("adds Claude cache tokens that are left out of input_tokens", () => {
    assert.deepEqual(
      parseChatUsage({
        input_tokens: 1_200,
        cache_read_input_tokens: 180_000,
        cache_creation_input_tokens: 4_000,
        output_tokens: 900,
      }),
      {
        promptTokens: 185_200,
        completionTokens: 900,
        totalTokens: 186_100,
        cacheReadTokens: 180_000,
        cacheCreationTokens: 4_000,
      },
    );
  });

  it("does not add xAI cached tokens that are already inside prompt_tokens", () => {
    assert.deepEqual(
      parseChatUsage({
        prompt_tokens: 24100,
        completion_tokens: 800,
        total_tokens: 24900,
        prompt_tokens_details: { cached_tokens: 20000 },
      }),
      {
        promptTokens: 24100,
        completionTokens: 800,
        totalTokens: 24900,
        cacheReadTokens: 20000,
      },
    );
  });
});

describe("contextWindowForModel", () => {
  it("prefers the catalog window when present", () => {
    assert.equal(contextWindowForModel("grok-4.6", 500000), 500000);
    assert.equal(contextWindowForModel("other", 200000), 200000);
  });

  it("falls back by model family when the catalog has no window", () => {
    assert.equal(contextWindowForModel("grok-4.6"), 500000);
    assert.equal(contextWindowForModel("grok-4.5"), 500000);
    assert.equal(contextWindowForModel("grok-3-mini"), 131072);
    assert.equal(contextWindowForModel("unknown-model"), 500000);
    assert.equal(contextWindowForModel("claude-sonnet-4-6"), 200_000);
    assert.equal(contextWindowForModel("claude-opus-4-8", 180_000), 180_000);
    assert.equal(contextWindowForModel("claude-opus-4-8-latest"), 200_000);
    assert.equal(contextWindowForModel("MiniMax-M3"), 512_000);
    assert.equal(contextWindowForModel("MiniMax-M2.7", 200_000), 200_000);
  });
});

describe("context window choices", () => {
  it("hides a single catalog window and keeps listed sizes in order", () => {
    assert.deepEqual(contextWindowChoices([256000, 500000, 256000], 256000), [256000, 500000]);
    assert.deepEqual(contextWindowChoices(undefined, 131072), []);
    assert.deepEqual(contextWindowChoices([500000], 256000), [256000, 500000]);
  });

  it("labels sizes the way the CLI slash command does", () => {
    assert.equal(contextWindowLabel(256000), "256k");
    assert.equal(contextWindowLabel(500000), "500k");
    assert.equal(contextWindowLabel(1_000_000), "1M");
    assert.equal(contextWindowLabel(131072), "131,072");
  });

  it("keeps a saved size when the model offers it", () => {
    const choices = [256000, 500000];
    assert.equal(resolveContextWindow(choices, 500000, 256000, "grok-4.6"), 500000);
    assert.equal(resolveContextWindow(choices, 128000, 256000, "grok-4.6"), 256000);
    assert.equal(resolveContextWindow([], 500000, 131072, "grok-3"), 131072);
    assert.equal(resolveContextWindow([], 0, null, "grok-4.6"), 500000);
  });
});

describe("formatTokenCount", () => {
  it("uses compact k and M suffixes", () => {
    assert.equal(formatTokenCount(12), "12");
    assert.equal(formatTokenCount(24100), "24k");
    assert.equal(formatTokenCount(1500), "1.5k");
    assert.equal(formatTokenCount(500000), "500k");
    assert.equal(formatTokenCount(1_200_000), "1.2M");
  });
});

describe("context usage snapshot", () => {
  it("builds a percent label from the prompt and the chosen window", () => {
    const usage = parseChatUsage({ prompt_tokens: 24100, completion_tokens: 10, total_tokens: 24110 })!;
    const snap = contextUsageSnapshot(usage, 500000);
    assert.equal(snap.percent, 5);
    assert.equal(snap.used, 24100);
    assert.equal(snap.window, 500000);
    assert.equal(snap.tone, "ok");
    assert.equal(formatContextUsage(usage, 500000), "5% · 24k / 500k");
  });

  it("turns warn at 80% and high at 95%", () => {
    assert.equal(contextUsageTone(79), "ok");
    assert.equal(contextUsageTone(80), "warn");
    assert.equal(contextUsageTone(95), "high");
    const snap = contextUsageSnapshot({ promptTokens: 480000, completionTokens: 0, totalTokens: 480000 }, 500000);
    assert.equal(snap.percent, 96);
    assert.equal(snap.tone, "high");
  });

  it("clamps a full or oversized window to 100%", () => {
    assert.equal(contextUsageSnapshot({ promptTokens: 600000, completionTokens: 0, totalTokens: 600000 }, 500000).percent, 100);
    assert.equal(contextUsageSnapshot({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 500000).percent, 0);
  });
});

describe("persisted chat usage", () => {
  it("hydrates usage for a conversation from stored wire data", () => {
    const next = putChatUsage({}, "c1", { prompt_tokens: 138000, completion_tokens: 20, total_tokens: 138020 });
    assert.deepEqual(next.c1, { promptTokens: 138000, completionTokens: 20, totalTokens: 138020 });
  });

  it("keeps the previous map when the payload is missing", () => {
    const prev = { c1: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } };
    assert.equal(putChatUsage(prev, "c1", null), prev);
    assert.equal(putChatUsage(prev, "c1", undefined), prev);
  });

  it("writes the latest usage and falls back to what was already stored", () => {
    const latest = { promptTokens: 20, completionTokens: 2, totalTokens: 22 };
    const stored = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
    assert.deepEqual(usageToPersist(latest, stored), { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 });
    assert.deepEqual(usageToPersist(undefined, stored), { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 });
    assert.equal(usageToPersist(undefined, undefined), undefined);
  });
});

describe("usage wire format", () => {
  it("round-trips through the API shape", () => {
    const usage = parseChatUsage({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })!;
    assert.deepEqual(usageToWire(usage), { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
    assert.equal(sameChatUsage(usage, parseChatUsage(usageToWire(usage))!), true);
    assert.equal(sameChatUsage(undefined, usage), false);
  });
});
