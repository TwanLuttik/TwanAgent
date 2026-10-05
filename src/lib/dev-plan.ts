export const PLAN_MODE_STATES = ["Inactive", "Pending", "Active", "ExitPending"] as const;

export type PlanModeState = (typeof PLAN_MODE_STATES)[number];

export type GrokPlan = {
  found: boolean;
  state: PlanModeState;
  awaitingApproval: boolean;
  content: string;
};

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
