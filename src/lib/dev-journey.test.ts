import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSidebar,
  conversationHasSummarizeSource,
  JOURNEY_SUMMARIZE_PROMPT,
  journeyKnowledgePath,
  journeyWash,
  lastAssistantText,
  parseJourneyColor,
  parseJourneyId,
} from "./dev-journey.ts";
import type { DevConversationSummary } from "./tauri.ts";
import type { JourneySummary } from "./dev-journey.ts";

function chat(
  id: string,
  extras: Partial<DevConversationSummary> = {},
): DevConversationSummary {
  return {
    id,
    title: id,
    created_at: "t0",
    updated_at: "t0",
    kind: "chat",
    sort_order: 0,
    ...extras,
  };
}

function journey(id: string, extras: Partial<JourneySummary> = {}): JourneySummary {
  return {
    id,
    title: id,
    created_at: "t0",
    updated_at: "t0",
    sort_order: 0,
    collapsed: false,
    ...extras,
  };
}

describe("buildSidebar", () => {
  it("nests children under their journey and sorts by sort_order", () => {
    const rows = buildSidebar(
      [
        chat("top", { sort_order: 2 }),
        chat("kid-b", { journey_id: "j1", sort_order: 1 }),
        chat("kid-a", { journey_id: "j1", sort_order: 0 }),
      ],
      [journey("j1", { sort_order: 1, title: "Marketing" })],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, "journey");
    if (rows[0].kind !== "journey") return;
    assert.equal(rows[0].journey.title, "Marketing");
    assert.deepEqual(
      rows[0].children.map((c) => c.id),
      ["kid-a", "kid-b"],
    );
    assert.equal(rows[1].kind, "chat");
    if (rows[1].kind !== "chat") return;
    assert.equal(rows[1].conversation.id, "top");
  });

  it("keeps collapsed state on the journey node", () => {
    const rows = buildSidebar(
      [chat("kid", { journey_id: "j1" })],
      [journey("j1", { collapsed: true })],
    );
    assert.equal(rows[0].kind, "journey");
    if (rows[0].kind !== "journey") return;
    assert.equal(rows[0].journey.collapsed, true);
    assert.equal(rows[0].children.length, 1);
  });
});

describe("conversationHasSummarizeSource", () => {
  it("is true only when a user or assistant message has text", () => {
    assert.equal(conversationHasSummarizeSource([]), false);
    assert.equal(conversationHasSummarizeSource([{ role: "tool", content: "ok" }]), false);
    assert.equal(conversationHasSummarizeSource([{ role: "user", content: "   " }]), false);
    assert.equal(conversationHasSummarizeSource([{ role: "user", content: "hello" }]), true);
    assert.equal(conversationHasSummarizeSource([{ role: "assistant", content: "hi" }]), true);
  });
});

describe("lastAssistantText", () => {
  it("returns the last non-empty assistant reply", () => {
    assert.equal(lastAssistantText([]), "");
    assert.equal(
      lastAssistantText([
        { role: "assistant", content: "first" },
        { role: "user", content: "more" },
        { role: "assistant", content: "  bullets  " },
      ]),
      "bullets",
    );
  });
});

describe("journey knowledge paths", () => {
  it("round-trips a journey id and ignores workspace paths", () => {
    assert.equal(journeyKnowledgePath("abc"), "journey:abc");
    assert.equal(parseJourneyId("journey:abc"), "abc");
    assert.equal(parseJourneyId("src/notes.md"), null);
  });
});

describe("journey color", () => {
  it("accepts known colors and treats anything else as none", () => {
    assert.equal(parseJourneyColor("blue"), "blue");
    assert.equal(parseJourneyColor("violet"), "violet");
    assert.equal(parseJourneyColor(""), "");
    assert.equal(parseJourneyColor("neon"), "");
    assert.equal(parseJourneyColor(undefined), "");
  });

  it("returns a subtle wash only for a known color", () => {
    assert.equal(journeyWash(""), undefined);
    assert.match(journeyWash("blue") ?? "", /\/ 0\.1/);
    assert.equal(journeyWash("nope"), undefined);
  });
});

describe("summarize prompt", () => {
  it("asks for reusable bullet points", () => {
    assert.match(JOURNEY_SUMMARIZE_PROMPT, /bullet points/i);
    assert.match(JOURNEY_SUMMARIZE_PROMPT, /Do not add a preamble/);
  });
});
