import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyGrokPlan,
  grokPlanFromPayload,
  isSessionPlanPath,
  planIsVisible,
  planModeBlockMessage,
  planModeBlocksTool,
  planModeEngaged,
  planModeSystemLine,
  planOpenByDefault,
  planShowsEmpty,
  planStateAfterDecision,
  planStatus,
  planTextFromMessages,
  planTitle,
  planToolResult,
} from "../plan.ts";

describe("grok plan payload", () => {
  it("reads the CLI session plan", () => {
    const plan = grokPlanFromPayload({
      found: true,
      state: "Active",
      awaiting_approval: false,
      content: "# Ship auth\n\nUse the existing session helper.",
    });
    assert.equal(plan.found, true);
    assert.equal(plan.state, "Active");
    assert.equal(plan.awaitingApproval, false);
    assert.match(plan.content, /Ship auth/);
  });

  it("drops unknown states and missing fields", () => {
    const plan = grokPlanFromPayload({ found: true, state: "nope" });
    assert.equal(plan.state, "Inactive");
    assert.equal(plan.awaitingApproval, false);
    assert.equal(plan.content, "");
    assert.deepEqual(grokPlanFromPayload(null), emptyGrokPlan());
  });
});

describe("plan preview", () => {
  it("hides a session that has no plan", () => {
    assert.equal(planIsVisible(emptyGrokPlan()), false);
    assert.equal(
      planIsVisible({ found: true, state: "Inactive", awaitingApproval: false, content: "  \n" }),
      false,
    );
  });

  it("shows the plan while planning, while waiting for approval, and after it is saved", () => {
    const planning = { found: true, state: "Active" as const, awaitingApproval: false, content: "" };
    const review = { found: true, state: "Inactive" as const, awaitingApproval: true, content: "# Plan" };
    const saved = { found: true, state: "Inactive" as const, awaitingApproval: false, content: "# Plan" };
    assert.equal(planIsVisible(planning), true);
    assert.equal(planIsVisible({ ...planning, state: "Pending" }), true);
    assert.equal(planIsVisible({ ...planning, state: "ExitPending" }), true);
    assert.equal(planIsVisible(review), true);
    assert.equal(planIsVisible(saved), true);
  });

  it("names the approval view and the empty plan", () => {
    const review = { found: true, state: "Active" as const, awaitingApproval: true, content: "# Plan" };
    const writing = { found: true, state: "Active" as const, awaitingApproval: false, content: "" };
    const saved = { found: true, state: "Inactive" as const, awaitingApproval: false, content: "# Plan" };
    assert.equal(planTitle(review), "Review plan");
    assert.equal(planStatus(review), "Waiting for approval");
    assert.equal(planTitle(writing), "Plan");
    assert.equal(planStatus(writing), "Plan mode");
    assert.equal(planShowsEmpty(writing), true);
    assert.equal(planShowsEmpty(saved), false);
    assert.equal(planStatus({ ...writing, state: "Pending" }), "Starts on the next message");
    assert.equal(planStatus({ ...writing, state: "ExitPending" }), "Leaving plan mode");
    assert.equal(planStatus(saved), "");
  });

  it("follows the CLI state machine", () => {
    assert.equal(planModeEngaged("Inactive"), false);
    assert.equal(planModeEngaged("Pending"), true);
    assert.equal(planModeEngaged("Active"), true);
    assert.equal(planModeEngaged("ExitPending"), true);
    assert.equal(planStateAfterDecision("enter", "approve"), "Active");
    assert.equal(planStateAfterDecision("enter", "decline"), "Inactive");
    assert.equal(planStateAfterDecision("exit", "approve"), "Inactive");
    assert.equal(planStateAfterDecision("exit", "quit"), "Inactive");
    assert.equal(planStateAfterDecision("exit", "revise"), "Active");
    assert.match(planToolResult("enter", "approve"), /plan\.md/);
    assert.match(planToolResult("exit", "revise", "use the helper"), /use the helper/);
    assert.match(planToolResult("exit", "quit"), /Do not implement/);
    assert.match(planToolResult("exit", "approve", "# edited"), /# edited/);
    assert.equal(
      planTextFromMessages([
        {
          role: "assistant",
          tool_calls: [{ name: "write_file", arguments: JSON.stringify({ path: "plan.md", contents: "# Plan\n" }) }],
        },
        {
          role: "assistant",
          tool_calls: [{ name: "write_file", arguments: JSON.stringify({ path: "src/lib.ts", contents: "nope" }) }],
        },
      ]),
      "# Plan\n",
    );
  });

  it("blocks workspace edits and allows only the session plan file", () => {
    assert.equal(planModeBlocksTool("write_file"), true);
    assert.equal(planModeBlocksTool("edit_file"), true);
    assert.equal(planModeBlocksTool("read_file"), false);
    assert.equal(planModeBlocksTool("run_command"), false);
    assert.equal(isSessionPlanPath("plan.md"), true);
    assert.equal(isSessionPlanPath("src/plan.md"), true);
    assert.equal(isSessionPlanPath("src/lib.ts"), false);
    assert.match(planModeBlockMessage("src/lib.ts"), /plan\.md/);
    assert.match(planModeSystemLine("Active", "/tmp/plan.md"), /latest request/);
    assert.match(planModeSystemLine("Active"), /write_file to path plan\.md/);
    assert.equal(planModeSystemLine("Inactive", "/tmp/plan.md"), "");
  });

  it("opens while plan mode is on and stays collapsed for a saved plan", () => {
    assert.equal(
      planOpenByDefault({ found: true, state: "Active", awaitingApproval: false, content: "" }),
      true,
    );
    assert.equal(
      planOpenByDefault({ found: true, state: "Inactive", awaitingApproval: true, content: "# Plan" }),
      true,
    );
    assert.equal(
      planOpenByDefault({ found: true, state: "Inactive", awaitingApproval: false, content: "# Plan" }),
      false,
    );
  });
});
