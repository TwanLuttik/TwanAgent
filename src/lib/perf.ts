export function formatPerfBytes(n: number): string {
  const value = Math.max(0, n);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${Math.round(value / (1024 * 1024))} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatPerfCpu(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, n) : 0;
  return `${value.toFixed(1)}%`;
}

export const PERF_SAMPLE_WINDOW = 40;

export function pushPerfSample(samples: number[], value: number, max = PERF_SAMPLE_WINDOW): number[] {
  const next = samples.length >= max ? samples.slice(samples.length - max + 1) : samples.slice();
  next.push(Number.isFinite(value) ? Math.max(0, value) : 0);
  return next;
}

export function formatPerfFps(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, n) : 0;
  return String(Math.round(value));
}
