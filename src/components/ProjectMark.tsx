import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { pickProjectLogo } from "../lib/project-logo";
import * as api from "../lib/tauri";
import { Symbol } from "./Symbol";

/**
 * Favicon or logo for one project. Empty when the root has neither, so the
 * folder glyph stays. A cloud project keeps the folder: its files are not here.
 */
export function useProjectLogo(path: string, remote = false, refresh = 0): string | null {
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    if (!path || remote) {
      setLogo(null);
      return;
    }
    let cancelled = false;
    void api
      .listDir(path, "")
      .then(async (entries) => {
        const picked = pickProjectLogo(entries.filter((entry) => entry.kind !== "dir"));
        if (!picked) return null;
        return api.resolveFile(path, picked);
      })
      .then((abs) => {
        if (!cancelled) setLogo(abs ? convertFileSrc(abs) : null);
      })
      .catch(() => {
        if (!cancelled) setLogo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [path, remote, refresh]);
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
  }, [logo]);
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
