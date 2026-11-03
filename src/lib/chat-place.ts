export type ChatPullRequest = { number: number; open: boolean };

/** Where a sidebar chat lives. The branch is the worktree's branch when this folder is one. */
export type ChatPlace = {
  branch: string;
  worktree: boolean;
  server: boolean;
  ahead?: number;
  behind?: number;
  dirty?: number;
  pr: ChatPullRequest | null;
};

function gitTracking(place: Pick<ChatPlace, "ahead" | "behind">): string {
  return [place.ahead ? `↑${place.ahead}` : "", place.behind ? `↓${place.behind}` : ""].filter(Boolean).join(" ");
}

/** One line under the chat title: branch, pull request, then Local or Server. */
export function chatFooterLabel(place: ChatPlace): string {
  const branch = [place.branch.trim(), gitTracking(place)].filter(Boolean).join(" ");
  const pr = place.pr
    ? place.pr.open
      ? `#${place.pr.number}`
      : `#${place.pr.number} closed`
    : "";
  return [branch, pr, place.server ? "Server" : "Local"].filter(Boolean).join(" · ");
}

/** The pull request whose head is this checkout. Missing when the branch has none. */
export function pullRequestForBranch(
  requests: { number: number; branch: string; open?: boolean }[],
  branch: string,
): ChatPullRequest | null {
  const name = branch.trim();
  if (!name) return null;
  const match = requests.find((row) => row.number > 0 && row.branch.trim() === name);
  if (!match) return null;
  return { number: match.number, open: match.open !== false };
}
