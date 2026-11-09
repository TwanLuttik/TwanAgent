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

export type UpdatePhase = "checking" | "idle" | "downloading" | "installing" | "ready" | "error";

export function updateButtonLabel(phase: UpdatePhase, received = 0, total = 0): string {
  if (phase === "checking") return "Checking…";
  if (phase === "installing") return "Installing…";
  if (phase === "ready") return "Restart";
  if (phase === "error") return "Retry";
  if (phase === "downloading") {
    if (total > 0) return `Downloading ${formatBytes(received)}`;
    return "Downloading…";
  }
  return "Update";
}

/** Subtitle while bytes are moving. `Downloading 9.54 MB of 19.1 MB`. */
export function updateProgressLabel(received: number, total: number): string {
  if (total > 0) return `Downloading ${formatBytes(received)} of ${formatBytes(total)}`;
  return "Downloading…";
}

/** The one line under the version: notes, progress, or the failure. */
export function updateDetail(
  phase: UpdatePhase,
  notes: string,
  received: number,
  total: number,
  error: string | null,
): string {
  if (phase === "downloading") return updateProgressLabel(received, total);
  if (phase === "installing") return "Installing…";
  if (phase === "ready") return "Restart to open it.";
  if (phase === "error") return error?.trim() || "Update failed.";
  return updateNote(notes);
}

/** Title and the quiet line under it. The title is the status, not the version number. */
export function updateCopy(
  phase: UpdatePhase,
  version: string,
  notes: string,
  received: number,
  total: number,
  error: string | null,
): { title: string; detail: string } {
  const ver = versionCore(version);
  if (phase === "downloading") {
    return { title: "Downloading", detail: total > 0 ? `${formatBytes(received)} of ${formatBytes(total)}` : "" };
  }
  if (phase === "installing") return { title: "Installing", detail: ver };
  if (phase === "ready") return { title: "Update ready", detail: ver };
  if (phase === "error") return { title: "Update failed", detail: error?.trim() || "" };
  return { title: ver, detail: updateNote(notes) };
}

export const DEMO_BYTES = 20_000_000;
export const DEMO_DOWNLOAD_MS = 4_000;
export const DEMO_INSTALL_MS = 800;
const DEMO_FAIL = "Demo failed. Nothing was downloaded.";

export type ReleaseUpdate = {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  bytes: number;
  sha256: string;
};

/** A release the dev demo can play without calling the installer. */
export function demoRelease(): ReleaseUpdate {
  return {
    version: "1.0.0-beta.99",
    tag: "v1.0.0-beta.99",
    name: "Demo",
    notes: "Demo release. Nothing is downloaded.",
    url: "",
    bytes: DEMO_BYTES,
    sha256: "",
  };
}

export function demoFrame(elapsedMs: number, total = DEMO_BYTES): {
  phase: "downloading" | "installing" | "ready";
  received: number;
  total: number;
} {
  const elapsed = Math.max(0, elapsedMs);
  const bytes = Math.max(0, Math.floor(total));
  if (elapsed >= DEMO_DOWNLOAD_MS + DEMO_INSTALL_MS) {
    return { phase: "ready", received: bytes, total: bytes };
  }
  if (elapsed >= DEMO_DOWNLOAD_MS) {
    return { phase: "installing", received: bytes, total: bytes };
  }
  const received = bytes === 0 ? 0 : Math.min(bytes, Math.floor((elapsed / DEMO_DOWNLOAD_MS) * bytes));
  return { phase: "downloading", received, total: bytes };
}

export type UpdateModel = {
  update: ReleaseUpdate | null;
  phase: UpdatePhase;
  received: number;
  total: number;
  error: string | null;
  demo: boolean;
  /** Real update hidden while a demo is on screen. */
  held: ReleaseUpdate | null;
};

/** Show the fake release. A real download, install, or restart stays put. */
export function openDemo(model: UpdateModel): UpdateModel {
  if (model.demo) return model;
  if (model.phase === "downloading" || model.phase === "installing" || model.phase === "ready") return model;
  const release = demoRelease();
  return {
    ...model,
    held: model.update,
    update: release,
    phase: "idle",
    received: 0,
    total: release.bytes,
    error: null,
    demo: true,
  };
}

/** Drop the fake release and bring back whatever was hidden. */
export function closeDemo(model: UpdateModel): UpdateModel {
  if (!model.demo) return model;
  const update = model.held;
  return {
    ...model,
    update,
    held: null,
    phase: "idle",
    received: 0,
    total: update?.bytes ?? 0,
    error: null,
    demo: false,
  };
}

export function failDemo(model: UpdateModel): UpdateModel {
  if (!model.demo) return model;
  if (model.phase !== "downloading" && model.phase !== "installing") return model;
  return { ...model, phase: "error", error: DEMO_FAIL };
}

/** Advance a playing demo. Idle and failed demos stay where they are. */
export function tickDemo(model: UpdateModel, elapsedMs: number): UpdateModel {
  const parked = model.phase === "idle" || model.phase === "error" || model.phase === "ready" || model.phase === "checking";
  if (!model.demo || parked) return model;
  const frame = demoFrame(elapsedMs, model.update?.bytes ?? DEMO_BYTES);
  return { ...model, phase: frame.phase, received: frame.received, total: frame.total, error: null };
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
