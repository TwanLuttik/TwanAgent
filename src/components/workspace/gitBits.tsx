export function GitLineStats({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions <= 0 && deletions <= 0) return null;
  const parts = [
    additions > 0 ? `+${additions}` : "",
    deletions > 0 ? `-${deletions}` : "",
  ].filter(Boolean);
  return (
    <span
      className="flex shrink-0 items-baseline gap-1 font-mono text-[10px] leading-none tabular-nums"
      title={parts.join(" ")}
    >
      {additions > 0 ? <span className="text-ok">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-err">-{deletions}</span> : null}
    </span>
  );
}

export function relativeCommitTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}

export function statusMark(status: string): string {
  if (status === "added" || status === "untracked") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  if (status === "conflict") return "!";
  return "M";
}

export function statusChip(status: string): string {
  if (status === "added" || status === "untracked") return "bg-ok/15 text-ok";
  if (status === "deleted" || status === "conflict") return "bg-err/15 text-err";
  if (status === "renamed") return "bg-accent/15 text-accent";
  return "bg-warn/15 text-warn";
}
