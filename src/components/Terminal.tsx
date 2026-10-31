import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { shellSessionId } from "../lib/shell-sessions";
import { shellSessions } from "../lib/shell-terminal";
import { browserFitClock, createPaneFitGate, onPaneFit, paneLayoutMoving } from "../lib/terminal-fit";
import { attachTerminalLinks, attachXtermInput } from "../lib/term-io";
import { openUrl } from "../lib/tauri";

export function Terminal({
  workspace,
  sessionKey,
  active,
}: {
  workspace: string;
  sessionKey: string;
  active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = shellSessionId(workspace, sessionKey);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new XTerm({
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

    let cancelled = false;
    let written = 0;
    const unsub = shellSessions.subscribe((ev) => {
      if (ev.type === "data") {
        if (ev.id !== id) return;
        term.write(ev.chunk);
        written += ev.chunk.length;
        return;
      }
      if (ev.session.id !== id) return;
      setError(ev.session.phase === "error" ? ev.session.error : null);
    });

    attachXtermInput(
      term,
      (data) => shellSessions.write(id, data),
      (data) => shellSessions.writeBytes(id, data),
    );
    const detachLinks = attachTerminalLinks(term, (url) => void openUrl(url));
    term.onResize(({ cols, rows }) => {
      if (!paneIsShown(el)) return;
      shellSessions.resize(id, cols, rows);
    });

    void (async () => {
      const session = await shellSessions.open(id, workspace, term.cols, term.rows);
      if (cancelled) return;
      setError(session.phase === "error" ? session.error : null);
      shellSessions.resize(id, term.cols, term.rows);
      if (session.buffer.length > written) {
        const pending = session.buffer.slice(written);
        term.write(pending);
        written += pending.length;
      }
    })();

    const stopWatch = watchTerminalBox(el, () => fit.fit());

    return () => {
      cancelled = true;
      stopWatch();
      unsub();
      detachLinks();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [workspace, sessionKey, id]);

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
      {error ? <p className="px-3 py-2 text-[12px] text-err">{error}</p> : null}
      <div
        ref={host}
        className="term min-h-0 flex-1 px-1.5"
        onMouseDown={() => termRef.current?.focus()}
      />
    </div>
  );
}

export function paneIsShown(el: HTMLElement): boolean {
  return el.clientWidth > 0 && el.clientHeight > 0 && !el.closest("[inert]");
}

/** Fit on a real size change, and once more when a pane drag or slide ends. */
export function watchTerminalBox(el: HTMLElement, fit: () => void): () => void {
  const gate = createPaneFitGate({
    clock: browserFitClock(),
    moving: () => paneLayoutMoving(el),
    shown: () => paneIsShown(el),
    fit,
  });
  const ro = new ResizeObserver(() => gate.noteResize());
  ro.observe(el);
  const stopFit = onPaneFit(() => gate.settle());
  return () => {
    gate.dispose();
    ro.disconnect();
    stopFit();
  };
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function xtermTheme() {
  return {
    background: cssVar("--color-panel") || "#f5f5f7",
    foreground: cssVar("--color-ink") || "#3f3f42",
    cursor: cssVar("--color-ink") || "#3f3f42",
    cursorAccent: cssVar("--color-panel") || "#f5f5f7",
    selectionBackground: cssVar("--color-select") || "#c8daf5",
    selectionInactiveBackground: cssVar("--color-select") || "#c8daf5",
  };
}

export function applyXtermTheme(term: XTerm | null) {
  if (!term) return;
  term.options.theme = xtermTheme();
}
