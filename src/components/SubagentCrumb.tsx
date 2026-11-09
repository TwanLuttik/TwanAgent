import { useSyncExternalStore } from "react";
import { subagentParentId, subscribeSubagentParents } from "../lib/subagent-parent";
import { Symbol } from "./Symbol";

export function useSubagentParentId(childId: string): string {
  return useSyncExternalStore(
    subscribeSubagentParents,
    () => subagentParentId(childId),
    () => "",
  );
}

/** Shows this chat was spawned from another conversation. The parent title opens that chat. */
export function SubagentCrumb({
  parentTitle,
  title,
  onOpenParent,
}: {
  parentTitle: string;
  title: string;
  onOpenParent: () => void;
}) {
  const parent = parentTitle.trim() || "Chat";
  const here = title.trim() || "Subagent";
  return (
    <nav aria-label="Subagent" className="pointer-events-auto flex min-w-0 items-center gap-1.5 py-2 text-[12px] leading-4">
      <button
        type="button"
        onClick={onOpenParent}
        className="max-w-[46%] cursor-pointer truncate text-muted hover:text-ink"
        title={parent}
      >
        {parent}
      </button>
      <Symbol name="chevron.right" className="size-3 shrink-0 text-muted/60" />
      <span className="min-w-0 truncate text-ink" title={here}>
        <span className="text-muted">Subagent</span>
        <span className="mx-1.5 text-muted/45">·</span>
        {here}
      </span>
    </nav>
  );
}
