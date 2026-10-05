import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { attachXtermInput } from "../lib/dev-term-io";
import * as api from "../lib/tauri";

export function DevTerminal({
  workspace,
  sessionKey,
  active,
}: {
  workspace: string;
  sessionKey: string;
  active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    let cancelled = false;
    let ptyId: string | null = null;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const id = await api.devPtyOpen(workspace, term.cols, term.rows);
        if (cancelled) {
          await api.devPtyKill(id);
          return;
        }
        ptyId = id;
        unlisten = await api.onDevPty((ev) => {
          if (ev.id !== id) return;
          if (ev.kind === "data" && ev.data) term.write(ev.data);
          if (ev.kind === "exit") term.write("\r\n[process exited]\r\n");
        });
        if (cancelled) {
          unlisten();
          return;
        }
        attachXtermInput(
          term,
          (data) => {
            void api.devPtyWrite(id, data);
          },
          (data) => {
            void api.devPtyWriteBytes(id, data);
          },
        );
        term.onResize(({ cols, rows }) => {
          void api.devPtyResize(id, cols, rows);
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    });
    ro.observe(el);

    return () => {
      cancelled = true;
      ro.disconnect();
      unlisten?.();
      if (ptyId) void api.devPtyKill(ptyId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [workspace, sessionKey]);

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
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      {error ? <p className="px-3 py-2 text-[12px] text-err">{error}</p> : null}
      <div
        ref={host}
        className="dev-term min-h-0 flex-1 px-1.5 py-1.5"
        onMouseDown={() => termRef.current?.focus()}
      />
    </div>
  );
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
  };
}

export function applyXtermTheme(term: Terminal | null) {
  if (!term) return;
  term.options.theme = xtermTheme();
}
