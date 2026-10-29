export const PLAN_MODE_STATES = ["Inactive", "Pending", "Active", "ExitPending"] as const;

export type PlanModeState = (typeof PLAN_MODE_STATES)[number];

/** Grok CLI plan tools. Offered only on Grok chats, never on Claude. */
export const PLAN_TOOL_NAMES = ["enter_plan_mode", "exit_plan_mode"] as const;

export type PlanToolName = (typeof PLAN_TOOL_NAMES)[number];

export type GrokPlan = {
  found: boolean;
  state: PlanModeState;
  awaitingApproval: boolean;
  content: string;
};

/** What the user decided on a plan-mode prompt. */
export type PlanDecision = "approve" | "decline" | "revise" | "quit";

export type PlanPrompt =
  | { kind: "enter" }
  | { kind: "exit"; content: string };

export function emptyGrokPlan(): GrokPlan {
  return { found: false, state: "Inactive", awaitingApproval: false, content: "" };
}

export function parsePlanModeState(raw: unknown): PlanModeState {
  if (raw === "Pending" || raw === "Active" || raw === "ExitPending" || raw === "Inactive") return raw;
  return "Inactive";
}

export function grokPlanFromPayload(raw: unknown): GrokPlan {
  if (!raw || typeof raw !== "object") return emptyGrokPlan();
  const row = raw as Record<string, unknown>;
  return {
    found: row.found === true,
    state: parsePlanModeState(row.state),
    awaitingApproval: row.awaiting_approval === true || row.awaitingApproval === true,
    content: typeof row.content === "string" ? row.content : "",
  };
}

export function planIsVisible(plan: GrokPlan): boolean {
  if (!plan.found) return false;
  if (plan.awaitingApproval || plan.state !== "Inactive") return true;
  return plan.content.trim().length > 0;
}

export function planTitle(plan: GrokPlan): string {
  return plan.awaitingApproval ? "Review plan" : "Plan";
}

export function planStatus(plan: GrokPlan): string {
  if (plan.awaitingApproval) return "Waiting for approval";
  if (plan.state === "Active") return "Plan mode";
  if (plan.state === "Pending") return "Starts on the next message";
  if (plan.state === "ExitPending") return "Leaving plan mode";
  return "";
}

export function planShowsEmpty(plan: GrokPlan): boolean {
  return planIsVisible(plan) && plan.content.trim().length === 0;
}

export function planOpenByDefault(plan: GrokPlan): boolean {
  return plan.awaitingApproval || plan.state !== "Inactive";
}

export function isPlanTool(name: string): name is PlanToolName {
  return name === "enter_plan_mode" || name === "exit_plan_mode";
}

/** Plan mode is on for this turn. Pending waits for the prompt that is running now. */
export function planModeEngaged(state: PlanModeState): boolean {
  return state === "Active" || state === "Pending" || state === "ExitPending";
}

/**
 * The only file plan mode may change. Same rule as the Grok CLI: `plan.md`
 * inside the session directory, never a workspace file.
 */
export function isSessionPlanPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "plan.md" || normalized.endsWith("/plan.md");
}

/** Workspace edits are rejected while planning. The session plan file is not one of these tools. */
export function planModeBlocksTool(name: string): boolean {
  return name === "write_file" || name === "edit_file";
}

export function planModeBlockMessage(path = ""): string {
  const target = path.trim();
  const where = target ? ` (${target})` : "";
  return `Error: plan mode only allows edits to the session plan file plan.md${where}. Other files stay unchanged until the plan is approved.`;
}

/** Next state after the user answers. Mirrors the CLI state machine. */
export function planStateAfterDecision(kind: PlanPrompt["kind"], decision: PlanDecision): PlanModeState {
  if (kind === "enter") return decision === "approve" ? "Active" : "Inactive";
  if (decision === "approve" || decision === "quit") return "Inactive";
  return "Active";
}

/** Tool result the model reads after the user answers. */
export function planToolResult(kind: PlanPrompt["kind"], decision: PlanDecision, note = ""): string {
  const extra = note.trim();
  if (kind === "enter") {
    if (decision === "approve") {
      return "Plan mode is active. Explore and write the plan with write_file to path plan.md. Do not edit other files. Call exit_plan_mode when the plan is ready.";
    }
    return "The user declined plan mode. Stay in normal mode and continue the task.";
  }
  if (decision === "approve") {
    const edited = extra ? `\nThe user edited the plan. Implement this version:\n${extra}` : "";
    return `The user approved the plan. Plan mode is off. Implement the plan.${edited}`;
  }
  if (decision === "quit") {
    return "The user quit the plan. Plan mode is off. Do not implement it.";
  }
  return extra
    ? `The user wants changes. Plan mode stays active. Revise plan.md to address:\n${extra}`
    : "The user wants changes. Plan mode stays active. Revise plan.md.";
}

/** The plan text the model wrote in this turn, when it used write_file on plan.md. */
export function planTextFromMessages(messages: { role: string; tool_calls?: { name: string; arguments: string }[] }[]): string {
  let found = "";
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (call.name !== "write_file" && call.name !== "edit_file") continue;
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments || "{}") as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!isSessionPlanPath(String(args.path ?? ""))) continue;
      if (call.name === "write_file") found = String(args.contents ?? "");
      else if (found) {
        const old = String(args.old_string ?? args.oldString ?? "");
        const next = String(args.new_string ?? args.newString ?? "");
        if (old && found.includes(old)) found = found.replace(old, next);
      }
    }
  }
  return found;
}

/** Reminder added to the system prompt while a Grok chat is planning. */
export function planModeSystemLine(state: PlanModeState, _planPath = ""): string {
  if (!planModeEngaged(state)) return "";
  const asked =
    state === "Active"
      ? "The user turned plan mode on for this message. Write the plan for their latest request."
      : "Plan mode is on.";
  return `${asked} You may explore this folder. Write the whole plan with write_file to path plan.md, which is the session plan and not a project file. Edits to any other file are rejected. Shell commands are not a way around that. Call exit_plan_mode when plan.md is written. Do not implement until the user approves it.`;
}
