import { formatBytes } from "./usage.ts";

/** `v1.0.0-beta.2+abc` and `1.0.0-beta.2` are the same release. The build id is not a version. */
export function versionCore(raw: string): string {
  const trimmed = raw.trim().replace(/^[vV]/, "");
  const plus = trimmed.indexOf("+");
  return plus === -1 ? trimmed : trimmed.slice(0, plus);
}

function splitPre(raw: string): { num: number[]; pre: string[] | null } {
  const dash = raw.indexOf("-");
  const head = dash === -1 ? raw : raw.slice(0, dash);
  const pre = dash === -1 ? null : raw.slice(dash + 1).split(".").filter(Boolean);
  const num = head
    .split(".")
    .map((part) => {
      const digits = part.match(/^\d+/)?.[0];
      return digits ? Number(digits) : Number.NaN;
    })
    .filter((part) => Number.isFinite(part));
  return { num, pre: pre && pre.length ? pre : null };
}

function cmpPre(left: string[], right: string[]): number {
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const a = left[i];
    const b = right[i];
    if (a == null) return -1;
    if (b == null) return 1;
    const an = /^\d+$/.test(a) ? Number(a) : null;
    const bn = /^\d+$/.test(b) ? Number(b) : null;
    if (an != null && bn != null && an !== bn) return an < bn ? -1 : 1;
    if (an != null && bn == null) return -1;
    if (an == null && bn != null) return 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** True when `candidate` should replace `current`. A final release beats the same prerelease. */
export function versionIsNewer(candidate: string, current: string): boolean {
  const left = splitPre(versionCore(candidate));
  const right = splitPre(versionCore(current));
  const len = Math.max(left.num.length, right.num.length);
  for (let i = 0; i < len; i++) {
    const a = left.num[i] ?? 0;
    const b = right.num[i] ?? 0;
    if (a !== b) return a > b;
  }
  if (!left.pre && !right.pre) return false;
  if (left.pre && !right.pre) return false;
  if (!left.pre && right.pre) return true;
  return cmpPre(left.pre ?? [], right.pre ?? []) > 0;
}

export function updateButtonLabel(
  phase: "idle" | "checking" | "downloading" | "installing" | "ready" | "error",
  received = 0,
  total = 0,
): string {
  if (phase === "checking") return "Checking…";
  if (phase === "installing") return "Installing…";
  if (phase === "ready") return "Restart";
  if (phase === "downloading") {
    if (total > 0) return `Downloading ${formatBytes(received)}`;
    return "Downloading…";
  }
  return "Update";
}

/** The first paragraph of the release notes, short enough for the sidebar. */
export function updateNote(notes: string): string {
  const line = notes
    .split(/\n+/)
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("#"));
  if (!line) return "";
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}
