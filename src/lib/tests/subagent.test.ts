import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySubagentEvent,
  applySubagentToChat,
  childCanUseTool,
  emptySubagent,
  parseSpawnArgs,
  parseSubagentType,
  subagentsForChat,
  subagentSystemPrompt,
  subagentTranscript,
  summarizeSubagent,
  toggleSubagentExpanded,
} from "../subagent.ts";

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

  it("never lets a child update journey knowledge", () => {
    assert.equal(childCanUseTool("general-purpose", "update_journey_knowledge"), false);
    assert.equal(childCanUseTool("explore", "update_journey_knowledge"), false);
  });

  it("never lets a child write parent todos", () => {
    assert.equal(childCanUseTool("general-purpose", "todo_write"), false);
    assert.equal(childCanUseTool("explore", "todo_write"), false);
    assert.equal(childCanUseTool("plan", "todo_write"), false);
  });

  it("blocks file edits for explore and plan", () => {
    assert.equal(childCanUseTool("explore", "read_file"), true);
    assert.equal(childCanUseTool("explore", "write_file"), false);
    assert.equal(childCanUseTool("plan", "edit_file"), false);
    assert.equal(childCanUseTool("general-purpose", "edit_file"), true);
  });

  it("blocks shell commands for explore and plan", () => {
    assert.equal(childCanUseTool("explore", "run_command"), false);
    assert.equal(childCanUseTool("plan", "run_command"), false);
    assert.equal(childCanUseTool("general-purpose", "run_command"), true);
    assert.equal(childCanUseTool("explore", "list_dir"), true);
    assert.equal(childCanUseTool("explore", "web_search"), true);
    assert.equal(childCanUseTool("plan", "web_search"), true);
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

  it("includes journey knowledge when provided", () => {
    assert.match(
      String(subagentSystemPrompt("/tmp/app", "explore", "Find parser", "ask", "- voice is casual").content),
      /Journey knowledge:[\s\S]*voice is casual/,
    );
    assert.doesNotMatch(
      String(subagentSystemPrompt("/tmp/app", "explore", "Find parser").content),
      /Journey knowledge:/,
    );
  });

  it("names the parent model and does not claim only Grok exists", () => {
    assert.match(
      String(subagentSystemPrompt("/tmp/app", "explore", "Find parser", "ask", undefined, "claude-opus-4-8").content),
      /You are Claude \(claude-opus-4-8\), a explore subagent/,
    );
    assert.match(
      String(subagentSystemPrompt("/tmp/app", "plan", "Write a plan", "ask", undefined, "grok-4.6").content),
      /You are Grok \(grok-4\.6\), a plan subagent/,
    );
    assert.match(
      String(subagentSystemPrompt("/tmp/app", "explore", "Find parser").content),
      /You are a explore subagent/,
    );
    assert.doesNotMatch(
      String(subagentSystemPrompt("/tmp/app", "explore", "Find parser", "ask", undefined, "grok-4.6").content),
      /Only Grok is available/,
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

describe("subagentTranscript", () => {
  const start = emptySubagent({
    id: "s1",
    description: "Analyze current code",
    type: "explore",
    prompt: "Analyze",
  });

  it("shows live stream tokens", () => {
    let rows = applySubagentEvent([], { type: "start", record: start });
    rows = applySubagentEvent(rows, { type: "delta", id: "s1", text: "Looking at " });
    rows = applySubagentEvent(rows, { type: "delta", id: "s1", text: "src/" });
    assert.deepEqual(subagentTranscript(rows[0]), ["Looking at src/"]);
  });

  it("keeps committed assistant text after an update clears the live stream", () => {
    let rows = applySubagentEvent([], { type: "start", record: start });
    rows = applySubagentEvent(rows, { type: "delta", id: "s1", text: "Found the parser." });
    rows = applySubagentEvent(rows, {
      type: "update",
      id: "s1",
      messages: [
        { role: "user", content: "Analyze" },
        { role: "assistant", content: "Found the parser." },
      ],
    });
    assert.equal(rows[0].streamText, "");
    assert.equal(rows[0].streamReasoning, "");
    assert.deepEqual(subagentTranscript(rows[0]), ["Found the parser."]);
  });

  it("keeps thinking after the live stream is cleared", () => {
    let rows = applySubagentEvent([], { type: "start", record: start });
    rows = applySubagentEvent(rows, { type: "reasoning", id: "s1", text: "Check the join rule." });
    rows = applySubagentEvent(rows, {
      type: "update",
      id: "s1",
      messages: [
        { role: "user", content: "Analyze" },
        { role: "assistant", content: "Found the parser.", reasoning: "Check the join rule." },
      ],
    });
    assert.equal(rows[0].streamReasoning, "");
    assert.deepEqual(subagentTranscript(rows[0]), ["Check the join rule.", "Found the parser."]);
  });

  it("appends a new stream after earlier assistant messages", () => {
    const agent = {
      ...start,
      messages: [{ role: "assistant", content: "Read the file." }],
      streamText: "Now checking tests.",
    };
    assert.deepEqual(subagentTranscript(agent), ["Read the file.", "Now checking tests."]);
  });

  it("falls back to the summary when nothing else is present", () => {
    assert.deepEqual(subagentTranscript({ ...start, summary: "All clear." }), ["All clear."]);
    assert.deepEqual(subagentTranscript(start), []);
  });
});

describe("subagents per conversation", () => {
  const start = emptySubagent({
    id: "s1",
    description: "Explore theme surfaces",
    type: "explore",
    prompt: "Look at the theme",
  });

  it("keeps agents and open state on the conversation that owns them", () => {
    const byChat = new Map();
    const shown = applySubagentToChat(byChat, "chat-a", { type: "start", record: start });
    assert.equal(shown.agents.length, 1);
    assert.equal(shown.expanded.s1, true);
    assert.deepEqual(subagentsForChat(byChat, "chat-b"), { agents: [], expanded: {} });

    const collapsed = toggleSubagentExpanded(byChat, "chat-a", "s1");
    assert.equal(collapsed.expanded.s1, false);
    assert.equal(subagentsForChat(byChat, "chat-a").expanded.s1, false);
    assert.equal(subagentsForChat(byChat, "chat-b").agents.length, 0);

    const other = emptySubagent({ id: "s2", description: "Other", type: "plan", prompt: "Plan" });
    applySubagentToChat(byChat, "chat-b", { type: "start", record: other });
    assert.equal(subagentsForChat(byChat, "chat-a").agents[0].id, "s1");
    assert.equal(subagentsForChat(byChat, "chat-a").expanded.s1, false);
    assert.equal(subagentsForChat(byChat, "chat-b").agents[0].id, "s2");
    assert.equal(subagentsForChat(byChat, "chat-b").expanded.s2, true);
  });
});
