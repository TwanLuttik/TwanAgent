import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySubagentEvent,
  childCanUseTool,
  emptySubagent,
  parseSpawnArgs,
  parseSubagentType,
  subagentSystemPrompt,
  summarizeSubagent,
} from "./dev-subagent.ts";

describe("parseSpawnArgs", () => {
  it("reads prompt, description, and type", () => {
    const parsed = parseSpawnArgs(
      JSON.stringify({
        prompt: "Find the parser",
        description: "Find parser",
        subagent_type: "explore",
      }),
    );
    assert.deepEqual(parsed, {
      prompt: "Find the parser",
      description: "Find parser",
      subagentType: "explore",
    });
  });

  it("defaults the type and description", () => {
    const parsed = parseSpawnArgs(JSON.stringify({ prompt: "Do the thing" }));
    assert.equal(parsed.subagentType, "general-purpose");
    assert.equal(parsed.description, "Subagent");
    assert.equal(parseSubagentType("nope"), "general-purpose");
  });
});

describe("childCanUseTool", () => {
  it("never lets a child spawn another child", () => {
    assert.equal(childCanUseTool("general-purpose", "spawn_subagent"), false);
  });

  it("blocks file edits for explore and plan", () => {
    assert.equal(childCanUseTool("explore", "read_file"), true);
    assert.equal(childCanUseTool("explore", "write_file"), false);
    assert.equal(childCanUseTool("plan", "edit_file"), false);
    assert.equal(childCanUseTool("general-purpose", "edit_file"), true);
  });
});

describe("subagentSystemPrompt", () => {
  it("includes the parent permission policy", () => {
    assert.match(
      String(subagentSystemPrompt("/tmp/app", "explore", "Find parser").content),
      /require the user to approve/,
    );
    assert.match(
      String(subagentSystemPrompt("/tmp/app", "general-purpose", "Edit files", "approve-all").content),
      /without asking/,
    );
  });
});

describe("summarizeSubagent", () => {
  it("uses the last assistant text", () => {
    assert.equal(
      summarizeSubagent([
        { role: "user", content: "look" },
        { role: "assistant", content: "first" },
        { role: "assistant", content: "final answer" },
      ]),
      "final answer",
    );
    assert.equal(summarizeSubagent([{ role: "user", content: "look" }]), "Subagent finished with no summary.");
  });
});

describe("applySubagentEvent", () => {
  const start = emptySubagent({
    id: "s1",
    description: "Find parser",
    type: "explore",
    prompt: "Find the parser",
  });

  it("tracks live output and completion", () => {
    let rows = applySubagentEvent([], { type: "start", record: start });
    rows = applySubagentEvent(rows, { type: "delta", id: "s1", text: "Looking" });
    rows = applySubagentEvent(rows, { type: "tool", id: "s1", label: "Read src/lib.rs" });
    rows = applySubagentEvent(rows, {
      type: "done",
      id: "s1",
      status: "done",
      summary: "Parser is in dev.ts",
      messages: [{ role: "assistant", content: "Parser is in dev.ts" }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "done");
    assert.equal(rows[0].summary, "Parser is in dev.ts");
    assert.deepEqual(rows[0].tools, ["Read src/lib.rs"]);
    assert.equal(rows[0].streamText, "");
  });

  it("marks a running agent as errored", () => {
    let rows = applySubagentEvent([], { type: "start", record: start });
    rows = applySubagentEvent(rows, { type: "error", id: "s1", error: "boom" });
    assert.equal(rows[0].status, "error");
    assert.equal(rows[0].error, "boom");
  });
});
