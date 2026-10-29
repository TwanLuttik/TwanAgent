import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { fileStructureSignature, subscribeFileStructure } from "../lib/file-structure";
import { nestedLogoDirs, pickProjectLogo, rootLogoDirs } from "../lib/project-logo";
import * as api from "../lib/tauri";
import { Symbol } from "./Symbol";

const LOGO_POLL_MS = 8000;

let pollRevision = 0;
const pollListeners = new Set<() => void>();
let pollTimer = 0;
let pollVisibility: (() => void) | null = null;

function bumpLogoPoll() {
  pollRevision += 1;
  pollListeners.forEach((listener) => listener());
}

/** Re-read icons while the window is open. Finder edits do not bump the file refresh. */
function subscribeLogoPoll(listener: () => void): () => void {
  pollListeners.add(listener);
  if (pollListeners.size === 1) {
    pollTimer = window.setInterval(() => {
      if (document.hidden) return;
      bumpLogoPoll();
    }, LOGO_POLL_MS);
    pollVisibility = () => {
      if (!document.hidden) bumpLogoPoll();
    };
    document.addEventListener("visibilitychange", pollVisibility);
  }
  return () => {
    pollListeners.delete(listener);
    if (pollListeners.size === 0) {
      window.clearInterval(pollTimer);
      pollTimer = 0;
      if (pollVisibility) document.removeEventListener("visibilitychange", pollVisibility);
      pollVisibility = null;
    }
  };
}

function logoPollRevision(): number {
  return pollRevision;
}

function subscribeNothing(): () => void {
  return () => {};
}

function idleRevision(): number {
  return 0;
}

function readLogoDir(root: string, dir: string): Promise<api.Entry[]> {
  return api.listDir(root, dir).catch(() => []);
}

function logoUrl(abs: string, modified: number | null | undefined): string {
  const url = convertFileSrc(abs);
  if (modified == null) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${modified}`;
}

/**
 * Favicon or logo for one project. Empty when none of the known folders has
 * one, so the folder glyph stays. A cloud project keeps the folder: its files
 * are not here.
 */
export function useProjectLogo(path: string, remote = false, refresh = 0): string | null {
  const [logo, setLogo] = useState<string | null>(null);
  const watch = Boolean(path) && !remote;
  const tree = useSyncExternalStore(
    watch ? subscribeFileStructure : subscribeNothing,
    () => (watch ? fileStructureSignature(path) : ""),
    () => "",
  );
  const polled = useSyncExternalStore(
    watch ? subscribeLogoPoll : subscribeNothing,
    watch ? logoPollRevision : idleRevision,
    idleRevision,
  );
  useEffect(() => {
    if (!path || remote) {
      setLogo(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rootEntries = await api.listDir(path, "");
        if (cancelled) return;
        const nested = (await Promise.all(rootLogoDirs(rootEntries).map((dir) => readLogoDir(path, dir)))).flat();
        if (cancelled) return;
        const deepDirs = nestedLogoDirs(nested);
        const deep = deepDirs.length ? (await Promise.all(deepDirs.map((dir) => readLogoDir(path, dir)))).flat() : [];
        if (cancelled) return;
        const files = [...rootEntries, ...nested, ...deep].filter((entry) => entry.kind !== "dir");
        const picked = pickProjectLogo(files);
        if (!picked) {
          setLogo(null);
          return;
        }
        const modified = files.find((entry) => entry.path.replace(/\\/g, "/") === picked)?.modified ?? null;
        const abs = await api.resolveFile(path, picked);
        if (!cancelled) setLogo(abs ? logoUrl(abs, modified) : null);
      } catch {
        // A failed poll keeps the icon already on screen.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, remote, refresh, tree, polled]);
  return logo;
}

export function ProjectMark({
  path,
  remote = false,
  refresh = 0,
  active = false,
  className = "size-3.5",
}: {
  path: string;
  remote?: boolean;
  refresh?: number;
  active?: boolean;
  className?: string;
}) {
  const logo = useProjectLogo(path, remote, refresh);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [logo, refresh]);
  if (!logo || failed) {
    return <Symbol name="folder.fill" className={`${className} shrink-0 ${active ? "text-accent" : "text-muted"}`} />;
  }
  return (
    <img
      src={logo}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className={`${className} shrink-0 rounded-[3px] object-contain`}
    />
  );
}
