import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentNameFor, contextWindowForProvider, isClaudeModel, providerFor } from "../provider.ts";

describe("providerFor", () => {
  it("classifies only the Claude catalog as anthropic", () => {
    assert.equal(providerFor("claude-opus-4-8"), "anthropic");
    assert.equal(providerFor(" claude-sonnet-4-6 "), "anthropic");
    assert.equal(providerFor("claude-haiku-4-5"), "anthropic");
    assert.equal(isClaudeModel("claude-haiku-4-5"), true);
  });

  it("keeps grok, empty, and side-by-side ids on xai", () => {
    assert.equal(providerFor("grok-4.6"), "xai");
    assert.equal(providerFor(""), "xai");
    assert.equal(providerFor("claude-opus-4-8-latest"), "xai");
    assert.equal(providerFor("sxs-claude-opus-4-6"), "xai");
    assert.equal(isClaudeModel("sxs-claude-opus-4-6"), false);
  });
});

describe("agentNameFor", () => {
  it("names Claude and Grok and stays quiet otherwise", () => {
    assert.equal(agentNameFor("claude-opus-4-8"), "Claude");
    assert.equal(agentNameFor("grok-4.6"), "Grok");
    assert.equal(agentNameFor(""), "");
    assert.equal(agentNameFor("sxs-claude-opus-4-6"), "");
  });
});

describe("contextWindowForProvider", () => {
  it("uses 200k for Claude when the catalog did not send a window", () => {
    assert.equal(contextWindowForProvider("claude-sonnet-4-6", null), 200_000);
    assert.equal(contextWindowForProvider("claude-opus-4-8", 0), 200_000);
  });

  it("lets a catalog window win and leaves grok unset", () => {
    assert.equal(contextWindowForProvider("claude-sonnet-4-6", 180_000), 180_000);
    assert.equal(contextWindowForProvider("grok-4.6", null), null);
  });
});
