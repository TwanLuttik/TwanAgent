/** One screen covers the chat. Settings and docs are dialogs. The rest replace the chat. */
export type AppOverlay =
  | { kind: "none" }
  | { kind: "settings" }
  | { kind: "servers" }
  | { kind: "usage" }
  | { kind: "docs" }
  | { kind: "project"; path: string; name: string };

export type OverlayScreen = "settings" | "servers" | "usage" | "docs";

const NONE: AppOverlay = { kind: "none" };

export function overlayNone(): AppOverlay {
  return NONE;
}

/** Flags the existing views already read. They cannot be true together. */
export function overlayFlags(overlay: AppOverlay): {
  showSettings: boolean;
  showServers: boolean;
  showUsage: boolean;
  showDocs: boolean;
  projectSettings: { path: string; name: string } | null;
} {
  return {
    showSettings: overlay.kind === "settings",
    showServers: overlay.kind === "servers",
    showUsage: overlay.kind === "usage",
    showDocs: overlay.kind === "docs",
    projectSettings: overlay.kind === "project" ? { path: overlay.path, name: overlay.name } : null,
  };
}

/** Usage, servers, and project settings hide the chat. Settings and docs float over it. */
export function overlayCoversChat(overlay: AppOverlay): boolean {
  return overlay.kind === "usage" || overlay.kind === "servers" || overlay.kind === "project";
}

export function showOverlay(current: AppOverlay, kind: OverlayScreen): AppOverlay {
  if (current.kind === kind) return current;
  return { kind };
}

export function openProjectOverlay(current: AppOverlay, path: string, name: string): AppOverlay {
  if (current.kind === "project" && current.path === path && current.name === name) return current;
  return { kind: "project", path, name };
}

export function closeOverlay(current: AppOverlay, kind: AppOverlay["kind"]): AppOverlay {
  if (current.kind !== kind) return current;
  return NONE;
}

export function closeEveryOverlay(current: AppOverlay): AppOverlay {
  if (current.kind === "none") return current;
  return NONE;
}

export function dismissProjectOverlay(
  current: AppOverlay,
  path: string,
  same: (left: string, right: string) => boolean,
): AppOverlay {
  if (current.kind !== "project" || !same(current.path, path)) return current;
  return NONE;
}
