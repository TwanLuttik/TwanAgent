export type GitSection = "changes" | "commits" | "request";

/** Pull request is a tab only while this branch has one. */
export function gitSectionTabs(hasRequest: boolean): GitSection[] {
  return hasRequest ? ["changes", "commits", "request"] : ["changes", "commits"];
}

/** Leave the pull request tab when the branch no longer has one. */
export function gitSectionAfterLoad(current: GitSection, hasRequest: boolean): GitSection {
  if (current === "request" && !hasRequest) return "changes";
  return current;
}

export function gitSectionLabel(section: GitSection): string {
  if (section === "commits") return "Commits";
  if (section === "request") return "Pull request";
  return "Changes";
}
