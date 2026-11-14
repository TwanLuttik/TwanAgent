import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { afterInput } from "../lib/after-input";
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
  const activeRef = useRef(active);
  activeRef.current = active;
  const [error, setError] = useState<string | null>(null);
  const id = shellSessionId(workspace, sessionKey);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let term: XTerm | null = null;
    let stopWatch: (() => void) | null = null;
    let unsub: (() => void) | null = null;
    let detachLinks: (() => void) | null = null;
    // Opening xterm builds a canvas on the main thread. Wait until a click on
    // the conversation can land first. Cancel keeps a fast project switch from
    // constructing a shell for the folder we already left.
    const cancelIdle = afterInput(() => {
      if (cancelled || !host.current) return;
      const node = host.current;
      const created = new XTerm({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        theme: xtermTheme(),
        scrollback: 4000,
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
      });
      term = created;
      const fit = new FitAddon();
      created.loadAddon(fit);
      created.open(node);
      fit.fit();
      termRef.current = created;
      fitRef.current = fit;

      let written = 0;
      unsub = shellSessions.subscribe((ev) => {
        if (ev.type === "data") {
          if (ev.id !== id) return;
          created.write(ev.chunk);
          written += ev.chunk.length;
          return;
        }
        if (ev.session.id !== id) return;
        setError(ev.session.phase === "error" ? ev.session.error : null);
      });

      attachXtermInput(
        created,
        (data) => shellSessions.write(id, data),
        (data) => shellSessions.writeBytes(id, data),
      );
      detachLinks = attachTerminalLinks(created, (url) => void openUrl(url));
      created.onResize(({ cols, rows }) => {
        if (!paneIsShown(node)) return;
        shellSessions.resize(id, cols, rows);
      });

      void (async () => {
        const session = await shellSessions.open(id, workspace, created.cols, created.rows);
        if (cancelled) return;
        setError(session.phase === "error" ? session.error : null);
        shellSessions.resize(id, created.cols, created.rows);
        if (session.buffer.length > written) {
          const pending = session.buffer.slice(written);
          created.write(pending);
          written += pending.length;
        }
      })();

      stopWatch = watchTerminalBox(node, () => fit.fit());
      if (activeRef.current) created.focus();
    });

    return () => {
      cancelled = true;
      cancelIdle();
      stopWatch?.();
      unsub?.();
      detachLinks?.();
      term?.dispose();
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

/** xterm knocks an opaque selection color down to 30%. An alpha keeps the accent visible. */
function accentFill(alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(cssVar("--color-accent"));
  const value = hex ? parseInt(hex[1], 16) : 0x007aff;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function xtermTheme() {
  return {
    background: cssVar("--color-panel") || "#f5f5f7",
    foreground: cssVar("--color-ink") || "#3f3f42",
    cursor: cssVar("--color-ink") || "#3f3f42",
    cursorAccent: cssVar("--color-panel") || "#f5f5f7",
    selectionBackground: accentFill(0.85),
    selectionInactiveBackground: accentFill(0.55),
    selectionForeground: cssVar("--color-on-accent") || "#ffffff",
  };
}

export function applyXtermTheme(term: XTerm | null) {
  if (!term) return;
  term.options.theme = xtermTheme();
}
