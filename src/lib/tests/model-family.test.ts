import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupModelFamilies, modelFamilyName, sharedModelCapabilities } from "../model-family.ts";

describe("modelFamilyName", () => {
  it("splits a trailing version from the family", () => {
    assert.deepEqual(modelFamilyName("Claude Opus 4.8"), { family: "Claude Opus", version: "4.8" });
    assert.deepEqual(modelFamilyName("Claude Sonnet 5"), { family: "Claude Sonnet", version: "5" });
    assert.deepEqual(modelFamilyName("Grok 4.6"), { family: "Grok", version: "4.6" });
  });

  it("leaves a name with no trailing version alone", () => {
    assert.deepEqual(modelFamilyName("Claude 3 Haiku"), { family: "Claude 3 Haiku", version: "" });
    assert.deepEqual(modelFamilyName("Grok"), { family: "Grok", version: "" });
  });

  it("keeps every MiniMax line under one family", () => {
    assert.deepEqual(modelFamilyName("MiniMax M3"), { family: "MiniMax", version: "M3" });
    assert.deepEqual(modelFamilyName("MiniMax M2.7 Highspeed"), { family: "MiniMax", version: "M2.7 Highspeed" });
  });
});

describe("sharedModelCapabilities", () => {
  it("returns the set only when every member matches", () => {
    assert.deepEqual(
      sharedModelCapabilities([
        { capabilities: ["vision", "thinking"] },
        { capabilities: ["thinking", "vision"] },
      ]),
      ["vision", "thinking"],
    );
    assert.equal(
      sharedModelCapabilities([
        { capabilities: ["vision"] },
        { capabilities: ["vision", "pdf"] },
      ]),
      null,
    );
    assert.equal(sharedModelCapabilities([{ capabilities: ["vision"] }]), null);
  });
});

describe("groupModelFamilies", () => {
  it("keeps one row per family and preserves version order", () => {
    const groups = groupModelFamilies([
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ]);
    assert.deepEqual(
      groups.map((group) => [group.label, group.models.map((model) => model.id)]),
      [
        ["Claude Sonnet", ["claude-sonnet-5"]],
        ["Claude Opus", ["claude-opus-4-8", "claude-opus-4-7"]],
        ["Claude Haiku", ["claude-haiku-4-5"]],
      ],
    );
  });

  it("nests MiniMax models under one header so they indent with the other providers", () => {
    const groups = groupModelFamilies([
      { id: "MiniMax-M3", name: "MiniMax M3" },
      { id: "MiniMax-M3.1-Flash-Preview", name: "MiniMax M3.1 Flash" },
      { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    ]);
    assert.deepEqual(
      groups.map((group) => [group.label, group.models.map((model) => model.id)]),
      [["MiniMax", ["MiniMax-M3", "MiniMax-M3.1-Flash-Preview", "MiniMax-M2.7"]]],
    );
  });
});
