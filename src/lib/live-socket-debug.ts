import type { LiveSocketEvent } from "./tauri.ts";

export const LIVE_SOCKET_LOG_MAX = 200;

export type LiveSocketRow = {
  id: number;
  at: string;
  direction: string;
  conversationId: string;
  port: number;
  kind: string;
  text: string;
};

export function liveSocketRow(event: LiveSocketEvent, id: number, at = new Date()): LiveSocketRow {
  const text = event.text ?? "";
  return {
    id,
    at: formatLiveSocketTime(at),
    direction: event.direction || "in",
    conversationId: event.conversation_id || "",
    port: event.port || 0,
    kind: liveSocketKind(text),
    text,
  };
}

export function pushLiveSocketRow(rows: LiveSocketRow[], row: LiveSocketRow, max = LIVE_SOCKET_LOG_MAX): LiveSocketRow[] {
  const next = rows.length >= max ? rows.slice(rows.length - max + 1) : rows.slice();
  next.push(row);
  return next;
}

export function formatLiveSocketTime(at: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

export function liveSocketKind(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return "text";
  try {
    const value = JSON.parse(trimmed) as { type?: unknown };
    return typeof value.type === "string" && value.type ? value.type : "json";
  } catch {
    return "text";
  }
}
