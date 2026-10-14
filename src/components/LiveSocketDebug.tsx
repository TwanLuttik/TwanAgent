import { useEffect, useRef, useState } from "react";
import { loadLiveSocketDebug, subscribePrefs } from "../lib/prefs";
import {
  liveSocketRow,
  pushLiveSocketRow,
  type LiveSocketRow,
} from "../lib/live-socket-debug";
import * as api from "../lib/tauri";

export function LiveSocketDebug() {
  const [on, setOn] = useState(() => loadLiveSocketDebug());
  const [rows, setRows] = useState<LiveSocketRow[]>([]);
  const [open, setOpen] = useState(true);
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => subscribePrefs(() => setOn(loadLiveSocketDebug())), []);

  useEffect(() => {
    if (!on) return;
    let gone = false;
    let unlisten: (() => void) | undefined;
    void api
      .onLiveSocket((event) => {
        if (gone) return;
        const id = nextId.current;
        nextId.current += 1;
        setRows((prev) => pushLiveSocketRow(prev, liveSocketRow(event, id)));
      })
      .then((stop) => {
        if (gone) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [on]);

  useEffect(() => {
    if (!on || !open || !stick.current) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows, on, open]);

  if (!on) return null;

  return (
    <aside
      className="pointer-events-auto fixed right-3 bottom-3 z-[70] flex w-[420px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-line bg-canvas/95 font-mono text-[11px] text-ink shadow-card backdrop-blur-sm"
      role="dialog"
      aria-label="Live socket"
    >
      <header className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">Live socket</span>
        <span className="tabular-nums text-muted">{rows.length}</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-muted hover:bg-wash hover:text-ink"
          onClick={() => setRows([])}
        >
          Clear
        </button>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-muted hover:bg-wash hover:text-ink"
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "Hide" : "Show"}
        </button>
      </header>
      {open ? (
        <div
          ref={scroller}
          className="max-h-[320px] min-h-[160px] overflow-auto px-2 py-1.5"
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {rows.length === 0 ? (
            <p className="m-0 text-muted">Waiting for a cloud chat to join the live socket.</p>
          ) : (
            rows.map((row) => (
              <div key={row.id} className="border-b border-line/60 py-1.5 last:border-b-0">
                <div className="flex items-baseline gap-2 text-muted">
                  <span className="tabular-nums">{row.at}</span>
                  <span className={row.direction === "out" ? "text-accent" : "text-ok"}>
                    {row.direction === "out" ? "out" : "in"}
                  </span>
                  <span className="text-ink">{row.kind}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {row.conversationId || "—"} · :{row.port}
                  </span>
                </div>
                <pre className="m-0 mt-0.5 overflow-x-auto whitespace-pre-wrap break-all text-ink/90">{row.text}</pre>
              </div>
            ))
          )}
        </div>
      ) : null}
    </aside>
  );
}
