import { useEffect, useState } from "react";
import { linePath } from "../lib/usage";
import { formatPerfBytes, formatPerfCpu, formatPerfFps, pushPerfSample } from "../lib/perf";
import { loadPerfOverlay, subscribePrefs } from "../lib/prefs";
import * as api from "../lib/tauri";

type NativePerf = {
  cpu: number;
  memory: number;
};

const GRAPH_W = 132;
const GRAPH_H = 36;

export function PerformanceOverlay() {
  const [on, setOn] = useState(() => loadPerfOverlay());
  const [fps, setFps] = useState(0);
  const [native, setNative] = useState<NativePerf>({ cpu: 0, memory: 0 });
  const [fpsHist, setFpsHist] = useState<number[]>([]);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);

  useEffect(() => subscribePrefs(() => setOn(loadPerfOverlay())), []);

  useEffect(() => {
    if (!on) return;
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    function tick(now: number) {
      frames += 1;
      if (now - last >= 500) {
        const next = (frames * 1000) / (now - last);
        setFps(next);
        setFpsHist((prev) => pushPerfSample(prev, next));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on]);

  useEffect(() => {
    if (!on) return;
    let gone = false;
    async function pull() {
      try {
        const snap = await api.appPerfSnapshot();
        if (gone) return;
        setNative({ cpu: snap.cpu_percent, memory: snap.memory_bytes });
        setCpuHist((prev) => pushPerfSample(prev, snap.cpu_percent));
        setMemHist((prev) => pushPerfSample(prev, snap.memory_bytes));
      } catch {
        if (!gone) setNative({ cpu: 0, memory: 0 });
      }
    }
    void pull();
    const id = window.setInterval(() => void pull(), 750);
    return () => {
      gone = true;
      window.clearInterval(id);
    };
  }, [on]);

  if (!on) return null;

  return (
    <div
      className="pointer-events-none fixed right-3 bottom-3 z-[80] w-[156px] rounded-md border border-line bg-canvas/85 px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-muted shadow-card backdrop-blur-sm"
      role="status"
      aria-label="Performance"
    >
      <Row label="FPS" value={formatPerfFps(fps)} />
      <Row label="CPU" value={formatPerfCpu(native.cpu)} />
      <Row label="MEM" value={formatPerfBytes(native.memory)} />
      <svg
        className="mt-1.5 block w-full"
        viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
        aria-hidden
      >
        <path d={linePath(fpsHist, GRAPH_W, GRAPH_H, 1)} fill="none" className="stroke-accent" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
        <path d={linePath(cpuHist, GRAPH_W, GRAPH_H, 1)} fill="none" className="stroke-ok" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
        <path d={linePath(memHist, GRAPH_W, GRAPH_H, 1)} fill="none" className="stroke-muted" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex items-center justify-end gap-2 text-[9px] text-muted/70">
        <span className="inline-flex items-center gap-1"><span className="size-1 rounded-full bg-accent" />FPS</span>
        <span className="inline-flex items-center gap-1"><span className="size-1 rounded-full bg-ok" />CPU</span>
        <span className="inline-flex items-center gap-1"><span className="size-1 rounded-full bg-muted" />MEM</span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted/70">{label}</span>
      <span className="tabular-nums text-ink">{value}</span>
    </div>
  );
}
