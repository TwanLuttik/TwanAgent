import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { emptyGrokPlan, grokPlanFromPayload, planIsVisible, planOpenByDefault, type GrokPlan } from "../lib/dev-plan";
import { attachXtermInput } from "../lib/dev-term-io";
import { terminalSessions } from "../lib/dev-terminal-sessions";
import type { TerminalSession } from "../lib/dev-terminal-chat";
import * as api from "../lib/tauri";
import { applyXtermTheme, xtermTheme } from "./DevTerminal";
import { PlanPreview } from "./PlanPreview";

export function GrokTerminal({
  workspace,
  conversationId,
  active,
}: {
  workspace: string;
  conversationId: string;
  active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const written = useRef(0);
  const planHold = useRef(false);
  const sawReview = useRef(false);
  const [plan, setPlan] = useState<GrokPlan>(emptyGrokPlan());
  const [planOpen, setPlanOpen] = useState(false);
  const [session, setSession] = useState<TerminalSession | undefined>(() =>
    terminalSessions.get(conversationId),
  );

  useEffect(() => {
    let stop = false;
    planHold.current = false;
    sawReview.current = false;
    setPlan(emptyGrokPlan());
    setPlanOpen(false);
    async function load() {
      try {
        const next = grokPlanFromPayload(await api.devGrokPlan(workspace, conversationId));
        if (stop) return;
        setPlan(next);
        if (next.awaitingApproval && !sawReview.current) {
          planHold.current = false;
          sawReview.current = true;
        } else if (!next.awaitingApproval) {
          sawReview.current = false;
        }
        if (!planHold.current && planOpenByDefault(next)) setPlanOpen(true);
      } catch {
        if (!stop) setPlan(emptyGrokPlan());
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 800);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [workspace, conversationId]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: xtermTheme(),
      scrollback: 4000,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    written.current = 0;

    let cancelled = false;
    const unsub = terminalSessions.subscribe((ev) => {
      if (ev.type === "data") {
        if (ev.id !== conversationId) return;
        term.write(ev.chunk);
        written.current += ev.chunk.length;
        return;
      }
      if (ev.session.conversationId !== conversationId) return;
      setSession({ ...ev.session });
    });

    attachXtermInput(
      term,
      (data) => {
        const live = terminalSessions.get(conversationId);
        if (live?.ptyId) void api.devPtyWrite(live.ptyId, data);
      },
      (data) => {
        const live = terminalSessions.get(conversationId);
        if (live?.ptyId) void api.devPtyWriteBytes(live.ptyId, data);
      },
    );
    term.onResize(({ cols, rows }) => {
      const live = terminalSessions.get(conversationId);
      if (live?.ptyId) void api.devPtyResize(live.ptyId, cols, rows);
    });

    void (async () => {
      const next = await terminalSessions.attach(conversationId, workspace, term.cols, term.rows);
      if (cancelled) {
        terminalSessions.detach(conversationId);
        return;
      }
      setSession(next);
      if (next.ptyId) void api.devPtyResize(next.ptyId, term.cols, term.rows);
      if (next.buffer.length > written.current) {
        term.write(next.buffer.slice(written.current));
        written.current = next.buffer.length;
      }
    })();

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    });
    ro.observe(el);

    return () => {
      cancelled = true;
      ro.disconnect();
      unsub();
      terminalSessions.detach(conversationId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [workspace, conversationId]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const id = requestAnimationFrame(() => {
      if (host.current && host.current.clientWidth > 0) fit?.fit();
      term?.focus();
      applyXtermTheme(term);
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  async function restart() {
    const term = termRef.current;
    written.current = 0;
    term?.reset();
    const next = await terminalSessions.restart(
      conversationId,
      workspace,
      term?.cols ?? 80,
      term?.rows ?? 24,
    );
    setSession(next);
    if (term && next.buffer.length > written.current) {
      term.write(next.buffer.slice(written.current));
      written.current = next.buffer.length;
    }
  }

  const stopped = session?.phase === "exited" || session?.phase === "error";
  const message =
    session?.phase === "error"
      ? session.error || "Couldn’t start Grok."
      : "Grok exited.";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-panel">
      {planIsVisible(plan) ? (
        <PlanPreview
          plan={plan}
          open={planOpen}
          workspace={workspace}
          onToggle={() => {
            planHold.current = true;
            setPlanOpen((value) => !value);
          }}
        />
      ) : null}
      <div ref={host} className="dev-term min-h-0 flex-1 px-1.5 py-1.5" />
      {stopped ? (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-3 border-t border-line bg-panel/95 px-3 py-2">
          <p className="min-w-0 truncate text-[12px] text-muted">{message}</p>
          <button
            type="button"
            onClick={() => void restart()}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent"
          >
            Restart Grok
          </button>
        </div>
      ) : null}
    </div>
  );
}
