import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentIdentityLine, agentNameFor, contextWindowForProvider, isClaudeModel, isMinimaxModel, providerFor } from "../provider.ts";

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
    assert.equal(providerFor("claude-opus-4-8-latest"), "anthropic");
    assert.equal(providerFor("claude-sonnet-4-5-20250929"), "anthropic");
    assert.equal(providerFor("sxs-claude-opus-4-6"), "xai");
    assert.equal(isClaudeModel("sxs-claude-opus-4-6"), false);
  });

  it("classifies MiniMax text ids and leaves lookalikes on xai", () => {
    assert.equal(providerFor("MiniMax-M3"), "minimax");
    assert.equal(providerFor(" MiniMax-M2.7 "), "minimax");
    assert.equal(providerFor("MiniMax-M3.1-Flash-Preview"), "minimax");
    assert.equal(isMinimaxModel("MiniMax-M2.7-highspeed"), true);
    assert.equal(providerFor("minimax-m3"), "xai");
    assert.equal(providerFor("sxs-MiniMax-M3"), "xai");
    assert.equal(isMinimaxModel("sxs-MiniMax-M3"), false);
    assert.equal(isMinimaxModel(""), false);
  });
});

describe("agentNameFor", () => {
  it("names Claude and Grok and stays quiet otherwise", () => {
    assert.equal(agentNameFor("claude-opus-4-8"), "Claude");
    assert.equal(agentNameFor("claude-haiku-4-5"), "Claude");
    assert.equal(agentNameFor("claude-haiku-4-5-latest"), "Claude");
    assert.equal(agentNameFor("grok-4.6"), "Grok");
    assert.equal(agentNameFor("MiniMax-M3"), "MiniMax");
    assert.equal(agentNameFor(""), "");
    assert.equal(agentNameFor("mystery-model"), "");
  });

  it("puts the selected model id in the identity line", () => {
    assert.equal(
      agentIdentityLine("claude-haiku-4-5"),
      "You are Claude (claude-haiku-4-5), a coding agent in TwanAgent.",
    );
    assert.equal(
      agentIdentityLine("grok-4.6"),
      "You are Grok (grok-4.6), a coding agent in TwanAgent.",
    );
    assert.equal(
      agentIdentityLine("MiniMax-M3"),
      "You are MiniMax (MiniMax-M3), a coding agent in TwanAgent.",
    );
    assert.equal(agentIdentityLine(""), "You are a coding agent in TwanAgent.");
    assert.equal(agentIdentityLine("mystery-model"), "You are a coding agent in TwanAgent.");
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
    assert.equal(contextWindowForProvider("MiniMax-M3", null), 512_000);
    assert.equal(contextWindowForProvider("MiniMax-M2.7", 200_000), 200_000);
  });
});
