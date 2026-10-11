import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { clearCommandRun, type CommandRun } from "../lib/command-run";
import { stopCommand } from "../lib/tauri";
import { formatElapsed } from "../lib/relative-time";
import { Symbol } from "./Symbol";
import { paneIsShown, xtermTheme } from "./Terminal";

export function CommandRunPill({ run }: { run: CommandRun }) {
  const [open, setOpen] = useState(true);
  const title = run.label || run.command;

  return (
    <div className="overflow-hidden rounded-xl border border-line/40 bg-panel shadow-card">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide command output" : "Show command output"}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-left hover:bg-wash"
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${run.running ? "animate-pulse bg-ok" : "bg-muted/50"}`}
            aria-hidden
          />
          <Symbol name="terminal" className="size-3 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{title}</span>
          <Elapsed startedAt={run.startedAt} running={run.running} />
          <Symbol name={open ? "chevron.down" : "chevron.up"} className="size-2.5 shrink-0 text-muted" />
        </button>
        {run.background ? (
          <button
            type="button"
            aria-label="Stop background command"
            title="Stop"
            onClick={() => {
              clearCommandRun(run.id);
              void stopCommand(run.id);
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-wash hover:text-ink"
          >
            <Symbol name="stop.fill" className="size-2.5" />
          </button>
        ) : null}
      </div>
      <CommandTerminal run={run} open={open} />
    </div>
  );
}

/**
 * The clock ticks every second. The first reading is the real elapsed time,
 * so a panel that opens after the two-second wait starts at 2s, not 0s.
 */
const Elapsed = memo(function Elapsed({ startedAt, running }: { startedAt: number; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useLayoutEffect(() => {
    setNow(Date.now());
  }, [startedAt]);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  const elapsed = formatElapsed(Math.max(0, now - startedAt));
  return <span className="shrink-0 tabular-nums text-[11px] text-muted/70">{elapsed}</span>;
});

function CommandTerminal({ run, open }: { run: CommandRun; open: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const written = useRef({ id: "", length: 0 });
  const outputRef = useRef(run);
  outputRef.current = run;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new XTerm({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: xtermTheme(),
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    const initial = outputRef.current;
    written.current = { id: initial.id, length: initial.output.length };
    if (initial.output) term.write(initial.output);
    let frame = 0;
    const fitSoon = () => {
      if (frame || !paneIsShown(el)) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (paneIsShown(el)) fit.fit();
      });
    };
    const ro = new ResizeObserver(fitSoon);
    ro.observe(el);
    fitSoon();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      written.current = { id: "", length: 0 };
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const seen = written.current;
    if (seen.id !== run.id || run.output.length < seen.length) {
      term.reset();
      if (run.output) term.write(run.output);
      written.current = { id: run.id, length: run.output.length };
      return;
    }
    const next = run.output.slice(seen.length);
    if (!next) return;
    term.write(next);
    written.current = { id: run.id, length: run.output.length };
  }, [run.id, run.output]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const el = host.current;
      if (el && paneIsShown(el)) fitRef.current?.fit();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
    >
      <div className="min-h-0 overflow-hidden border-t border-line/30">
        <div className="px-3 pt-1.5 font-mono text-[11px] leading-snug text-muted">
          <span className="text-ok">$</span> {run.command}
        </div>
        <div ref={host} className="command-term term px-1.5 pb-1.5" />
      </div>
    </div>
  );
}
