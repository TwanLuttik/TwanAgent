import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChatMarkdown } from "./ChatMarkdown";
import { Symbol } from "./Symbol";
import type { PlanDecision, PlanPrompt } from "../lib/plan";

export function PlanApproval({
  prompt,
  onAnswer,
}: {
  prompt: PlanPrompt;
  workspace: string;
  onAnswer: (decision: PlanDecision, note?: string) => void;
}) {
  const reviewing = prompt.kind === "exit";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(reviewing ? prompt.content : "");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!reviewing) return;
    setDraft(prompt.content);
    setEditing(false);
  }, [reviewing, prompt.kind === "exit" ? prompt.content : ""]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && reviewing) {
        event.preventDefault();
        onAnswer("quit");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAnswer, reviewing]);

  if (typeof document === "undefined") return null;
  const body = reviewing ? (editing ? draft : prompt.content) : "";
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 px-6 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={reviewing ? "Review plan" : "Enter plan mode"}
        className="flex max-h-full w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-card"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line/40 px-4">
          <Symbol name="doc.fill" className="size-3.5 text-muted" />
          <span className="text-[13px] font-medium">{reviewing ? "Review plan" : "Enter plan mode?"}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
            {reviewing ? "Nothing is edited until you approve." : "Grok will only write the plan until you approve it."}
          </span>
          {reviewing ? (
            <button
              type="button"
              onClick={() => setEditing((value) => !value)}
              className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-wash hover:text-ink"
            >
              {editing ? "Preview" : "Edit"}
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          {!reviewing ? (
            <p className="m-0 text-[14px] leading-relaxed text-ink/85">
              Plan mode explores this folder and writes a plan. Code changes wait until you approve that plan.
            </p>
          ) : editing ? (
            <textarea
              value={draft}
              aria-label="Edit plan"
              onChange={(event) => setDraft(event.target.value)}
              className="block min-h-80 w-full resize-y bg-transparent font-mono text-[13px] leading-relaxed outline-none"
            />
          ) : body.trim() ? (
            <ChatMarkdown text={body} />
          ) : (
            <p className="m-0 text-[13px] text-muted">No plan written yet.</p>
          )}
        </div>
        <div className="shrink-0 border-t border-line/40 px-4 py-3">
          {reviewing ? (
            <form
              className="mb-3 flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!note.trim()) return;
                onAnswer("revise", note.trim());
              }}
            >
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (note.trim()) onAnswer("revise", note.trim());
                  }
                }}
                rows={2}
                placeholder="Suggest a change"
                className="block min-w-0 flex-1 resize-none rounded-md border border-line/50 bg-panel px-2.5 py-1.5 text-[13px] outline-none"
              />
              <button
                type="submit"
                disabled={!note.trim()}
                className="rounded-md border border-line px-2.5 py-1.5 text-[12px] disabled:opacity-40"
              >
                Send
              </button>
            </form>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent"
              onClick={() => onAnswer("approve", reviewing && draft !== prompt.content ? draft : "")}
            >
              {reviewing ? "Approve" : "Enter plan mode"}
            </button>
            {reviewing ? (
              <button
                type="button"
                className="rounded-md border border-line px-3 py-1.5 text-[12px] text-muted"
                onClick={() => onAnswer("quit")}
              >
                Quit plan
              </button>
            ) : (
              <button
                type="button"
                className="rounded-md border border-line px-3 py-1.5 text-[12px]"
                onClick={() => onAnswer("decline")}
              >
                Not now
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
