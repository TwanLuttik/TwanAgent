export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/** How long until the compact age label (`now`, `5m`, `2h`) can change. */
export function relativeAgeTickMs(iso: string, nowMs = Date.now()): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 60_000;
  const sec = Math.max(0, Math.floor(Math.max(0, nowMs - then) / 1000));
  if (sec < 60) return Math.max(1000, (60 - sec) * 1000);
  if (sec < 3600) return Math.max(1000, (60 - (sec % 60)) * 1000);
  if (sec < 86_400) return Math.max(1000, (3600 - (sec % 3600)) * 1000);
  return 3_600_000;
}

export function formatRelativeAge(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const delta = Math.max(0, nowMs - then);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const week = Math.floor(day / 7);
  if (day < 30) return `${week}w`;
  const month = Math.floor(day / 30);
  if (day < 365) return `${month}mo`;
  return `${Math.floor(day / 365)}y`;
}
