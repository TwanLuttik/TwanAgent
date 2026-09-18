import { fileIconKind } from "./file-icon.ts";

const FENCED_BLOCK = /^```[\s\S]*?^```/gm;
const INLINE_CODE = /`([^`\n]+)`/g;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXT = /\.[a-zA-Z0-9]{1,12}$/;

export function normalizeWorkspacePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function looksLikeWorkspacePath(value: string): boolean {
  const path = normalizeWorkspacePath(value);
  if (!path || path.length > 260) return false;
  if (path.includes("://")) return false;
  if (SCHEME.test(path) && !WINDOWS_DRIVE.test(path)) return false;
  if (/\s/.test(path) && !path.includes("/")) return false;
  if (path.includes("/")) return path.split("/").every((part) => part.length > 0);
  if (path.startsWith(".")) return true;
  if (fileIconKind(path) !== "doc") return true;
  return EXT.test(path);
}

export function inlineCodeValues(text: string): string[] {
  const withoutFences = text.replace(FENCED_BLOCK, "");
  const values: string[] = [];
  for (const match of withoutFences.matchAll(INLINE_CODE)) {
    const value = match[1]?.trim();
    if (value) values.push(value);
  }
  return values;
}
