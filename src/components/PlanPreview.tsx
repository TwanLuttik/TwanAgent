import { ChatMarkdown, WorkspaceFileLinks } from "./ChatMarkdown";
import { Symbol } from "./Symbol";
import { planShowsEmpty, planStatus, planTitle, type GrokPlan } from "../lib/plan";

export function PlanPreview({
  plan,
  open,
  workspace,
  onToggle,
}: {
  plan: GrokPlan;
  open: boolean;
  workspace: string;
  onToggle: () => void;
}) {
  const status = planStatus(plan);
  return (
    <section
      className={`flex min-h-0 shrink-0 flex-col border-b border-line/35 bg-canvas ${
        open ? "h-[min(46%,28rem)]" : ""
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex h-8 shrink-0 items-center gap-2 px-3 text-left"
      >
        <Symbol name="doc.fill" className="size-3.5 text-muted" />
        <span className="text-[12px] font-medium text-ink">{planTitle(plan)}</span>
        {status ? <span className="min-w-0 truncate text-[12px] text-muted">{status}</span> : null}
        <Symbol name={open ? "chevron.up" : "chevron.down"} className="ml-auto size-3.5 text-muted" />
      </button>
      {open ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {planShowsEmpty(plan) ? (
            <p className="m-0 text-[13px] text-muted">No plan written yet.</p>
          ) : (
            <WorkspaceFileLinks workspace={workspace}>
              <ChatMarkdown text={plan.content} />
            </WorkspaceFileLinks>
          )}
        </div>
      ) : null}
    </section>
  );
}
