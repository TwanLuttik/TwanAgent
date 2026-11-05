export type ChatPullRequest = { number: number; open: boolean };

/** Where a sidebar chat lives. The branch is the worktree's branch when this folder is one. */
export type ChatPlace = {
  branch: string;
  worktree: boolean;
  server: boolean;
  /** Machine name, or the host when the machine has no name yet. */
  serverName?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  pr: ChatPullRequest | null;
};

/** The name to show for a project that runs on a server. */
export function serverDisplayName(server?: { machineName?: string; host?: string } | null): string {
  return server?.machineName?.trim() || server?.host?.trim() || "";
}

/** Label for the server mark. Empty when this chat is local. */
export function serverMarkLabel(place: Pick<ChatPlace, "server" | "serverName">): string {
  if (!place.server) return "";
  return place.serverName?.trim() || "Server";
}

function gitTracking(place: Pick<ChatPlace, "ahead" | "behind">): string {
  return [place.ahead ? `↑${place.ahead}` : "", place.behind ? `↓${place.behind}` : ""].filter(Boolean).join(" ");
}

/** One line under the chat title: branch, pull request, then Local or the server name. */
export function chatFooterLabel(place: ChatPlace): string {
  const branch = [place.branch.trim(), gitTracking(place)].filter(Boolean).join(" ");
  const pr = place.pr
    ? place.pr.open
      ? `#${place.pr.number}`
      : `#${place.pr.number} closed`
    : "";
  return [branch, pr, place.server ? serverMarkLabel(place) : "Local"].filter(Boolean).join(" · ");
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
