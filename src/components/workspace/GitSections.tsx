import type { ReactNode } from "react";
import { gitSectionLabel, type GitSection } from "../../lib/git-sections";
import type { GitBranchPullRequest, GitCommit, GitPullRequestFile } from "../../lib/tauri";
import { relativeCommitTime } from "./gitBits";

export function GitSectionTabs({
  section,
  hasRequest,
  onSelect,
  changesCount = 0,
  trailing,
}: {
  section: GitSection;
  hasRequest: boolean;
  onSelect: (section: GitSection) => void;
  /** Files in the working tree. Shown on Changes so the count is not a second label. */
  changesCount?: number;
  trailing?: ReactNode;
}) {
  const tabs: GitSection[] = hasRequest ? ["changes", "commits", "request"] : ["changes", "commits"];
  return (
    <div className="flex h-9 shrink-0 items-end justify-between gap-2 border-b border-line/30 px-2">
      <div role="tablist" aria-label="Git" className="flex min-w-0 items-center gap-1">
        {tabs.map((id) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(id)}
              className={`-mb-px flex items-center gap-1.5 border-b px-1.5 py-1.5 text-[13px] ${
                active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {gitSectionLabel(id)}
              {id === "changes" && changesCount > 0 ? (
                <span className={`text-[11px] tabular-nums ${active ? "text-muted" : "text-muted/70"}`}>{changesCount}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}

type CommitRow = Pick<GitCommit, "hash" | "short" | "author" | "at" | "subject">;

/** GitHub mobile's commit rows: message, author and time, short hash. */
export function CommitList({
  commits,
  openHash,
  detail,
  onOpen,
  scroll = true,
}: {
  commits: CommitRow[];
  openHash: string | null;
  detail: string | null;
  onOpen: (hash: string) => void;
  /** The commits tab scrolls on its own. A pull request page scrolls as one sheet. */
  scroll?: boolean;
}) {
  if (commits.length === 0) {
    return <p className="px-3 py-3 text-[13px] text-muted">No commits</p>;
  }
  const rows = commits.map((row) => {
        const open = openHash === row.hash;
        const when = relativeCommitTime(row.at);
        const author = row.author.trim() || "Unknown";
        return (
          <div key={row.hash}>
            <button
              type="button"
              onClick={() => onOpen(row.hash)}
              className={`flex w-full items-baseline gap-3 px-3 py-2 text-left ${open ? "bg-wash" : "hover:bg-wash"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-5 text-ink">{row.subject || "Commit"}</span>
                <span className="block truncate text-[12px] text-muted">
                  {author}
                  {when ? ` · ${when}` : ""}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted">{row.short}</span>
            </button>
            {open && detail ? (
              <pre className="mx-3 mb-2.5 max-h-48 overflow-auto rounded-[8px] bg-wash px-2.5 py-2 font-mono text-[10px] leading-snug whitespace-pre-wrap text-ink/80">
                {detail}
              </pre>
            ) : null}
          </div>
        );
      });
  if (!scroll) return <div>{rows}</div>;
  return <div className="min-h-0 flex-1 overflow-auto">{rows}</div>;
}

function statePill(state: string): { label: string; className: string } {
  if (state === "merged") return { label: "Merged", className: "text-accent" };
  if (state === "closed") return { label: "Closed", className: "text-err" };
  if (state === "draft") return { label: "Draft", className: "text-muted" };
  return { label: "Open", className: "text-ok" };
}

function checksLabel(checks: GitBranchPullRequest["checks"]): { text: string; className: string } | null {
  if (checks.fail > 0) {
    const noun = checks.fail === 1 ? "check was" : "checks were";
    return { text: `${checks.fail} ${noun} not successful`, className: "text-err" };
  }
  if (checks.pending > 0) return { text: "Checks pending", className: "text-warn" };
  if (checks.pass > 0) return { text: "All checks passed", className: "text-ok" };
  return null;
}

function reviewLabel(review: string): { text: string; className: string } | null {
  if (review === "approved") return { text: "Approved", className: "text-ok" };
  if (review === "changes") return { text: "Changes requested", className: "text-err" };
  if (review === "review") return { text: "Review required", className: "text-muted" };
  return null;
}

function fileName(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { dir: "", name: path };
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** One pull request, laid out the way GitHub's phone app shows it. */
export function PullRequestView({
  request,
  openHash,
  detail,
  onOpenCommit,
  onOpenUrl,
}: {
  request: GitBranchPullRequest;
  openHash: string | null;
  detail: string | null;
  onOpenCommit: (hash: string) => void;
  onOpenUrl: (url: string) => void;
}) {
  const pill = statePill(request.state);
  const checks = checksLabel(request.checks);
  const review = reviewLabel(request.review);
  const body = request.body.trim();
  return (
    <div className="min-h-0 flex-1 overflow-auto pb-3">
      <div className="px-3 pt-3">
        <div className="flex items-center gap-2">
          <span className={`text-[12px] font-medium ${pill.className}`}>{pill.label}</span>
          <span className="min-w-0 truncate text-[12px] text-muted">
            #{request.number}
            {request.author ? ` · ${request.author}` : ""}
          </span>
        </div>
        <h2 className="mt-1.5 text-[16px] font-semibold leading-snug text-ink">{request.title}</h2>
        {request.head || request.base ? (
          <p className="mt-2 flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-muted">
            {request.head ? (
              <span className="max-w-[10rem] truncate font-mono text-[11px] text-ink">{request.head}</span>
            ) : null}
            <span aria-hidden>→</span>
            {request.base ? (
              <span className="max-w-[10rem] truncate font-mono text-[11px] text-ink">{request.base}</span>
            ) : null}
          </p>
        ) : null}
        <p className="mt-2 flex items-center gap-2 text-[12px] tabular-nums">
          {request.additions > 0 ? <span className="font-medium text-ok">+{request.additions}</span> : null}
          {request.deletions > 0 ? <span className="font-medium text-err">−{request.deletions}</span> : null}
          {request.changed > 0 ? (
            <span className="text-muted">{request.changed === 1 ? "1 file" : `${request.changed} files`}</span>
          ) : null}
        </p>
        {checks ? <p className={`mt-2 text-[13px] font-medium ${checks.className}`}>{checks.text}</p> : null}
        {review ? <p className={`mt-0.5 text-[13px] ${review.className}`}>{review.text}</p> : null}
        {body ? (
          <p className="mt-3 text-[13px] leading-5 whitespace-pre-wrap text-ink/90">{body}</p>
        ) : null}
        {request.url ? (
          <button
            type="button"
            onClick={() => onOpenUrl(request.url)}
            className="mt-3 text-[12px] text-muted hover:text-ink"
          >
            View on GitHub
          </button>
        ) : null}
      </div>
      {request.commits.length ? (
        <section className="mt-4">
          <h3 className="px-3 pb-1 text-[12px] font-semibold text-muted">
            Commits
            <span className="ml-1.5 font-medium tabular-nums">{request.commits.length}</span>
          </h3>
          <CommitList commits={request.commits} openHash={openHash} detail={detail} onOpen={onOpenCommit} scroll={false} />
        </section>
      ) : null}
      {request.files.length ? (
        <section className="mt-1">
          <h3 className="px-3 py-1.5 text-[12px] font-semibold text-muted">Files</h3>
          {request.files.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function FileRow({ file }: { file: GitPullRequestFile }) {
  const { dir, name } = fileName(file.path);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[13px]" title={file.path}>
        {dir ? <span className="text-muted">{dir}</span> : null}
        <span className="text-ink">{name}</span>
      </span>
      {file.additions > 0 ? <span className="shrink-0 font-mono text-[11px] text-ok tabular-nums">+{file.additions}</span> : null}
      {file.deletions > 0 ? <span className="shrink-0 font-mono text-[11px] text-err tabular-nums">−{file.deletions}</span> : null}
    </div>
  );
}
